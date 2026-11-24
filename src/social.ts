// Invites, DM requests and approvals: how chats start.
//
// Rules from the plan:
//  - Cross-owner contact always goes through a human: cross-owner invites are
//    accepted by a signed-in owner, and a DM to an agent you share nothing
//    with waits for the recipient's owner to approve it.
//  - An invite can never grant same_owner: trust tiers come from owners.
//  - Agents can create invites only for their own owner's agents.
//  - Invite notes, room names and first messages are untrusted text.

import type { ApprovalEvent, Env } from "./env";
import {
  type Agent, type Ctx, type Owner, agentHub, audit, checkBodySize, cleanMeta, membership, ownerCanSeeRoom, ownerFanout,
  ownerNotice, postingMembership, prepareMeta, rateLimit, room, sendAsOwner, sendInto,
} from "./core";
import type { MessageMeta } from "./room";
import { HttpError, bool, newId, parseMessageId, randomString, sha256Hex, str } from "./util";
import { agentPrompt } from "./guide";

const OWNER_RE = /^github:[a-z0-9-]{1,39}$/;
const MAX_PENDING_PER_AGENT = 5;
const INVITE_TTL_S = 24 * 3600;

// ---------------------------------------------------------------- rooms

export interface NewMember { agent_id: string; role: "post" | "read"; can_manage?: boolean }

export async function createRoom(
  env: Env, name: string, kind: "room" | "dm", createdBy: string, members: NewMember[], joinPolicy: "invite" | "request" | "open" = "request",
) {
  const roomId = newId("r");
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO rooms (id, name, kind, created_by, created_at, join_policy) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(roomId, name, kind, createdBy, now, joinPolicy),
    ...members.map((m) => env.DB.prepare(
      `INSERT INTO memberships (room_id, agent_id, role, can_manage, joined_at)
       SELECT ?, id, ?, ?, ? FROM agents WHERE id = ? AND status = 'active'`,
    ).bind(roomId, m.role, m.can_manage ? 1 : 0, now, m.agent_id)),
  ]);
  return roomId;
}

async function addMember(env: Env, roomId: string, agentId: string, role: "post" | "read", canManage = false) {
  await env.DB.prepare(
    `INSERT INTO memberships (room_id, agent_id, role, can_manage, joined_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(room_id, agent_id) DO UPDATE SET role = excluded.role, can_manage = excluded.can_manage`,
  ).bind(roomId, agentId, role, canManage ? 1 : 0, Date.now()).run();
}

async function findDm(env: Env, a: string, b: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT r.id FROM rooms r
     JOIN memberships m1 ON m1.room_id = r.id AND m1.agent_id = ?
     JOIN memberships m2 ON m2.room_id = r.id AND m2.agent_id = ?
     WHERE r.kind = 'dm' ORDER BY r.created_at LIMIT 1`,
  ).bind(a, b).first<{ id: string }>();
  return row?.id ?? null;
}

async function shareRoom(env: Env, a: string, b: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS ok FROM memberships m1 JOIN memberships m2 ON m1.room_id = m2.room_id
     WHERE m1.agent_id = ? AND m2.agent_id = ? LIMIT 1`,
  ).bind(a, b).first();
  return Boolean(row);
}

async function dmRoom(env: Env, from: Agent, to: { id: string; owner_id: string }): Promise<string> {
  return (await findDm(env, from.id, to.id))
    ?? createRoom(env, "dm", "dm", from.owner_id, [{ agent_id: from.id, role: "post" }, { agent_id: to.id, role: "post" }]);
}

// ---------------------------------------------------------------- DMs and approvals

export const approvalUrl = (ctx: Ctx, id: string) => `${ctx.origin}/approvals#${id}`;

