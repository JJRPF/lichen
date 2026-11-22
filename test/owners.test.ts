// Phases 3–5: Access sign-in, owner API, invites, DM approvals, dashboard, rotation.

import { describe, it, expect } from "vitest";
import { env, SELF } from "cloudflare:test";
import { call, newAgent, newRoom, ADMIN, accessJwt, registerOwner, ownerCall, openSocket } from "./helpers";
import { CLOSE_ROTATED } from "../src/agent";

let n = 0;
/** A registered owner with a signed-in session and one agent. */
async function owner(login: string) {
  const id = `github:${login}${++n}`;
  const email = `${login}${n}@example.com`;
  await registerOwner(id, email);
  const jwt = await accessJwt(email);
  const agent = await newAgent(id, `${login}-agent`);
  return { id, email, jwt, agent };
}

describe("Cloudflare Access sign-in", () => {
  it("accepts a valid Access JWT (header or cookie) for a registered owner", async () => {
    const o = await owner("jjrpf");
    const me = await ownerCall("/owner/me", { jwt: o.jwt });
    expect(me.status).toBe(200);
    expect(me.data.owner_id).toBe(o.id);
    expect(me.data.ntfy_topic).toMatch(/^lichen-[a-z0-9]{24}$/);
    expect((await ownerCall("/owner/me", { jwt: o.jwt, cookie: true })).status).toBe(200);
  });

  it("rejects missing, forged, expired, wrong-audience and wrong-issuer tokens", async () => {
    const o = await owner("alice");
    const now = Math.floor(Date.now() / 1000);
    expect((await ownerCall("/owner/me")).status).toBe(401);
    const [h, p] = o.jwt.split(".");
    const forged = `${h}.${btoa(JSON.stringify({ ...JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/"))), email: "mallory@example.com" })).replace(/=+$/, "")}.${o.jwt.split(".")[2]}`;
    expect((await ownerCall("/owner/me", { jwt: forged })).status).toBe(401);
    expect((await ownerCall("/owner/me", { jwt: await accessJwt(o.email, { exp: now - 3600 }) })).status).toBe(401);
    expect((await ownerCall("/owner/me", { jwt: await accessJwt(o.email, { aud: ["other-app"] }) })).status).toBe(401);
    expect((await ownerCall("/owner/me", { jwt: await accessJwt(o.email, { iss: "https://evil.cloudflareaccess.com" }) })).status).toBe(401);
    expect((await ownerCall("/owner/me", { jwt: await accessJwt(o.email, {}, { kid: "unknown" }) })).status).toBe(401);
    expect((await ownerCall("/owner/me", { jwt: await accessJwt(o.email, {}, { alg: "HS256" }) })).status).toBe(401);
  });

  it("refuses signed-in emails the operator hasn't registered", async () => {
    const r = await ownerCall("/owner/me", { jwt: await accessJwt("stranger@example.com") });
    expect(r.status).toBe(403);
    expect(r.data.error).toBe("not_registered");
  });

  it("only accepts same-origin JSON writes from browsers; admin can act for an owner", async () => {
    const o = await owner("csrf");
    expect((await ownerCall("/owner/enroll-codes", { jwt: o.jwt, body: { agent_name: "x" }, origin: null })).status).toBe(403);
    expect((await ownerCall("/owner/enroll-codes", { jwt: o.jwt, body: { agent_name: "x" }, origin: "https://evil.example" })).status).toBe(403);
    expect((await ownerCall("/owner/enroll-codes", { jwt: o.jwt, body: { agent_name: "x" } })).status).toBe(201);
    expect((await ownerCall("/owner/enroll-codes", { as: o.id, body: { agent_name: "y" }, origin: null })).status).toBe(201);
    expect((await ownerCall("/owner/me", { as: "github:nobody-here" })).status).toBe(404);
  });

  it("validates owner registration", async () => {
    expect((await call("/admin/owners", { token: ADMIN, body: { owner_id: "bob", email: "b@example.com" } })).status).toBe(400);
    expect((await call("/admin/owners", { token: ADMIN, body: { owner_id: "github:bob", email: "nope" } })).status).toBe(400);
    expect((await call("/admin/owners", { body: { owner_id: "github:bob", email: "b@example.com" } })).status).toBe(401);
  });
});

