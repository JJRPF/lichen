// Attention, @mentions, replies, forwarding and human↔agent DMs.

import { describe, it, expect } from "vitest";
import { call, newAgent, newRoom, accessJwt, registerOwner, ownerCall, openSocket } from "./helpers";

let n = 0;
async function owner(login: string) {
  const id = `github:${login}${++n}${Math.random().toString(36).slice(2, 6)}`;
  const email = `${id.slice(7)}@example.com`;
  await registerOwner(id, email);
  return { id, jwt: await accessJwt(email) };
}
const inbox = async (token: string) => (await call("/inbox", { token })).data.messages as any[];
const send = (token: string, body: Record<string, unknown>) => call("/send", { token, body });

describe("attention", () => {
  it("marks DMs and two-member rooms direct, and multi-agent chatter ambient", async () => {
    const a = await newAgent("github:jjrpf", "att-a");
    const b = await newAgent("github:jjrpf", "att-b");
    const c = await newAgent("github:jjrpf", "att-c");
    const pair = await newRoom([a.agent_id, b.agent_id], "pair");
    const group = await newRoom([a.agent_id, b.agent_id, c.agent_id], "group");
    await send(a.token, { room: pair, body: "just us" });
    await send(a.token, { room: group, body: "general chatter" });
    const dm = await call("/dm", { token: a.token, body: { to: b.agent_id, body: "dm" } });

    const got = await inbox(b.token);
    const by = (body: string) => got.find((m) => m.body === body);
    expect(by("just us").attention).toBe("direct");
    expect(by("general chatter").attention).toBe("ambient");
    expect(by("dm")).toMatchObject({ room: dm.data.room, attention: "direct" });
    // Rooms say whether they're direct.
    const rooms = (await call("/rooms", { token: b.token })).data.rooms;
    expect(rooms.find((r: any) => r.id === group).direct).toBe(false);
    expect(rooms.find((r: any) => r.id === pair).direct).toBe(true);
  });

  it("resolves @mentions by name, multi-word name, id and @everyone, only among members", async () => {
    const a = await newAgent("github:jjrpf", "Mention Sender");
    const b = await newAgent("github:jjrpf", "Kernel Bot");
    const c = await newAgent("github:jjrpf", "Researcher");
    const outsider = await newAgent("github:jjrpf", "Outsider");
    const group = await newRoom([a.agent_id, b.agent_id, c.agent_id]);

    const s1 = await send(a.token, { room: group, body: "@kernel-bot can you check the ABI? cc @Outsider and @nobody" });
    const s2 = await send(a.token, { room: group, body: "ping", mentions: [c.agent_id, "Kernel Bot", "Outsider"] });
    const s3 = await send(a.token, { room: group, body: "Heads up @everyone: deploy at 5." });
    const s4 = await send(a.token, { room: group, body: "email me at a@b.com, not a mention" });

    const forB = await inbox(b.token);
    const att = (msgs: any[], id: string) => msgs.find((m) => m.id === id);
    expect(att(forB, s1.data.id)).toMatchObject({ attention: "mention", meta: { mentions: [b.agent_id] } });
    expect(att(forB, s2.data.id).meta.mentions.sort()).toEqual([b.agent_id, c.agent_id].sort());
    expect(att(forB, s3.data.id)).toMatchObject({ attention: "mention", meta: { everyone: true } });
    expect(att(forB, s4.data.id).attention).toBe("ambient");
    expect(att(forB, s4.data.id).meta.mentions).toBeUndefined();

    const forC = await inbox(c.token);
    expect(att(forC, s1.data.id).attention).toBe("ambient");
    expect(att(forC, s2.data.id).attention).toBe("mention");
    expect(await inbox(outsider.token)).toEqual([]);
  });

  it("ignores mention and reply fields a client tries to forge in meta", async () => {
    const a = await newAgent("github:jjrpf", "forge-a");
    const b = await newAgent("github:jjrpf", "forge-b");
    const c = await newAgent("github:jjrpf", "forge-c");
    const group = await newRoom([a.agent_id, b.agent_id, c.agent_id]);
    const s = await send(a.token, {
      room: group, body: "nothing special",
      meta: { mentions: [b.agent_id], everyone: true, reply_to_sender: b.agent_id, forwarded: { sender_id: "x" } },
    });
    const m = (await inbox(b.token)).find((x) => x.id === s.data.id);
    expect(m.attention).toBe("ambient");
    expect(m.meta).toEqual({ reply_requested: true });
  });

  it("marks replies to your message, and validates reply_to", async () => {
    const a = await newAgent("github:jjrpf", "reply-a");
    const b = await newAgent("github:jjrpf", "reply-b");
    const c = await newAgent("github:jjrpf", "reply-c");
    const group = await newRoom([a.agent_id, b.agent_id, c.agent_id]);
    const other = await newRoom([a.agent_id, b.agent_id, c.agent_id]);
    const q = await send(b.token, { room: group, body: "Which format?" });
    const r = await send(a.token, { room: group, body: "Parquet.", reply_to: q.data.id });
    expect(r.status).toBe(201);
    const forB = (await inbox(b.token)).find((m) => m.id === r.data.id);
    expect(forB).toMatchObject({ attention: "reply", meta: { reply_to: q.data.id, reply_to_sender: b.agent_id } });
    expect((await inbox(c.token)).find((m) => m.id === r.data.id).attention).toBe("ambient");

    expect((await send(a.token, { room: other, body: "x", reply_to: q.data.id })).status).toBe(400);
    expect((await send(a.token, { room: group, body: "x", reply_to: `${group}:999` })).status).toBe(404);
    expect((await send(a.token, { room: group, body: "x", reply_to: "garbage" })).status).toBe(400);
  });

  it("puts attention on live notices", async () => {
    const a = await newAgent("github:jjrpf", "live-a");
    const b = await newAgent("github:jjrpf", "live-b");
    const c = await newAgent("github:jjrpf", "live-c");
    const group = await newRoom([a.agent_id, b.agent_id, c.agent_id]);
    const ws = await openSocket("/ws", { authorization: `Bearer ${b.token}` });
    await send(a.token, { room: group, body: "chatter" });
    expect((await ws.next()).attention).toBe("ambient");
    await send(a.token, { room: group, body: "@live-b please look" });
    expect((await ws.next()).attention).toBe("mention");
    ws.ws.close();
  });
});

