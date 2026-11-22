// Lichen — agent-to-agent messaging on Cloudflare's free plan.
// Phase 1: enroll, rooms, send, react, inbox, history, ack.
// Phase 2: /ws live notices (one AgentSocket DO per agent, hibernating sockets).
//
// Every response is JSON data. Nothing the server returns is meant to be executed.

import { Room, type Envelope, type Fanout, type MessageMeta, type StoredMessage } from "./room";
import { AgentSocket } from "./agent";
import { VERSION, tierFor, type Env, type TrustTier } from "./env";
import {
  HttpError, json, errorResponse, newId, newToken, randomString, sha256Hex, safeEqual,
  readBody, str, bool, encodeCursor, decodeCursor, parseMessageId, type Cursor,
} from "./util";

export { Room, AgentSocket };
export type { Env };

interface Agent {
  id: string;
  owner_id: string;
  name: string;
}

const REACTIONS = new Set(["👍", "✅", "👀", "❌", "🎉"]);
const ENROLL_CODE_TTL_S = 24 * 60 * 60;
const PAGE_LIMIT = 50;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await route(req, env);
    } catch (err) {
      return errorResponse(err);
    }
  },
} satisfies ExportedHandler<Env>;

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname.replace(/\/+$/, "") || "/";
  const m = req.method;

  if (p === "/" && m === "GET") return json({ service: "lichen", version: VERSION });
  if (p === "/enroll" && m === "POST") return enroll(req, env);

  if (p.startsWith("/admin/")) {
    requireAdmin(req, env);
    return admin(req, env, p, m);
  }

  const agent = await authAgent(req, env);
  if (p === "/rooms" && m === "GET") return listRooms(env, agent);
  if (p === "/send" && m === "POST") return send(req, env, agent);
  if (p === "/react" && m === "POST") return react(req, env, agent);
  if (p === "/inbox" && m === "GET") return inbox(url, env, agent);
  if (p === "/history" && m === "GET") return history(url, env, agent);
  if (p === "/ack" && m === "POST") return ack(req, env, agent);
  if (p === "/ws" && m === "GET") return connect(req, env, agent);
  if (p === "/me" && m === "GET") return json({ agent_id: agent.id, owner_id: agent.owner_id, name: agent.name });

  throw new HttpError(404, "not_found");
}

// ---------------------------------------------------------------- auth

function bearer(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1] : null;
}

async function rateLimit(env: Env, key: string): Promise<void> {
  if (!env.RATE_LIMITER) return;
  const { success } = await env.RATE_LIMITER.limit({ key });
  if (!success) throw new HttpError(429, "rate_limited", "Too many requests; slow down");
}

async function authAgent(req: Request, env: Env): Promise<Agent> {
  const token = bearer(req);
  if (!token) throw new HttpError(401, "unauthorized", "Missing bearer token");
  const hash = await sha256Hex(token);
  // Rate-limit by token hash before touching D1, so a bad token is cheap too.
  await rateLimit(env, `tok:${hash}`);
  const agent = await env.DB.prepare(
    "SELECT id, owner_id, name FROM agents WHERE token_hash = ? AND status = 'active'",
  ).bind(hash).first<Agent>();
  if (!agent) throw new HttpError(401, "unauthorized", "Unknown or revoked token");
  return agent;
}

/** Phase-1 stand-in for Cloudflare Access: a single admin bearer token. */
function requireAdmin(req: Request, env: Env): void {
  const token = bearer(req);
  if (!env.ADMIN_TOKEN || !token || !safeEqual(token, env.ADMIN_TOKEN)) {
    throw new HttpError(401, "unauthorized", "Admin token required");
  }
}

async function audit(env: Env, actor: string, action: string, target: string | null, detail?: object) {
  await env.DB.prepare("INSERT INTO audit (ts, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)")
    .bind(Date.now(), actor, action, target, detail ? JSON.stringify(detail) : null).run();
}

// ---------------------------------------------------------------- enroll

