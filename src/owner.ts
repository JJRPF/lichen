// Owner API (/owner/*) and dashboard pages.
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
  type Ctx, type Owner, agentHub, audit, connect, isAdmin, mintEnrollCode, newNtfyTopic, ownerCanSeeRoom, ownerRoomIds,
  rateLimit, readHistory, room,
} from "./core";
import { ownerHubName } from "./env";
import { acceptInvite, createInvite, createRoom, decideApproval, findInvite } from "./social";
import { DASHBOARD_JS, dashboardPage } from "./pages";
import { HttpError, json, readBody, str } from "./util";

interface OwnerAuth { owner: Owner; via: "access" | "admin" }

const PAGES = new Set(["/dashboard", "/approvals", "/accept"]);

export async function ownerRoute(req: Request, ctx: Ctx, p: string, m: string, url: URL): Promise<Response | null> {
  if (m === "GET" && PAGES.has(p)) return dashboardPage(accessConfigured(ctx.env), ctx.origin);
  if (m === "GET" && p === "/dashboard.js") {
    return new Response(DASHBOARD_JS, {
      headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff" },
    });
  }
  if (!p.startsWith("/owner/")) return null;

  const auth = await authOwner(req, ctx);
  if (auth.via === "access" && m !== "GET") checkSameOrigin(req, ctx, true);
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
    return json(await mintEnrollCode(env, owner.id, owner.id, str(b.agent_name, "agent_name", 64, true)!, b.ttl_seconds), 201);
  }
  let mm = /^\/owner\/agents\/(agt_[a-z0-9]+)\/revoke$/.exec(p);
  if (mm && m === "POST") {
    const res = await env.DB.prepare("UPDATE agents SET status = 'revoked' WHERE id = ? AND owner_id = ?").bind(mm[1], owner.id).run();
    if (!res.meta.changes) throw new HttpError(404, "agent_not_found");
    await agentHub(env, mm[1]).closeAll();
    await audit(env, owner.id, "agent.revoke", mm[1]);
    return json({ ok: true, agent_id: mm[1], status: "revoked" });
  }

  // ---------------------------------------------------------------- rooms & threads
  if (p === "/owner/rooms" && m === "GET") {
    const ids = await ownerRoomIds(env, owner.id);
    if (!ids.length) return json({ rooms: [] });
    const { results } = await env.DB.prepare(
      `SELECT r.id, r.name, r.kind, r.created_by, r.created_at, m.agent_id, a.owner_id, a.name AS agent_name, a.status, m.role
       FROM rooms r JOIN memberships m ON m.room_id = r.id JOIN agents a ON a.id = m.agent_id
       WHERE r.id IN (${ids.map(() => "?").join(",")}) ORDER BY r.created_at`,
    ).bind(...ids).all<Record<string, any>>();
    const rooms = new Map<string, any>();
    for (const r of results) {
      const entry = rooms.get(r.id) ?? { id: r.id, name: r.name, kind: r.kind, created_by: r.created_by, created_at: r.created_at, members: [] };
      entry.members.push({ agent_id: r.agent_id, owner_id: r.owner_id, name: r.agent_name, status: r.status, role: r.role });
      rooms.set(r.id, entry);
    }
    return json({ rooms: [...rooms.values()] });
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
    return json(await acceptInvite(ctx, inv, owner.id, str(b.agent_id, "agent_id", 64)));
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
