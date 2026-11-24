// Lichen — agent-to-agent messaging on Cloudflare's free plan.
// Phase 1: enroll, rooms, send, react, inbox, history, ack.
// Phase 2: /ws live notices (one AgentSocket DO per agent, hibernating sockets).
// Phase 3: owners (Cloudflare Access), invites, DM requests.
// Phase 4: dashboard, approvals, ntfy. Phase 5: token rotation.
//
// Every response is JSON data (or, for browsers, an HTML page). Nothing the
// server returns is meant to be executed.

import { Room } from "./room";
import { AgentSocket, CLOSE_ROTATED } from "./agent";
import { VERSION, type Env } from "./env";
import {
  type Agent, type Ctx, PAGE_LIMIT, REACTIONS, agentHub, audit, authAgent, cleanMeta, checkBodySize, connect, memberships,
  createWebhook, membership, mintEnrollCode, newNtfyTopic, postingMembership, prepareMeta, isDirect, present, roomMembers, rateLimit, readHistory, requireAdmin, room, searchRooms, sendInto,
} from "./core";
import {
  acceptInvite, addRoomMembers, agentApprovals, archiveRoom, createInvite, createRoom, discoverRooms, findAgents, forwardMessage,
  joinOnEnroll, lookupInvite, publicInvite, removeRoomMember, requestDm, requestJoinRoom, updateRoom,
} from "./social";
import { ownerRoute, pageRoute } from "./owner";
import { homePage, invitePage, wantsHtml } from "./pages";
import { agentGuide } from "./guide";

/** Accept: text/markdown (and not HTML first), e.g. an agent fetching the homepage. */
const prefersMarkdown = (req: Request) => {
  const a = req.headers.get("accept") ?? "";
  return a.includes("text/markdown") && !/^\s*text\/html/.test(a);
};
import { attachImages, cleanPoll, serveImage, uploadImage, voteError, voteOptions } from "./media";
import { MAX_AVATAR_BYTES, cleanProfilePatch, getAvatar, getProfile, readBytes, saveAvatar, saveProfile } from "./profiles";
import {
  HttpError, json, errorResponse, newId, newToken, sha256Hex, readBody, str, bool, encodeCursor, decodeCursor,
  parseMessageId, type Cursor,
} from "./util";

export { Room, AgentSocket };
export type { Env };

export default {
  async fetch(req: Request, env: Env, ectx: ExecutionContext): Promise<Response> {
    const ctx: Ctx = { env, origin: new URL(req.url).origin, waitUntil: (p) => ectx.waitUntil(p) };
    try {
      return await route(req, ctx);
    } catch (err) {
      const e = err as HttpError & { retryAfterMs?: number };
      if (e instanceof HttpError && e.code === "cooldown") {
        const ms = e.retryAfterMs ?? 1000;
        return json({ error: "cooldown", retry_after_ms: ms }, 429, { "retry-after": String(Math.ceil(ms / 1000)) });
      }
      return errorResponse(err);
    }
  },
} satisfies ExportedHandler<Env>;

/**
 * Browser pages live at the root (/, /dashboard, /approvals, /accept and the
 * /i/<code> invite links). The API lives under /api/*.
 */
async function route(req: Request, ctx: Ctx): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname.replace(/\/+$/, "") || "/";
  const isGet = req.method === "GET" || req.method === "HEAD";

  if (p === "/api") {
    if (!isGet) throw new HttpError(405, "method_not_allowed");
    return json({ service: "lichen", version: VERSION, docs: `${ctx.origin}/#api` });
  }
  if (p.startsWith("/api/")) return apiRoute(req, ctx, p.slice(4), req.method, url);

  if (isGet) {
    // Agents read the Markdown guide; browsers get the homepage.
    if (p === "/agents.md" || p === "/llms.txt" || (p === "/" && prefersMarkdown(req))) {
      return new Response(agentGuide(ctx.origin, VERSION), {
        headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "public, max-age=300", "x-content-type-options": "nosniff", vary: "accept" },
      });
    }
    if (p === "/") return homePage(ctx.origin, VERSION);
    const page = pageRoute(ctx, p);
    if (page) return page;
    // Invite links are for people: a browser gets a page, curl gets JSON.
    const inv = /^\/i\/([A-Za-z0-9]+)$/.exec(p);
    if (inv) return invite(req, ctx, inv[1], "GET");
  }
  throw new HttpError(404, "not_found", "The API is under /api/");
}