describe("invites", () => {
  it("lets a collaborator's owner accept with an existing agent; the agent joins as external", async () => {
    const me = await owner("jj");
    const collab = await owner("collab");
    const roomId = await newRoom([me.agent.agent_id]);
    const inv = await ownerCall("/owner/invites", { jwt: me.jwt, body: { room: roomId, for: collab.id.slice(7), note: "S2R coordination" } });
    expect(inv.status).toBe(201);
    expect(inv.data.url).toMatch(/\/i\/[a-z0-9]{20}$/);
    const code = inv.data.code;

    // curl gets JSON, without the room id.
    const view = await call(`/i/${code}`);
    expect(view.data.invite).toMatchObject({ status: "active", inviter: me.id, for: collab.id, role: "post", uses_left: 1 });
    expect(JSON.stringify(view.data)).not.toContain(roomId);

    // Someone else can't use a bound invite.
    const third = await owner("third");
    expect((await ownerCall("/owner/invites/accept", { jwt: third.jwt, body: { code, agent_id: third.agent.agent_id } })).status).toBe(403);
    // An agent can't accept a cross-owner invite by itself.
    const self = await call(`/i/${code}`, { token: collab.agent.token, method: "POST", body: {} });
    expect(self.status).toBe(403);
    expect(self.data.error).toBe("owner_must_accept");
    // Nor can an owner accept for someone else's agent.
    expect((await ownerCall("/owner/invites/accept", { jwt: collab.jwt, body: { code, agent_id: me.agent.agent_id } })).status).toBe(404);

    const ok = await ownerCall("/owner/invites/accept", { jwt: collab.jwt, body: { code, agent_id: collab.agent.agent_id } });
    expect(ok.status).toBe(200);
    expect(ok.data).toEqual({ status: "joined", room: roomId, agent_id: collab.agent.agent_id });

    await call("/send", { token: me.agent.token, body: { room: roomId, body: "welcome" } });
    const msg = (await call("/inbox", { token: collab.agent.token })).data.messages[0];
    expect(msg.envelope.trust_tier).toBe("external");

    // Used up; and the inviter was told.
    expect((await ownerCall("/owner/invites/accept", { jwt: collab.jwt, body: { code, agent_id: collab.agent.agent_id } })).status).toBe(410);
    const notices = (await ownerCall("/owner/notices", { jwt: me.jwt })).data;
    expect(notices.notices.map((x: any) => x.kind)).toContain("invite_joined");
    expect(notices.unread).toBeGreaterThan(0);
  });

  it("gives an enroll code that joins the room on enroll", async () => {
    const me = await owner("host");
    const guest = await owner("guest");
    const roomId = await newRoom([me.agent.agent_id]);
    const { code } = (await ownerCall("/owner/invites", { jwt: me.jwt, body: { room: roomId, role: "read" } })).data;
    const acc = await ownerCall("/owner/invites/accept", { jwt: guest.jwt, body: { code } });
    expect(acc.data.status).toBe("enroll");
    const enrolled = await call("/enroll", { body: { code: acc.data.enroll_code } });
    expect(enrolled.status).toBe(201);
    expect(enrolled.data.owner_id).toBe(guest.id);
    expect(enrolled.data.joined_room).toBe(roomId);
    const rooms = await call("/rooms", { token: enrolled.data.token });
    expect(rooms.data.rooms[0]).toMatchObject({ id: roomId, role: "read" });
    expect(rooms.data.rooms[0].members.map((m: any) => m.agent_id).sort()).toEqual([me.agent.agent_id, enrolled.data.agent_id].sort());
  });

  it("lets agents invite only their own owner's agents", async () => {
    const me = await owner("selfinv");
    const other = await owner("otherinv");
    const second = await newAgent(me.id, "second");
    const roomId = await newRoom([me.agent.agent_id]);
    const inv = await call("/invites", { token: me.agent.token, body: { room: roomId, uses: 2 } });
    expect(inv.status).toBe(201);
    expect(inv.data.same_owner_only).toBe(true);

    expect((await call(`/i/${inv.data.code}`, { token: other.agent.token, method: "POST", body: {} })).status).toBe(403);
    expect((await ownerCall("/owner/invites/accept", { jwt: other.jwt, body: { code: inv.data.code, agent_id: other.agent.agent_id } })).status).toBe(403);
    const joined = await call(`/i/${inv.data.code}`, { token: second.token, method: "POST", body: {} });
    expect(joined.data.status).toBe("joined");
    // Not a member: can't invite to that room.
    expect((await call("/invites", { token: other.agent.token, body: { room: roomId } })).status).toBe(404);
  });

  it("opens a fresh DM per use of a dm_with invite, and stops working once revoked", async () => {
    const me = await owner("dminv");
    const guest = await owner("dmguest");
    const inv = (await ownerCall("/owner/invites", { jwt: me.jwt, body: { dm_with: me.agent.agent_id, uses: 3 } })).data;
    const acc = await ownerCall("/owner/invites/accept", { jwt: guest.jwt, body: { code: inv.code, agent_id: guest.agent.agent_id } });
    const rooms = (await call("/rooms", { token: guest.agent.token })).data.rooms;
    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({ id: acc.data.room, kind: "dm" });

    expect((await ownerCall(`/owner/invites/${inv.id}/revoke`, { jwt: me.jwt, body: {} })).status).toBe(200);
    expect((await call(`/i/${inv.code}`)).data.invite.status).toBe("revoked");
    expect((await ownerCall("/owner/invites/accept", { jwt: guest.jwt, body: { code: inv.code, agent_id: guest.agent.agent_id } })).status).toBe(410);
    // Owners can't invite to someone else's agent's DM.
    expect((await ownerCall("/owner/invites", { jwt: guest.jwt, body: { dm_with: me.agent.agent_id } })).status).toBe(404);
  });

  it("shows browsers an escaped page with a strict CSP", async () => {
    const me = await owner("html");
    const roomId = await newRoom([me.agent.agent_id], "<b>room</b>");
    const { code } = (await ownerCall("/owner/invites", { jwt: me.jwt, body: { room: roomId, note: "<script>alert(1)</script>" } })).data;
    const res = await SELF.fetch(`https://lichen.test/i/${code}`, { headers: { accept: "text/html" } });
    const html = await res.text();
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;b&gt;room&lt;/b&gt;");
    expect(html).not.toContain("<script>alert");
    expect((await call("/i/doesnotexist1")).status).toBe(404);
  });
});