/** POST /dm {to, body, ...meta}: open (or reuse) a DM, or ask the recipient's owner. */
export async function requestDm(ctx: Ctx, agent: Agent, b: Record<string, unknown>) {
  const { env } = ctx;
  const to = str(b.to, "to", 64, true)!;
  const text = str(b.body, "body", 1_000_000, true)!;
  checkBodySize(env, text);
  const meta = cleanMeta(b.meta && typeof b.meta === "object" ? { ...(b.meta as object) } as Record<string, unknown> : b);
  if (to === agent.id) throw new HttpError(400, "invalid_field", "Can't DM yourself");

  const target = await env.DB.prepare("SELECT id, owner_id FROM agents WHERE id = ? AND status = 'active'")
    .bind(to).first<{ id: string; owner_id: string }>();
  if (!target) throw new HttpError(404, "agent_not_found");

  const rule = await env.DB.prepare("SELECT rule FROM contact_rules WHERE owner_id = ? AND agent_id = ?")
    .bind(target.owner_id, agent.id).first<{ rule: string }>();
  if (rule?.rule === "block") throw new HttpError(403, "not_allowed", "The recipient's owner doesn't accept DMs from this agent");

  const direct = target.owner_id === agent.owner_id || rule?.rule === "allow" || await shareRoom(env, agent.id, target.id);
  if (direct) {
    const roomId = await dmRoom(env, agent, target);
    const sent = await sendInto(ctx, agent, await postingMembership(env, agent, roomId), text, meta);
    return { status: 201, body: { status: "ok", room: roomId, message: sent } };
  }

  const existing = await env.DB.prepare(
    "SELECT id FROM approvals WHERE requester_agent = ? AND target_agent = ? AND status = 'pending'",
  ).bind(agent.id, target.id).first<{ id: string }>();
  if (existing) {
    return { status: 202, body: { status: "pending", approval_id: existing.id, approval_url: approvalUrl(ctx, existing.id) } };
  }
  const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM approvals WHERE requester_agent = ? AND status = 'pending'")
    .bind(agent.id).first<{ n: number }>();
  if ((pending?.n ?? 0) >= MAX_PENDING_PER_AGENT) throw new HttpError(429, "too_many_pending", "Too many DM requests waiting for approval");

  const id = newId("apr");
  await env.DB.prepare(
    `INSERT INTO approvals (id, requester_agent, requester_owner, target_agent, target_owner, first_message, meta, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, agent.id, agent.owner_id, target.id, target.owner_id, text, JSON.stringify(meta), Date.now()).run();
  await audit(env, agent.id, "dm.request", id, { target_agent: target.id, target_owner: target.owner_id });
  await ownerNotice(ctx, target.owner_id, "approval_pending", id);
  return { status: 202, body: { status: "pending", approval_id: id, approval_url: approvalUrl(ctx, id) } };
}

export type ApprovalAction = "allow_once" | "always_allow" | "deny" | "block";
const ACTIONS = new Set<ApprovalAction>(["allow_once", "always_allow", "deny", "block"]);

interface ApprovalRow {
  id: string; requester_agent: string; requester_owner: string; target_agent: string; target_owner: string;
  first_message: string; meta: string | null; status: string;
}

/** The recipient's owner decides a DM request. */
export async function decideApproval(ctx: Ctx, owner: Owner, id: string, actionRaw: unknown) {
  const { env } = ctx;
  const action = actionRaw as ApprovalAction;
  if (!ACTIONS.has(action)) throw new HttpError(400, "invalid_action", "action must be allow_once, always_allow, deny or block");
  const row = await env.DB.prepare("SELECT * FROM approvals WHERE id = ? AND target_owner = ?").bind(id, owner.id).first<ApprovalRow>();
  if (!row) throw new HttpError(404, "approval_not_found");
  if (row.status !== "pending") throw new HttpError(409, "already_decided", `This request was already ${row.status}`);

  const now = Date.now();
  let status: ApprovalEvent["status"];
  let roomId: string | null = null;

  if (action === "allow_once" || action === "always_allow") {
    const requester = await env.DB.prepare("SELECT id, owner_id, name FROM agents WHERE id = ? AND status = 'active'")
      .bind(row.requester_agent).first<Agent>();
    if (!requester) throw new HttpError(409, "requester_gone", "The requesting agent was revoked");
    // Claim the decision first so two clicks can't both deliver.
    const claimed = await env.DB.prepare(
      "UPDATE approvals SET status = 'allowed', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'",
    ).bind(now, owner.id, id).run();
    if (!claimed.meta.changes) throw new HttpError(409, "already_decided");
    roomId = await dmRoom(env, requester, { id: row.target_agent, owner_id: row.target_owner });
    await env.DB.prepare("UPDATE approvals SET room_id = ? WHERE id = ?").bind(roomId, id).run();
    if (action === "always_allow") await setRule(env, owner.id, row.requester_agent, "allow");
    const meta = row.meta ? JSON.parse(row.meta) : { reply_requested: true };
    try {
      await sendInto(ctx, requester, await postingMembership(env, requester, roomId), row.first_message, meta);
    } catch (e) {
      // The DM exists either way; a cooldown here only delays the first message.
      if (!(e instanceof HttpError)) throw e;
    }
    status = "allowed";
  } else {
    status = action === "block" ? "blocked" : "denied";
    const res = await env.DB.prepare(
      "UPDATE approvals SET status = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'",
    ).bind(status, now, owner.id, id).run();
    if (!res.meta.changes) throw new HttpError(409, "already_decided");
    if (action === "block") await setRule(env, owner.id, row.requester_agent, "block");
  }

  await audit(env, owner.id, `approval.${action}`, id, { requester_agent: row.requester_agent, room_id: roomId });
  const event: ApprovalEvent = { kind: "approval", id, status, room: roomId };
  for (const a of [row.requester_agent, row.target_agent]) ctx.waitUntil(agentHub(env, a).notify(event).catch(() => 0));
  return { id, status, room: roomId };
}

async function setRule(env: Env, ownerId: string, agentId: string, rule: "allow" | "block") {
  await env.DB.prepare(
    `INSERT INTO contact_rules (owner_id, agent_id, rule, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(owner_id, agent_id) DO UPDATE SET rule = excluded.rule, created_at = excluded.created_at`,
  ).bind(ownerId, agentId, rule, Date.now()).run();
}

/** What an agent sees under "approvals" in /inbox: pointers, never the first message. */
export async function agentApprovals(ctx: Ctx, agent: Agent) {
  const since = Date.now() - 7 * 24 * 3600 * 1000;
  const { results } = await ctx.env.DB.prepare(
    `SELECT id, requester_agent, requester_owner, target_agent, target_owner, status, room_id, created_at, decided_at
     FROM approvals
     WHERE (target_agent = ? AND status = 'pending')
        OR (requester_agent = ? AND (status = 'pending' OR decided_at > ?))
     ORDER BY created_at LIMIT 20`,
  ).bind(agent.id, agent.id, since).all<Record<string, any>>();
  return results.map((r) => {
    const incoming = r.target_agent === agent.id;
    return {
      id: r.id,
      direction: incoming ? "incoming" : "outgoing",
      status: r.status,
      peer: incoming ? { agent_id: r.requester_agent, owner_id: r.requester_owner } : { agent_id: r.target_agent, owner_id: r.target_owner },
      room: r.room_id,
      approval_url: approvalUrl(ctx, r.id),
      created_at: r.created_at,
    };
  });
}

// ---------------------------------------------------------------- invites

interface InviteRow {
  id: string; room_id: string | null; dm_agent: string | null; created_by: string; created_by_agent: string | null;
  for_owner: string | null; same_owner_only: number; role: "post" | "read"; uses_left: number; note: string | null;
  expires_at: number; created_at: number; revoked_at: number | null; room_name?: string | null; room_kind?: string | null;
}

function inviteStatus(inv: InviteRow, now = Date.now()) {
  if (inv.revoked_at) return "revoked";
  if (inv.expires_at < now) return "expired";
  if (inv.uses_left <= 0) return "used";
  return "active";
}

/** Create an invite, as an owner or (same-owner only) as an agent. */
export async function createInvite(ctx: Ctx, by: { owner: string; agent?: Agent }, b: Record<string, unknown>) {
  const { env } = ctx;
  const roomId = str(b.room, "room", 64);
  const dmWith = str(b.dm_with, "dm_with", 64);
  if (!roomId === !dmWith) throw new HttpError(400, "invalid_field", "Give exactly one of room or dm_with");

  if (roomId) {
    if (by.agent) {
      const m = await membership(env, by.agent.id, roomId);
      if (m.role !== "post") throw new HttpError(403, "read_only");
    } else if (!(await ownerCanSeeRoom(env, by.owner, roomId))) {
      throw new HttpError(404, "room_not_found");
    }
  } else {
    if (by.agent && dmWith !== by.agent.id) throw new HttpError(403, "forbidden", "An agent can only invite to a DM with itself");
    const a = await env.DB.prepare("SELECT id FROM agents WHERE id = ? AND owner_id = ? AND status = 'active'")
      .bind(dmWith, by.owner).first();
    if (!a) throw new HttpError(404, "agent_not_found", "dm_with must be one of your active agents");
  }

  let forOwner = str(b.for, "for", 50)?.toLowerCase();
  if (forOwner && !forOwner.startsWith("github:")) forOwner = `github:${forOwner}`;
  if (forOwner && !OWNER_RE.test(forOwner)) throw new HttpError(400, "invalid_field", "for must be a GitHub username");
  const role = (str(b.role, "role", 8) ?? "post") as "post" | "read";
  if (role !== "post" && role !== "read") throw new HttpError(400, "invalid_field", "role must be post or read");
  const ttl = Math.min(Math.max(Number(b.expires_in ?? INVITE_TTL_S) || INVITE_TTL_S, 60), 30 * 24 * 3600);
  const uses = Math.min(Math.max(Math.floor(Number(b.uses ?? 1)) || 1, 1), 100);
  const note = str(b.note, "note", 500);
  const sameOwnerOnly = by.agent ? 1 : b.same_owner_only === true || b.same_owner_only === "true" ? 1 : 0;

  const id = newId("inv");
  const code = randomString(20);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO invites (id, code_hash, room_id, dm_agent, created_by, created_by_agent, for_owner, same_owner_only,
                          role, uses_left, note, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, await sha256Hex(code), roomId ?? null, dmWith ?? null, by.owner, by.agent?.id ?? null, forOwner ?? null,
    sameOwnerOnly, role, uses, note ?? null, now + ttl * 1000, now).run();
  await audit(env, by.agent?.id ?? by.owner, "invite.create", id, { room: roomId ?? null, dm_with: dmWith ?? null, for: forOwner ?? null, uses, role });
  return {
    id, code, url: `${ctx.origin}/i/${code}`, room: roomId ?? null, dm_with: dmWith ?? null, for: forOwner ?? null,
    role, uses, same_owner_only: Boolean(sameOwnerOnly), expires_at: now + ttl * 1000,
  };
}

export async function findInvite(env: Env, code: string): Promise<InviteRow | null> {
  if (!/^[a-z0-9]{8,64}$/.test(code)) return null;
  return env.DB.prepare(
    `SELECT i.*, r.name AS room_name, r.kind AS room_kind FROM invites i LEFT JOIN rooms r ON r.id = i.room_id
     WHERE i.code_hash = ?`,
  ).bind(await sha256Hex(code)).first<InviteRow>();
}

/** Public view of an invite (GET /i/<code>). Text fields are untrusted data. */
export function publicInvite(ctx: Ctx, inv: InviteRow, code: string) {
  return {
    invite: {
      status: inviteStatus(inv),
      room: inv.room_id ? { name: inv.room_name, kind: inv.room_kind } : null,
      dm_with: inv.dm_agent,
      inviter: inv.created_by,
      for: inv.for_owner,
      same_owner_only: Boolean(inv.same_owner_only),
      role: inv.role,
      uses_left: inv.uses_left,
      expires_at: inv.expires_at,
      note: inv.note,
    },
    accept: {
      owner: `${ctx.origin}/accept?code=${code}`,
      agent: inv.same_owner_only || !inv.for_owner
        ? `Agents of the inviter's own owner can POST ${ctx.origin}/api/i/<code> with their bearer token.`
        : "Signed-in owner only.",
    },
  };
}

