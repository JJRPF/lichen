// Shared pieces of the Worker: auth, membership, sending, owner notices.

import type { Envelope, Fanout, MessageMeta, StoredMessage } from "./room";
import { attentionFor, ownerHubName, tierFor, type Env, type LiveEvent, type TrustTier } from "./env";
import { HttpError, parseMessageId, randomString, safeEqual, sha256Hex, str, bool } from "./util";
import { agentPrompt } from "./guide";
import { checkWebhook } from "./webhooks";

const ENROLL_CODE_TTL_S = 24 * 60 * 60;

/** Per-request context. */
export interface Ctx {
  env: Env;
  origin: string;
  waitUntil(p: Promise<unknown>): void;
}

export interface Agent {
  id: string;
  owner_id: string;
  name: string;
}

export const REACTIONS = new Set(["👍", "✅", "👀", "❌", "🎉"]);
export const PAGE_LIMIT = 50;

// ---------------------------------------------------------------- auth

export function bearer(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1] : null;
}

export async function rateLimit(env: Env, key: string): Promise<void> {
  if (!env.RATE_LIMITER) return;
  const { success } = await env.RATE_LIMITER.limit({ key });
  if (!success) throw new HttpError(429, "rate_limited", "Too many requests; slow down");
}

export async function authAgent(req: Request, env: Env): Promise<Agent> {
  const token = bearer(req);
  if (!token) throw new HttpError(401, "unauthorized", "Missing bearer token");
  const hash = await sha256Hex(token);
  // Rate-limit by token hash before touching D1, so a bad token is cheap too.
  await rateLimit(env, `tok:${hash}`);
  const row = await env.DB.prepare(
    "SELECT id, owner_id, name, last_seen_at FROM agents WHERE token_hash = ? AND status = 'active'",
  ).bind(hash).first<Agent & { last_seen_at: number | null }>();
  if (!row) throw new HttpError(401, "unauthorized", "Unknown or revoked token");
  // "Last seen" for profiles, written at most once a minute.
  const now = Date.now();
  if (!row.last_seen_at || now - row.last_seen_at > 60_000) {
    await env.DB.prepare("UPDATE agents SET last_seen_at = ? WHERE id = ?").bind(now, row.id).run();
  }
  return { id: row.id, owner_id: row.owner_id, name: row.name };
}

export function isAdmin(req: Request, env: Env): boolean {
  const token = bearer(req);
  return Boolean(env.ADMIN_TOKEN && token && safeEqual(token, env.ADMIN_TOKEN));
}

/** Operator token (stand-in for an operator role; owners use Cloudflare Access). */
export function requireAdmin(req: Request, env: Env): void {
  if (!isAdmin(req, env)) throw new HttpError(401, "unauthorized", "Admin token required");
}

export async function audit(env: Env, actor: string, action: string, target: string | null, detail?: object) {
  await env.DB.prepare("INSERT INTO audit (ts, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)")
    .bind(Date.now(), actor, action, target, detail ? JSON.stringify(detail) : null).run();
}

// ---------------------------------------------------------------- rooms

export const room = (env: Env, roomId: string) => env.ROOM.get(env.ROOM.idFromName(roomId));
export const agentHub = (env: Env, agentId: string) => env.AGENT.get(env.AGENT.idFromName(agentId));
export const ownerHub = (env: Env, ownerId: string) => env.AGENT.get(env.AGENT.idFromName(ownerHubName(ownerId)));

export interface MembershipRow {
  room_id: string; name: string; kind: string; role: string; can_manage: number; last_read_seq: number;
  human_owner: string | null; archived_at: number | null; join_policy: string; members: number;
}

const MEMBERSHIP_COLS = `m.room_id, r.name, r.kind, m.role, m.can_manage, m.last_read_seq, r.human_owner, r.archived_at, r.join_policy,
  (SELECT COUNT(*) FROM memberships x JOIN agents ax ON ax.id = x.agent_id WHERE x.room_id = m.room_id AND ax.status = 'active') AS members`;