async function enroll(req: Request, env: Env): Promise<Response> {
  await rateLimit(env, `enroll:${req.headers.get("cf-connecting-ip") ?? "unknown"}`);
  const body = await readBody(req);
  const code = str(body.code, "code", 64, true)!.trim().toLowerCase();
  const codeHash = await sha256Hex(code);
  const now = Date.now();

  const row = await env.DB.prepare(
    "SELECT owner_id, agent_name, expires_at, used_at FROM enroll_codes WHERE code_hash = ?",
  ).bind(codeHash).first<{ owner_id: string; agent_name: string; expires_at: number; used_at: number | null }>();
  if (!row || row.used_at || row.expires_at < now) throw new HttpError(401, "invalid_code", "Code is unknown, used or expired");

  const agentId = newId("agt");
  const token = newToken();
  // Claim the code atomically: only one enroll can flip used_at from NULL.
  const results = await env.DB.batch([
    env.DB.prepare("UPDATE enroll_codes SET used_at = ?, agent_id = ? WHERE code_hash = ? AND used_at IS NULL")
      .bind(now, agentId, codeHash),
    env.DB.prepare(
      `INSERT INTO agents (id, owner_id, name, token_hash, created_at)
       SELECT ?, ?, ?, ?, ? WHERE changes() = 1`,
    ).bind(agentId, row.owner_id, row.agent_name, await sha256Hex(token), now),
  ]);
  if (results[1].meta.changes !== 1) throw new HttpError(401, "invalid_code", "Code is unknown, used or expired");

  await audit(env, agentId, "enroll", row.owner_id);
  const base = new URL(req.url).origin;
  return json({ agent_id: agentId, owner_id: row.owner_id, name: row.agent_name, token, base_url: base }, 201);
}

// ---------------------------------------------------------------- rooms

interface MembershipRow { room_id: string; name: string; kind: string; role: string; last_read_seq: number }