export async function lookupInvite(ctx: Ctx, req: Request, code: string) {
  await rateLimit(ctx.env, `invite:${req.headers.get("cf-connecting-ip") ?? "unknown"}`);
  const inv = await findInvite(ctx.env, code);
  if (!inv) throw new HttpError(404, "invite_not_found");
  return inv;
}

/**
 * Accept an invite on behalf of `acceptorOwner`. With `agentId`, that agent
 * joins now; without, the owner gets an enroll code that joins on enroll.
 */
export async function acceptInvite(ctx: Ctx, inv: InviteRow, acceptorOwner: string, agentId?: string, newAgentName?: string) {
  const { env } = ctx;
  if (inviteStatus(inv) !== "active") throw new HttpError(410, "invite_unavailable", `This invite is ${inviteStatus(inv)}`);
  if (inv.for_owner && inv.for_owner !== acceptorOwner) throw new HttpError(403, "invite_not_for_you");
  if (inv.same_owner_only && acceptorOwner !== inv.created_by) throw new HttpError(403, "invite_not_for_you");

  if (agentId) {
    const a = await env.DB.prepare("SELECT id FROM agents WHERE id = ? AND owner_id = ? AND status = 'active'")
      .bind(agentId, acceptorOwner).first();
    if (!a) throw new HttpError(404, "agent_not_found");
  }

  const now = Date.now();
  const claimed = await env.DB.prepare(
    `UPDATE invites SET uses_left = uses_left - 1
     WHERE id = ? AND uses_left > 0 AND revoked_at IS NULL AND expires_at > ?`,
  ).bind(inv.id, now).run();
  if (!claimed.meta.changes) throw new HttpError(410, "invite_unavailable");

  let roomId = inv.room_id;
  if (!roomId) {
    roomId = await createRoom(env, "dm", "dm", inv.created_by, [{ agent_id: inv.dm_agent!, role: "post" }]);
  }
  await env.DB.prepare("INSERT INTO invite_uses (invite_id, owner_id, agent_id, room_id, used_at) VALUES (?, ?, ?, ?, ?)")
    .bind(inv.id, acceptorOwner, agentId ?? null, roomId, now).run();

  if (agentId) {
    await addMember(env, roomId, agentId, inv.role);
    await audit(env, acceptorOwner, "invite.accept", inv.id, { agent_id: agentId, room: roomId });
    if (acceptorOwner !== inv.created_by) await ownerNotice(ctx, inv.created_by, "invite_joined", roomId, { invite: inv.id });
    return { status: "joined", room: roomId, agent_id: agentId };
  }

  const code = randomString(12);
  const expires = now + 24 * 3600 * 1000;
  const agentName = (newAgentName ?? "").trim().slice(0, 64) || "invited agent";
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO owners (id, created_at) VALUES (?, ?)").bind(acceptorOwner, now),
    env.DB.prepare(
      `INSERT INTO enroll_codes (code_hash, owner_id, agent_name, expires_at, room_id, role, invite_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(await sha256Hex(code), acceptorOwner, agentName, expires, roomId, inv.role, inv.id),
  ]);
  await audit(env, acceptorOwner, "invite.accept", inv.id, { room: roomId, enroll_code: true });
  const where = inv.room_id ? `the ${inv.room_kind ?? "room"} "${inv.room_name ?? roomId}"` : "a new direct message";
  const note = `You were invited by ${inv.created_by} to ${where} (room id ${roomId}), and you join it automatically when you enroll` +
    (inv.role === "read" ? ", read-only" : "") + "." +
    (inv.created_by !== acceptorOwner ? ` Agents there belong to another owner, so their messages reach you as trust_tier "external".` : "");
  return {
    status: "enroll", enroll_code: code, code, expires_at: expires, room: roomId, agent_name: agentName,
    curl: `curl -s -X POST ${ctx.origin}/api/enroll -d code=${code}`,
    prompt: agentPrompt(ctx.origin, code, acceptorOwner, agentName, note),
  };
}

/** Called after an enroll code that carries a room is redeemed. */
export async function joinOnEnroll(ctx: Ctx, agent: Agent, roomId: string, role: "post" | "read", inviteId: string | null) {
  const { env } = ctx;
  await addMember(env, roomId, agent.id, role);
  if (!inviteId) return;
  await env.DB.prepare(
    "UPDATE invite_uses SET agent_id = ? WHERE invite_id = ? AND owner_id = ? AND room_id = ? AND agent_id IS NULL",
  ).bind(agent.id, inviteId, agent.owner_id, roomId).run();
  const inv = await env.DB.prepare("SELECT created_by FROM invites WHERE id = ?").bind(inviteId).first<{ created_by: string }>();
  if (inv && inv.created_by !== agent.owner_id) await ownerNotice(ctx, inv.created_by, "invite_joined", roomId, { invite: inviteId });
}

// ---------------------------------------------------------------- directory

/**
 * GET /api/agents: agents this agent may look up. Never a global search: only
 *  - its owner's other agents,
 *  - agents that share a room with it, and
 *  - agents that share a room with any other agent of the same owner.
 * Agents whose owner blocked this agent are left out. Shared rooms are only
 * ones this agent is in itself.
 */
export async function findAgents(ctx: Ctx, agent: Agent, q: string) {
  const { env } = ctx;
  const needle = q.trim().toLowerCase().slice(0, 64);
  const like = "%" + needle.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.name, a.owner_id FROM agents a
     WHERE a.status = 'active' AND a.id != ?1
       AND (a.owner_id = ?2 OR a.id IN (
         SELECT m2.agent_id FROM memberships m1
         JOIN agents mine ON mine.id = m1.agent_id AND mine.owner_id = ?2
         JOIN memberships m2 ON m2.room_id = m1.room_id))
       AND a.owner_id NOT IN (SELECT owner_id FROM contact_rules WHERE agent_id = ?1 AND rule = 'block')
       AND (?3 = '' OR lower(a.name) LIKE ?4 ESCAPE '\\' OR a.owner_id LIKE ?4 ESCAPE '\\' OR a.id = ?3)
     ORDER BY (a.owner_id = ?2) DESC, a.name LIMIT 100`,
  ).bind(agent.id, agent.owner_id, needle, like).all<{ id: string; name: string; owner_id: string }>();

  const { results: shared } = await env.DB.prepare(
    `SELECT m2.agent_id, r.id, r.name, r.kind FROM memberships m1
     JOIN memberships m2 ON m2.room_id = m1.room_id AND m2.agent_id != m1.agent_id
     JOIN rooms r ON r.id = m1.room_id WHERE m1.agent_id = ?`,
  ).bind(agent.id).all<{ agent_id: string; id: string; name: string; kind: string }>();
  const sharedBy = new Map<string, { id: string; name: string; kind: string }[]>();
  for (const s of shared) {
    const list = sharedBy.get(s.agent_id) ?? [];
    list.push({ id: s.id, name: s.name, kind: s.kind });
    sharedBy.set(s.agent_id, list);
  }
  const { results: allows } = await env.DB.prepare("SELECT owner_id FROM contact_rules WHERE agent_id = ? AND rule = 'allow'")
    .bind(agent.id).all<{ owner_id: string }>();
  const allowed = new Set(allows.map((r) => r.owner_id));

  const agents = results.map((a) => {
    const rooms = sharedBy.get(a.id) ?? [];
    const sameOwner = a.owner_id === agent.owner_id;
    const relation = sameOwner ? "same_owner" : rooms.length ? "shared_room" : "owner_network";
    return {
      agent_id: a.id, name: a.name, owner_id: a.owner_id,
      trust_tier: sameOwner ? "same_owner" : "external",
      relation, shared_rooms: rooms,
      dm: sameOwner || rooms.length || allowed.has(a.owner_id) ? "direct" : "needs_owner_approval",
    };
  });
  // Agents you actually share a room with come before ones only your owner's other agents have met.
  const rank = { same_owner: 0, shared_room: 1, owner_network: 2 } as const;
  agents.sort((x, y) => rank[x.relation as keyof typeof rank] - rank[y.relation as keyof typeof rank] || x.name.localeCompare(y.name));
  return { agents };
}

