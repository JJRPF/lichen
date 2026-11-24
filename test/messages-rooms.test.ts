import { describe, it, expect } from "vitest";
import { call, newAgent, newRoom, ownerCall, registerOwner } from "./helpers";
import { DASHBOARD_JS } from "../src/pages";

describe("dashboard script integrity", () => {
  it("parses cleanly with new Function and has no template hazards", () => {
    expect(() => new Function(DASHBOARD_JS)).not.toThrow();
  });
});

describe("messages: edit, delete, pins, search", () => {
  it("edits and deletes messages with proper authorization", async () => {
    await registerOwner("github:alice", "alice@example.com");
    await registerOwner("github:bob", "bob@example.com");
    const a = await newAgent("github:alice", "alpha");
    const b = await newAgent("github:bob", "beta");
    const r = await ownerCall("/owner/rooms", { as: "github:alice", body: { name: "dev", members: [a.agent_id] } });
    expect(r.status).toBe(201);
    const roomId = r.data.id;
    // Add beta via admin so both owners are in the room.
    await call(`/admin/rooms/${roomId}/members`, { token: "test-admin-token", body: { agent_id: b.agent_id } });

    const s1 = await call("/send", { token: a.token, body: { room: roomId, body: "initial text" } });
    expect(s1.status).toBe(201);
    const id1 = s1.data.id;

    // Beta cannot edit or delete alpha's message.
    expect((await call(`/messages/${id1}`, { method: "PATCH", token: b.token, body: { body: "hacked" } })).status).toBe(403);
    expect((await call(`/messages/${id1}`, { method: "DELETE", token: b.token })).status).toBe(403);

    // Alpha edits its own message.
    const ed = await call(`/messages/${id1}`, { method: "PATCH", token: a.token, body: { body: "updated text" } });
    expect(ed.status).toBe(200);
    expect(ed.data.message.body).toBe("updated text");
    expect(ed.data.message.edited_at).toBeTypeOf("number");

    // Owner alice can edit her agent's message too.
    const oed = await ownerCall(`/owner/messages/${id1}`, { as: "github:alice", method: "PATCH", body: { body: "owner-edited" } });
    expect(oed.status).toBe(200);
    expect(oed.data.message.body).toBe("owner-edited");

    // Pin the message, list pins, then delete it (which also unpins it).
    expect((await call("/pins", { token: a.token, body: { message_id: id1 } })).status).toBe(201);
    const pins1 = await call(`/pins?room=${roomId}`, { token: b.token });
    expect(pins1.status).toBe(200);
    expect(pins1.data.pins.map((p: any) => p.id)).toEqual([id1]);

    // Beta sends a message; alice (room creator) can moderate/delete it.
    const s2 = await call("/send", { token: b.token, body: { room: roomId, body: "beta msg" } });
    const delBeta = await ownerCall(`/owner/messages/${s2.data.id}/delete`, { as: "github:alice", body: {} });
    expect(delBeta.status).toBe(200);

    // Alpha deletes its own message; body is nulled, pin is removed, reactions rejected.
    const del1 = await call(`/messages/${id1}`, { method: "DELETE", token: a.token });
    expect(del1.status).toBe(200);
    const pins2 = await call(`/pins?room=${roomId}`, { token: a.token });
    expect(pins2.data.pins).toEqual([]);
    expect((await call("/react", { token: b.token, body: { message_id: id1, emoji: "✅" } })).status).toBe(404);

    const hist = await call(`/history?room=${roomId}`, { token: a.token });
    const m1 = hist.data.messages.find((m: any) => m.id === id1);
    expect(m1.deleted).toBe(true);
    expect(m1.body).toBeNull();
  });

  it("pins, unpins, and searches across rooms respecting membership", async () => {
    const a = await newAgent("github:searcher", "s1");
    const outsider = await newAgent("github:stranger", "s2");
    const r1 = await newRoom([a.agent_id], "room-one");
    const r2 = await newRoom([a.agent_id], "room-two");

    const m1 = await call("/send", { token: a.token, body: { room: r1, body: "Deploy Cloudflare Workers v2" } });
    const m2 = await call("/send", { token: a.token, body: { room: r2, body: "Another cloudflare note" } });
    const m3 = await call("/send", { token: a.token, body: { room: r2, body: "cloudflare deleted" } });
    await call(`/messages/${m3.data.id}`, { method: "DELETE", token: a.token });

    // Pin & unpin
    expect((await call("/pins", { token: a.token, body: { message_id: m1.data.id } })).status).toBe(201);
    expect((await call(`/pins/${m1.data.id}`, { method: "DELETE", token: a.token })).status).toBe(200);
    expect((await call(`/pins?room=${r1}`, { token: a.token })).data.pins).toEqual([]);

    // Search across all rooms (case-insensitive, skips deleted)
    const all = await call("/search?q=CLOUDFLARE", { token: a.token });
    expect(all.status).toBe(200);
    expect(all.data.results.map((m: any) => m.id).sort()).toEqual([m1.data.id, m2.data.id].sort());

    // Scoped to one room
    const one = await call(`/search?q=cloudflare&room=${r1}`, { token: a.token });
    expect(one.data.results.map((m: any) => m.id)).toEqual([m1.data.id]);

    // Outsider cannot search room r1
    expect((await call(`/search?q=cloudflare&room=${r1}`, { token: outsider.token })).status).toBe(404);
  });
});

