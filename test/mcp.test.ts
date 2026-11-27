// Optional MCP server (/mcp) and its OAuth: discovery, registration, consent,
// tokens, refresh, revocation, and tools that act as the connected agent.

import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";
import { ADMIN, accessJwt, call, newAgent, newRoom, ownerCall, registerOwner } from "./helpers";

const BASE = "https://lichen.test";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

let n = 0;
async function owner(login: string) {
  const id = `github:${login}${++n}`;
  const email = `${login}${n}@example.com`;
  await registerOwner(id, email);
  return { id, email, jwt: await accessJwt(email), agent: await newAgent(id, `${login}-agent`) };
}

const b64url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)).buffer);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

async function register(body: Record<string, unknown> = {}) {
  const res = await SELF.fetch(BASE + "/oauth/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", ...body }),
  });
  return { status: res.status, data: (await res.json()) as any };
}

async function token(form: Record<string, string>, headers: Record<string, string> = {}) {
  const res = await SELF.fetch(BASE + "/oauth/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(form).toString(),
  });
  return { status: res.status, data: (await res.json()) as any };
}

/** Full flow: register, authorize, owner approves, swap the code. */
async function connect(o: { jwt: string }, approve: Record<string, unknown> = {}) {
  const client = (await register()).data;
  const { verifier, challenge } = await pkce();
  const q = new URLSearchParams({
    response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge,
    code_challenge_method: "S256", state: "st-1", resource: `${BASE}/mcp`, scope: "lichen",
  });
  const auth = await SELF.fetch(`${BASE}/oauth/authorize?${q}`, { redirect: "manual" });
  expect(auth.status).toBe(302);
  const loc = new URL(auth.headers.get("location")!);
  expect(loc.pathname).toBe("/accept");
  const request = loc.searchParams.get("connect")!;
  const view = await ownerCall(`/owner/oauth/requests/${request}`, { jwt: o.jwt });
  expect(view.status).toBe(200);
  expect(view.data.redirect_host).toBe("claude.ai");
  const ok = await ownerCall("/owner/oauth/approve", { jwt: o.jwt, body: { request, ...approve } });
  expect(ok.status).toBe(200);
  const back = new URL(ok.data.redirect);
  expect(back.origin + back.pathname).toBe(REDIRECT);
  expect(back.searchParams.get("state")).toBe("st-1");
  expect(back.searchParams.get("iss")).toBe(BASE);
  const code = back.searchParams.get("code")!;
  const t = await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier, client_id: client.client_id });
  expect(t.status).toBe(200);
  return { client, code, verifier, tokens: t.data, agentId: ok.data.agent_id as string, request };
}

let rpcId = 0;
async function rpc(tok: string | null, method: string, params?: unknown) {
  const res = await SELF.fetch(BASE + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, ...(params ? { params } : {}) }),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, data: text ? JSON.parse(text) : null };
}

async function tool(tok: string, name: string, args: Record<string, unknown> = {}) {
  const r = await rpc(tok, "tools/call", { name, arguments: args });
  expect(r.status).toBe(200);
  const result = r.data.result;
  return { isError: !!result.isError, data: JSON.parse(result.content[0].text) };
}

describe("MCP discovery", () => {
  it("answers 401 with resource metadata, and serves both metadata documents", async () => {
    const r = await rpc(null, "initialize", { protocolVersion: "2025-06-18" });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource"`);

    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const pr = (await (await SELF.fetch(BASE + path)).json()) as any;
      expect(pr.resource).toBe(`${BASE}/mcp`);
      expect(pr.authorization_servers).toEqual([BASE]);
    }
    const as = (await (await SELF.fetch(BASE + "/.well-known/oauth-authorization-server")).json()) as any;
    expect(as.issuer).toBe(BASE);
    expect(as.registration_endpoint).toBe(`${BASE}/oauth/register`);
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
  });

  it("doesn't stream: GET /mcp is 405", async () => {
    expect((await SELF.fetch(BASE + "/mcp")).status).toBe(405);
  });
});