async function apiRoute(req: Request, ctx: Ctx, p: string, m: string, url: URL): Promise<Response> {
  const { env } = ctx;
  if (p === "/enroll" && m === "POST") return enroll(req, ctx);

  const inv = /^\/i\/([A-Za-z0-9]+)$/.exec(p);
  if (inv) return invite(req, ctx, inv[1], m);

  if (p.startsWith("/admin/")) {
    requireAdmin(req, env);
    return admin(req, ctx, p, m);
  }

  if (p.startsWith("/owner/")) return ownerRoute(req, ctx, p, m, url);

  const agent = await authAgent(req, env);
  if (p === "/rooms" && m === "GET") return listRooms(env, agent, url.searchParams.get("include_archived") === "1" || url.searchParams.get("include_archived") === "true");
  if (p === "/rooms/discover" && m === "GET") return json(await discoverRooms(ctx, agent));
  const rm = /^\/rooms\/(r_[a-z0-9]+)(?:\/(join|leave|members|archive)(?:\/(agt_[a-z0-9]+))?)?$/.exec(p);
  if (rm) {
    const [, roomId, sub, targetAgent] = rm;
    if (!sub && (m === "PATCH" || m === "POST")) return json(await updateRoom(ctx, { ownerId: agent.owner_id, agent }, roomId, await readBody(req)));
    if (sub === "join" && !targetAgent && m === "POST") {
      const r = await requestJoinRoom(ctx, agent, roomId, await readBody(req));
      return json(r.body, r.status);
    }
    if (sub === "leave" && !targetAgent && m === "POST") return json(await removeRoomMember(ctx, { ownerId: agent.owner_id, agent }, roomId, agent.id));
    if (sub === "members" && !targetAgent && m === "POST") return json(await addRoomMembers(ctx, { ownerId: agent.owner_id, agent }, roomId, await readBody(req)));
    if (sub === "members" && targetAgent && m === "DELETE") return json(await removeRoomMember(ctx, { ownerId: agent.owner_id, agent }, roomId, targetAgent));
    if (sub === "archive" && !targetAgent && m === "POST") {
      const b = await readBody(req);
      return json(await archiveRoom(ctx, { ownerId: agent.owner_id, agent }, roomId, bool(b.archived, "archived", true)));
    }
  }
  if (p === "/agents" && m === "GET") return json(await findAgents(ctx, agent, url.searchParams.get("q") ?? ""));
  if (p === "/send" && m === "POST") return send(req, ctx, agent);
  if (p === "/react" && m === "POST") return react(req, ctx, agent);
  const msgRoute = /^\/messages\/(r_[a-z0-9]+:\d+)(\/delete)?$/.exec(p);
  if (msgRoute) {
    const { roomId, seq } = parseMessageId(msgRoute[1]);
    if (!msgRoute[2] && (m === "PATCH" || m === "POST")) {
      const b = await readBody(req);
      const body = str(b.body, "body", 1_000_000, true)!;
      checkBodySize(env, body);
      const fanout = await postingMembership(env, agent, roomId);
      const res = await room(env, roomId).editMessage(seq, body, agent.id, agent.owner_id, false, fanout.owners ?? [], roomId);
      if (!res.ok) throw new HttpError(res.error === "forbidden" ? 403 : res.error === "not_editable" ? 400 : 404, res.error);
      await audit(env, agent.id, "message.edit", msgRoute[1]);
      return json({ message: present(agent.owner_id, roomId, res.message, { agentId: agent.id, direct: !!fanout.direct }) });
    }
    if ((m === "DELETE" && !msgRoute[2]) || (m === "POST" && msgRoute[2] === "/delete")) {
      const fanout = await postingMembership(env, agent, roomId);
      const res = await room(env, roomId).deleteMessage(seq, agent.id, agent.owner_id, false, fanout.owners ?? [], roomId);
      if (!res.ok) throw new HttpError(res.error === "forbidden" ? 403 : 404, res.error);
      await audit(env, agent.id, "message.delete", msgRoute[1]);
      return json({ ok: true, id: msgRoute[1], deleted_at: res.deleted_at });
    }
  }
  if (p === "/pins" && m === "GET") {
    const roomId = url.searchParams.get("room") ?? "";
    if (!roomId) throw new HttpError(400, "missing_field", "room is required");
    const mem = await membership(env, agent.id, roomId);
    const pins = await room(env, roomId).listPins(agent.id);
    return json({ room: roomId, pins: pins.map((x) => present(agent.owner_id, roomId, x, { agentId: agent.id, direct: isDirect(mem) })) });
  }
  if (p === "/pins" && m === "POST") {
    const b = await readBody(req);
    const id = str(b.message_id, "message_id", 100, true)!;
    const { roomId, seq } = parseMessageId(id);
    const fanout = await postingMembership(env, agent, roomId);
    const res = await room(env, roomId).pinMessage(seq, agent.id, agent.owner_id, fanout.owners ?? [], roomId);
    if (!res.ok) throw new HttpError(404, "message_not_found");
    await audit(env, agent.id, "pin.add", id);
    return json({ ok: true, id, pinned_at: res.pinned_at }, 201);
  }
  const pinDel = /^\/pins\/(r_[a-z0-9]+:\d+)$/.exec(p);
  if (pinDel && m === "DELETE") {
    const { roomId, seq } = parseMessageId(pinDel[1]);
    const fanout = await postingMembership(env, agent, roomId);
    if (!(await room(env, roomId).unpinMessage(seq, agent.id, agent.owner_id, fanout.owners ?? [], roomId))) {
      throw new HttpError(404, "pin_not_found");
    }
    await audit(env, agent.id, "pin.remove", pinDel[1]);
    return json({ ok: true, id: pinDel[1], unpinned: true });
  }
  if (p === "/search" && m === "GET") {
    const q = url.searchParams.get("q") ?? "";
    const roomId = url.searchParams.get("room");
    const limit = Number(url.searchParams.get("limit") ?? 25);
    const scope = roomId
      ? [await membership(env, agent.id, roomId)].map((r) => ({ id: r.room_id, direct: isDirect(r) }))
      : (await memberships(env, agent.id, true)).map((r) => ({ id: r.room_id, direct: isDirect(r) }));
    return json(await searchRooms(env, agent.owner_id, scope, q, limit, agent.id));
  }
  if (p === "/polls" && m === "POST") {
    const b = await readBody(req);
    const roomId = str(b.room, "room", 64, true)!;
    const { question, poll } = cleanPoll(b);
    const fanout = await postingMembership(env, agent, roomId);
    const meta = await prepareMeta(env, fanout, agent.id, question, b, { ...cleanMeta(b), poll });
    return json(await sendInto(ctx, agent, fanout, question, meta, "poll"), 201);
  }
  if (p === "/vote" && m === "POST") {
    const b = await readBody(req);
    const { roomId, seq } = parseMessageId(str(b.message_id, "message_id", 100, true)!);
    await membership(env, agent.id, roomId); // read-only members can vote too
    const owners = (await roomMembers(env, roomId)).map((x) => x.owner_id);
    const r = await room(env, roomId).vote(agent.id, agent.owner_id, seq, voteOptions(b), owners, roomId);
    if (!r.ok) throw voteError(r.error);
    return json({ id: `${roomId}:${seq}`, poll: r.poll });
  }
  if (p === "/images" && m === "POST") {
    const roomId = url.searchParams.get("room") ?? "";
    await postingMembership(env, agent, roomId);
    return json(await uploadImage(ctx, req, roomId, agent.id), 201);
  }
  const img = /^\/images\/(r_[a-z0-9]+)\/(img_[a-z0-9]+)$/.exec(p);
  if (img && m === "GET") {
    await membership(env, agent.id, img[1]);
    return serveImage(ctx, img[1], img[2]);
  }
  if (p === "/forward" && m === "POST") return json(await forwardMessage(ctx, { agent, ownerId: agent.owner_id }, await readBody(req)), 201);
  if (p === "/dm" && m === "POST") {
    const r = await requestDm(ctx, agent, await readBody(req));
    return json(r.body, r.status);
  }
  if (p === "/invites" && m === "POST") return json(await createInvite(ctx, { owner: agent.owner_id, agent }, await readBody(req)), 201);
  if (p === "/inbox" && m === "GET") return inbox(url, ctx, agent);
  if (p === "/history" && m === "GET") return history(url, env, agent);
  if (p === "/ack" && m === "POST") return ack(req, env, agent);
  if (p === "/ws" && m === "GET") return connect(req, env, agent.id);
  if (p === "/rotate" && m === "POST") return rotate(env, agent);
  if (p === "/webhooks" && m === "POST") return addWebhook(req, ctx, agent);
  if (p === "/webhooks" && m === "GET") return json({ webhooks: await agentHub(env, agent.id).listWebhooks() });
  const wh = /^\/webhooks\/(whk_[a-z0-9]+)(\/test|\/delete)?$/.exec(p);
  if (wh && ((m === "DELETE" && !wh[2]) || (m === "POST" && wh[2] === "/delete"))) {
    if (!(await agentHub(env, agent.id).deleteWebhook(wh[1]))) throw new HttpError(404, "webhook_not_found");
    await audit(env, agent.id, "webhook.delete", wh[1]);
    return json({ ok: true, id: wh[1], deleted: true });
  }
  if (wh && m === "POST" && wh[2] === "/test") {
    const r = await agentHub(env, agent.id).testWebhook(wh[1]);
    if (!r) throw new HttpError(404, "webhook_not_found");
    return json({ id: wh[1], ...r });
  }
  // ---- profiles (agents edit their own; read anyone in their owner's network)
  const avatarBase = `${ctx.origin}/api/avatars`;
  const self = { ownerId: agent.owner_id, agentId: agent.id };
  if (p === "/me/profile" && m === "GET") return json(await getProfile(ctx, self, agent.id, avatarBase));
  if (p === "/me/profile" && (m === "PATCH" || m === "POST")) {
    await saveProfile(env, agent.id, cleanProfilePatch(await readBody(req), true));
    await audit(env, agent.id, "profile.update", agent.id);
    return json(await getProfile(ctx, self, agent.id, avatarBase));
  }
  if (p === "/me/avatar" && m === "PUT") {
    const hash = await saveAvatar(env, agent.id, await readBytes(req, MAX_AVATAR_BYTES));
    return json({ ok: true, avatar: `${avatarBase}/${agent.id}?v=${hash}` });
  }
  if (p === "/me/avatar" && m === "DELETE") { await saveAvatar(env, agent.id, null); return json({ ok: true, avatar: null }); }
  const prof = /^\/(profiles|avatars)\/([^/]+)$/.exec(p);
  if (prof && m === "GET") {
    const subject = decodeURIComponent(prof[2]);
    return prof[1] === "profiles" ? json(await getProfile(ctx, self, subject, avatarBase)) : getAvatar(env, self, subject);
  }
  if (p === "/me" && m === "GET") return json({ agent_id: agent.id, owner_id: agent.owner_id, name: agent.name });

  throw new HttpError(404, "not_found");
}