/** Every message in a DM, a human↔agent DM, or a two-member room is "direct". */
export const isDirect = (r: { kind: string; human_owner: string | null; members: number }) =>
  r.kind === "dm" || !!r.human_owner || r.members <= 2;

export async function memberships(env: Env, agentId: string, includeArchived = false): Promise<MembershipRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT ${MEMBERSHIP_COLS} FROM memberships m JOIN rooms r ON r.id = m.room_id
     WHERE m.agent_id = ? ${includeArchived ? "" : "AND r.archived_at IS NULL"} ORDER BY r.created_at`,
  ).bind(agentId).all<MembershipRow>();
  return results;
}

export async function membership(env: Env, agentId: string, roomId: string): Promise<MembershipRow> {
  const row = await env.DB.prepare(
    `SELECT ${MEMBERSHIP_COLS} FROM memberships m JOIN rooms r ON r.id = m.room_id WHERE m.agent_id = ? AND m.room_id = ?`,
  ).bind(agentId, roomId).first<MembershipRow>();
  // Same answer for "no such room" and "not a member", so room ids can't be probed.
  if (!row) throw new HttpError(404, "room_not_found");
  return row;
}

export interface MemberRow {
  agent_id: string; owner_id: string; name: string; role: string; can_manage: number;
  kind: string; human_owner: string | null; archived_at: number | null; auto_pause: number;
}

/** Active members of a room, with the room's kind (one D1 query). */
export async function roomMembers(env: Env, roomId: string): Promise<MemberRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT m.agent_id, a.owner_id, a.name, m.role, m.can_manage, r.kind, r.human_owner, r.archived_at, r.auto_pause
     FROM memberships m JOIN agents a ON a.id = m.agent_id JOIN rooms r ON r.id = m.room_id
     WHERE m.room_id = ? AND a.status = 'active'`,
  ).bind(roomId).all<MemberRow>();
  return results;
}

/** Fan-out targets for a room, minus the sender. Members are kept for @mention lookup. */
export type RoomFanout = Fanout & { members: MemberRow[]; autoPause?: boolean };

function fanoutFor(roomId: string, rows: MemberRow[], senderId: string | null): RoomFanout {
  const first = rows[0];
  return {
    roomId,
    recipients: rows.filter((r) => r.agent_id !== senderId).map(({ agent_id, owner_id }) => ({ agent_id, owner_id })),
    owners: [...new Set(rows.map((r) => r.owner_id))],
    direct: !!first && isDirect({ kind: first.kind, human_owner: first.human_owner, members: rows.length }),
    autoPause: first ? first.auto_pause !== 0 : true,
    members: rows,
  };
}

/**
 * Everyone who should hear about a new message in a room, in one D1 query,
 * plus the sender's own row. Same 404 for "no such room" and "not a member".
 */
export async function postingMembership(env: Env, sender: Agent, roomId: string): Promise<RoomFanout> {
  const rows = await roomMembers(env, roomId);
  const me = rows.find((r) => r.agent_id === sender.id);
  if (!me) throw new HttpError(404, "room_not_found");
  if (me.archived_at) throw new HttpError(409, "room_archived", "This room is archived");
  if (me.role !== "post") throw new HttpError(403, "read_only", "This agent can only read this room");
  return fanoutFor(roomId, rows, sender.id);
}

/** URL-ish handle for @mentions: lowercase, spaces → "-". "Kernel Bot" → "kernel-bot". */
export const mentionHandle = (name: string) => name.trim().toLowerCase().replace(/\s+/g, "-");

/**
 * Server-side metadata: resolve @mentions (from the text and an optional
 * `mentions` list of names/ids) against the room's members, and check
 * `reply_to`. Unknown names are ignored; nobody outside the room can be mentioned.
 */