async function memberships(env: Env, agentId: string): Promise<MembershipRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT m.room_id, r.name, r.kind, m.role, m.last_read_seq
     FROM memberships m JOIN rooms r ON r.id = m.room_id WHERE m.agent_id = ? ORDER BY r.created_at`,
  ).bind(agentId).all<MembershipRow>();
  return results;
}

async function membership(env: Env, agentId: string, roomId: string): Promise<MembershipRow> {
  const row = await env.DB.prepare(
    `SELECT m.room_id, r.name, r.kind, m.role, m.last_read_seq
     FROM memberships m JOIN rooms r ON r.id = m.room_id WHERE m.agent_id = ? AND m.room_id = ?`,
  ).bind(agentId, roomId).first<MembershipRow>();
  // Same answer for "no such room" and "not a member", so room ids can't be probed.
  if (!row) throw new HttpError(404, "room_not_found");
  return row;
}

async function listRooms(env: Env, agent: Agent): Promise<Response> {
  const rows = await memberships(env, agent.id);
  return json({
    rooms: rows.map((r) => ({ id: r.room_id, name: r.name, kind: r.kind, role: r.role, last_read_seq: r.last_read_seq })),
  });
}

const room = (env: Env, roomId: string) => env.ROOM.get(env.ROOM.idFromName(roomId));
const agentHub = (env: Env, agentId: string) => env.AGENT.get(env.AGENT.idFromName(agentId));

interface MemberRow { agent_id: string; owner_id: string; role: string }

/**
 * The caller's membership plus everyone else who should get a live notice,
 * in one D1 query. Same 404 for "no such room" and "not a member".
 */
async function postingMembership(env: Env, agent: Agent, roomId: string): Promise<Fanout> {
  const { results } = await env.DB.prepare(
    `SELECT m.agent_id, a.owner_id, m.role FROM memberships m JOIN agents a ON a.id = m.agent_id
     WHERE m.room_id = ? AND a.status = 'active'`,
  ).bind(roomId).all<MemberRow>();
  const me = results.find((r) => r.agent_id === agent.id);
  if (!me) throw new HttpError(404, "room_not_found");
  if (me.role !== "post") throw new HttpError(403, "read_only", "This agent can only read this room");
  return {
    roomId,
    recipients: results.filter((r) => r.agent_id !== agent.id).map(({ agent_id, owner_id }) => ({ agent_id, owner_id })),
  };
}

// ---------------------------------------------------------------- send / react

/** Only these metadata keys are kept. Trust fields from clients are dropped. */
function cleanMeta(b: Record<string, unknown>): MessageMeta {
  const origin = str(b.origin, "origin", 16);
  if (origin !== undefined && origin !== "external") throw new HttpError(400, "invalid_field", "origin may only be 'external'");
  const meta: MessageMeta = {
    intent: str(b.intent, "intent", 64),
    repo: str(b.repo, "repo", 200),
    thread_id: str(b.thread_id, "thread_id", 128),
    reply_requested: bool(b.reply_requested, "reply_requested", true),
    origin: origin as "external" | undefined,
  };
  for (const k of Object.keys(meta) as (keyof MessageMeta)[]) if (meta[k] === undefined) delete meta[k];
  return meta;
}

async function send(req: Request, env: Env, agent: Agent): Promise<Response> {
  const b = await readBody(req);
  const roomId = str(b.room, "room", 64, true)!;
  const text = str(b.body, "body", 1_000_000, true)!;
  const maxBytes = Number(env.MAX_BODY_BYTES ?? 16384);
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new HttpError(413, "body_too_large", `body must be at most ${maxBytes} bytes`);
  }
  // Allow metadata either flat or nested under "meta".
  const meta = cleanMeta(b.meta && typeof b.meta === "object" ? { ...(b.meta as object) } as Record<string, unknown> : b);

  const fanout = await postingMembership(env, agent, roomId);

  const envelope: Envelope = { sender_id: agent.id, sender_owner_id: agent.owner_id };
  const res = await room(env, roomId).sendMessage(envelope, text, meta, {
    turnCap: Number(env.TURN_CAP ?? 10),
    cooldownMs: Number(env.COOLDOWN_MS ?? 2000),
  }, fanout);
  if (!res.ok) {
    if (res.error === "thread_paused") {
      throw new HttpError(409, "thread_paused", "Turn cap reached; an owner must resume this thread");
    }
    const retry = Math.ceil((res.retry_after_ms ?? 1000) / 1000);
    return json({ error: "cooldown", retry_after_ms: res.retry_after_ms }, 429, { "retry-after": String(retry) });
  }

  const id = `${roomId}:${res.seq}`;
  await audit(env, agent.id, "send", id, { thread_id: meta.thread_id ?? null, bytes: text.length });
  return json({ id, room: roomId, seq: res.seq, created_at: res.created_at, thread_paused: res.paused ?? false }, 201);
}

async function react(req: Request, env: Env, agent: Agent): Promise<Response> {
  const b = await readBody(req);
  const { roomId, seq } = parseMessageId(str(b.message_id, "message_id", 100, true)!);
  const emoji = str(b.emoji, "emoji", 16, true)!;
  if (!REACTIONS.has(emoji)) throw new HttpError(400, "invalid_emoji", `emoji must be one of ${[...REACTIONS].join(" ")}`);

  const fanout = await postingMembership(env, agent, roomId);

  const res = await room(env, roomId).react({ sender_id: agent.id, sender_owner_id: agent.owner_id }, seq, emoji, fanout);
  if (!res.ok) throw new HttpError(404, "message_not_found");
  const id = `${roomId}:${res.seq}`;
  await audit(env, agent.id, "react", id, { target: `${roomId}:${seq}`, emoji });
  return json({ id, room: roomId, seq: res.seq, no_turn: true }, 201);
}

// ---------------------------------------------------------------- live notices

/**
 * GET /ws (WebSocket upgrade). The token is checked here, then the upgrade is
 * handed to this agent's AgentSocket DO. The socket only ever carries notices
 * ({id, room, from, trust_tier}, plus no_turn for reactions); bodies are read
 * from /inbox.
 */
async function connect(req: Request, env: Env, agent: Agent): Promise<Response> {
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    throw new HttpError(426, "upgrade_required", "Connect with a WebSocket client");
  }
  const headers = new Headers(req.headers);
  headers.delete("authorization"); // the DO doesn't need the token
  return agentHub(env, agent.id).fetch(new Request("https://agent.internal/ws", { headers }));
}

// ---------------------------------------------------------------- read

function tier(viewer: Agent, senderOwner: string): TrustTier {
  return tierFor(viewer.owner_id, senderOwner);
}

/** Shape a stored message for a particular viewer. The envelope is the server's word. */
function present(viewer: Agent, roomId: string, m: StoredMessage) {
  const envelope = { sender_id: m.sender_id, sender_owner_id: m.sender_owner_id, trust_tier: tier(viewer, m.sender_owner_id) };
  const base = { id: `${roomId}:${m.seq}`, room: roomId, seq: m.seq, kind: m.kind, envelope, created_at: m.created_at };
  if (m.kind === "reaction") {
    return { ...base, emoji: m.emoji, target_id: `${roomId}:${m.target_seq}`, no_turn: true };
  }
  return { ...base, body: m.body, meta: m.meta, no_turn: false };
}

async function inbox(url: URL, env: Env, agent: Agent): Promise<Response> {
  const since = decodeCursor(url.searchParams.get("since"));
  const rows = await memberships(env, agent.id);
  const next: Cursor = {};
  let more = false;

  const perRoom = await Promise.all(rows.map(async (r) => {
    const after = Math.max(r.last_read_seq, since[r.room_id] ?? 0);
    // Fetch one extra to know if there's more.
    const msgs = await room(env, r.room_id).list({ afterSeq: after, excludeSender: agent.id, limit: PAGE_LIMIT + 1 });
    if (msgs.length > PAGE_LIMIT) { more = true; msgs.length = PAGE_LIMIT; }
    // Advance the cursor to the last message seen (own messages are skipped, not lost).
    next[r.room_id] = msgs.length ? msgs[msgs.length - 1].seq : after;
    return msgs.map((m) => present(agent, r.room_id, m));
  }));

  const messages = perRoom.flat().sort((a, b) => a.created_at - b.created_at);
  return json({ messages, cursor: encodeCursor(next), more, approvals: [] });
}

async function history(url: URL, env: Env, agent: Agent): Promise<Response> {
  const roomId = url.searchParams.get("room");
  if (!roomId) throw new HttpError(400, "missing_field", "room is required");
  await membership(env, agent.id, roomId);

  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? PAGE_LIMIT) || PAGE_LIMIT, 1), 100);
  const before = url.searchParams.get("before");
  const after = url.searchParams.get("after");
  const thread = url.searchParams.get("thread_id");

  const msgs = await room(env, roomId).list({
    afterSeq: after ? Number(after) : undefined,
    beforeSeq: before ? Number(before) : after ? undefined : Number.MAX_SAFE_INTEGER,
    threadId: thread ?? undefined,
    limit,
  });
  return json({ room: roomId, messages: msgs.map((m) => present(agent, roomId, m)) });
}

async function ack(req: Request, env: Env, agent: Agent): Promise<Response> {
  const b = await readBody(req);
  const marks: Cursor = {};
  if (typeof b.id === "string") {
    const { roomId, seq } = parseMessageId(b.id);
    marks[roomId] = seq;
  } else if (typeof b.cursor === "string") {
    Object.assign(marks, decodeCursor(b.cursor));
  } else {
    throw new HttpError(400, "missing_field", "id or cursor is required");
  }

  // Only ever move forward; silently ignore rooms the agent isn't in.
  const stmts = Object.entries(marks).map(([roomId, seq]) =>
    env.DB.prepare(
      "UPDATE memberships SET last_read_seq = MAX(last_read_seq, ?) WHERE agent_id = ? AND room_id = ?",
    ).bind(seq, agent.id, roomId));
  const res = stmts.length ? await env.DB.batch(stmts) : [];
  const updated = res.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
  return json({ ok: true, rooms: updated });
}

// ---------------------------------------------------------------- admin (stub for Access)

async function admin(req: Request, env: Env, p: string, m: string): Promise<Response> {
  const now = Date.now();

  if (p === "/admin/enroll-codes" && m === "POST") {
    const b = await readBody(req);
    const ownerId = str(b.owner_id, "owner_id", 100, true)!;
    if (!/^github:[A-Za-z0-9-]{1,39}$/.test(ownerId)) throw new HttpError(400, "invalid_owner", "owner_id must look like github:<username>");
    const agentName = str(b.agent_name, "agent_name", 64, true)!;
    const ttl = Math.min(Number(b.ttl_seconds ?? ENROLL_CODE_TTL_S) || ENROLL_CODE_TTL_S, 7 * 24 * 3600);
    const code = randomString(12);
    const expires = now + ttl * 1000;
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO owners (id, created_at) VALUES (?, ?)").bind(ownerId.toLowerCase(), now),
      env.DB.prepare("INSERT INTO enroll_codes (code_hash, owner_id, agent_name, expires_at) VALUES (?, ?, ?, ?)")
        .bind(await sha256Hex(code), ownerId.toLowerCase(), agentName, expires),
    ]);
    await audit(env, "admin", "enroll_code.create", ownerId.toLowerCase(), { agent_name: agentName });
    return json({ code, owner_id: ownerId.toLowerCase(), agent_name: agentName, expires_at: expires }, 201);
  }

  if (p === "/admin/rooms" && m === "POST") {
    const b = await readBody(req);
    const name = str(b.name, "name", 100, true)!;
    const kind = (str(b.kind, "kind", 8) ?? "room") as "room" | "dm";
    if (kind !== "room" && kind !== "dm") throw new HttpError(400, "invalid_field", "kind must be room or dm");
    const createdBy = str(b.created_by, "created_by", 100) ?? "admin";
    const members = Array.isArray(b.members) ? b.members.filter((x): x is string => typeof x === "string") : [];
    if (members.length > 50) throw new HttpError(400, "too_many_members");
    const roomId = newId("r");
    await env.DB.batch([
      env.DB.prepare("INSERT INTO rooms (id, name, kind, created_by, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(roomId, name, kind, createdBy, now),
      ...members.map((a) => env.DB.prepare(
        "INSERT INTO memberships (room_id, agent_id, role, joined_at) SELECT ?, id, 'post', ? FROM agents WHERE id = ?",
      ).bind(roomId, now, a)),
    ]);
    await audit(env, "admin", "room.create", roomId, { name, kind, members });
    return json({ id: roomId, name, kind, members }, 201);
  }

  let mm = /^\/admin\/rooms\/(r_[a-z0-9]+)\/members$/.exec(p);
  if (mm && m === "POST") {
    const b = await readBody(req);
    const agentId = str(b.agent_id, "agent_id", 64, true)!;
    const role = str(b.role, "role", 8) ?? "post";
    if (role !== "post" && role !== "read") throw new HttpError(400, "invalid_field", "role must be post or read");
    const res = await env.DB.prepare(
      `INSERT INTO memberships (room_id, agent_id, role, joined_at)
       SELECT r.id, a.id, ?, ? FROM rooms r, agents a WHERE r.id = ? AND a.id = ?
       ON CONFLICT(room_id, agent_id) DO UPDATE SET role = excluded.role`,
    ).bind(role, now, mm[1], agentId).run();
    if (!res.meta.changes) throw new HttpError(404, "not_found", "Room or agent not found");
    await audit(env, "admin", "membership.add", mm[1], { agent_id: agentId, role });
    return json({ ok: true, room: mm[1], agent_id: agentId, role });
  }

  mm = /^\/admin\/rooms\/(r_[a-z0-9]+)\/resume$/.exec(p);
  if (mm && m === "POST") {
    const b = await readBody(req);
    const thread = str(b.thread_id, "thread_id", 128) ?? "";
    await room(env, mm[1]).resume(thread);
    await audit(env, "admin", "thread.resume", mm[1], { thread_id: thread });
    return json({ ok: true, room: mm[1], thread_id: thread });
  }

  mm = /^\/admin\/agents\/(agt_[a-z0-9]+)\/revoke$/.exec(p);
  if (mm && m === "POST") {
    const res = await env.DB.prepare("UPDATE agents SET status = 'revoked' WHERE id = ?").bind(mm[1]).run();
    if (!res.meta.changes) throw new HttpError(404, "not_found");
    await agentHub(env, mm[1]).closeAll();
    await audit(env, "admin", "agent.revoke", mm[1]);
    return json({ ok: true, agent_id: mm[1], status: "revoked" });
  }

  throw new HttpError(404, "not_found");
}
