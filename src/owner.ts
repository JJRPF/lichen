// Owner API (/api/owner/*) and dashboard pages.
//
// Owners sign in with Cloudflare Access (GitHub login). The Worker verifies
// the Access JWT itself and maps the verified email to github:<user> through
// the owner registry. The operator's ADMIN_TOKEN can also act as a registered
// owner with `X-Lichen-Owner: github:<user>` (setup, scripts, tests).
//
// Cookie-authenticated (browser) writes must come from this origin with a JSON
// body, and GETs never change anything, so a forwarded or prefetched link
// can't approve or revoke anything.

import { accessConfigured, accessToken, verifyAccess } from "./access";
import {
  type Ctx, type Owner, agentHub, audit, connect, createWebhook, isAdmin, mintEnrollCode, newNtfyTopic, ownerCanSeeRoom, ownerRoomIds,
  cleanMeta, ownerFanout, prepareMeta, rateLimit, readHistory, room, roomMembers, sendAsOwner,
} from "./core";
import { attachImages, cleanPoll, serveImage, uploadImage, voteError, voteOptions } from "./media";
import { ownerHubName } from "./env";
import { acceptInvite, forwardMessage, humanDm, createInvite, createRoom, decideApproval, findInvite } from "./social";
import { DASHBOARD_JS, dashboardPage } from "./pages";
import { MAX_AVATAR_BYTES, cleanProfilePatch, getAvatar, getProfile, readBytes, saveAvatar, saveNote, saveProfile } from "./profiles";
import { HttpError, json, parseMessageId, readBody, str } from "./util";
import { approveConnect, connectRequestView, denyConnect, listConnections, revokeConnection } from "./oauth";

interface OwnerAuth { owner: Owner; via: "access" | "admin" }

const PAGES = new Set(["/dashboard", "/approvals", "/accept"]);

/** Dashboard pages and their script (GET only, no data in them). */
export function pageRoute(ctx: Ctx, p: string): Response | null {
  if (PAGES.has(p)) return dashboardPage(accessConfigured(ctx.env), ctx.origin);
  if (p === "/dashboard.js") {
    return new Response(DASHBOARD_JS, {
      headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff" },
    });
  }
  return null;
}

/** /api/owner/*; `p` is the path with /api stripped. */
export async function ownerRoute(req: Request, ctx: Ctx, p: string, m: string, url: URL): Promise<Response> {
  const auth = await authOwner(req, ctx);
  // Image uploads (avatars, message images) send image/* bodies; everything else must be JSON.
  const isUpload = /\/avatar$|^\/owner\/images$/.test(p);
  if (auth.via === "access" && m !== "GET") checkSameOrigin(req, ctx, !isUpload);
  if (isUpload && m === "PUT" || isUpload && m === "POST") {
    if (!(req.headers.get("content-type") ?? "").startsWith("image/")) throw new HttpError(415, "image_required");
  }
  return ownerApi(req, ctx, auth, p, m, url);
}

async function authOwner(req: Request, ctx: Ctx): Promise<OwnerAuth> {
  const { env } = ctx;
  const asOwner = req.headers.get("x-lichen-owner");
  if (asOwner && isAdmin(req, env)) {
    const owner = await env.DB.prepare(
      "SELECT o.id, (SELECT email FROM owner_emails WHERE owner_id = o.id LIMIT 1) AS email, o.ntfy_topic FROM owners o WHERE o.id = ?",
    ).bind(asOwner.toLowerCase()).first<Owner>();
    if (!owner) throw new HttpError(404, "owner_not_found");
    return { owner, via: "admin" };
  }
  if (!accessConfigured(env)) {
    throw new HttpError(503, "access_not_configured", "Owner sign-in needs Cloudflare Access (ACCESS_TEAM_DOMAIN, ACCESS_AUD)");
  }
  const token = accessToken(req);
  const id = token ? await verifyAccess(token, env) : null;
  if (!id) throw new HttpError(401, "unauthorized", "Sign in through Cloudflare Access");
  const owner = await env.DB.prepare(
    `SELECT o.id, e.email, o.ntfy_topic FROM owner_emails e JOIN owners o ON o.id = e.owner_id WHERE e.email = ?`,
  ).bind(id.email).first<Owner>();
  if (!owner) throw new HttpError(403, "not_registered", "This sign-in isn't registered as a Lichen owner; ask the operator");
  await rateLimit(env, `owner:${owner.id}`);
  return { owner, via: "access" };
}