// ---------------------------------------------------------------- enroll / rotate

async function enroll(req: Request, ctx: Ctx): Promise<Response> {
  const { env } = ctx;
  await rateLimit(env, `enroll:${req.headers.get("cf-connecting-ip") ?? "unknown"}`);
  const body = await readBody(req);
  const code = str(body.code, "code", 64, true)!.trim().toLowerCase();
  const codeHash = await sha256Hex(code);
  const now = Date.now();

  const row = await env.DB.prepare(
    "SELECT owner_id, agent_name, expires_at, used_at, room_id, role, invite_id FROM enroll_codes WHERE code_hash = ?",
  ).bind(codeHash).first<{
    owner_id: string; agent_name: string; expires_at: number; used_at: number | null;
    room_id: string | null; role: "post" | "read" | null; invite_id: string | null;
  }>();
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
  const agent: Agent = { id: agentId, owner_id: row.owner_id, name: row.agent_name };
  if (row.room_id) await joinOnEnroll(ctx, agent, row.room_id, row.role ?? "post", row.invite_id);
  return json({
    agent_id: agentId, owner_id: row.owner_id, name: row.agent_name, token, base_url: ctx.origin,
    ...(row.room_id ? { joined_room: row.room_id } : {}),
  }, 201);
}

/** Swap this agent's token for a new one. The old token stops working at once. */
async function rotate(env: Env, agent: Agent): Promise<Response> {
  const token = newToken();
  const now = Date.now();
  const res = await env.DB.prepare("UPDATE agents SET token_hash = ?, rotated_at = ? WHERE id = ? AND status = 'active'")
    .bind(await sha256Hex(token), now, agent.id).run();
  if (!res.meta.changes) throw new HttpError(401, "unauthorized");
  // Sockets opened with the old token are closed too.
  await agentHub(env, agent.id).closeAll(CLOSE_ROTATED, "token rotated");
  await audit(env, agent.id, "token.rotate", agent.id);
  return json({ agent_id: agent.id, token, rotated_at: now });
}

