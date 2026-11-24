import { describe, it, expect } from "vitest";
import { env, SELF } from "cloudflare:test";
import { call, newAgent, newRoom, ADMIN } from "./helpers";
import { CLOSE_REPLACED, CLOSE_REVOKED, MAX_SOCKETS } from "../src/agent";

interface Socket {
  ws: WebSocket;
  /** Next frame, parsed as JSON when possible. Rejects after `ms`. */
  next(ms?: number): Promise<any>;
  /** Resolves true if no frame arrives within `ms`. */
  quiet(ms?: number): Promise<boolean>;
  closed: Promise<{ code: number; reason: string }>;
}

async function openSocket(token?: string, upgrade = true): Promise<Response> {
  const headers: Record<string, string> = {};
  if (upgrade) headers.upgrade = "websocket";
  if (token) headers.authorization = `Bearer ${token}`;
  return SELF.fetch("https://lichen.test/api/ws", { headers });
}

async function connect(token: string): Promise<Socket> {
  const res = await openSocket(token);
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();

  const frames: any[] = [];
  const waiters: ((v: any) => void)[] = [];
  ws.addEventListener("message", (e) => {
    const data = typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data as ArrayBuffer);
    let v: any = data;
    try { v = JSON.parse(data); } catch { /* plain text, e.g. "pong" */ }
    const w = waiters.shift();
    if (w) w(v); else frames.push(v);
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.addEventListener("close", (e) => resolve({ code: e.code, reason: e.reason })));

  const next = (ms = 2000) => {
    if (frames.length) return Promise.resolve(frames.shift());
    return new Promise<any>((resolve, reject) => {
      const waiter = (v: any) => { clearTimeout(t); resolve(v); };
      const t = setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1); // don't let a timed-out wait eat a later frame
        reject(new Error("no frame within " + ms + "ms"));
      }, ms);
      waiters.push(waiter);
    });
  };
  const quiet = async (ms = 300) => {
    try { await next(ms); return false; } catch { return true; }
  };
  return { ws, next, quiet, closed };
}

const socketCount = (agentId: string) => env.AGENT.get(env.AGENT.idFromName(agentId)).socketCount();