// ---------------------------------------------------------------- forwarding

/**
 * Forward a message into another room or DM. The copy says who originally
 * sent it, and keeps provenance: anything from another owner, or already
 * marked origin: external, stays origin: external, even forwarded by your own
 * agent. Works for agents (must be in the source room and allowed to post in
 * the target) and owners (must have an agent in both).
 */
export async function forwardMessage(ctx: Ctx, by: { agent?: Agent; ownerId: string }, b: Record<string, unknown>) {
  const { env } = ctx;
  const messageId = str(b.message_id, "message_id", 100, true)!;
  const target = str(b.room, "room", 64, true)!;
  const comment = str(b.comment, "comment", 1000);
  const { roomId: source, seq } = parseMessageId(messageId);

  if (by.agent) await membership(env, by.agent.id, source);
  else if (!(await ownerCanSeeRoom(env, by.ownerId, source))) throw new HttpError(404, "room_not_found");
  const msg = await room(env, source).getMessage(seq);
  if (!msg || msg.kind !== "message") throw new HttpError(404, "message_not_found");

  const external = msg.sender_owner_id !== by.ownerId || msg.meta?.origin === "external";
  const meta: MessageMeta = {
    reply_requested: bool(b.reply_requested, "reply_requested", false),
    ...(str(b.thread_id, "thread_id", 128) ? { thread_id: str(b.thread_id, "thread_id", 128) } : {}),
    ...(external ? { origin: "external" as const } : {}),
    forwarded: {
      id: messageId, sender_id: msg.sender_id, sender_owner_id: msg.sender_owner_id,
      sender_kind: msg.sender_id.startsWith("github:") ? "human" : "agent", created_at: msg.created_at,
    },
    ...(comment ? { forward_comment: comment } : {}),
  };
  const text = msg.body ?? "";

  let sent;
  if (by.agent) {
    const fanout = await postingMembership(env, by.agent, target);
    // Mentions come only from the forwarder's own comment, never the forwarded text.
    await prepareMeta(env, fanout, by.agent.id, comment ?? "", { mentions: b.mentions }, meta);
    sent = await sendInto(ctx, by.agent, fanout, text, meta);
  } else {
    const fanout = await ownerFanout(env, by.ownerId, target);
    await prepareMeta(env, fanout, by.ownerId, comment ?? "", { mentions: b.mentions }, meta);
    sent = await sendAsOwner(ctx, by.ownerId, target, text, meta, fanout);
  }
  await audit(env, by.agent?.id ?? by.ownerId, "forward", sent.id, { from: messageId });
  return { ...sent, forwarded_from: messageId, origin: meta.origin ?? null };
}

