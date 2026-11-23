// Profiles, polls and images.

import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";
import { call, newAgent, newRoom, accessJwt, registerOwner, ownerCall, openSocket } from "./helpers";

let n = 0;
async function owner(login: string) {
  const id = `github:${login}${++n}${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
  const email = `${id.slice(7)}@example.com`;
  await registerOwner(id, email);
  return { id, jwt: await accessJwt(email) };
}
const BASE = "https://lichen.test/api";
const raw = (path: string, token: string, init: RequestInit = {}) =>
  SELF.fetch(BASE + path, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers as any) } });

// Smallest valid images for each type (magic bytes are what count).
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1]);
const GIF = new TextEncoder().encode("GIF89a\x01\x00\x01\x00");
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

describe("profiles", () => {
  it("lets an agent describe itself, with validation; agents have no pronouns and model is a family", async () => {
    const me = await owner("prof");
    const a = await newAgent(me.id, "prof-agent");
    const r = await call("/me/profile", { token: a.token, method: "PATCH", body: {
      display_name: "Prof\nAgent", status_text: "to infinity and beyond", bio: "I review **PRs**.\nhttps://github.com/JJRPF/lichen",
      banner_color: "#5B8BD0", role: "Code reviewer", model: "claude", runtime: "Claude Code (cloud)",
      capabilities: ["code review", "TypeScript", "code review"], links: [{ label: "Repo", url: "https://github.com/JJRPF/lichen" }],
      pronouns: "they/them",
    } });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({
      id: a.agent_id, kind: "agent", username: "prof-agent", display_name: "Prof Agent", status_text: "to infinity and beyond",
      banner_color: "#5b8bd0", role: "Code reviewer", model: "Claude", runtime: "Claude Code (cloud)",
      capabilities: ["code review", "TypeScript"], owner: { id: me.id, verified: true }, trust_tier: "same_owner",
      connections: [{ type: "github", login: me.id.slice(7), verified: true, via: "owner" }],
      presence: { state: "offline" },
    });
    expect(r.data).not.toHaveProperty("pronouns");
    expect(r.data.member_since).toBeGreaterThan(0);
    expect(r.data.presence.last_seen_at).toBeGreaterThan(0);

    for (const bad of [{ model: "GPT-4o-2024" }, { banner_color: "red" }, { links: [{ url: "http://x.example" }] },
      { capabilities: Array(13).fill("x") }, { bio: "x".repeat(1001) }]) {
      expect((await call("/me/profile", { token: a.token, method: "PATCH", body: bad })).status, JSON.stringify(bad)).toBe(400);
    }
    // null clears
    const cleared = await call("/me/profile", { token: a.token, method: "PATCH", body: { status_text: null, model: "" } });
    expect(cleared.data).toMatchObject({ status_text: null, model: null, role: "Code reviewer" });
  });

  it("shows presence: online with a socket, reachable with a webhook", async () => {
    const a = await newAgent("github:jjrpf", "pres");
    const ws = await openSocket("/ws", { authorization: `Bearer ${a.token}` });
    expect((await call("/me/profile", { token: a.token })).data.presence.state).toBe("online");
    ws.ws.close();
    await new Promise((r) => setTimeout(r, 100));
    await call("/webhooks", { token: a.token, body: { url: "https://ok.example/pres-" + a.agent_id } });
    expect((await call("/me/profile", { token: a.token })).data.presence.state).toBe("reachable");
  });

  it("is visible only within the owner's network, with mutual rooms", async () => {
    const A = await owner("visA"); const B = await owner("visB"); const C = await owner("visC");
    const a = await newAgent(A.id, "vis-a"); const b = await newAgent(B.id, "vis-b"); const c = await newAgent(C.id, "vis-c");
    const shared = await newRoom([a.agent_id, b.agent_id], "shared");
    await newRoom([b.agent_id, c.agent_id], "b-c");
    await ownerCall("/owner/profile", { jwt: B.jwt, body: { display_name: "Bea", pronouns: "she/her", bio: "Kernel person" } });

    const seen = await call(`/profiles/${b.agent_id}`, { token: a.token });
    expect(seen.data).toMatchObject({ trust_tier: "external", mutual_rooms: [{ id: shared, name: "shared" }] });
    const human = await call(`/profiles/${encodeURIComponent(B.id)}`, { token: a.token });
    expect(human.data).toMatchObject({ kind: "human", display_name: "Bea", pronouns: "she/her", connections: [{ via: "sign-in", verified: true }] });
    // Two hops away: invisible, for agents and owners alike.
    expect((await call(`/profiles/${c.agent_id}`, { token: a.token })).status).toBe(404);
    expect((await call(`/profiles/${encodeURIComponent(C.id)}`, { token: a.token })).status).toBe(404);
    expect((await ownerCall(`/owner/profiles/${c.agent_id}`, { jwt: A.jwt })).status).toBe(404);
    expect((await ownerCall(`/owner/profiles/${b.agent_id}`, { jwt: A.jwt })).data.mutual_rooms.map((r: any) => r.id)).toEqual([shared]);
    expect((await call("/profiles/agt_nosuchagent", { token: a.token })).status).toBe(404);
  });

  it("lets owners edit their agents, keep private notes, and upload avatars (images only)", async () => {
    const me = await owner("own");
    const other = await owner("own-other");
    const a = await newAgent(me.id, "own-a");
    const theirs = await newAgent(other.id, "own-theirs");
    await newRoom([a.agent_id, theirs.agent_id]);

    expect((await ownerCall(`/owner/agents/${a.agent_id}/profile`, { jwt: me.jwt, body: { role: "Planner", model: "Gemini" } })).data)
      .toMatchObject({ role: "Planner", model: "Gemini" });
    expect((await ownerCall(`/owner/agents/${theirs.agent_id}/profile`, { jwt: me.jwt, body: { role: "x" } })).status).toBe(404);

    // Notes are private to the owner who wrote them.
    await ownerCall(`/owner/notes/${theirs.agent_id}`, { jwt: me.jwt, method: "PUT", body: { note: "Reliable on kernel questions" } });
    expect((await ownerCall(`/owner/profiles/${theirs.agent_id}`, { jwt: me.jwt })).data.note).toBe("Reliable on kernel questions");
    expect((await call(`/profiles/${theirs.agent_id}`, { token: a.token })).data).not.toHaveProperty("note");
    expect((await ownerCall(`/owner/profiles/${theirs.agent_id}`, { jwt: other.jwt })).data.note).toBeNull();

    // Avatars: sniffed by magic bytes; SVG and other types refused.
    const up = await raw("/me/avatar", a.token, { method: "PUT", headers: { "content-type": "image/png" }, body: PNG });
    expect(up.status).toBe(200);
    const url = ((await up.json()) as any).avatar as string;
    expect(url).toMatch(new RegExp(`^${BASE}/avatars/${a.agent_id}\\?v=[0-9a-f]{12}$`));
    const img = await raw(url.slice(BASE.length), theirs.token);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(img.headers.get("content-security-policy")).toContain("sandbox");
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(PNG);
    expect((await raw("/me/avatar", a.token, { method: "PUT", headers: { "content-type": "image/svg+xml" }, body: SVG })).status).toBe(415);
    expect((await raw("/me/avatar", a.token, { method: "PUT", body: new Uint8Array(300 * 1024).fill(0x89) })).status).toBe(413);
    expect((await call(`/profiles/${a.agent_id}`, { token: theirs.token })).data.avatar).toContain("/api/avatars/");
    // Owner dashboards get owner-side avatar URLs, and room members carry display names.
    expect((await ownerCall(`/owner/profiles/${a.agent_id}`, { jwt: me.jwt })).data.avatar).toContain("/api/owner/avatars/");
    const member = (await ownerCall("/owner/rooms", { jwt: me.jwt })).data.rooms[0].members.find((m: any) => m.agent_id === a.agent_id);
    expect(member.avatar).toContain("/api/owner/avatars/");
  });
});

describe("polls", () => {
  it("creates a poll, counts votes per voter, and closes on time", async () => {
    const a = await newAgent("github:jjrpf", "poll-a");
    const b = await newAgent("github:jjrpf", "poll-b");
    const c = await newAgent("github:jjrpf", "poll-c");
    const roomId = await newRoom([a.agent_id, b.agent_id, c.agent_id]);
    const p = await call("/polls", { token: a.token, body: { room: roomId, question: "Which format? @poll-b", options: ["Parquet", "Arrow", "CSV"] } });
    expect(p.status).toBe(201);

    const forB = (await call("/inbox", { token: b.token })).data.messages[0];
    expect(forB).toMatchObject({ id: p.data.id, kind: "poll", body: "Which format? @poll-b", attention: "mention",
      poll: { options: ["Parquet", "Arrow", "CSV"], multi: false, counts: [0, 0, 0], voters: 0, mine: [], closed: false } });

    expect((await call("/vote", { token: b.token, body: { message_id: p.data.id, option: 0 } })).data.poll).toMatchObject({ counts: [1, 0, 0], mine: [0] });
    expect((await call("/vote", { token: c.token, body: { message_id: p.data.id, options: [1] } })).data.poll).toMatchObject({ counts: [1, 1, 0], voters: 2 });
    // Changing your vote replaces it; single choice refuses two.
    expect((await call("/vote", { token: b.token, body: { message_id: p.data.id, options: [1] } })).data.poll.counts).toEqual([0, 2, 0]);
    expect((await call("/vote", { token: b.token, body: { message_id: p.data.id, options: [0, 1] } })).status).toBe(400);
    expect((await call("/vote", { token: b.token, body: { message_id: p.data.id, options: [7] } })).status).toBe(400);
    // Votes don't create messages and don't wake anyone.
    expect((await call("/inbox", { token: a.token })).data.messages).toEqual([]);
    const hist = (await call(`/history?room=${roomId}`, { token: a.token })).data.messages;
    expect(hist).toHaveLength(1);
    expect(hist[0].poll).toMatchObject({ counts: [0, 2, 0], mine: [] });

    for (const bad of [{ options: ["only one"] }, { options: ["a", "A"] }, { options: Array(11).fill(0).map((_, i) => `o${i}`) }, { options: ["a", "b"], duration_minutes: 0 }]) {
      expect((await call("/polls", { token: a.token, body: { room: roomId, question: "q", ...bad } })).status, JSON.stringify(bad)).toBe(400);
    }
    const quick = await call("/polls", { token: a.token, body: { room: roomId, question: "Multi?", options: ["x", "y"], multi: true, duration_minutes: 1 } });
    expect((await call("/vote", { token: b.token, body: { message_id: quick.data.id, options: [0, 1] } })).data.poll.counts).toEqual([1, 1]);
    expect((await call("/vote", { token: b.token, body: { message_id: `${roomId}:999`, options: [0] } })).status).toBe(404);
  });

  it("lets owners create polls and vote as themselves", async () => {
    const me = await owner("opoll");
    const a = await newAgent(me.id, "opoll-a");
    const roomId = await newRoom([a.agent_id]);
    const p = await ownerCall("/owner/polls", { jwt: me.jwt, body: { room: roomId, question: "Ship today?", options: ["Yes", "No"] } });
    expect(p.status).toBe(201);
    const msg = (await call("/inbox", { token: a.token })).data.messages[0];
    expect(msg).toMatchObject({ kind: "poll", envelope: { sender_kind: "human" }, attention: "direct" });
    expect((await ownerCall("/owner/vote", { jwt: me.jwt, body: { message_id: p.data.id, option: 0 } })).data.poll).toMatchObject({ counts: [1, 0], mine: [0] });
    const seen = (await ownerCall(`/owner/history?room=${roomId}`, { jwt: me.jwt })).data.messages[0];
    expect(seen.poll.mine).toEqual([0]);
  });
});

describe("images", () => {
  it("uploads, attaches by id, and serves only to members; messages carry no bytes", async () => {
    const a = await newAgent("github:jjrpf", "img-a");
    const b = await newAgent("github:jjrpf", "img-b");
    const outsider = await newAgent("github:jjrpf", "img-out");
    const roomId = await newRoom([a.agent_id, b.agent_id]);
    const up = await raw(`/images?room=${roomId}`, a.token, { method: "POST", headers: { "content-type": "image/gif" }, body: GIF });
    expect(up.status).toBe(201);
    const { id, type, size } = (await up.json()) as any;
    expect({ type, size }).toEqual({ type: "image/gif", size: GIF.byteLength });

    // Image-only message, with alt text.
    const sent = await call("/send", { token: a.token, body: { room: roomId, images: [{ id, alt: "build graph" }] } });
    expect(sent.status).toBe(201);
    const got = (await call("/inbox", { token: b.token })).data.messages[0];
    expect(got.body).toBe("");
    expect(got.meta.images).toEqual([{ id, type: "image/gif", size: GIF.byteLength, alt: "build graph" }]);

    const img = await raw(`/images/${roomId}/${id}`, b.token);
    expect(img.status).toBe(200);
    expect(img.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(GIF);
    expect((await raw(`/images/${roomId}/${id}`, outsider.token)).status).toBe(404);

    // An image is used once, by its uploader, in its room.
    expect((await call("/send", { token: a.token, body: { room: roomId, body: "again", images: [id] } })).status).toBe(400);
    const up2 = (await (await raw(`/images?room=${roomId}`, a.token, { method: "POST", body: PNG })).json()) as any;
    expect((await call("/send", { token: b.token, body: { room: roomId, body: "stolen", images: [up2.id] } })).status).toBe(400);
    expect((await raw(`/images?room=${roomId}`, a.token, { method: "POST", body: SVG })).status).toBe(415);
    expect((await raw(`/images?room=${roomId}`, outsider.token, { method: "POST", body: PNG })).status).toBe(404);
    expect((await call("/send", { token: a.token, body: { room: roomId } })).status).toBe(400); // no body, no images
  });

  it("lets owners upload and view images in their agents' rooms", async () => {
    const me = await owner("oimg");
    const a = await newAgent(me.id, "oimg-a");
    const roomId = await newRoom([a.agent_id]);
    const res = await SELF.fetch(`${BASE}/owner/images?room=${roomId}`, {
      method: "POST", body: PNG, headers: { "cf-access-jwt-assertion": me.jwt, origin: "https://lichen.test", "content-type": "image/png" },
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as any;
    expect((await ownerCall("/owner/send", { jwt: me.jwt, body: { room: roomId, body: "Screenshot:", images: [id] } })).status).toBe(201);
    const view = await SELF.fetch(`${BASE}/owner/images/${roomId}/${id}`, { headers: { "cf-access-jwt-assertion": me.jwt } });
    expect(view.headers.get("content-type")).toBe("image/png");
    // JSON content-type is refused for uploads (and image/* for JSON routes is irrelevant).
    const bad = await SELF.fetch(`${BASE}/owner/images?room=${roomId}`, {
      method: "POST", body: PNG, headers: { "cf-access-jwt-assertion": me.jwt, origin: "https://lichen.test", "content-type": "application/json" },
    });
    expect(bad.status).toBe(415);
  });
});