describe("DM requests and approvals", () => {
  it("opens same-owner DMs right away and reuses the room", async () => {
    const me = await owner("samedm");
    const b = await newAgent(me.id, "b");
    const first = await call("/dm", { token: me.agent.token, body: { to: b.agent_id, body: "hi" } });
    expect(first.status).toBe(201);
    expect(first.data.status).toBe("ok");
    const again = await call("/dm", { token: b.token, body: { to: me.agent.agent_id, body: "hey" } });
    expect(again.data.room).toBe(first.data.room);
    expect((await call("/dm", { token: b.token, body: { to: b.agent_id, body: "me" } })).status).toBe(400);
    expect((await call("/dm", { token: b.token, body: { to: "agt_nosuchagent", body: "?" } })).status).toBe(404);
  });

  it("asks the recipient's owner when agents share nothing, and delivers on approval", async () => {
    const me = await owner("req");
    const them = await owner("rcpt");
    const meWs = await openSocket("/ws", { authorization: `Bearer ${me.agent.token}` });
    const themOwnerWs = await openSocket("/owner/ws", { "cf-access-jwt-assertion": them.jwt, origin: "https://lichen.test" });

    const req = await call("/dm", { token: me.agent.token, body: { to: them.agent.agent_id, body: "Can we coordinate on S2R?", intent: "question" } });
    expect(req.status).toBe(202);
    expect(req.data.status).toBe("pending");
    expect(req.data.approval_url).toBe(`https://lichen.test/approvals#${req.data.approval_id}`);
    // Asking twice returns the same request.
    expect((await call("/dm", { token: me.agent.token, body: { to: them.agent.agent_id, body: "again" } })).data.approval_id).toBe(req.data.approval_id);

    // The recipient's owner gets a pointer, not the message.
    const ev = await themOwnerWs.next();
    expect(ev).toMatchObject({ kind: "notice", notice: "approval_pending" });
    expect(JSON.stringify(ev)).not.toContain("S2R");

    // Both agents see the request in /inbox, without its text.
    const inboxThem = (await call("/inbox", { token: them.agent.token })).data;
    expect(inboxThem.messages).toHaveLength(0);
    expect(inboxThem.approvals).toEqual([expect.objectContaining({ id: req.data.approval_id, direction: "incoming", status: "pending" })]);
    expect(JSON.stringify(inboxThem)).not.toContain("S2R");
    expect((await call("/inbox", { token: me.agent.token })).data.approvals[0].direction).toBe("outgoing");

    // Only the recipient's owner can see and decide it.
    expect((await ownerCall(`/owner/approvals/${req.data.approval_id}`, { jwt: me.jwt, body: { action: "allow_once" } })).status).toBe(404);
    const list = (await ownerCall("/owner/approvals", { jwt: them.jwt })).data.approvals;
    expect(list[0]).toMatchObject({ id: req.data.approval_id, first_message: "Can we coordinate on S2R?" });

    expect((await ownerCall(`/owner/approvals/${req.data.approval_id}`, { jwt: them.jwt, body: { action: "nope" } })).status).toBe(400);
    const ok = await ownerCall(`/owner/approvals/${req.data.approval_id}`, { jwt: them.jwt, body: { action: "allow_once" } });
    expect(ok.data.status).toBe("allowed");
    expect(await meWs.next()).toEqual({ kind: "approval", id: req.data.approval_id, status: "allowed", room: ok.data.room });

    const delivered = (await call("/inbox", { token: them.agent.token })).data.messages;
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ room: ok.data.room, body: "Can we coordinate on S2R?", envelope: { trust_tier: "external" } });
    expect((await ownerCall(`/owner/approvals/${req.data.approval_id}`, { jwt: them.jwt, body: { action: "deny" } })).status).toBe(409);
    meWs.ws.close(); themOwnerWs.ws.close();
  });

  it("deny, always allow and block", async () => {
    const a = await owner("dab-a");
    const b = await owner("dab-b");
    const ask = () => call("/dm", { token: a.agent.token, body: { to: b.agent.agent_id, body: "hello" } });

    const r1 = await ask();
    expect((await ownerCall(`/owner/approvals/${r1.data.approval_id}`, { jwt: b.jwt, body: { action: "deny" } })).data).toMatchObject({ status: "denied", room: null });
    expect((await call("/rooms", { token: b.agent.token })).data.rooms).toHaveLength(0);

    const r2 = await ask();
    expect(r2.data.approval_id).not.toBe(r1.data.approval_id);
    await ownerCall(`/owner/approvals/${r2.data.approval_id}`, { jwt: b.jwt, body: { action: "always_allow" } });

    // Allowed now, and the DM is reused.
    const c = await newAgent(b.id, "b-second");
    expect((await call("/dm", { token: a.agent.token, body: { to: c.agent_id, body: "direct" } })).status).toBe(201);

    // Block stops future requests from that agent to this owner.
    const x = await owner("dab-x");
    const r3 = await call("/dm", { token: x.agent.token, body: { to: b.agent.agent_id, body: "spam" } });
    await ownerCall(`/owner/approvals/${r3.data.approval_id}`, { jwt: b.jwt, body: { action: "block" } });
    expect((await call("/dm", { token: x.agent.token, body: { to: b.agent.agent_id, body: "spam again" } })).status).toBe(403);
  });

  it("connects agents that already share a room without approval", async () => {
    const a = await owner("share-a");
    const b = await owner("share-b");
    await newRoom([a.agent.agent_id, b.agent.agent_id]);
    expect((await call("/dm", { token: a.agent.token, body: { to: b.agent.agent_id, body: "hi" } })).status).toBe(201);
  });

  it("limits how many requests an agent can have waiting", async () => {
    const a = await owner("limit");
    let last = 0;
    for (let i = 0; i < 6; i++) {
      const t = await owner(`limit-t${i}`);
      last = (await call("/dm", { token: a.agent.token, body: { to: t.agent.agent_id, body: "hi" } })).status;
    }
    expect(last).toBe(429);
  });
});

