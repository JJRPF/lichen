// OAuth 2.1 for the optional MCP endpoint (/mcp).
//
// Lichen is its own authorization server, so an MCP client (a claude.ai custom
// connector, Claude Code, …) can connect with nothing but the URL:
//
//   1. The client finds us from the 401 on /mcp → /.well-known/oauth-protected-resource
//      → /.well-known/oauth-authorization-server.
//   2. It registers itself (RFC 7591, /oauth/register). Redirect URIs must be on
//      an allowed host (OAUTH_REDIRECT_HOSTS, default claude.ai and claude.com)
//      or loopback, so a code can only ever land with a known client.
//   3. /oauth/authorize checks the request (PKCE S256 is required) and sends the
//      browser to /accept?connect=<id>. That page is behind Cloudflare Access,
//      so the owner signs in with GitHub as usual, sees who is asking, and picks
//      which of their agents the client acts as (or makes a new one).
//   4. /oauth/token swaps the one-time code for an access token (1 hour) and a
//      refresh token (rotated on every use).
//
// Only hashes of codes and tokens are stored. Owners list and revoke
// connections in the dashboard; revoking the agent ends them too.

import { type Agent, type Ctx, audit, authAgent, bearer, rateLimit } from "./core";
import type { Env } from "./env";
import { accessConfigured } from "./access";
import { HttpError, json, newId, newToken, randomString, readBody, safeEqual, sha256Hex, str } from "./util";

const SCOPE = "lichen";
const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_MS = 60 * 24 * 60 * 60 * 1000;
const REQUEST_TTL_MS = 15 * 60 * 1000; // time to sign in and approve
const CODE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_REDIRECT_HOSTS = "claude.ai,claude.com";
const AUTH_METHODS = new Set(["none", "client_secret_post", "client_secret_basic"]);

/** Metadata, registration, token and /mcp are called cross-origin by browser-based clients. */
export const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id, last-event-id",
  "access-control-expose-headers": "www-authenticate, mcp-session-id, mcp-protocol-version",
  "access-control-max-age": "86400",
};

const NO_STORE = { ...CORS, "cache-control": "no-store", pragma: "no-cache" };

/** RFC 6749 error bodies ({error, error_description}), not Lichen's {error, message}. */
class OAuthError extends Error {
  constructor(public status: number, public error: string, description: string) {
    super(description);
  }
}

export const mcpResource = (origin: string) => `${origin}/mcp`;
const resourceMetadataUrl = (origin: string) => `${origin}/.well-known/oauth-protected-resource`;

// ---------------------------------------------------------------- metadata

/** RFC 9728, also served at /.well-known/oauth-protected-resource/mcp. */
export function protectedResource(origin: string): Response {
  return json({
    resource: mcpResource(origin),
    authorization_servers: [origin],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Lichen",
    resource_documentation: `${origin}/agents.md`,
  }, 200, { ...CORS, "cache-control": "public, max-age=300" });
}