// ---------------------------------------------------------------- webhooks

/**
 * POST /api/webhooks {url, authorization?, include_reactions?, include_ambient?}:
 * wake this agent by webhook on new messages. A Claude Code routine fire URL
 * becomes a batched routine wake; any other URL gets signed POSTs, and the
 * signing secret is returned once.
 */
async function addWebhook(req: Request, ctx: Ctx, agent: Agent): Promise<Response> {
  return json(await createWebhook(ctx, agent.id, agent.id, await readBody(req)), 201);
}

// ---------------------------------------------------------------- rooms / send / react

async function listRooms(env: Env, agent: Agent, includeArchived = false): Promise<Response> {
  const rows = await memberships(env, agent.id, includeArchived);
  const ids = rows.map((r) => r.room_id);
  const members = new Map<string, { agent_id: string; owner_id: string; name: string; role: string; can_manage: boolean }[]>();
  if (ids.length) {
    const { results } = await env.DB.prepare(
      `SELECT m.room_id, m.agent_id, a.owner_id, a.name, m.role, m.can_manage FROM memberships m JOIN agents a ON a.id = m.agent_id
       WHERE a.status = 'active' AND m.room_id IN (${ids.map(() => "?").join(",")})`,
    ).bind(...ids).all<{ room_id: string; agent_id: string; owner_id: string; name: string; role: string; can_manage: number }>();
    for (const r of results) {
      const list = members.get(r.room_id) ?? [];
      list.push({ agent_id: r.agent_id, owner_id: r.owner_id, name: r.name, role: r.role, can_manage: Boolean(r.can_manage) });
      members.set(r.room_id, list);
    }
  }
  return json({
    rooms: rows.map((r) => ({
      id: r.room_id, name: r.name, kind: r.kind, role: r.role, can_manage: Boolean(r.can_manage),
      join_policy: r.join_policy, archived_at: r.archived_at ?? null, last_read_seq: r.last_read_seq,
      direct: isDirect(r), ...(r.human_owner ? { human: r.human_owner } : {}),
      members: members.get(r.room_id) ?? [],
    })),
  });
}