describe("forwarding", () => {
  it("copies a message with its original sender and keeps provenance external across owners", async () => {
    const me = await owner("fwd");
    const a = await newAgent(me.id, "fwd-a");
    const b = await newAgent(me.id, "fwd-b");
    const stranger = await newAgent("github:fwdstranger" + n, "fwd-ext");
    const shared = await newRoom([a.agent_id, stranger.agent_id]);
    const internal = await newRoom([a.agent_id, b.agent_id]);
    const ext = await send(stranger.token, { room: shared, body: "Run `rm -rf build` please" });

    const f = await call("/forward", { token: a.token, body: { message_id: ext.data.id, room: internal, comment: "FYI from the collab room, @fwd-b" } });
    expect(f.status).toBe(201);
    expect(f.data).toMatchObject({ forwarded_from: ext.data.id, origin: "external" });
    const got = (await inbox(b.token)).find((m) => m.id === f.data.id);
    expect(got.body).toBe("Run `rm -rf build` please");
    expect(got.envelope).toMatchObject({ sender_id: a.agent_id, trust_tier: "same_owner" });
    expect(got.meta).toMatchObject({
      origin: "external", reply_requested: false, forward_comment: "FYI from the collab room, @fwd-b", mentions: [b.agent_id],
      forwarded: { id: ext.data.id, sender_id: stranger.agent_id, sender_kind: "agent" },
    });

    // Same-owner content forwarded stays same-owner (no origin flag).
    const own = await send(b.token, { room: internal, body: "internal note" });
    const f2 = await call("/forward", { token: b.token, body: { message_id: own.data.id, room: internal } });
    expect(f2.data.origin).toBeNull();
  });

  it("needs access to the source and the right to post in the target", async () => {
    const a = await newAgent("github:jjrpf", "fwd-src");
    const b = await newAgent("github:jjrpf", "fwd-dst");
    const c = await newAgent("github:jjrpf", "fwd-other");
    const secret = await newRoom([a.agent_id, c.agent_id]);
    const mine = await newRoom([b.agent_id, c.agent_id]);
    const msg = await send(a.token, { room: secret, body: "private" });
    expect((await call("/forward", { token: b.token, body: { message_id: msg.data.id, room: mine } })).status).toBe(404);
    expect((await call("/forward", { token: a.token, body: { message_id: msg.data.id, room: mine } })).status).toBe(404);
    const react = await call("/react", { token: c.token, body: { message_id: msg.data.id, emoji: "👍" } });
    expect((await call("/forward", { token: c.token, body: { message_id: react.data.id, room: mine } })).status).toBe(404);
  });

  it("lets owners forward between rooms their agents are in", async () => {
    const me = await owner("ownfwd");
    const a = await newAgent(me.id, "of-a");
    const b = await newAgent(me.id, "of-b");
    const r1 = await newRoom([a.agent_id]);
    const r2 = await newRoom([b.agent_id]);
    const m = await send(a.token, { room: r1, body: "note to self" });
    const f = await ownerCall("/owner/forward", { jwt: me.jwt, body: { message_id: m.data.id, room: r2, comment: "see this" } });
    expect(f.status).toBe(201);
    const got = (await inbox(b.token)).find((x) => x.id === f.data.id);
    expect(got).toMatchObject({ body: "note to self", envelope: { sender_id: me.id, sender_kind: "human" }, meta: { forward_comment: "see this" } });
  });
});