describe("rooms: rename, archive, delete, membership & self-join", () => {
  it("renames, archives/unarchives, and deletes rooms", async () => {
    await registerOwner("github:carol", "carol@example.com");
    await registerOwner("github:dave", "dave@example.com");
    const c1 = await newAgent("github:carol", "c1");
    const d1 = await newAgent("github:dave", "d1");

    const created = await ownerCall("/owner/rooms", { as: "github:carol", body: { name: "old-name", members: [c1.agent_id] } });
    const roomId = created.data.id;

    // Rename
    const ren = await ownerCall(`/owner/rooms/${roomId}`, { as: "github:carol", method: "PATCH", body: { name: "new-name", join_policy: "open" } });
    expect(ren.status).toBe(200);
    expect(ren.data.name).toBe("new-name");
    expect(ren.data.join_policy).toBe("open");

    // Non-creator cannot rename or archive
    expect((await ownerCall(`/owner/rooms/${roomId}`, { as: "github:dave", method: "PATCH", body: { name: "nope" } })).status).toBe(403);
    expect((await ownerCall(`/owner/rooms/${roomId}/archive`, { as: "github:dave", body: { archived: true } })).status).toBe(403);

    // Archive makes room read-only and hides it from default /rooms
    expect((await ownerCall(`/owner/rooms/${roomId}/archive`, { as: "github:carol", body: { archived: true } })).status).toBe(200);
    expect((await call("/send", { token: c1.token, body: { room: roomId, body: "blocked" } })).status).toBe(409);
    expect((await call("/rooms", { token: c1.token })).data.rooms.find((x: any) => x.id === roomId)).toBeUndefined();
    expect((await call("/rooms?include_archived=1", { token: c1.token })).data.rooms.find((x: any) => x.id === roomId)).toBeDefined();

    // Unarchive restores posting
    expect((await ownerCall(`/owner/rooms/${roomId}/archive`, { as: "github:carol", body: { archived: false } })).status).toBe(200);
    expect((await call("/send", { token: c1.token, body: { room: roomId, body: "back!" } })).status).toBe(201);

    // Delete purges room permanently
    expect((await ownerCall(`/owner/rooms/${roomId}`, { as: "github:dave", method: "DELETE" })).status).toBe(403);
    expect((await ownerCall(`/owner/rooms/${roomId}`, { as: "github:carol", method: "DELETE" })).status).toBe(200);
    expect((await call(`/history?room=${roomId}`, { token: c1.token })).status).toBe(404);
    expect((await ownerCall("/owner/rooms?include_archived=1", { as: "github:carol" })).data.rooms.find((x: any) => x.id === roomId)).toBeUndefined();
    void d1;
  });

  it("lets humans and authorized agents add agents to rooms, and lets agents self-join with permission", async () => {
    await registerOwner("github:erin", "erin@example.com");
    await registerOwner("github:frank", "frank@example.com");
    const e1 = await newAgent("github:erin", "e1");
    const e2 = await newAgent("github:erin", "e2");
    const e3 = await newAgent("github:erin", "e3");
    const f1 = await newAgent("github:frank", "f1");

    const rReq = (await ownerCall("/owner/rooms", { as: "github:erin", body: { name: "ops", members: [e1.agent_id], join_policy: "request" } })).data.id;
    const rOpen = (await ownerCall("/owner/rooms", { as: "github:erin", body: { name: "lobby", members: [e1.agent_id], join_policy: "open" } })).data.id;

    // 1. e2 discovers both same-owner rooms
    const disc = await call("/rooms/discover", { token: e2.token });
    expect(disc.status).toBe(200);
    expect(disc.data.rooms.find((x: any) => x.id === rOpen)?.can_join_directly).toBe(true);
    expect(disc.data.rooms.find((x: any) => x.id === rReq)?.can_join_directly).toBe(false);

    // 2. e2 joins open same-owner room directly
    const joinOpen = await call(`/rooms/${rOpen}/join`, { token: e2.token, body: {} });
    expect(joinOpen.status).toBe(200);
    expect(joinOpen.data.status).toBe("joined");

    // 3. e2 requests to join request-policy room -> owner approves
    const joinReq = await call(`/rooms/${rReq}/join`, { token: e2.token, body: { note: "Helping with ops" } });
    expect(joinReq.status).toBe(202);
    expect(joinReq.data.status).toBe("pending");
    const reqId = joinReq.data.request_id;

    const listJr = await ownerCall("/owner/join-requests", { as: "github:erin" });
    expect(listJr.data.join_requests.some((j: any) => j.id === reqId)).toBe(true);

    const dec = await ownerCall(`/owner/join-requests/${reqId}`, { as: "github:erin", body: { action: "approve", role: "post", can_manage: true } });
    expect(dec.status).toBe(200);
    expect(dec.data.status).toBe("approved");

    // 4. e1 (not can_manage) cannot add e3; e2 (can_manage=true) CAN add e3 and rename room
    expect((await call(`/rooms/${rReq}/members`, { token: e1.token, body: { agent_id: e3.agent_id } })).status).toBe(403);
    const addByAgent = await call(`/rooms/${rReq}/members`, { token: e2.token, body: { agent_id: e3.agent_id } });
    expect(addByAgent.status).toBe(200);
    expect(addByAgent.data.added).toEqual([e3.agent_id]);

    // Authorized agent cannot add another owner's agent directly
    expect((await call(`/rooms/${rReq}/members`, { token: e2.token, body: { agent_id: f1.agent_id } })).status).toBe(403);

    // Authorized agent can rename room
    const agentRename = await call(`/rooms/${rReq}`, { method: "PATCH", token: e2.token, body: { name: "ops-renamed" } });
    expect(agentRename.status).toBe(200);
    expect(agentRename.data.name).toBe("ops-renamed");

    // 5. Human owner can easily add agents directly
    expect((await call(`/rooms/${rReq}/leave`, { token: e3.token, body: {} })).status).toBe(200);
    const humanAdd = await ownerCall(`/owner/rooms/${rReq}/members`, { as: "github:erin", body: { agent_ids: [e3.agent_id], role: "read" } });
    expect(humanAdd.status).toBe(200);
    expect(humanAdd.data.added).toEqual([e3.agent_id]);

    // 6. Stranger frank cannot see or request erin's room
    expect((await call(`/rooms/${rReq}/join`, { token: f1.token, body: {} })).status).toBe(404);
  });

  it("lets owners manage/delete admin-created rooms and toggle thread auto-pause off", async () => {
    await registerOwner("github:grace", "grace@example.com");
    const g1 = await newAgent("github:grace", "g1");
    // Room created via /admin/rooms (created_by = 'admin')
    const adminRoomId = await newRoom([g1.agent_id], "pilot");

    const listed = await ownerCall("/owner/rooms", { as: "github:grace" });
    const found = listed.data.rooms.find((r: any) => r.id === adminRoomId);
    expect(found.can_manage).toBe(true);
    expect(found.auto_pause).toBe(true);

    // Disable thread freezing (auto_pause: false)
    const upd = await ownerCall(`/owner/rooms/${adminRoomId}`, { as: "github:grace", method: "PATCH", body: { auto_pause: false } });
    expect(upd.status).toBe(200);
    expect(upd.data.auto_pause).toBe(false);

    // Send 12 consecutive agent messages without hitting the turn cap (default 10)
    for (let i = 0; i < 12; i++) {
      const s = await call("/send", { token: g1.token, body: { room: adminRoomId, body: `msg ${i}` } });
      expect(s.status).toBe(201);
      expect(s.data.thread_paused).toBe(false);
    }

    // Owner can delete the admin-created room
    expect((await ownerCall(`/owner/rooms/${adminRoomId}`, { as: "github:grace", method: "DELETE" })).status).toBe(200);
  });
});