// ---------------------------------------------------------------- human ↔ agent DMs

/** Open (or reuse) a DM between an owner and one of their own agents. */
export async function humanDm(ctx: Ctx, ownerId: string, agentId: string) {
  const { env } = ctx;
  const a = await env.DB.prepare("SELECT id, name FROM agents WHERE id = ? AND owner_id = ? AND status = 'active'")
    .bind(agentId, ownerId).first<{ id: string; name: string }>();
  if (!a) throw new HttpError(404, "agent_not_found", "You can DM your own active agents");
  const existing = await env.DB.prepare(
    `SELECT r.id FROM rooms r JOIN memberships m ON m.room_id = r.id AND m.agent_id = ?
     WHERE r.kind = 'dm' AND r.human_owner = ? ORDER BY r.created_at LIMIT 1`,
  ).bind(agentId, ownerId).first<{ id: string }>();
  if (existing) return { room: existing.id, agent_id: agentId, created: false };
  const roomId = await createRoom(env, "dm", "dm", ownerId, [{ agent_id: agentId, role: "post" }]);
  await env.DB.prepare("UPDATE rooms SET human_owner = ? WHERE id = ?").bind(ownerId, roomId).run();
  await audit(env, ownerId, "dm.human", roomId, { agent_id: agentId });
  return { room: roomId, agent_id: agentId, created: true };
}

// ---------------------------------------------------------------- room management & join requests

const JOIN_POLICIES = new Set(["invite", "request", "open"]);

interface RoomRow {
  id: string; name: string; kind: string; created_by: string; human_owner: string | null;
  archived_at: number | null; join_policy: string; auto_pause: number;
}

async function getRoomRow(env: Env, roomId: string): Promise<RoomRow> {
  const r = await env.DB.prepare(
    "SELECT id, name, kind, created_by, human_owner, archived_at, join_policy, auto_pause FROM rooms WHERE id = ?",
  ).bind(roomId).first<RoomRow>();
  if (!r) throw new HttpError(404, "room_not_found");
  return r;
}

/** An owner can manage a room if they created it, it's their human DM, or it's an admin-created room they belong to. */
async function canOwnerManageRoom(env: Env, ownerId: string, r: RoomRow): Promise<boolean> {
  if (r.created_by === ownerId || r.human_owner === ownerId) return true;
  if (r.created_by === "admin") return ownerCanSeeRoom(env, ownerId, r.id);
  return false;
}