export async function prepareMeta(
  env: Env, fanout: RoomFanout, senderId: string, text: string, b: Record<string, unknown>, meta: MessageMeta,
): Promise<MessageMeta> {
  const byHandle = new Map<string, string>();
  for (const m of fanout.members) {
    byHandle.set(m.agent_id.toLowerCase(), m.agent_id);
    byHandle.set(mentionHandle(m.name), m.agent_id);
  }
  const wanted = new Set<string>();
  let everyone = false;
  for (const match of text.matchAll(/(^|[^\w@])@([A-Za-z0-9][\w.-]{0,63})/g)) {
    const h = match[2].toLowerCase().replace(/[.-]+$/, "");
    if (h === "everyone" || h === "here") everyone = true;
    else wanted.add(h);
  }
  if (Array.isArray(b.mentions)) for (const x of b.mentions.slice(0, 50)) if (typeof x === "string") wanted.add(mentionHandle(x));
  const ids = [...new Set([...wanted].map((h) => byHandle.get(h)).filter((x): x is string => !!x && x !== senderId))];
  if (ids.length) meta.mentions = ids;
  if (everyone) meta.everyone = true;

  const replyTo = str(b.reply_to, "reply_to", 100);
  if (replyTo) {
    const { roomId, seq } = parseMessageId(replyTo);
    if (roomId !== fanout.roomId) throw new HttpError(400, "invalid_field", "reply_to must be a message in the same room");
    const target = await room(env, roomId).getMessage(seq);
    if (!target || target.kind !== "message") throw new HttpError(404, "reply_target_not_found");
    meta.reply_to = replyTo;
    meta.reply_to_sender = target.sender_id;
  }
  return meta;
}

/** Only these metadata keys are kept. Trust fields from clients are dropped. */
export function cleanMeta(b: Record<string, unknown>): MessageMeta {
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

export function checkBodySize(env: Env, text: string) {
  const maxBytes = Number(env.MAX_BODY_BYTES ?? 16384);
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new HttpError(413, "body_too_large", `body must be at most ${maxBytes} bytes`);
  }
}

export interface Sent { id: string; room: string; seq: number; created_at: number; thread_paused: boolean }

/** Append a message as `sender` and notify the room. Membership must already be checked (fanout). */
export async function sendInto(ctx: Ctx, sender: Agent, fanout: RoomFanout | Fanout, text: string, meta: MessageMeta, kind: "message" | "poll" = "message"): Promise<Sent> {
  const { env } = ctx;
  const envelope: Envelope = { sender_id: sender.id, sender_owner_id: sender.owner_id };
  const autoPause = "autoPause" in fanout ? fanout.autoPause !== false : true;
  const res = await room(env, fanout.roomId).sendMessage(envelope, text, meta, {
    turnCap: autoPause ? Number(env.TURN_CAP ?? 10) : 0,
    cooldownMs: Number(env.COOLDOWN_MS ?? 2000),
  }, stripMembers(fanout), kind);
  if (!res.ok) {
    if (res.error === "thread_paused") {
      throw new HttpError(409, "thread_paused", "Turn cap reached; an owner must resume this thread");
    }
    const err = new HttpError(429, "cooldown", "Wait before posting again in this thread") as HttpError & { retryAfterMs?: number };
    err.retryAfterMs = res.retry_after_ms;
    throw err;
  }
  const id = `${fanout.roomId}:${res.seq}`;
  await audit(env, sender.id, "send", id, { thread_id: meta.thread_id ?? null, bytes: text.length });
  if (res.paused) {
    // Turn cap reached: tell every owner in the room, on the dashboard.
    for (const o of fanout.owners ?? [sender.owner_id]) {
      await ownerNotice(ctx, o, "thread_paused", fanout.roomId, { thread_id: meta.thread_id ?? "" });
    }
  }
  return { id, room: fanout.roomId, seq: res.seq, created_at: res.created_at, thread_paused: res.paused ?? false };
}

/**
 * An owner posts into a room from the dashboard, as a human. The owner must
 * have at least one active agent in the room. Every agent member is notified,
 * and the thread's turn-cap streak resets.
 */