describe("OAuth", () => {
  it("only registers redirect URIs on allowed hosts or loopback", async () => {
    expect((await register()).status).toBe(201);
    expect((await register({ redirect_uris: ["http://localhost:4567/callback"] })).status).toBe(201);
    expect((await register({ redirect_uris: ["https://claude.com/api/mcp/auth_callback"] })).status).toBe(201);
    const bad = await register({ redirect_uris: ["https://evil.example/cb"] });
    expect(bad.status).toBe(400);
    expect(bad.data.error).toBe("invalid_redirect_uri");
    expect((await register({ redirect_uris: ["http://evil.example/cb"] })).status).toBe(400);
    expect((await register({ redirect_uris: [] })).status).toBe(400);
    const confidential = await register({ token_endpoint_auth_method: "client_secret_post" });
    expect(confidential.data.client_secret).toMatch(/^mcs_/);
  });

  it("checks the client, redirect URI and PKCE before anything reaches an owner", async () => {
    const client = (await register()).data;
    const { challenge } = await pkce();
    const go = (q: Record<string, string>) => SELF.fetch(`${BASE}/oauth/authorize?${new URLSearchParams(q)}`, { redirect: "manual" });
    const base = { response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256" };
    expect((await go({ ...base, client_id: "mcl_nope" })).status).toBe(400);
    expect((await go({ ...base, redirect_uri: "https://claude.ai/elsewhere" })).status).toBe(400);
    const noPkce = await go({ ...base, code_challenge_method: "plain" });
    expect(noPkce.status).toBe(302);
    expect(new URL(noPkce.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
    const badResource = await go({ ...base, resource: "https://other.example/mcp" });
    expect(new URL(badResource.headers.get("location")!).searchParams.get("error")).toBe("invalid_target");
  });

  it("connects an existing agent; codes work once and need the right verifier", async () => {
    const o = await owner("conn");
    const c = await connect(o, { agent_id: o.agent.agent_id });
    expect(c.agentId).toBe(o.agent.agent_id);
    expect(c.tokens.token_type).toBe("Bearer");
    expect(c.tokens.access_token).toMatch(/^lma_/);
    expect(c.tokens.refresh_token).toMatch(/^lmr_/);
    // Same code again: refused.
    const again = await token({ grant_type: "authorization_code", code: c.code, redirect_uri: REDIRECT, code_verifier: c.verifier, client_id: c.client.client_id });
    expect(again.status).toBe(400);
    expect(again.data.error).toBe("invalid_grant");
    // The request can't be decided twice.
    expect((await ownerCall("/owner/oauth/approve", { jwt: o.jwt, body: { request: c.request } })).status).toBe(404);

    const me = await tool(c.tokens.access_token, "whoami");
    expect(me.data.agent_id).toBe(o.agent.agent_id);
  });

  it("rejects a wrong PKCE verifier and another client's code", async () => {
    const o = await owner("pkce");
    const client = (await register()).data;
    const other = (await register()).data;
    const { challenge } = await pkce();
    const q = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256" });
    const request = new URL((await SELF.fetch(`${BASE}/oauth/authorize?${q}`, { redirect: "manual" })).headers.get("location")!).searchParams.get("connect")!;
    const code = new URL((await ownerCall("/owner/oauth/approve", { jwt: o.jwt, body: { request } })).data.redirect).searchParams.get("code")!;
    const wrong = (await pkce()).verifier;
    expect((await token({ grant_type: "authorization_code", code, code_verifier: wrong, client_id: other.client_id })).data.error).toBe("invalid_grant");
    expect((await token({ grant_type: "authorization_code", code, code_verifier: wrong, client_id: client.client_id })).data.error).toBe("invalid_grant");
  });

  it("makes a new agent when asked, refreshes with rotation, and stops when revoked", async () => {
    const o = await owner("fresh");
    const c = await connect(o, { agent_name: "Claude Duet" });
    expect(c.agentId).not.toBe(o.agent.agent_id);
    const agents = await ownerCall("/owner/agents", { jwt: o.jwt });
    expect(agents.data.agents.map((a: any) => a.name)).toContain("Claude Duet");

    const r1 = await token({ grant_type: "refresh_token", refresh_token: c.tokens.refresh_token, client_id: c.client.client_id });
    expect(r1.status).toBe(200);
    expect(r1.data.access_token).not.toBe(c.tokens.access_token);
    // The old refresh token and old access token stop working.
    expect((await token({ grant_type: "refresh_token", refresh_token: c.tokens.refresh_token, client_id: c.client.client_id })).status).toBe(400);
    expect((await rpc(c.tokens.access_token, "ping")).status).toBe(401);
    expect((await rpc(r1.data.access_token, "ping")).status).toBe(200);

    const list = await ownerCall("/owner/connections", { jwt: o.jwt });
    expect(list.data.connections).toHaveLength(1);
    expect(list.data.connections[0].redirect_host).toBe("claude.ai");
    const revoked = await ownerCall(`/owner/connections/${list.data.connections[0].id}/revoke`, { jwt: o.jwt, body: {} });
    expect(revoked.status).toBe(200);
    const after = await rpc(r1.data.access_token, "ping");
    expect(after.status).toBe(401);
    expect(after.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect((await token({ grant_type: "refresh_token", refresh_token: r1.data.refresh_token, client_id: c.client.client_id })).status).toBe(400);
  });

  it("revoking the agent ends its connections", async () => {
    const o = await owner("agentrev");
    const c = await connect(o, { agent_id: o.agent.agent_id });
    expect((await ownerCall(`/owner/agents/${o.agent.agent_id}/revoke`, { jwt: o.jwt, body: {} })).status).toBe(200);
    expect((await rpc(c.tokens.access_token, "ping")).status).toBe(401);
  });

  it("deny sends the browser back with access_denied", async () => {
    const o = await owner("deny");
    const client = (await register()).data;
    const { challenge } = await pkce();
    const q = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "s" });
    const request = new URL((await SELF.fetch(`${BASE}/oauth/authorize?${q}`, { redirect: "manual" })).headers.get("location")!).searchParams.get("connect")!;
    const r = await ownerCall("/owner/oauth/deny", { jwt: o.jwt, body: { request } });
    expect(new URL(r.data.redirect).searchParams.get("error")).toBe("access_denied");
  });

  it("only lets the owner act as their own agents, and needs sign-in", async () => {
    const a = await owner("own1");
    const b = await owner("own2");
    const client = (await register()).data;
    const { challenge } = await pkce();
    const q = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256" });
    const request = new URL((await SELF.fetch(`${BASE}/oauth/authorize?${q}`, { redirect: "manual" })).headers.get("location")!).searchParams.get("connect")!;
    expect((await ownerCall("/owner/oauth/approve", { body: { request } })).status).toBe(401);
    expect((await ownerCall("/owner/oauth/approve", { jwt: b.jwt, body: { request, agent_id: a.agent.agent_id } })).status).toBe(404);
    expect((await ownerCall("/owner/oauth/approve", { jwt: b.jwt, body: { request }, origin: "https://evil.example" })).status).toBe(403);
  });

  it("confidential clients must send their secret", async () => {
    const reg = await register({ token_endpoint_auth_method: "client_secret_basic" });
    const r = await token({ grant_type: "refresh_token", refresh_token: "lmr_x", client_id: reg.data.client_id });
    expect(r.status).toBe(401);
    expect(r.data.error).toBe("invalid_client");
    const basic = btoa(`${reg.data.client_id}:${reg.data.client_secret}`);
    const ok = await token({ grant_type: "refresh_token", refresh_token: "lmr_x" }, { authorization: `Basic ${basic}` });
    expect(ok.data.error).toBe("invalid_grant"); // authenticated; the token itself is bad
  });
});

describe("MCP tools", () => {
  it("initializes, lists tools and negotiates the protocol version", async () => {
    const o = await owner("init");
    const { tokens } = await connect(o, { agent_id: o.agent.agent_id });
    const init = await rpc(tokens.access_token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(init.data.result.protocolVersion).toBe("2025-06-18");
    expect(init.data.result.capabilities.tools).toBeTruthy();
    expect(init.data.result.serverInfo.name).toBe("lichen");
    expect((await rpc(tokens.access_token, "initialize", { protocolVersion: "1999-01-01" })).data.result.protocolVersion).toBe("2025-11-25");

    const note = await SELF.fetch(BASE + "/mcp", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tokens.access_token}` },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(note.status).toBe(202);

    const list = await rpc(tokens.access_token, "tools/list");
    const names = list.data.result.tools.map((t: any) => t.name);
    for (const t of ["whoami", "list_rooms", "find_agents", "read_inbox", "read_history", "send_message", "direct_message", "react", "mark_read"]) {
      expect(names).toContain(t);
    }
    expect(list.data.result.tools.every((t: any) => t.inputSchema?.type === "object")).toBe(true);
    expect((await rpc(tokens.access_token, "nope/method")).data.error.code).toBe(-32601);
    expect((await rpc(tokens.access_token, "tools/call", { name: "nope" })).data.error.code).toBe(-32602);
  });

  it("sends and reads as the connected agent, with the API's rules", async () => {
    const o = await owner("tools");
    const peer = await newAgent(o.id, "Peer Bot");
    const roomId = await newRoom([o.agent.agent_id, peer.agent_id], "mcp-room");
    const { tokens } = await connect(o, { agent_id: o.agent.agent_id });
    const t = tokens.access_token;

    const rooms = await tool(t, "list_rooms");
    expect(rooms.data.rooms.map((r: any) => r.id)).toContain(roomId);

    const sent = await tool(t, "send_message", { room: roomId, body: "hello from MCP", thread_id: "t1" });
    expect(sent.isError).toBe(false);
    expect(sent.data.id).toBe(`${roomId}:1`);

    // The peer (curl) sees it, sent by the connected agent.
    const peerInbox = await call("/inbox", { token: peer.token });
    expect(peerInbox.data.messages[0].envelope.sender_id).toBe(o.agent.agent_id);
    expect(peerInbox.data.messages[0].body).toBe("hello from MCP");

    await call("/send", { token: peer.token, body: { room: roomId, body: "@tools-agent ping", thread_id: "t1" } });
    const inbox = await tool(t, "read_inbox");
    expect(inbox.data.unread).toBe(1);
    expect(inbox.data.needs_you).toBe(1);
    expect(inbox.data.messages[0].attention).toBe("direct");
    // Still unread until marked.
    expect((await tool(t, "read_inbox")).data.unread).toBe(1);
    const marked = await tool(t, "read_inbox", { mark_read: true });
    expect(marked.data.marked_read).toBe(true);
    expect((await tool(t, "read_inbox")).data.unread).toBe(0);

    const hist = await tool(t, "read_history", { room: roomId, limit: 10 });
    expect(hist.data.messages).toHaveLength(2);

    expect((await tool(t, "react", { message_id: `${roomId}:2`, emoji: "✅" })).isError).toBe(false);

    // API errors come back as tool errors, not protocol errors.
    const bad = await tool(t, "send_message", { room: "r_doesnotexist", body: "x" });
    expect(bad.isError).toBe(true);
    expect(bad.data.error).toBe("room_not_found");
    const badEmoji = await tool(t, "react", { message_id: `${roomId}:2`, emoji: "💥" });
    expect(badEmoji.isError).toBe(true);
  });

  it("also accepts an agent's own lch_ token (for clients with a static header)", async () => {
    const o = await owner("static");
    const me = await tool(o.agent.token, "whoami");
    expect(me.data.agent_id).toBe(o.agent.agent_id);
    expect((await rpc("lch_wrong", "ping")).status).toBe(401);
    expect((await rpc(ADMIN, "ping")).status).toBe(401);
  });
});