/** Rename a room or update its join_policy / auto_pause. Owner creator (or admin-room member), or an authorized agent (can_manage). */
export async function updateRoom(ctx: Ctx, by: { ownerId: string; agent?: Agent }, roomId: string, b: Record<string, unknown>) {
  const { env } = ctx;
  const r = await getRoomRow(env, roomId);
  if (by.agent) {
    const m = await membership(env, by.agent.id, roomId);
    if (!m.can_manage) throw new HttpError(403, "forbidden", "This agent is not authorized to manage this room");
  } else if (!(await canOwnerManageRoom(env, by.ownerId, r))) {
    throw new HttpError(403, "forbidden", "Only the room's creator can edit room settings");
  }
  if (r.kind !== "room") throw new HttpError(400, "invalid_room", "Direct messages cannot be renamed or change room settings");
  if (r.archived_at) throw new HttpError(409, "room_archived", "Unarchive the room before editing it");

  const nextName = b.name !== undefined ? str(b.name, "name", 100, true)!.trim() : r.name;
  if (!nextName) throw new HttpError(400, "missing_field", "name cannot be empty");
  const nextPolicy = b.join_policy !== undefined ? str(b.join_policy, "join_policy", 16, true)! : r.join_policy;
  if (!JOIN_POLICIES.has(nextPolicy)) throw new HttpError(400, "invalid_field", "join_policy must be invite, request or open");
  const nextAutoPause = b.auto_pause !== undefined ? bool(b.auto_pause, "auto_pause", true) : r.auto_pause !== 0;

  await env.DB.prepare("UPDATE rooms SET name = ?, join_policy = ?, auto_pause = ? WHERE id = ?")
    .bind(nextName, nextPolicy, nextAutoPause ? 1 : 0, roomId).run();
  if (!nextAutoPause) await room(env, roomId).resumeAll();
  await audit(env, by.agent?.id ?? by.ownerId, "room.update", roomId, { name: nextName, join_policy: nextPolicy, auto_pause: nextAutoPause });
  return { id: roomId, name: nextName, join_policy: nextPolicy, auto_pause: nextAutoPause };
}

/** Archive or unarchive a room. */
export async function archiveRoom(ctx: Ctx, by: { ownerId: string; agent?: Agent }, roomId: string, archived: boolean) {
  const { env } = ctx;
  const r = await getRoomRow(env, roomId);
  if (by.agent) {
    const m = await membership(env, by.agent.id, roomId);
    if (!m.can_manage) throw new HttpError(403, "forbidden", "This agent is not authorized to manage this room");
  } else if (!(await canOwnerManageRoom(env, by.ownerId, r))) {
    throw new HttpError(403, "forbidden", "Only the room's creator can archive or unarchive it");
  }
  const now = archived ? Date.now() : null;
  const actor = by.agent?.id ?? by.ownerId;
  await env.DB.prepare("UPDATE rooms SET archived_at = ?, archived_by = ? WHERE id = ?")
    .bind(now, archived ? actor : null, roomId).run();
  await audit(env, actor, archived ? "room.archive" : "room.unarchive", roomId);
  return { id: roomId, archived, archived_at: now };
}

/** Permanently delete a room and purge its Durable Object storage. Owner creator (or admin-room member) only. */
export async function deleteRoom(ctx: Ctx, ownerId: string, roomId: string) {
  const { env } = ctx;
  const r = await getRoomRow(env, roomId);
  if (!(await canOwnerManageRoom(env, ownerId, r))) {
    throw new HttpError(403, "forbidden", "Only the room's creator can delete it");
  }
  await room(env, roomId).purge();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM room_join_requests WHERE room_id = ?").bind(roomId),
    env.DB.prepare("DELETE FROM invite_uses WHERE room_id = ?").bind(roomId),
    env.DB.prepare("DELETE FROM invites WHERE room_id = ?").bind(roomId),
    env.DB.prepare("UPDATE enroll_codes SET room_id = NULL, role = NULL, invite_id = NULL WHERE room_id = ?").bind(roomId),
    env.DB.prepare("DELETE FROM memberships WHERE room_id = ?").bind(roomId),
    env.DB.prepare("DELETE FROM rooms WHERE id = ?").bind(roomId),
  ]);
  await audit(env, ownerId, "room.delete", roomId, { name: r.name, kind: r.kind });
  return { ok: true, id: roomId, deleted: true };
}

/** Add one or more same-owner active agents to a room (human owner or authorized agent). */
export async function addRoomMembers(ctx: Ctx, by: { ownerId: string; agent?: Agent }, roomId: string, b: Record<string, unknown>) {
  const { env } = ctx;
  const r = await getRoomRow(env, roomId);
  if (r.kind !== "room") throw new HttpError(400, "invalid_room", "Cannot add members to a direct message");
  if (r.archived_at) throw new HttpError(409, "room_archived", "This room is archived");

  if (by.agent) {
    const m = await membership(env, by.agent.id, roomId);
    if (!m.can_manage) throw new HttpError(403, "forbidden", "This agent is not authorized to add members to this room");
  } else if (r.created_by !== by.ownerId && !(await ownerCanSeeRoom(env, by.ownerId, roomId))) {
    throw new HttpError(404, "room_not_found");
  }

  const rawList = Array.isArray(b.agent_ids)
    ? b.agent_ids.filter((x): x is string => typeof x === "string")
    : typeof b.agent_id === "string" ? [b.agent_id] : [];
  const ids = [...new Set(rawList.map((s) => s.trim()).filter(Boolean))].slice(0, 50);
  if (!ids.length) throw new HttpError(400, "missing_field", "agent_id or agent_ids is required");

  const role = (str(b.role, "role", 8) ?? "post") as "post" | "read";
  if (role !== "post" && role !== "read") throw new HttpError(400, "invalid_field", "role must be post or read");
  const canManage = bool(b.can_manage, "can_manage", false);

  const { results } = await env.DB.prepare(
    `SELECT id FROM agents WHERE owner_id = ? AND status = 'active' AND id IN (${ids.map(() => "?").join(",")})`,
  ).bind(by.ownerId, ...ids).all<{ id: string }>();
  if (results.length !== ids.length) {
    throw new HttpError(403, "not_your_agent", "Can only add active agents of the same owner directly; use an invite for other owners");
  }

  const now = Date.now();
  await env.DB.batch(ids.map((id) => env.DB.prepare(
    `INSERT INTO memberships (room_id, agent_id, role, can_manage, joined_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(room_id, agent_id) DO UPDATE SET role = excluded.role, can_manage = excluded.can_manage`,
  ).bind(roomId, id, role, canManage ? 1 : 0, now)));
  await audit(env, by.agent?.id ?? by.ownerId, "membership.add", roomId, { agent_ids: ids, role, can_manage: canManage });
  return { ok: true, room: roomId, added: ids, role, can_manage: canManage };
}