describe("owner dashboard API", () => {
  it("shows only rooms with the owner's agents, and only lets owners manage their own agents", async () => {
    const me = await owner("dash");
    const other = await owner("dash-other");
    const mine = await newRoom([me.agent.agent_id], "mine");
    const theirs = await newRoom([other.agent.agent_id], "theirs");
    await call("/send", { token: other.agent.token, body: { room: theirs, body: "private" } });

    const rooms = (await ownerCall("/owner/rooms", { jwt: me.jwt })).data.rooms;
    expect(rooms.map((r: any) => r.id)).toEqual([mine]);
    expect((await ownerCall(`/owner/history?room=${theirs}`, { jwt: me.jwt })).status).toBe(404);
    expect((await ownerCall(`/owner/history?room=${mine}`, { jwt: me.jwt })).status).toBe(200);

    expect((await ownerCall("/owner/rooms", { jwt: me.jwt, body: { name: "x", members: [other.agent.agent_id] } })).status).toBe(403);
    expect((await ownerCall(`/owner/agents/${other.agent.agent_id}/revoke`, { jwt: me.jwt, body: {} })).status).toBe(404);
    expect((await ownerCall(`/owner/rooms/${theirs}/members/${other.agent.agent_id}/remove`, { jwt: me.jwt, body: {} })).status).toBe(404);

    const agents = (await ownerCall("/owner/agents", { jwt: me.jwt })).data.agents;
    expect(agents.map((a: any) => a.id)).toEqual([me.agent.agent_id]);
    expect((await ownerCall(`/owner/agents/${me.agent.agent_id}/revoke`, { jwt: me.jwt, body: {} })).status).toBe(200);
    expect((await call("/me", { token: me.agent.token })).status).toBe(401);
  });

  it("streams room notices to the owner's dashboard socket, which needs a same-origin connection", async () => {
    const me = await owner("live");
    const b = await newAgent(me.id, "live-b");
    const roomId = await newRoom([me.agent.agent_id, b.agent_id]);
    const bad = await SELF.fetch("https://lichen.test/owner/ws", { headers: { upgrade: "websocket", "cf-access-jwt-assertion": me.jwt, origin: "https://evil.example" } });
    expect(bad.status).toBe(403);

    const ws = await openSocket("/owner/ws", { "cf-access-jwt-assertion": me.jwt, origin: "https://lichen.test" });
    const sent = await call("/send", { token: me.agent.token, body: { room: roomId, body: "seen by owner" } });
    expect(await ws.next()).toEqual({ id: sent.data.id, room: roomId, from: me.agent.agent_id, trust_tier: "same_owner" });
    ws.ws.close();
  });

  it("tells every owner in the room when a thread hits the turn cap; an owner can resume it", async () => {
    const a = await owner("cap-a");
    const b = await owner("cap-b");
    const roomId = await newRoom([a.agent.agent_id, b.agent.agent_id]);
    let last: any;
    for (let i = 0; i < 4; i++) {
      last = await call("/send", { token: i % 2 ? b.agent.token : a.agent.token, body: { room: roomId, body: `m${i}`, thread_id: "loop" } });
    }
    expect(last.data.thread_paused).toBe(true);
    for (const o of [a, b]) {
      const kinds = (await ownerCall("/owner/notices", { jwt: o.jwt })).data.notices.map((x: any) => x.kind);
      expect(kinds).toContain("thread_paused");
    }
    expect((await call("/send", { token: a.agent.token, body: { room: roomId, body: "more", thread_id: "loop" } })).status).toBe(409);
    expect((await ownerCall(`/owner/rooms/${roomId}/resume`, { jwt: b.jwt, body: { thread_id: "loop" } })).status).toBe(200);
    expect((await call("/send", { token: a.agent.token, body: { room: roomId, body: "more", thread_id: "loop" } })).status).toBe(201);
  });

  it("shows the owner's own audit trail, without message bodies", async () => {
    const me = await owner("aud");
    const roomId = await newRoom([me.agent.agent_id]);
    await call("/send", { token: me.agent.token, body: { room: roomId, body: "top secret body" } });
    const rows = (await ownerCall("/owner/audit", { jwt: me.jwt })).data.audit;
    expect(rows.map((r: any) => r.action)).toEqual(expect.arrayContaining(["send", "enroll"]));
    expect(JSON.stringify(rows)).not.toContain("top secret body");
    expect(rows.every((r: any) => r.actor === me.agent.agent_id || r.actor === me.id || r.target === me.id || r.target === me.agent.agent_id)).toBe(true);
  });

  it("regenerates the ntfy topic", async () => {
    const me = await owner("ntfy");
    const before = (await ownerCall("/owner/me", { jwt: me.jwt })).data.ntfy_topic;
    const after = (await ownerCall("/owner/ntfy/regenerate", { jwt: me.jwt, body: {} })).data.ntfy_topic;
    expect(after).not.toBe(before);
  });

  it("serves the dashboard shell and script with a strict CSP; GET never changes state", async () => {
    for (const path of ["/dashboard", "/approvals", "/accept?code=x"]) {
      const res = await SELF.fetch(`https://lichen.test${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(await res.text()).toContain('<script src="/dashboard.js" defer></script>');
    }
    const js = await SELF.fetch("https://lichen.test/dashboard.js");
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(await js.text()).not.toContain("innerHTML");
    const me = await owner("getonly");
    expect((await ownerCall(`/owner/agents/${me.agent.agent_id}/revoke`, { jwt: me.jwt })).status).toBe(404);
  });
});

describe("token rotation", () => {
  it("swaps the token, kills the old one and closes its sockets", async () => {
    const a = await newAgent("github:jjrpf", "rotator");
    const ws = await openSocket("/ws", { authorization: `Bearer ${a.token}` });
    const r = await call("/rotate", { token: a.token, method: "POST", body: {} });
    expect(r.status).toBe(200);
    expect(r.data.token).toMatch(/^lch_/);
    expect(r.data.token).not.toBe(a.token);
    expect((await ws.closed).code).toBe(CLOSE_ROTATED);
    expect((await call("/me", { token: a.token })).status).toBe(401);
    expect((await call("/me", { token: r.data.token })).data.agent_id).toBe(a.agent_id);
    const row = await env.DB.prepare("SELECT rotated_at FROM agents WHERE id = ?").bind(a.agent_id).first<{ rotated_at: number }>();
    expect(row!.rotated_at).toBeGreaterThan(0);
  });
});

describe("owner routes without Access configured", () => {
  it("answer 503 instead of trusting any header", async () => {
    // Simulated by calling the router with an env lacking ACCESS_* (unit-level).
    const { default: worker } = await import("../src/index");
    const bare = { ...env, ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" };
    const res = await worker.fetch(new Request("https://lichen.test/owner/me", { headers: { "cf-access-jwt-assertion": "x.y.z" } }), bare as any, {
      waitUntil() {}, passThroughOnException() {}, props: {},
    } as any);
    expect(res.status).toBe(503);
  });
});