/** RFC 8414. */
export function authServer(origin: string): Response {
  return json({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: [...AUTH_METHODS],
    revocation_endpoint_auth_methods_supported: [...AUTH_METHODS],
    scopes_supported: [SCOPE],
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${origin}/agents.md`,
  }, 200, { ...CORS, "cache-control": "public, max-age=300" });
}

/** /oauth/* (register, authorize, token, revoke). */
export async function oauthRoute(req: Request, ctx: Ctx, p: string): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  try {
    if (p === "/oauth/register" && req.method === "POST") return await register(req, ctx);
    if (p === "/oauth/authorize" && (req.method === "GET" || req.method === "HEAD")) return await authorize(req, ctx);
    if (p === "/oauth/token" && req.method === "POST") return await token(req, ctx);
    if (p === "/oauth/revoke" && req.method === "POST") return await revoke(req, ctx);
  } catch (err) {
    if (err instanceof OAuthError) {
      const extra: Record<string, string> = err.error === "invalid_client" ? { "www-authenticate": 'Basic realm="lichen"' } : {};
      return json({ error: err.error, error_description: err.message }, err.status, { ...NO_STORE, ...extra });
    }
    if (err instanceof HttpError) {
      // Body parsing and rate limits throw HttpError; answer in OAuth form.
      const code = err.status === 429 ? "slow_down" : "invalid_request";
      return json({ error: code, error_description: err.message }, err.status, NO_STORE);
    }
    throw err;
  }
  throw new HttpError(404, "not_found");
}

// ---------------------------------------------------------------- registration (RFC 7591)

/** Redirect URIs: an allowed https host, or loopback http (native clients). No fragments, no credentials. */
export function redirectAllowed(env: Env, uri: string): boolean {
  let u: URL;
  try { u = new URL(uri); } catch { return false; }
  if (u.hash || u.username || u.password) return false;
  if (u.protocol === "http:") return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:") return false;
  const hosts = (env.OAUTH_REDIRECT_HOSTS ?? DEFAULT_REDIRECT_HOSTS).split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  const host = u.hostname.toLowerCase();
  return hosts.some((h) => h === "*" || host === h || host.endsWith("." + h));
}

async function register(req: Request, ctx: Ctx): Promise<Response> {
  const { env } = ctx;
  await rateLimit(env, `oauth-register:${req.headers.get("cf-connecting-ip") ?? "unknown"}`);
  const b = await readBody(req);
  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every((u) => typeof u === "string" && u.length <= 2000)) {
    throw new OAuthError(400, "invalid_redirect_uri", "redirect_uris must be a list of 1 to 10 URLs");
  }
  const bad = (uris as string[]).find((u) => !redirectAllowed(env, u));
  if (bad) throw new OAuthError(400, "invalid_redirect_uri", `Redirect URI not allowed here: ${bad.slice(0, 200)}`);
  const method = typeof b.token_endpoint_auth_method === "string" ? b.token_endpoint_auth_method : "client_secret_basic";
  if (!AUTH_METHODS.has(method)) throw new OAuthError(400, "invalid_client_metadata", "token_endpoint_auth_method must be none, client_secret_post or client_secret_basic");
  if (Array.isArray(b.grant_types) && !b.grant_types.every((g) => g === "authorization_code" || g === "refresh_token")) {
    throw new OAuthError(400, "invalid_client_metadata", "Only authorization_code and refresh_token grants are supported");
  }
  if (Array.isArray(b.response_types) && !b.response_types.every((t) => t === "code")) {
    throw new OAuthError(400, "invalid_client_metadata", "Only the code response type is supported");
  }
  const name = (typeof b.client_name === "string" && b.client_name.trim() ? b.client_name.trim() : "MCP client").slice(0, 100);
  const id = newId("mcl", 20);
  const secret = method === "none" ? null : newToken("mcs");
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO oauth_clients (id, secret_hash, auth_method, name, redirect_uris, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(id, secret ? await sha256Hex(secret) : null, method, name, JSON.stringify(uris), now).run();
  await audit(env, "oauth", "oauth.register", id, { name, hosts: [...new Set((uris as string[]).map((u) => new URL(u).host))] });
  return json({
    client_id: id,
    client_id_issued_at: Math.floor(now / 1000),
    client_name: name,
    redirect_uris: uris,
    token_endpoint_auth_method: method,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: SCOPE,
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
  }, 201, NO_STORE);
}

interface ClientRow { id: string; secret_hash: string | null; auth_method: string; name: string; redirect_uris: string }

const getClient = (env: Env, id: string) =>
  env.DB.prepare("SELECT id, secret_hash, auth_method, name, redirect_uris FROM oauth_clients WHERE id = ?").bind(id).first<ClientRow>();

// ---------------------------------------------------------------- authorize

function redirectWith(uri: string, params: Record<string, string | null | undefined>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

const found = (location: string) => new Response(null, { status: 302, headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" } });

async function authorize(req: Request, ctx: Ctx): Promise<Response> {
  const { env, origin } = ctx;
  await rateLimit(env, `oauth-authorize:${req.headers.get("cf-connecting-ip") ?? "unknown"}`);
  const q = new URL(req.url).searchParams;
  const clientId = q.get("client_id") ?? "";
  const client = clientId ? await getClient(env, clientId) : null;
  // Until the client and its redirect URI check out, errors are shown here, never redirected.
  if (!client) throw new OAuthError(400, "invalid_client", "Unknown client_id; register first");
  const registered = JSON.parse(client.redirect_uris) as string[];
  const redirectUri = q.get("redirect_uri") ?? (registered.length === 1 ? registered[0] : "");
  if (!registered.includes(redirectUri)) throw new OAuthError(400, "invalid_request", "redirect_uri doesn't match the registered ones");

  const state = q.get("state");
  const fail = (error: string, description: string) => found(redirectWith(redirectUri, { error, error_description: description, state, iss: origin }));
  if (q.get("response_type") !== "code") return fail("unsupported_response_type", "response_type must be code");
  const challenge = q.get("code_challenge") ?? "";
  if (q.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
    return fail("invalid_request", "PKCE with code_challenge_method=S256 is required");
  }
  const resource = q.get("resource");
  if (resource && !validResource(origin, resource)) return fail("invalid_target", `resource must be ${mcpResource(origin)}`);
  if (state && state.length > 1000) return fail("invalid_request", "state is too long");
  if (!accessConfigured(env)) return fail("temporarily_unavailable", "Owner sign-in isn't set up on this Lichen server");

  const id = newId("oar", 24);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO oauth_requests (id, client_id, redirect_uri, code_challenge, state, resource, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, client.id, redirectUri, challenge, state, resource, now, now + REQUEST_TTL_MS).run();
  // /accept is behind Cloudflare Access: the owner signs in there, then approves.
  return found(`${origin}/accept?connect=${id}`);
}

const validResource = (origin: string, r: string) => [mcpResource(origin), origin, `${origin}/`, `${mcpResource(origin)}/`].includes(r);

// ---------------------------------------------------------------- owner consent (called from /api/owner/*)

interface RequestRow {
  id: string; client_id: string; redirect_uri: string; state: string | null; expires_at: number;
  client_name: string;
}

async function pendingRequest(env: Env, id: string): Promise<RequestRow> {
  const row = await env.DB.prepare(
    `SELECT r.id, r.client_id, r.redirect_uri, r.state, r.expires_at, c.name AS client_name
     FROM oauth_requests r JOIN oauth_clients c ON c.id = r.client_id
     WHERE r.id = ? AND r.decided_at IS NULL AND r.expires_at > ?`,
  ).bind(id, Date.now()).first<RequestRow>();
  if (!row) throw new HttpError(404, "connect_request_not_found", "This connection request expired or was already decided. Start again from your app.");
  return row;
}

/** What the consent screen shows. The client name is self-described; the redirect host is what counts. */
export async function connectRequestView(env: Env, id: string) {
  const r = await pendingRequest(env, id);
  const u = new URL(r.redirect_uri);
  return { id: r.id, client_name: r.client_name, client_id: r.client_id, redirect_host: u.host, redirect_scheme: u.protocol.replace(":", ""), expires_at: r.expires_at };
}

/** Approve: pick (or create) the agent, mint a one-time code, return where to send the browser. */
export async function approveConnect(ctx: Ctx, ownerId: string, b: Record<string, unknown>) {
  const { env, origin } = ctx;
  const r = await pendingRequest(env, str(b.request, "request", 64, true)!);
  const now = Date.now();
  const agentId = str(b.agent_id, "agent_id", 64);
  let agent: Agent;
  if (agentId) {
    const row = await env.DB.prepare("SELECT id, owner_id, name FROM agents WHERE id = ? AND owner_id = ? AND status = 'active'")
      .bind(agentId, ownerId).first<Agent>();
    if (!row) throw new HttpError(404, "agent_not_found");
    agent = row;
  } else {
    // A new agent that only this connection (and later ones the owner points at it) can act as.
    const name = (str(b.agent_name, "agent_name", 64) ?? "").trim() || "Claude";
    agent = { id: newId("agt"), owner_id: ownerId, name };
    await env.DB.prepare("INSERT INTO agents (id, owner_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(agent.id, ownerId, name, await sha256Hex(newToken()), now).run();
    await audit(env, agent.id, "enroll", ownerId, { via: "mcp", client_id: r.client_id });
  }
  const code = newToken("mco");
  const res = await env.DB.prepare(
    `UPDATE oauth_requests SET owner_id = ?, agent_id = ?, code_hash = ?, code_expires_at = ?, decided_at = ?
     WHERE id = ? AND decided_at IS NULL`,
  ).bind(ownerId, agent.id, await sha256Hex(code), now + CODE_TTL_MS, now, r.id).run();
  if (!res.meta.changes) throw new HttpError(404, "connect_request_not_found", "This connection request was already decided");
  await audit(env, ownerId, "oauth.approve", agent.id, { client_id: r.client_id, client_name: r.client_name });
  return { ok: true, agent_id: agent.id, agent_name: agent.name, redirect: redirectWith(r.redirect_uri, { code, state: r.state, iss: origin }) };
}

export async function denyConnect(ctx: Ctx, ownerId: string, b: Record<string, unknown>) {
  const { env, origin } = ctx;
  const r = await pendingRequest(env, str(b.request, "request", 64, true)!);
  await env.DB.prepare("UPDATE oauth_requests SET decided_at = ?, owner_id = ? WHERE id = ? AND decided_at IS NULL")
    .bind(Date.now(), ownerId, r.id).run();
  await audit(env, ownerId, "oauth.deny", r.client_id, { client_name: r.client_name });
  return { ok: true, redirect: redirectWith(r.redirect_uri, { error: "access_denied", error_description: "The owner said no", state: r.state, iss: origin }) };
}

/** Live connections for the dashboard. */
export async function listConnections(env: Env, ownerId: string) {
  const { results } = await env.DB.prepare(
    `SELECT g.id, g.client_id, c.name AS client_name, c.redirect_uris, g.agent_id, a.name AS agent_name, a.status AS agent_status,
            g.created_at, g.last_used_at
     FROM oauth_grants g JOIN oauth_clients c ON c.id = g.client_id JOIN agents a ON a.id = g.agent_id
     WHERE g.owner_id = ? AND g.revoked_at IS NULL AND g.refresh_expires_at > ? ORDER BY g.created_at DESC LIMIT 100`,
  ).bind(ownerId, Date.now()).all<Record<string, any>>();
  return {
    connections: results.map(({ redirect_uris, ...g }) => ({
      ...g, redirect_host: (() => { try { return new URL(JSON.parse(redirect_uris)[0]).host; } catch { return null; } })(),
    })),
  };
}

export async function revokeConnection(env: Env, ownerId: string, id: string) {
  const res = await env.DB.prepare("UPDATE oauth_grants SET revoked_at = ? WHERE id = ? AND owner_id = ? AND revoked_at IS NULL")
    .bind(Date.now(), id, ownerId).run();
  if (!res.meta.changes) throw new HttpError(404, "connection_not_found");
  await audit(env, ownerId, "oauth.revoke", id);
  return { ok: true, id, status: "revoked" };
}

// ---------------------------------------------------------------- token

/** Client authentication: HTTP Basic or body credentials; public clients send only client_id. */
async function authClient(req: Request, env: Env, b: Record<string, unknown>): Promise<ClientRow> {
  let id = typeof b.client_id === "string" ? b.client_id : "";
  let secret = typeof b.client_secret === "string" ? b.client_secret : "";
  const basic = /^Basic\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  if (basic) {
    let decoded = "";
    try { decoded = atob(basic[1]); } catch { throw new OAuthError(401, "invalid_client", "Bad Basic credentials"); }
    const i = decoded.indexOf(":");
    if (i < 0) throw new OAuthError(401, "invalid_client", "Bad Basic credentials");
    const decode = (s: string) => { try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch { return s; } };
    id = decode(decoded.slice(0, i));
    secret = decode(decoded.slice(i + 1));
  }
  const client = id ? await getClient(env, id) : null;
  if (!client) throw new OAuthError(401, "invalid_client", "Unknown client");
  if (client.secret_hash) {
    if (!secret || !safeEqual(await sha256Hex(secret), client.secret_hash)) throw new OAuthError(401, "invalid_client", "Wrong client secret");
  }
  return client;
}

const b64url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function issue(env: Env, grantId: string | null, client: string, ownerId: string, agentId: string) {
  const access = newToken("lma");
  const refresh = newToken("lmr");
  const now = Date.now();
  const accessHash = await sha256Hex(access);
  const refreshHash = await sha256Hex(refresh);
  if (grantId) {
    await env.DB.prepare(
      "UPDATE oauth_grants SET access_hash = ?, access_expires_at = ?, refresh_hash = ?, refresh_expires_at = ? WHERE id = ?",
    ).bind(accessHash, now + ACCESS_TTL_S * 1000, refreshHash, now + REFRESH_TTL_MS, grantId).run();
  } else {
    grantId = newId("grt");
    await env.DB.prepare(
      `INSERT INTO oauth_grants (id, client_id, owner_id, agent_id, access_hash, access_expires_at, refresh_hash, refresh_expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(grantId, client, ownerId, agentId, accessHash, now + ACCESS_TTL_S * 1000, refreshHash, now + REFRESH_TTL_MS, now).run();
  }
  return json({ access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: SCOPE }, 200, NO_STORE);
}

async function token(req: Request, ctx: Ctx): Promise<Response> {
  const { env } = ctx;
  await rateLimit(env, `oauth-token:${req.headers.get("cf-connecting-ip") ?? "unknown"}`);
  const b = await readBody(req);
  const client = await authClient(req, env, b);
  const now = Date.now();

  if (b.grant_type === "authorization_code") {
    const code = typeof b.code === "string" ? b.code : "";
    const verifier = typeof b.code_verifier === "string" ? b.code_verifier : "";
    if (!code || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new OAuthError(400, "invalid_request", "code and a valid code_verifier are required");
    const row = await env.DB.prepare(
      `SELECT r.id, r.client_id, r.redirect_uri, r.code_challenge, r.code_expires_at, r.used_at, r.owner_id, r.agent_id
       FROM oauth_requests r WHERE r.code_hash = ?`,
    ).bind(await sha256Hex(code)).first<{
      id: string; client_id: string; redirect_uri: string; code_challenge: string; code_expires_at: number; used_at: number | null;
      owner_id: string; agent_id: string;
    }>();
    const bad = () => new OAuthError(400, "invalid_grant", "The code is unknown, used, expired or for another client");
    if (!row || row.client_id !== client.id || row.used_at || row.code_expires_at < now) throw bad();
    if (typeof b.redirect_uri === "string" && b.redirect_uri !== row.redirect_uri) throw new OAuthError(400, "invalid_grant", "redirect_uri doesn't match");
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    if (!safeEqual(challenge, row.code_challenge)) throw new OAuthError(400, "invalid_grant", "PKCE verification failed");
    const claimed = await env.DB.prepare("UPDATE oauth_requests SET used_at = ? WHERE id = ? AND used_at IS NULL").bind(now, row.id).run();
    if (!claimed.meta.changes) throw bad();
    const agent = await env.DB.prepare("SELECT 1 AS ok FROM agents WHERE id = ? AND status = 'active'").bind(row.agent_id).first();
    if (!agent) throw new OAuthError(400, "invalid_grant", "The agent was revoked");
    await audit(env, row.agent_id, "oauth.connect", client.id);
    return issue(env, null, client.id, row.owner_id, row.agent_id);
  }

  if (b.grant_type === "refresh_token") {
    const refresh = typeof b.refresh_token === "string" ? b.refresh_token : "";
    const g = refresh ? await env.DB.prepare(
      `SELECT g.id, g.owner_id, g.agent_id, g.refresh_hash FROM oauth_grants g JOIN agents a ON a.id = g.agent_id
       WHERE g.refresh_hash = ? AND g.client_id = ? AND g.revoked_at IS NULL AND g.refresh_expires_at > ? AND a.status = 'active'`,
    ).bind(await sha256Hex(refresh), client.id, now).first<{ id: string; owner_id: string; agent_id: string; refresh_hash: string }>() : null;
    if (!g) throw new OAuthError(400, "invalid_grant", "The refresh token is unknown, used, expired or revoked");
    // Rotate: only the first use of a refresh token wins.
    const claimed = await env.DB.prepare("UPDATE oauth_grants SET refresh_hash = ? WHERE id = ? AND refresh_hash = ?")
      .bind(`used:${randomString(24)}`, g.id, g.refresh_hash).run();
    if (!claimed.meta.changes) throw new OAuthError(400, "invalid_grant", "The refresh token was already used");
    return issue(env, g.id, client.id, g.owner_id, g.agent_id);
  }

  throw new OAuthError(400, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
}

/** RFC 7009: always 200, whether or not the token was known. */
async function revoke(req: Request, ctx: Ctx): Promise<Response> {
  const { env } = ctx;
  const b = await readBody(req);
  const client = await authClient(req, env, b);
  const t = typeof b.token === "string" ? b.token : "";
  if (t) {
    const hash = await sha256Hex(t);
    const res = await env.DB.prepare(
      "UPDATE oauth_grants SET revoked_at = ? WHERE client_id = ? AND revoked_at IS NULL AND (access_hash = ? OR refresh_hash = ?)",
    ).bind(Date.now(), client.id, hash, hash).run();
    if (res.meta.changes) await audit(env, "oauth", "oauth.revoke", client.id);
  }
  return new Response(null, { status: 200, headers: NO_STORE });
}

// ---------------------------------------------------------------- /mcp auth

/** 401 that tells MCP clients where to start OAuth (RFC 9728 §5.1). */
export function mcpUnauthorized(origin: string, description: string, hadToken: boolean): Response {
  const challenge = `Bearer resource_metadata="${resourceMetadataUrl(origin)}", scope="${SCOPE}"` + (hadToken ? ', error="invalid_token"' : "");
  return json({ error: hadToken ? "invalid_token" : "unauthorized", error_description: description }, 401, { ...CORS, "www-authenticate": challenge });
}

/**
 * The agent behind an MCP request: an OAuth access token from a connection,
 * or (for clients that take a static header, like Claude Code) the agent's
 * own lch_ token.
 */
export async function authMcp(req: Request, ctx: Ctx): Promise<Agent | Response> {
  const { env, origin } = ctx;
  const t = bearer(req);
  if (!t) return mcpUnauthorized(origin, "Sign in to connect", false);
  if (t.startsWith("lch_")) {
    try { return await authAgent(req, env); } catch (err) {
      if (err instanceof HttpError && err.status === 401) return mcpUnauthorized(origin, err.message, true);
      throw err;
    }
  }
  const hash = await sha256Hex(t);
  await rateLimit(env, `tok:${hash}`);
  const now = Date.now();
  const row = await env.DB.prepare(
    `SELECT g.id AS grant_id, g.last_used_at, a.id, a.owner_id, a.name, a.last_seen_at
     FROM oauth_grants g JOIN agents a ON a.id = g.agent_id
     WHERE g.access_hash = ? AND g.revoked_at IS NULL AND g.access_expires_at > ? AND a.status = 'active'`,
  ).bind(hash, now).first<Agent & { grant_id: string; last_used_at: number | null; last_seen_at: number | null }>();
  if (!row) return mcpUnauthorized(origin, "The access token is unknown, expired or revoked", true);
  // "Last seen" (profiles) and "last used" (dashboard), at most once a minute.
  if (!row.last_used_at || now - row.last_used_at > 60_000) {
    await env.DB.batch([
      env.DB.prepare("UPDATE oauth_grants SET last_used_at = ? WHERE id = ?").bind(now, row.grant_id),
      env.DB.prepare("UPDATE agents SET last_seen_at = ? WHERE id = ?").bind(now, row.id),
    ]);
  }
  return { id: row.id, owner_id: row.owner_id, name: row.name };
}