export async function ownerFanout(env: Env, ownerId: string, roomId: string): Promise<RoomFanout> {
  const rows = await roomMembers(env, roomId);
  if (rows.length) {
    if (!rows.some((r) => r.owner_id === ownerId)) {
      const created = await env.DB.prepare("SELECT archived_at FROM rooms WHERE id = ? AND created_by = ?").bind(roomId, ownerId).first<{ archived_at: number | null }>();
      if (!created) throw new HttpError(404, "room_not_found");
      if (created.archived_at) throw new HttpError(409, "room_archived", "This room is archived");
    } else if (rows[0].archived_at) {
      throw new HttpError(409, "room_archived", "This room is archived");
    }
    return fanoutFor(roomId, rows, null);
  }
  const r = await env.DB.prepare("SELECT kind, human_owner, archived_at FROM rooms WHERE id = ? AND created_by = ?")
    .bind(roomId, ownerId).first<{ kind: string; human_owner: string | null; archived_at: number | null }>();
  if (!r) throw new HttpError(404, "room_not_found");
  if (r.archived_at) throw new HttpError(409, "room_archived", "This room is archived");
  return { roomId, recipients: [], owners: [ownerId], direct: isDirect({ kind: r.kind, human_owner: r.human_owner, members: 0 }), members: [] };
}

/** The room DO only needs who to notify, not member names. */
const stripMembers = (f: Fanout): Fanout => ({ roomId: f.roomId, recipients: f.recipients, owners: f.owners, direct: f.direct });

export async function sendAsOwner(ctx: Ctx, ownerId: string, roomId: string, text: string, meta: MessageMeta, fanout?: RoomFanout, kind: "message" | "poll" = "message"): Promise<Sent> {
  const { env } = ctx;
  checkBodySize(env, text);
  fanout ??= await ownerFanout(env, ownerId, roomId);
  const res = await room(env, roomId).sendHuman({ sender_id: ownerId, sender_owner_id: ownerId }, text, meta, stripMembers(fanout), kind);
  const id = `${roomId}:${res.seq}`;
  await audit(env, ownerId, "owner.send", id, { thread_id: meta.thread_id ?? null, bytes: text.length });
  return { id, room: roomId, seq: res.seq, created_at: res.created_at, thread_paused: false };
}

// ---------------------------------------------------------------- reading

/**
 * Shape a stored message for a viewer. With `viewer` (an agent) it also says
 * how the message relates to that agent: `attention`.
 */
export function present(viewerOwner: string, roomId: string, m: StoredMessage, viewer?: { agentId: string; direct: boolean }) {
  const trust_tier: TrustTier = tierFor(viewerOwner, m.sender_owner_id);
  // Owners post as themselves (github:<user>) from the dashboard; agents as agt_….
  const sender_kind = m.sender_id.startsWith("github:") ? "human" : "agent";
  const envelope = { sender_id: m.sender_id, sender_owner_id: m.sender_owner_id, sender_kind, trust_tier };
  const base = {
    id: `${roomId}:${m.seq}`, room: roomId, seq: m.seq, kind: m.kind, envelope, created_at: m.created_at,
    ...(m.edited_at ? { edited_at: m.edited_at } : {}),
    ...(m.deleted_at ? { deleted: true, deleted_at: m.deleted_at, deleted_by: m.deleted_by ?? null } : {}),
    ...(m.pinned_at ? { pinned_at: m.pinned_at, pinned_by: m.pinned_by ?? null } : {}),
  };
  if (m.kind === "reaction") {
    return { ...base, emoji: m.emoji, target_id: `${roomId}:${m.target_seq}`, no_turn: true };
  }
  const attention = viewer && m.sender_id !== viewer.agentId ? attentionFor(viewer.agentId, viewer.direct, m.meta) : undefined;
  return {
    ...base,
    body: m.deleted_at ? null : m.body,
    meta: m.deleted_at ? null : m.meta,
    ...(m.poll && !m.deleted_at ? { poll: m.poll } : {}),
    no_turn: Boolean(m.deleted_at),
    ...(attention ? { attention } : {}),
  };
}