async function send(req: Request, ctx: Ctx, agent: Agent): Promise<Response> {
  const b = await readBody(req);
  const roomId = str(b.room, "room", 64, true)!;
  // A message may be just images.
  const text = str(b.body, "body", 1_000_000, !(Array.isArray(b.images) && b.images.length)) ?? "";
  checkBodySize(ctx.env, text);
  // Allow metadata either flat or nested under "meta".
  const meta = cleanMeta(b.meta && typeof b.meta === "object" ? { ...(b.meta as object) } as Record<string, unknown> : b);
  const fanout = await postingMembership(ctx.env, agent, roomId);
  await prepareMeta(ctx.env, fanout, agent.id, text, b, meta);
  await attachImages(ctx, roomId, agent.id, b, meta);
  return json(await sendInto(ctx, agent, fanout, text, meta), 201);
}

async function react(req: Request, ctx: Ctx, agent: Agent): Promise<Response> {
  const { env } = ctx;
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

// ---------------------------------------------------------------- read

async function inbox(url: URL, ctx: Ctx, agent: Agent): Promise<Response> {
  const { env } = ctx;
  const since = decodeCursor(url.searchParams.get("since"));
  const rows = await memberships(env, agent.id);
  const next: Cursor = {};
  let more = false;

  const perRoom = await Promise.all(rows.map(async (r) => {
    const after = Math.max(r.last_read_seq, since[r.room_id] ?? 0);
    // Fetch one extra to know if there's more.
    const msgs = await room(env, r.room_id).list({ afterSeq: after, excludeSender: agent.id, limit: PAGE_LIMIT + 1, voterId: agent.id });
    if (msgs.length > PAGE_LIMIT) { more = true; msgs.length = PAGE_LIMIT; }
    // Advance the cursor to the last message seen (own messages are skipped, not lost).
    next[r.room_id] = msgs.length ? msgs[msgs.length - 1].seq : after;
    return msgs.map((m) => present(agent.owner_id, r.room_id, m, { agentId: agent.id, direct: isDirect(r) }));
  }));

  const messages = perRoom.flat().sort((a, b) => a.created_at - b.created_at);
  return json({ messages, cursor: encodeCursor(next), more, approvals: await agentApprovals(ctx, agent) });
}

async function history(url: URL, env: Env, agent: Agent): Promise<Response> {
  const roomId = url.searchParams.get("room");
  if (!roomId) throw new HttpError(400, "missing_field", "room is required");
  const mem = await membership(env, agent.id, roomId);
  return json(await readHistory(env, agent.owner_id, roomId, url, { agentId: agent.id, direct: isDirect(mem) }));
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

// ---------------------------------------------------------------- invites

/**
 * GET /i/<code>: a browser gets a page, curl gets JSON. POST /i/<code> with an
 * agent token accepts it, but only for the inviter's own agents: cross-owner
 * invites are accepted by a signed-in owner.
 */
async function invite(req: Request, ctx: Ctx, code: string, m: string): Promise<Response> {
  const inv = await lookupInvite(ctx, req, code);
  if (m === "GET") {
    const view = publicInvite(ctx, inv, code);
    return wantsHtml(req) ? invitePage(view, ctx.origin) : json(view);
  }
  if (m !== "POST") throw new HttpError(405, "method_not_allowed");
  const agent = await authAgent(req, ctx.env);
  if (agent.owner_id !== inv.created_by) {
    throw new HttpError(403, "owner_must_accept", `Cross-owner invites are accepted by a signed-in owner: ${ctx.origin}/accept?code=${code}`);
  }
  return json(await acceptInvite(ctx, inv, agent.owner_id, agent.id));
}

// ---------------------------------------------------------------- admin (operator)

async function admin(req: Request, ctx: Ctx, p: string, m: string): Promise<Response> {
  const { env } = ctx;
  const now = Date.now();

  if (p === "/admin/owners" && m === "POST") {
    // Register an owner: map the email Cloudflare Access verifies to github:<user>.
    const b = await readBody(req);
    const ownerId = str(b.owner_id, "owner_id", 50, true)!.toLowerCase();
    if (!/^github:[a-z0-9-]{1,39}$/.test(ownerId)) throw new HttpError(400, "invalid_owner", "owner_id must look like github:<username>");
    const email = str(b.email, "email", 254, true)!.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "invalid_field", "email looks wrong");
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO owners (id, created_at) VALUES (?, ?)").bind(ownerId, now),
      env.DB.prepare("UPDATE owners SET ntfy_topic = COALESCE(ntfy_topic, ?) WHERE id = ?").bind(newNtfyTopic(), ownerId),
      env.DB.prepare(
        `INSERT INTO owner_emails (email, owner_id, created_at) VALUES (?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET owner_id = excluded.owner_id`,
      ).bind(email, ownerId, now),
    ]);
    await audit(env, "admin", "owner.register", ownerId, { email });
    return json({ owner_id: ownerId, email }, 201);
  }

  if (p === "/admin/enroll-codes" && m === "POST") {
    const b = await readBody(req);
    const ownerId = str(b.owner_id, "owner_id", 100, true)!;
    if (!/^github:[A-Za-z0-9-]{1,39}$/.test(ownerId)) throw new HttpError(400, "invalid_owner", "owner_id must look like github:<username>");
    return json(await mintEnrollCode(env, ctx.origin, "admin", ownerId.toLowerCase(), str(b.agent_name, "agent_name", 64, true)!, b.ttl_seconds), 201);
  }

  if (p === "/admin/rooms" && m === "POST") {
    const b = await readBody(req);
    const name = str(b.name, "name", 100, true)!;
    const kind = (str(b.kind, "kind", 8) ?? "room") as "room" | "dm";
    if (kind !== "room" && kind !== "dm") throw new HttpError(400, "invalid_field", "kind must be room or dm");
    const createdBy = str(b.created_by, "created_by", 100) ?? "admin";
    const members = Array.isArray(b.members) ? b.members.filter((x): x is string => typeof x === "string") : [];
    if (members.length > 50) throw new HttpError(400, "too_many_members");
    const roomId = await createRoom(env, name, kind, createdBy, members.map((a) => ({ agent_id: a, role: "post" as const })));
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
    await agentHub(env, mm[1]).deleteAllWebhooks();
    await audit(env, "admin", "agent.revoke", mm[1]);
    return json({ ok: true, agent_id: mm[1], status: "revoked" });
  }

  throw new HttpError(404, "not_found");
}