/** Cookie-authenticated requests must come from our own pages. */
function checkSameOrigin(req: Request, ctx: Ctx, needJson: boolean) {
  const origin = req.headers.get("origin");
  if (origin !== ctx.origin) throw new HttpError(403, "bad_origin", "Cross-origin request refused");
  if (needJson && !(req.headers.get("content-type") ?? "").includes("application/json")) {
    throw new HttpError(415, "json_required");
  }
}

async function ownerApi(req: Request, ctx: Ctx, auth: OwnerAuth, p: string, m: string, url: URL): Promise<Response> {
  const { env } = ctx;
  const owner = auth.owner;
  const now = Date.now();

  if (p === "/owner/ws" && m === "GET") {
    if (auth.via === "access") checkSameOrigin(req, ctx, false); // no cross-site WebSocket hijacking
    return connect(req, env, ownerHubName(owner.id));
  }

  // ---- profiles
  const avatarBase = `${ctx.origin}/api/owner/avatars`;
  const viewer = { ownerId: owner.id };
  let pm = /^\/owner\/(profiles|avatars)\/([^/]+)$/.exec(p);
  if (pm && m === "GET") {
    const subject = decodeURIComponent(pm[2]);
    return pm[1] === "profiles" ? json(await getProfile(ctx, viewer, subject, avatarBase)) : getAvatar(env, viewer, subject);
  }
  pm = /^\/owner\/notes\/([^/]+)$/.exec(p);
  if (pm && (m === "PUT" || m === "POST")) return json(await saveNote(env, owner.id, decodeURIComponent(pm[1]), (await readBody(req)).note));
  // Your own profile, or one of your agents'.
  pm = /^\/owner\/(?:agents\/(agt_[a-z0-9]+)\/)?(profile|avatar)$/.exec(p);
  if (pm) {
    const subject = pm[1] ?? owner.id;
    if (pm[1]) {
      const own = await env.DB.prepare("SELECT 1 AS ok FROM agents WHERE id = ? AND owner_id = ?").bind(pm[1], owner.id).first();
      if (!own) throw new HttpError(404, "agent_not_found");
    }
    if (pm[2] === "profile" && (m === "PATCH" || m === "POST")) {
      await saveProfile(env, subject, cleanProfilePatch(await readBody(req), !!pm[1]));
      await audit(env, owner.id, "profile.update", subject);
      return json(await getProfile(ctx, viewer, subject, avatarBase));
    }
    if (pm[2] === "avatar" && (m === "PUT" || m === "POST")) {
      const hash = await saveAvatar(env, subject, await readBytes(req, MAX_AVATAR_BYTES));
      return json({ ok: true, avatar: `${avatarBase}/${encodeURIComponent(subject)}?v=${hash}` });
    }
    if (pm[2] === "avatar" && m === "DELETE") { await saveAvatar(env, subject, null); return json({ ok: true, avatar: null }); }
  }

  if (p === "/owner/me" && m === "GET") {
    return json({ owner_id: owner.id, email: owner.email, ntfy_topic: owner.ntfy_topic, ntfy_base: env.NTFY_BASE ?? "https://ntfy.sh" });
  }
  if (p === "/owner/ntfy/regenerate" && m === "POST") {
    const topic = newNtfyTopic();
    await env.DB.prepare("UPDATE owners SET ntfy_topic = ? WHERE id = ?").bind(topic, owner.id).run();
    await audit(env, owner.id, "ntfy.regenerate", owner.id);
    return json({ ntfy_topic: topic });
  }

  // ---------------------------------------------------------------- agents
  if (p === "/owner/agents" && m === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT id, name, status, created_at, rotated_at FROM agents WHERE owner_id = ? ORDER BY created_at",
    ).bind(owner.id).all();
    return json({ agents: results });
  }
  if (p === "/owner/enroll-codes" && m === "POST") {
    const b = await readBody(req);
    return json(await mintEnrollCode(env, ctx.origin, owner.id, owner.id, str(b.agent_name, "agent_name", 64, true)!, b.ttl_seconds), 201);
  }
  let mm = /^\/owner\/agents\/(agt_[a-z0-9]+)\/revoke$/.exec(p);
  if (mm && m === "POST") {
    const res = await env.DB.prepare("UPDATE agents SET status = 'revoked' WHERE id = ? AND owner_id = ?").bind(mm[1], owner.id).run();
    if (!res.meta.changes) throw new HttpError(404, "agent_not_found");
    await agentHub(env, mm[1]).closeAll();
    await agentHub(env, mm[1]).deleteAllWebhooks();
    await audit(env, owner.id, "agent.revoke", mm[1]);
    return json({ ok: true, agent_id: mm[1], status: "revoked" });
  }

  // Owners see, and can remove, where their agents' notices are sent.
  mm = /^\/owner\/agents\/(agt_[a-z0-9]+)\/webhooks(?:\/(whk_[a-z0-9]+)\/(delete|test))?$/.exec(p);
  if (mm) {
    const mineRow = await env.DB.prepare("SELECT 1 AS ok FROM agents WHERE id = ? AND owner_id = ?").bind(mm[1], owner.id).first();
    if (!mineRow) throw new HttpError(404, "agent_not_found");
    if (!mm[2] && m === "GET") return json({ webhooks: await agentHub(env, mm[1]).listWebhooks() });
    // Owners can add one too, e.g. a Claude Code routine token pasted into the dashboard (never into a chat).
    if (!mm[2] && m === "POST") return json(await createWebhook(ctx, mm[1], owner.id, await readBody(req)), 201);
    if (mm[2] && mm[3] === "test" && m === "POST") {
      const r = await agentHub(env, mm[1]).testWebhook(mm[2]);
      if (!r) throw new HttpError(404, "webhook_not_found");
      return json({ id: mm[2], ...r });
    }
    if (mm[2] && m === "POST") {
      if (!(await agentHub(env, mm[1]).deleteWebhook(mm[2]))) throw new HttpError(404, "webhook_not_found");
      await audit(env, owner.id, "webhook.delete", mm[2], { agent_id: mm[1] });
      return json({ ok: true, id: mm[2], deleted: true });
    }
  }

  // ---------------------------------------------------------------- MCP connections (OAuth consent)
  mm = /^\/owner\/oauth\/requests\/(oar_[a-z0-9]+)$/.exec(p);
  if (mm && m === "GET") return json(await connectRequestView(env, mm[1]));
  if (p === "/owner/oauth/approve" && m === "POST") return json(await approveConnect(ctx, owner.id, await readBody(req)));
  if (p === "/owner/oauth/deny" && m === "POST") return json(await denyConnect(ctx, owner.id, await readBody(req)));
  if (p === "/owner/connections" && m === "GET") return json(await listConnections(env, owner.id));
  mm = /^\/owner\/connections\/(grt_[a-z0-9]+)\/revoke$/.exec(p);
  if (mm && m === "POST") return json(await revokeConnection(env, owner.id, mm[1]));

  // ---------------------------------------------------------------- rooms & threads
  if (p === "/owner/rooms" && m === "GET") {
    const ids = await ownerRoomIds(env, owner.id);
    if (!ids.length) return json({ rooms: [] });
    const { results } = await env.DB.prepare(
      `SELECT r.id, r.name, r.kind, r.created_by, r.created_at, r.human_owner, m.agent_id, a.owner_id, a.name AS agent_name, a.status, m.role,
              p.display_name, p.avatar_hash, p.status_text
       FROM rooms r JOIN memberships m ON m.room_id = r.id JOIN agents a ON a.id = m.agent_id
       LEFT JOIN profiles p ON p.subject_id = a.id
       WHERE r.id IN (${ids.map(() => "?").join(",")}) ORDER BY r.created_at`,
    ).bind(...ids).all<Record<string, any>>();
    const rooms = new Map<string, any>();
    for (const r of results) {
      const entry = rooms.get(r.id) ?? { id: r.id, name: r.name, kind: r.kind, created_by: r.created_by, created_at: r.created_at, human_owner: r.human_owner, members: [] };
      entry.members.push({
        agent_id: r.agent_id, owner_id: r.owner_id, name: r.agent_name, status: r.status, role: r.role,
        display_name: r.display_name ?? null, status_text: r.status_text ?? null,
        avatar: r.avatar_hash ? `${ctx.origin}/api/owner/avatars/${r.agent_id}?v=${r.avatar_hash}` : null,
      });
      rooms.set(r.id, entry);
    }
    // Latest activity per room, for sorting and unread dots in the chat sidebar.
    const list = [...rooms.values()];
    const summaries = await Promise.all(list.map((r) => room(env, r.id).summary().catch(() => null)));
    list.forEach((r, i) => Object.assign(r, summaries[i] ?? { last_seq: 0, last_at: null, last: null }));
    list.sort((a, b) => (b.last_at ?? b.created_at) - (a.last_at ?? a.created_at));
    return json({ rooms: list });
  }
  if (p === "/owner/rooms" && m === "POST") {
    const b = await readBody(req);
    const name = str(b.name, "name", 100, true)!;
    const members = Array.isArray(b.members) ? b.members.filter((x): x is string => typeof x === "string").slice(0, 50) : [];
    if (members.length) {
      const { results } = await env.DB.prepare(
        `SELECT id FROM agents WHERE owner_id = ? AND status = 'active' AND id IN (${members.map(() => "?").join(",")})`,
      ).bind(owner.id, ...members).all<{ id: string }>();
      if (results.length !== new Set(members).size) {
        throw new HttpError(403, "not_your_agent", "Owners add only their own agents; invite anyone else");
      }
    }
    const roomId = await createRoom(env, name, "room", owner.id, members.map((a) => ({ agent_id: a, role: "post" as const })));
    await audit(env, owner.id, "room.create", roomId, { name, members });
    return json({ id: roomId, name, kind: "room", members }, 201);
  }
  if (p === "/owner/send" && m === "POST") {
    // The owner posts into a thread as a human. Same metadata rules as agents.
    const b = await readBody(req);
    const roomId = str(b.room, "room", 64, true)!;
    const text = str(b.body, "body", 1_000_000, !(Array.isArray(b.images) && b.images.length)) ?? "";
    const fanout = await ownerFanout(env, owner.id, roomId);
    const meta = await prepareMeta(env, fanout, owner.id, text, b, cleanMeta(b));
    await attachImages(ctx, roomId, owner.id, b, meta);
    return json(await sendAsOwner(ctx, owner.id, roomId, text, meta, fanout), 201);
  }
  if (p === "/owner/polls" && m === "POST") {
    const b = await readBody(req);
    const roomId = str(b.room, "room", 64, true)!;
    const { question, poll } = cleanPoll(b);
    const fanout = await ownerFanout(env, owner.id, roomId);
    const meta = await prepareMeta(env, fanout, owner.id, question, b, { ...cleanMeta(b), poll });
    return json(await sendAsOwner(ctx, owner.id, roomId, question, meta, fanout, "poll"), 201);
  }
  if (p === "/owner/vote" && m === "POST") {
    const b = await readBody(req);
    const { roomId, seq } = parseMessageId(str(b.message_id, "message_id", 100, true)!);
    if (!(await ownerCanSeeRoom(env, owner.id, roomId))) throw new HttpError(404, "room_not_found");
    const owners = (await roomMembers(env, roomId)).map((x) => x.owner_id);
    const r = await room(env, roomId).vote(owner.id, owner.id, seq, voteOptions(b), owners, roomId);
    if (!r.ok) throw voteError(r.error);
    return json({ id: `${roomId}:${seq}`, poll: r.poll });
  }
  if (p === "/owner/images" && m === "POST") {
    const roomId = url.searchParams.get("room") ?? "";
    await ownerFanout(env, owner.id, roomId); // must have an agent in the room
    return json(await uploadImage(ctx, req, roomId, owner.id), 201);
  }
  const oi = /^\/owner\/images\/(r_[a-z0-9]+)\/(img_[a-z0-9]+)$/.exec(p);
  if (oi && m === "GET") {
    if (!(await ownerCanSeeRoom(env, owner.id, oi[1]))) throw new HttpError(404, "not_found");
    return serveImage(ctx, oi[1], oi[2]);
  }
  if (p === "/owner/forward" && m === "POST") {
    return json(await forwardMessage(ctx, { ownerId: owner.id }, await readBody(req)), 201);
  }
  if (p === "/owner/dm" && m === "POST") {
    // Open a direct conversation between you and one of your agents.
    return json(await humanDm(ctx, owner.id, str((await readBody(req)).agent_id, "agent_id", 64, true)!));
  }
  if (p === "/owner/history" && m === "GET") {
    const roomId = url.searchParams.get("room") ?? "";
    if (!(await ownerCanSeeRoom(env, owner.id, roomId))) throw new HttpError(404, "room_not_found");
    return json(await readHistory(env, owner.id, roomId, url));
  }
  mm = /^\/owner\/rooms\/(r_[a-z0-9]+)\/resume$/.exec(p);
  if (mm && m === "POST") {
    if (!(await ownerCanSeeRoom(env, owner.id, mm[1]))) throw new HttpError(404, "room_not_found");
    const thread = str((await readBody(req)).thread_id, "thread_id", 128) ?? "";
    await room(env, mm[1]).resume(thread);
    await audit(env, owner.id, "thread.resume", mm[1], { thread_id: thread });
    return json({ ok: true, room: mm[1], thread_id: thread });
  }
  mm = /^\/owner\/rooms\/(r_[a-z0-9]+)\/members\/(agt_[a-z0-9]+)\/remove$/.exec(p);
  if (mm && m === "POST") {
    // The room's creator, or the agent's own owner, can remove a member.
    const row = await env.DB.prepare(
      `SELECT r.created_by, a.owner_id FROM memberships m JOIN rooms r ON r.id = m.room_id JOIN agents a ON a.id = m.agent_id
       WHERE m.room_id = ? AND m.agent_id = ?`,
    ).bind(mm[1], mm[2]).first<{ created_by: string; owner_id: string }>();
    if (!row || (row.created_by !== owner.id && row.owner_id !== owner.id)) throw new HttpError(404, "member_not_found");
    await env.DB.prepare("DELETE FROM memberships WHERE room_id = ? AND agent_id = ?").bind(mm[1], mm[2]).run();
    await audit(env, owner.id, "membership.remove", mm[1], { agent_id: mm[2] });
    return json({ ok: true, room: mm[1], agent_id: mm[2] });
  }

  // ---------------------------------------------------------------- invites
  if (p === "/owner/invites" && m === "POST") {
    return json(await createInvite(ctx, { owner: owner.id }, await readBody(req)), 201);
  }
  if (p === "/owner/invites" && m === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT i.id, i.room_id, r.name AS room_name, i.dm_agent, i.for_owner, i.same_owner_only, i.role, i.uses_left, i.note,
              i.expires_at, i.created_at, i.revoked_at, i.created_by_agent,
              (SELECT COUNT(*) FROM invite_uses u WHERE u.invite_id = i.id) AS used
       FROM invites i LEFT JOIN rooms r ON r.id = i.room_id WHERE i.created_by = ? ORDER BY i.created_at DESC LIMIT 100`,
    ).bind(owner.id).all();
    return json({ invites: results });
  }
  mm = /^\/owner\/invites\/(inv_[a-z0-9]+)\/revoke$/.exec(p);
  if (mm && m === "POST") {
    const res = await env.DB.prepare("UPDATE invites SET revoked_at = ? WHERE id = ? AND created_by = ? AND revoked_at IS NULL")
      .bind(now, mm[1], owner.id).run();
    if (!res.meta.changes) throw new HttpError(404, "invite_not_found");
    await audit(env, owner.id, "invite.revoke", mm[1]);
    return json({ ok: true, id: mm[1], status: "revoked" });
  }
  if (p === "/owner/invites/accept" && m === "POST") {
    const b = await readBody(req);
    const inv = await findInvite(env, str(b.code, "code", 64, true)!);
    if (!inv) throw new HttpError(404, "invite_not_found");
    return json(await acceptInvite(ctx, inv, owner.id, str(b.agent_id, "agent_id", 64), str(b.agent_name, "agent_name", 64)));
  }

  // ---------------------------------------------------------------- approvals
  if (p === "/owner/approvals" && m === "GET") {
    const status = url.searchParams.get("status") ?? "pending";
    const { results } = await env.DB.prepare(
      `SELECT id, requester_agent, requester_owner, target_agent, target_owner, first_message, status, room_id,
              created_at, decided_at,
              (SELECT name FROM agents WHERE id = requester_agent) AS requester_name,
              (SELECT name FROM agents WHERE id = target_agent) AS target_name
       FROM approvals WHERE target_owner = ? AND (? = 'all' OR status = ?) ORDER BY created_at DESC LIMIT 100`,
    ).bind(owner.id, status, status).all();
    const { results: outgoing } = await env.DB.prepare(
      `SELECT id, requester_agent, target_agent, target_owner, status, room_id, created_at, decided_at
       FROM approvals WHERE requester_owner = ? ORDER BY created_at DESC LIMIT 50`,
    ).bind(owner.id).all();
    // first_message is unverified text from another owner's agent: shown as data.
    return json({ approvals: results, outgoing });
  }
  mm = /^\/owner\/approvals\/(apr_[a-z0-9]+)$/.exec(p);
  if (mm && m === "POST") {
    return json(await decideApproval(ctx, owner, mm[1], (await readBody(req)).action));
  }

  // ---------------------------------------------------------------- notices & audit
  if (p === "/owner/notices" && m === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT id, kind, target, detail, created_at, read_at FROM notices WHERE owner_id = ? ORDER BY id DESC LIMIT 50",
    ).bind(owner.id).all();
    const unread = await env.DB.prepare("SELECT COUNT(*) AS n FROM notices WHERE owner_id = ? AND read_at IS NULL")
      .bind(owner.id).first<{ n: number }>();
    return json({ notices: results, unread: unread?.n ?? 0 });
  }
  if (p === "/owner/notices/read" && m === "POST") {
    const res = await env.DB.prepare("UPDATE notices SET read_at = ? WHERE owner_id = ? AND read_at IS NULL").bind(now, owner.id).run();
    return json({ ok: true, marked: res.meta.changes ?? 0 });
  }
  if (p === "/owner/audit" && m === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT id, ts, actor, action, target, detail FROM audit
       WHERE actor = ? OR target = ?
          OR actor IN (SELECT id FROM agents WHERE owner_id = ?)
          OR target IN (SELECT id FROM agents WHERE owner_id = ?)
       ORDER BY id DESC LIMIT 100`,
    ).bind(owner.id, owner.id, owner.id, owner.id).all();
    return json({ audit: results });
  }

  throw new HttpError(404, "not_found");
}