export async function searchRooms(
  env: Env, viewerOwner: string, rooms: { id: string; direct?: boolean }[], query: string, limit: number, agentId?: string,
) {
  const q = query.trim();
  if (!q) throw new HttpError(400, "missing_field", "q is required");
  if (q.length > 200) throw new HttpError(400, "field_too_long", "q must be at most 200 characters");
  const cap = Math.min(Math.max(limit || 25, 1), 50);
  const voterId = agentId ?? viewerOwner;
  const perRoom = await Promise.all(rooms.map(async (r) => {
    const msgs = await room(env, r.id).search(q, cap, voterId);
    const viewer = agentId ? { agentId, direct: !!r.direct } : undefined;
    return msgs.map((m) => present(viewerOwner, r.id, m, viewer));
  }));
  const results = perRoom.flat().sort((a, b) => b.created_at - a.created_at).slice(0, cap);
  return { query: q, results };
}

export async function readHistory(env: Env, viewerOwner: string, roomId: string, url: URL, viewer?: { agentId: string; direct: boolean }) {
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? PAGE_LIMIT) || PAGE_LIMIT, 1), 100);
  const before = url.searchParams.get("before");
  const after = url.searchParams.get("after");
  const thread = url.searchParams.get("thread_id");
  const msgs = await room(env, roomId).list({
    afterSeq: after ? Number(after) : undefined,
    beforeSeq: before ? Number(before) : after ? undefined : Number.MAX_SAFE_INTEGER,
    threadId: thread ?? undefined,
    limit,
    voterId: viewer?.agentId ?? viewerOwner,
  });
  return { room: roomId, messages: msgs.map((m) => present(viewerOwner, roomId, m, viewer)) };
}

// ---------------------------------------------------------------- owners

export interface Owner { id: string; email: string | null; ntfy_topic: string | null }

export const newNtfyTopic = () => `lichen-${randomString(24)}`;

const NOTICE_TEXT: Record<string, string> = {
  approval_pending: "Lichen: 1 pending request",
  join_request_pending: "Lichen: 1 room join request",
  invite_joined: "Lichen: someone joined",
  thread_paused: "Lichen: a thread is paused",
};

/**
 * Record a dashboard notice, push a pointer to the owner's open dashboards,
 * and send an ntfy push. Pushes say *that* something is waiting and *where*,
 * never *what*: ntfy topics can be read by anyone who guesses the name.
 */
export async function ownerNotice(ctx: Ctx, ownerId: string, kind: string, target: string | null, detail?: object) {
  const { env } = ctx;
  const row = await env.DB.prepare(
    "INSERT INTO notices (owner_id, kind, target, detail, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id",
  ).bind(ownerId, kind, target, detail ? JSON.stringify(detail) : null, Date.now()).first<{ id: number }>();
  const event: LiveEvent = { kind: "notice", notice: kind, id: row?.id ?? 0 };
  ctx.waitUntil(ownerHub(env, ownerId).notify(event).catch(() => 0));

  const base = env.NTFY_BASE ?? "https://ntfy.sh";
  if (!base) return;
  const owner = await env.DB.prepare("SELECT ntfy_topic FROM owners WHERE id = ?").bind(ownerId).first<{ ntfy_topic: string | null }>();
  if (!owner?.ntfy_topic) return;
  const click = `${ctx.origin}${kind === "approval_pending" ? "/approvals" : "/dashboard"}`;
  ctx.waitUntil(fetch(`${base.replace(/\/+$/, "")}/${owner.ntfy_topic}`, {
    method: "POST",
    headers: { Title: "Lichen", Click: click, Tags: "bell" },
    body: NOTICE_TEXT[kind] ?? "Lichen: 1 new notice",
    signal: AbortSignal.timeout(5000),
  }).catch(() => undefined));
}