/** Update a member's role or can_manage flag. Room creator or the agent's owner. */
export async function updateRoomMember(ctx: Ctx, ownerId: string, roomId: string, agentId: string, b: Record<string, unknown>) {
  const { env } = ctx;
  const row = await env.DB.prepare(
    `SELECT r.created_by, a.owner_id, m.role, m.can_manage FROM memberships m
     JOIN rooms r ON r.id = m.room_id JOIN agents a ON a.id = m.agent_id
     WHERE m.room_id = ? AND m.agent_id = ?`,
  ).bind(roomId, agentId).first<{ created_by: string; owner_id: string; role: string; can_manage: number }>();
  if (!row || (row.created_by !== ownerId && row.owner_id !== ownerId)) throw new HttpError(404, "member_not_found");
  const role = (b.role !== undefined ? str(b.role, "role", 8, true)! : row.role) as "post" | "read";
  if (role !== "post" && role !== "read") throw new HttpError(400, "invalid_field", "role must be post or read");
  const canManage = b.can_manage !== undefined ? bool(b.can_manage, "can_manage", false) : Boolean(row.can_manage);
  // Only the room's creator can grant can_manage.
  if (canManage && !row.can_manage && row.created_by !== ownerId) {
    throw new HttpError(403, "forbidden", "Only the room's creator can grant room management permission");
  }
  await env.DB.prepare("UPDATE memberships SET role = ?, can_manage = ? WHERE room_id = ? AND agent_id = ?")
    .bind(role, canManage ? 1 : 0, roomId, agentId).run();
  await audit(env, ownerId, "membership.update", roomId, { agent_id: agentId, role, can_manage: canManage });
  return { ok: true, room: roomId, agent_id: agentId, role, can_manage: canManage };
}

/** Remove a member (owner creator, agent's owner, authorized agent for same-owner, or self-leave). */
export async function removeRoomMember(ctx: Ctx, by: { ownerId: string; agent?: Agent }, roomId: string, agentId: string) {
  const { env } = ctx;
  const row = await env.DB.prepare(
    `SELECT r.created_by, r.kind, a.owner_id FROM memberships m
     JOIN rooms r ON r.id = m.room_id JOIN agents a ON a.id = m.agent_id
     WHERE m.room_id = ? AND m.agent_id = ?`,
  ).bind(roomId, agentId).first<{ created_by: string; kind: string; owner_id: string }>();
  if (!row) throw new HttpError(404, "member_not_found");
  if (by.agent) {
    const isSelf = by.agent.id === agentId;
    if (isSelf) {
      if (row.kind !== "room") throw new HttpError(400, "invalid_room", "Cannot leave a direct message");
    } else {
      const caller = await membership(env, by.agent.id, roomId);
      if (!caller.can_manage || row.owner_id !== by.ownerId) {
        throw new HttpError(403, "forbidden", "Can only remove same-owner agents when authorized to manage this room");
      }
    }
  } else if (row.created_by !== by.ownerId && row.owner_id !== by.ownerId) {
    throw new HttpError(404, "member_not_found");
  }
  await env.DB.prepare("DELETE FROM memberships WHERE room_id = ? AND agent_id = ?").bind(roomId, agentId).run();
  await audit(env, by.agent?.id ?? by.ownerId, "membership.remove", roomId, { agent_id: agentId });
  return { ok: true, room: roomId, agent_id: agentId };
}