describe("/ws", () => {
  it("needs a valid token and a WebSocket upgrade", async () => {
    expect((await openSocket()).status).toBe(401);
    expect((await openSocket("lch_nope")).status).toBe(401);
    const a = await newAgent("github:jjrpf", "ws-auth");
    const plain = await openSocket(a.token, false);
    expect(plain.status).toBe(426);
    expect(((await plain.json()) as any).error).toBe("upgrade_required");
  });

  it("pushes a notice (no body) to other members; the body comes from /inbox", async () => {
    const a = await newAgent("github:jjrpf", "ws-alpha");
    const b = await newAgent("github:jjrpf", "ws-beta");
    const roomId = await newRoom([a.agent_id, b.agent_id]);
    const sa = await connect(a.token);
    const sb = await connect(b.token);

    const sent = await call("/send", { token: a.token, body: { room: roomId, body: "secret plans", thread_id: "t1" } });
    expect(sent.status).toBe(201);

    const notice = await sb.next();
    expect(notice).toEqual({ id: sent.data.id, room: roomId, from: a.agent_id, trust_tier: "same_owner", attention: "direct" });
    expect(JSON.stringify(notice)).not.toContain("secret plans");

    // The sender doesn't get a notice for its own message.
    expect(await sa.quiet()).toBe(true);

    const inbox = await call("/inbox", { token: b.token });
    expect(inbox.data.messages.map((m: any) => m.id)).toEqual([notice.id]);
    expect(inbox.data.messages[0].body).toBe("secret plans");
    sa.ws.close(); sb.ws.close();
  });

  it("flags reactions no_turn and computes the tier per recipient", async () => {
    const mine = await newAgent("github:jjrpf", "ws-mine");
    const mine2 = await newAgent("github:jjrpf", "ws-mine2");
    const theirs = await newAgent("github:collab", "ws-theirs");
    const roomId = await newRoom([mine.agent_id, mine2.agent_id, theirs.agent_id]);
    const s2 = await connect(mine2.token);
    const st = await connect(theirs.token);

    const sent = await call("/send", { token: mine.token, body: { room: roomId, body: "hi", trust_tier: "same_owner" } });
    expect((await s2.next()).trust_tier).toBe("same_owner");
    expect(await st.next()).toEqual({ id: sent.data.id, room: roomId, from: mine.agent_id, trust_tier: "external", attention: "ambient" });

    const r = await call("/react", { token: theirs.token, body: { message_id: sent.data.id, emoji: "👍" } });
    expect(r.status).toBe(201);
    expect(await s2.next()).toEqual({ id: r.data.id, room: roomId, from: theirs.agent_id, trust_tier: "external", no_turn: true });
    expect(await st.quiet()).toBe(true);
    s2.ws.close(); st.ws.close();
  });

  it("notifies read-only members but not non-members", async () => {
    const a = await newAgent("github:jjrpf", "ws-poster");
    const reader = await newAgent("github:jjrpf", "ws-reader");
    const outsider = await newAgent("github:jjrpf", "ws-outsider");
    const roomId = await newRoom([a.agent_id]);
    await call(`/admin/rooms/${roomId}/members`, { token: ADMIN, body: { agent_id: reader.agent_id, role: "read" } });
    const sr = await connect(reader.token);
    const so = await connect(outsider.token);

    await call("/send", { token: a.token, body: { room: roomId, body: "fyi", reply_requested: false } });
    expect((await sr.next()).room).toBe(roomId);
    expect(await so.quiet()).toBe(true);
    sr.ws.close(); so.ws.close();
  });

  it("delivers to every socket of an agent and answers ping without a body", async () => {
    const a = await newAgent("github:jjrpf", "ws-multi-a");
    const b = await newAgent("github:jjrpf", "ws-multi-b");
    const roomId = await newRoom([a.agent_id, b.agent_id]);
    const s1 = await connect(b.token);
    const s2 = await connect(b.token);
    expect(await socketCount(b.agent_id)).toBe(2);

    s1.ws.send("ping");
    expect(await s1.next()).toBe("pong");
    s1.ws.send(JSON.stringify({ body: "clients can't post over the socket" }));
    expect(await s1.quiet()).toBe(true);

    const sent = await call("/send", { token: a.token, body: { room: roomId, body: "both" } });
    expect((await s1.next()).id).toBe(sent.data.id);
    expect((await s2.next()).id).toBe(sent.data.id);
    s1.ws.close(); s2.ws.close();
  });

  it(`keeps at most ${MAX_SOCKETS} sockets per agent, closing the oldest`, async () => {
    const a = await newAgent("github:jjrpf", "ws-cap");
    const socks: Socket[] = [];
    for (let i = 0; i < MAX_SOCKETS; i++) socks.push(await connect(a.token));
    const extra = await connect(a.token);
    expect((await socks[0].closed).code).toBe(CLOSE_REPLACED);
    expect(await socketCount(a.agent_id)).toBe(MAX_SOCKETS);
    for (const s of [...socks.slice(1), extra]) s.ws.close();
  });

  it("closes an agent's sockets when its token is revoked", async () => {
    const a = await newAgent("github:jjrpf", "ws-revoked");
    const s = await connect(a.token);
    expect((await call(`/admin/agents/${a.agent_id}/revoke`, { token: ADMIN, method: "POST" })).status).toBe(200);
    expect((await s.closed).code).toBe(CLOSE_REVOKED);
    expect((await openSocket(a.token)).status).toBe(401);
  });
});

describe("worker entry module", () => {
  it("exports only handlers and Durable Object classes (workerd rejects anything else)", async () => {
    const mod: Record<string, unknown> = await import("../src/index");
    for (const [name, value] of Object.entries(mod)) {
      const ok = typeof value === "function" || (name === "default" && typeof value === "object");
      expect(ok, `export ${name}`).toBe(true);
    }
    expect((await call("/")).data.version).toBe("0.10.0");
  });
});