/** Rooms that any of this owner's agents belong to, or that this owner created. */
export async function ownerRoomIds(env: Env, ownerId: string, includeArchived = false): Promise<string[]> {
  const arch = includeArchived ? "" : "AND r.archived_at IS NULL";
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT r.id AS room_id FROM rooms r
     LEFT JOIN memberships m ON m.room_id = r.id
     LEFT JOIN agents a ON a.id = m.agent_id
     WHERE (a.owner_id = ? OR r.created_by = ?) ${arch}`,
  ).bind(ownerId, ownerId).all<{ room_id: string }>();
  return results.map((r) => r.room_id);
}

export async function ownerCanSeeRoom(env: Env, ownerId: string, roomId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS ok FROM rooms r
     LEFT JOIN memberships m ON m.room_id = r.id
     LEFT JOIN agents a ON a.id = m.agent_id
     WHERE r.id = ? AND (a.owner_id = ? OR r.created_by = ?) LIMIT 1`,
  ).bind(roomId, ownerId, ownerId).first();
  return Boolean(row);
}

// ---------------------------------------------------------------- enroll codes / sockets

/** One-time enroll code for a new agent of `ownerId` (same_owner by construction). */
export async function mintEnrollCode(env: Env, origin: string, actor: string, ownerId: string, agentName: string, ttlRaw: unknown) {
  const now = Date.now();
  const ttl = Math.min(Number(ttlRaw ?? ENROLL_CODE_TTL_S) || ENROLL_CODE_TTL_S, 7 * 24 * 3600);
  const code = randomString(12);
  const expires = now + ttl * 1000;
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO owners (id, created_at) VALUES (?, ?)").bind(ownerId, now),
    env.DB.prepare("INSERT INTO enroll_codes (code_hash, owner_id, agent_name, expires_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex(code), ownerId, agentName, expires),
  ]);
  await audit(env, actor, "enroll_code.create", ownerId, { agent_name: agentName });
  return {
    code, owner_id: ownerId, agent_name: agentName, expires_at: expires,
    curl: `curl -s -X POST ${origin}/api/enroll -d code=${code}`,
    // Paste this into the agent: it explains Lichen and enrolls with plain curl.
    prompt: agentPrompt(origin, code, ownerId, agentName),
  };
}

/**
 * GET /ws (WebSocket upgrade). The token is checked before this; the upgrade
 * is handed to the AgentSocket DO named `hubName`. The socket only carries
 * notices ({id, room, from, trust_tier}, plus no_turn for reactions) and
 * approval events; bodies are read from /inbox.
 */
export async function connect(req: Request, env: Env, hubName: string): Promise<Response> {
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    throw new HttpError(426, "upgrade_required", "Connect with a WebSocket client");
  }
  const headers = new Headers(req.headers);
  headers.delete("authorization"); // the DO doesn't need credentials
  headers.delete("cookie");
  headers.delete("cf-access-jwt-assertion");
  return env.AGENT.get(env.AGENT.idFromName(hubName)).fetch(new Request("https://agent.internal/ws", { headers }));
}


/**
 * Register a webhook for `agentId` (validated by checkWebhook). `actor` is the
 * agent itself or its owner, for the audit log. Returns the API response body.
 */
export async function createWebhook(ctx: Ctx, agentId: string, actor: string, b: Record<string, unknown>) {
  const o = checkWebhook(b, ctx.origin, ctx.env.ROUTINE_API_ORIGIN);
  const r = await agentHub(ctx.env, agentId).addWebhook({
    agentId, origin: ctx.origin, url: o.url, authorization: o.authorization, format: o.format,
    includeReactions: bool(b.include_reactions, "include_reactions", false),
    includeAmbient: bool(b.include_ambient, "include_ambient", false),
  });
  if ("error" in r) throw new HttpError(409, r.error!, r.message);
  await audit(ctx.env, actor, "webhook.create", r.webhook.id, {
    agent_id: agentId, host: new URL(o.url).hostname, format: o.format, reactions: r.webhook.include_reactions,
  });
  return {
    ...r.webhook,
    note: o.format === "claude_routine"
      ? "Lichen will fire this routine when a message needs this agent (DMs, mentions, replies), batched to at most one fire every 2 minutes. The token isn't shown again."
      : "Save the secret now; it isn't shown again. Verify each delivery's webhook-signature with it (Standard Webhooks).",
  };
}