/** Non-DM, non-archived rooms this agent isn't in yet that it can join or request to join. */
export async function discoverRooms(ctx: Ctx, agent: Agent) {
  const { env } = ctx;
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.name, r.created_by, r.join_policy, r.created_at,
            (SELECT COUNT(*) FROM memberships m JOIN agents a ON a.id = m.agent_id WHERE m.room_id = r.id AND a.status = 'active') AS member_count,
            (SELECT id FROM room_join_requests j WHERE j.room_id = r.id AND j.agent_id = ?1 AND j.status = 'pending' LIMIT 1) AS pending_request_id
     FROM rooms r
     WHERE r.kind = 'room' AND r.archived_at IS NULL
       AND r.id NOT IN (SELECT room_id FROM memberships WHERE agent_id = ?1)
       AND (
         r.created_by = ?2
         OR (
           r.join_policy IN ('request', 'open')
           AND r.created_by NOT IN (SELECT owner_id FROM contact_rules WHERE agent_id = ?1 AND rule = 'block')
           AND r.created_by IN (
             SELECT DISTINCT a2.owner_id FROM memberships m1
             JOIN agents mine ON mine.id = m1.agent_id AND mine.owner_id = ?2
             JOIN memberships m2 ON m2.room_id = m1.room_id
             JOIN agents a2 ON a2.id = m2.agent_id AND a2.status = 'active'
           )
         )
       )
     ORDER BY (r.created_by = ?2) DESC, r.created_at DESC LIMIT 100`,
  ).bind(agent.id, agent.owner_id).all<Record<string, any>>();
  return {
    rooms: results.map((r) => ({
      id: r.id, name: r.name, created_by: r.created_by, join_policy: r.join_policy,
      member_count: r.member_count,
      can_join_directly: r.created_by === agent.owner_id && r.join_policy === "open",
      pending_request_id: r.pending_request_id ?? null,
    })),
  };
}

/** Agent self-join: joins immediately if same-owner + open, otherwise creates a join request for the room's owner. */
export async function requestJoinRoom(ctx: Ctx, agent: Agent, roomId: string, b: Record<string, unknown>) {
  const { env } = ctx;
  const r = await env.DB.prepare(
    "SELECT id, name, kind, created_by, archived_at, join_policy FROM rooms WHERE id = ?",
  ).bind(roomId).first<RoomRow>();
  if (!r || r.kind !== "room" || r.archived_at) throw new HttpError(404, "room_not_found");

  const already = await env.DB.prepare("SELECT 1 AS ok FROM memberships WHERE room_id = ? AND agent_id = ?")
    .bind(roomId, agent.id).first();
  if (already) return { status: 200, body: { status: "joined", room: roomId, already_member: true } };

  const sameOwner = r.created_by === agent.owner_id;
  if (!sameOwner) {
    if (r.join_policy === "invite") throw new HttpError(404, "room_not_found");
    const blocked = await env.DB.prepare("SELECT 1 AS ok FROM contact_rules WHERE owner_id = ? AND agent_id = ? AND rule = 'block'")
      .bind(r.created_by, agent.id).first();
    if (blocked) throw new HttpError(403, "not_allowed", "This owner doesn't accept requests from this agent");
    const inNetwork = await env.DB.prepare(
      `SELECT 1 AS ok FROM memberships m1
       JOIN agents mine ON mine.id = m1.agent_id AND mine.owner_id = ?1
       JOIN memberships m2 ON m2.room_id = m1.room_id
       JOIN agents a2 ON a2.id = m2.agent_id AND a2.owner_id = ?2 AND a2.status = 'active' LIMIT 1`,
    ).bind(agent.owner_id, r.created_by).first();
    if (!inNetwork) throw new HttpError(404, "room_not_found");
  }

  if (sameOwner && r.join_policy === "open") {
    await addMember(env, roomId, agent.id, "post", false);
    await audit(env, agent.id, "room.join", roomId);
    return { status: 200, body: { status: "joined", room: roomId } };
  }

  const existing = await env.DB.prepare(
    "SELECT id FROM room_join_requests WHERE room_id = ? AND agent_id = ? AND status = 'pending'",
  ).bind(roomId, agent.id).first<{ id: string }>();
  if (existing) {
    return { status: 202, body: { status: "pending", request_id: existing.id, room: roomId, approval_url: approvalUrl(ctx, existing.id) } };
  }
  const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM room_join_requests WHERE agent_id = ? AND status = 'pending'")
    .bind(agent.id).first<{ n: number }>();
  if ((pending?.n ?? 0) >= MAX_PENDING_PER_AGENT) throw new HttpError(429, "too_many_pending", "Too many room join requests waiting for approval");

  const id = newId("jreq");
  const note = str(b.note, "note", 500) ?? null;
  await env.DB.prepare(
    `INSERT INTO room_join_requests (id, room_id, agent_id, agent_owner, room_owner, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, roomId, agent.id, agent.owner_id, r.created_by, note, Date.now()).run();
  await audit(env, agent.id, "room.join_request", id, { room: roomId, room_owner: r.created_by });
  await ownerNotice(ctx, r.created_by, "join_request_pending", id, { room: roomId, agent_id: agent.id });
  return { status: 202, body: { status: "pending", request_id: id, room: roomId, approval_url: approvalUrl(ctx, id) } };
}

/** The room's creator approves or denies a room join request. */
export async function decideJoinRequest(ctx: Ctx, owner: Owner, id: string, b: Record<string, unknown>) {
  const { env } = ctx;
  const action = str(b.action, "action", 16, true)!;
  if (action !== "approve" && action !== "deny") throw new HttpError(400, "invalid_action", "action must be approve or deny");
  const row = await env.DB.prepare(
    "SELECT id, room_id, agent_id, agent_owner, room_owner, status FROM room_join_requests WHERE id = ? AND room_owner = ?",
  ).bind(id, owner.id).first<{ id: string; room_id: string; agent_id: string; agent_owner: string; room_owner: string; status: string }>();
  if (!row) throw new HttpError(404, "join_request_not_found");
  if (row.status !== "pending") throw new HttpError(409, "already_decided", `This request was already ${row.status}`);

  const now = Date.now();
  const status = action === "approve" ? "approved" : "denied";
  const role = (str(b.role, "role", 8) ?? "post") as "post" | "read";
  if (role !== "post" && role !== "read") throw new HttpError(400, "invalid_field", "role must be post or read");
  const canManage = bool(b.can_manage, "can_manage", false);

  const claimed = await env.DB.prepare(
    "UPDATE room_join_requests SET status = ?, role = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'",
  ).bind(status, role, now, owner.id, id).run();
  if (!claimed.meta.changes) throw new HttpError(409, "already_decided");

  if (action === "approve") {
    const active = await env.DB.prepare("SELECT 1 AS ok FROM agents WHERE id = ? AND status = 'active'").bind(row.agent_id).first();
    if (!active) throw new HttpError(409, "requester_gone", "The requesting agent was revoked");
    await addMember(env, row.room_id, row.agent_id, role, canManage);
  }
  await audit(env, owner.id, `join_request.${action}`, id, { room: row.room_id, agent_id: row.agent_id, role });
  const event: ApprovalEvent = { kind: "approval", id, status: action === "approve" ? "allowed" : "denied", room: action === "approve" ? row.room_id : null };
  ctx.waitUntil(agentHub(env, row.agent_id).notify(event).catch(() => 0));
  return { id, status, room: row.room_id, agent_id: row.agent_id, ...(action === "approve" ? { role, can_manage: canManage } : {}) };
}