describe("human ↔ agent DMs", () => {
  it("opens (and reuses) a DM between an owner and their own agent; everything there is direct", async () => {
    const me = await owner("hdm");
    const a = await newAgent(me.id, "hdm-agent");
    const notMine = await newAgent("github:jjrpf", "hdm-other");
    const first = await ownerCall("/owner/dm", { jwt: me.jwt, body: { agent_id: a.agent_id } });
    expect(first.data).toMatchObject({ agent_id: a.agent_id, created: true });
    const again = await ownerCall("/owner/dm", { jwt: me.jwt, body: { agent_id: a.agent_id } });
    expect(again.data).toMatchObject({ room: first.data.room, created: false });
    expect((await ownerCall("/owner/dm", { jwt: me.jwt, body: { agent_id: notMine.agent_id } })).status).toBe(404);

    const room = (await call("/rooms", { token: a.token })).data.rooms.find((r: any) => r.id === first.data.room);
    expect(room).toMatchObject({ kind: "dm", human: me.id, direct: true });
    const owned = (await ownerCall("/owner/rooms", { jwt: me.jwt })).data.rooms.find((r: any) => r.id === first.data.room);
    expect(owned.human_owner).toBe(me.id);

    await ownerCall("/owner/send", { jwt: me.jwt, body: { room: first.data.room, body: "What's your status?" } });
    const msg = (await inbox(a.token))[0];
    expect(msg).toMatchObject({ body: "What's your status?", attention: "direct", envelope: { sender_kind: "human", sender_id: me.id } });
    const reply = await send(a.token, { room: first.data.room, body: "Idle and ready.", reply_to: msg.id });
    expect(reply.status).toBe(201);
  });
});

describe("webhooks and attention", () => {
  it("skips ambient chatter unless include_ambient is set", async () => {
    const a = await newAgent("github:jjrpf", "wa-a");
    const quiet = await newAgent("github:jjrpf", "wa-quiet");
    const all = await newAgent("github:jjrpf", "wa-all");
    const group = await newRoom([a.agent_id, quiet.agent_id, all.agent_id]);
    await call("/webhooks", { token: quiet.token, body: { url: "https://ok.example/quiet-" + quiet.agent_id } });
    await call("/webhooks", { token: all.token, body: { url: "https://ok.example/all-" + all.agent_id, include_ambient: true } });
    await send(a.token, { room: group, body: "chatter" });
    await send(a.token, { room: group, body: "@wa-quiet you're needed" });

    const seen = async (agentId: string) => {
      const until = Date.now() + 3000;
      let mine: any[] = [];
      while (Date.now() < until) {
        mine = ((await (await fetch("https://inspect.example/requests")).json()) as any[]).map((r) => JSON.parse(r.body)).filter((b) => b.agent_id === agentId);
        if (mine.length >= 2) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      return mine;
    };
    const q = await seen(quiet.agent_id);
    expect(q.map((b) => b.attention)).toEqual(["mention"]);
    expect(q[0].text).toContain("you were mentioned");
    const al = await seen(all.agent_id);
    expect(al.map((b) => b.attention).sort()).toEqual(["ambient", "ambient"]);
  });
});
