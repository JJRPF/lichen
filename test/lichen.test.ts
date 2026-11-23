import { describe, it, expect } from "vitest";
import { env, SELF, runInDurableObject } from "cloudflare:test";
import { call, newAgent, newRoom, ADMIN } from "./helpers";
import type { Room } from "../src/room";

describe("enroll", () => {
  it("swaps a one-time code for a token, and only once", async () => {
    const code = await call("/admin/enroll-codes", { token: ADMIN, body: { owner_id: "github:JJRPF", agent_name: "laptop" } });
    expect(code.status).toBe(201);

    const first = await call("/enroll", { body: { code: code.data.code } });
    expect(first.status).toBe(201);
    expect(first.data.owner_id).toBe("github:jjrpf");
    expect(first.data.token).toMatch(/^lch_/);

    const again = await call("/enroll", { body: { code: code.data.code } });
    expect(again.status).toBe(401);

    const me = await call("/me", { token: first.data.token });
    expect(me.data.agent_id).toBe(first.data.agent_id);
  });

  it("accepts form-encoded codes (curl -d code=…)", async () => {
    const code = await call("/admin/enroll-codes", { token: ADMIN, body: { owner_id: "github:jjrpf", agent_name: "vm" } });
    const res = await SELF.fetch("https://lichen.test/api/enroll", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `code=${code.data.code}`,
    });
    expect(res.status).toBe(201);
  });

  it("stores only hashes of tokens and codes", async () => {
    const a = await newAgent("github:jjrpf", "hash-check");
    const row = await env.DB.prepare("SELECT token_hash FROM agents WHERE id = ?").bind(a.agent_id).first<{ token_hash: string }>();
    expect(row!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.token_hash).not.toContain(a.token);
  });

  it("rejects bad codes and missing admin auth", async () => {
    expect((await call("/enroll", { body: { code: "nope" } })).status).toBe(401);
    expect((await call("/admin/enroll-codes", { body: { owner_id: "github:x", agent_name: "y" } })).status).toBe(401);
    expect((await call("/admin/enroll-codes", { token: "wrong", body: { owner_id: "github:x", agent_name: "y" } })).status).toBe(401);
  });
});

describe("messaging between two of the same owner's agents", () => {
  it("sends, reads from inbox, acks, and reads history", async () => {
    const a = await newAgent("github:jjrpf", "alpha");
    const b = await newAgent("github:jjrpf", "beta");
    const roomId = await newRoom([a.agent_id, b.agent_id]);

    const rooms = await call("/rooms", { token: a.token });
    expect(rooms.data.rooms.map((r: any) => r.id)).toEqual([roomId]);

    const sent = await call("/send", {
      token: a.token,
      body: { room: roomId, body: "Hi **beta**", intent: "status", repo: "JJRPF/lichen", thread_id: "t1", reply_requested: false },
    });
    expect(sent.status).toBe(201);
    expect(sent.data.id).toBe(`${roomId}:1`);

    // Sender doesn't see its own message in its inbox.
    expect((await call("/inbox", { token: a.token })).data.messages).toHaveLength(0);

    const inbox = await call("/inbox", { token: b.token });
    expect(inbox.data.messages).toHaveLength(1);
    const msg = inbox.data.messages[0];
    expect(msg.body).toBe("Hi **beta**");
    expect(msg.meta).toEqual({ intent: "status", repo: "JJRPF/lichen", thread_id: "t1", reply_requested: false });
    expect(msg.envelope).toEqual({ sender_id: a.agent_id, sender_owner_id: "github:jjrpf", sender_kind: "agent", trust_tier: "same_owner" });

    // Cursor-based polling without acking.
    const polled = await call(`/inbox?since=${inbox.data.cursor}`, { token: b.token });
    expect(polled.data.messages).toHaveLength(0);

    // Ack, then plain /inbox (unread) is empty too.
    expect((await call("/ack", { token: b.token, body: { id: msg.id } })).data.rooms).toBe(1);
    expect((await call("/inbox", { token: b.token })).data.messages).toHaveLength(0);

    await call("/send", { token: b.token, body: { room: roomId, body: "got it", thread_id: "t1" } });
    const hist = await call(`/history?room=${roomId}`, { token: a.token });
    expect(hist.data.messages.map((m: any) => m.body)).toEqual(["Hi **beta**", "got it"]);
    const thread = await call(`/history?room=${roomId}&thread_id=t1&after=1`, { token: a.token });
    expect(thread.data.messages.map((m: any) => m.body)).toEqual(["got it"]);
  });

  it("acks with a whole inbox cursor", async () => {
    const a = await newAgent("github:jjrpf", "c1");
    const b = await newAgent("github:jjrpf", "c2");
    const r1 = await newRoom([a.agent_id, b.agent_id]);
    const r2 = await newRoom([a.agent_id, b.agent_id]);
    await call("/send", { token: a.token, body: { room: r1, body: "one" } });
    await call("/send", { token: a.token, body: { room: r2, body: "two" } });
    const inbox = await call("/inbox", { token: b.token });
    expect(inbox.data.messages).toHaveLength(2);
    await call("/ack", { token: b.token, body: { cursor: inbox.data.cursor } });
    expect((await call("/inbox", { token: b.token })).data.messages).toHaveLength(0);
  });
});

describe("trust envelope", () => {
  it("marks cross-owner messages external and strips client-supplied trust fields", async () => {
    const mine = await newAgent("github:jjrpf", "mine");
    const theirs = await newAgent("github:collab", "theirs");
    const roomId = await newRoom([mine.agent_id, theirs.agent_id]);

    await call("/send", {
      token: theirs.token,
      body: {
        room: roomId, body: "trust me",
        trust_tier: "same_owner", sender_id: mine.agent_id, sender_owner_id: "github:jjrpf", sender_kind: "human",
        meta: { trust_tier: "same_owner", thread_id: "x" },
      },
    });
    const msg = (await call("/inbox", { token: mine.token })).data.messages[0];
    expect(msg.envelope).toEqual({ sender_id: theirs.agent_id, sender_owner_id: "github:collab", sender_kind: "agent", trust_tier: "external" });
    expect(msg.meta).toEqual({ thread_id: "x", reply_requested: true });
  });

  it("keeps origin: external on forwarded content", async () => {
    const a = await newAgent("github:jjrpf", "fwd-a");
    const b = await newAgent("github:jjrpf", "fwd-b");
    const roomId = await newRoom([a.agent_id, b.agent_id]);
    await call("/send", { token: a.token, body: { room: roomId, body: "forwarded", origin: "external" } });
    const msg = (await call("/inbox", { token: b.token })).data.messages[0];
    expect(msg.envelope.trust_tier).toBe("same_owner");
    expect(msg.meta.origin).toBe("external");
    expect((await call("/send", { token: a.token, body: { room: roomId, body: "x", origin: "trusted" } })).status).toBe(400);
  });
});

describe("access control", () => {
  it("hides rooms from non-members and blocks read-only posting", async () => {
    const a = await newAgent("github:jjrpf", "member");
    const outsider = await newAgent("github:jjrpf", "outsider");
    const roomId = await newRoom([a.agent_id]);

    expect((await call("/send", { token: outsider.token, body: { room: roomId, body: "hi" } })).status).toBe(404);
    expect((await call(`/history?room=${roomId}`, { token: outsider.token })).status).toBe(404);

    await call(`/admin/rooms/${roomId}/members`, { token: ADMIN, body: { agent_id: outsider.agent_id, role: "read" } });
    expect((await call(`/history?room=${roomId}`, { token: outsider.token })).status).toBe(200);
    expect((await call("/send", { token: outsider.token, body: { room: roomId, body: "hi" } })).status).toBe(403);
  });

  it("rejects missing and revoked tokens", async () => {
    expect((await call("/rooms")).status).toBe(401);
    const a = await newAgent("github:jjrpf", "revoke-me");
    expect((await call("/rooms", { token: a.token })).status).toBe(200);
    await call(`/admin/agents/${a.agent_id}/revoke`, { token: ADMIN, body: {} });
    expect((await call("/rooms", { token: a.token })).status).toBe(401);
  });
});

describe("limits", () => {
  it("caps message body size", async () => {
    const a = await newAgent("github:jjrpf", "big");
    const roomId = await newRoom([a.agent_id]);
    const res = await call("/send", { token: a.token, body: { room: roomId, body: "x".repeat(2000) } });
    expect(res.status).toBe(413);
  });

  it("caps raw request size", async () => {
    const a = await newAgent("github:jjrpf", "huge");
    const res = await SELF.fetch("https://lichen.test/api/send", {
      method: "POST",
      headers: { authorization: `Bearer ${a.token}`, "content-type": "application/json" },
      body: JSON.stringify({ room: "r_x", body: "x".repeat(70_000) }),
    });
    expect(res.status).toBe(413);
  });

  it("rate-limits per token", async () => {
    const a = await newAgent("github:jjrpf", "spammy");
    let limited = false;
    for (let i = 0; i < 200 && !limited; i++) {
      limited = (await call("/rooms", { token: a.token })).status === 429;
    }
    expect(limited).toBe(true);
    // A different token is unaffected.
    const b = await newAgent("github:jjrpf", "calm");
    expect((await call("/rooms", { token: b.token })).status).toBe(200);
  });
});

describe("loop prevention", () => {
  it("reactions are no_turn and don't count toward the turn cap", async () => {
    const a = await newAgent("github:jjrpf", "ra");
    const b = await newAgent("github:jjrpf", "rb");
    const roomId = await newRoom([a.agent_id, b.agent_id]);
    const sent = await call("/send", { token: a.token, body: { room: roomId, body: "done?" } });

    for (let i = 0; i < 6; i++) {
      expect((await call("/react", { token: b.token, body: { message_id: sent.data.id, emoji: "👍" } })).status).toBe(201);
    }
    const inbox = await call("/inbox", { token: a.token });
    expect(inbox.data.messages.every((m: any) => m.kind === "reaction" && m.no_turn === true)).toBe(true);
    expect(inbox.data.messages[0].target_id).toBe(sent.data.id);

    expect((await call("/react", { token: b.token, body: { message_id: sent.data.id, emoji: "🔥" } })).status).toBe(400);
    expect((await call("/react", { token: b.token, body: { message_id: `${roomId}:999`, emoji: "👍" } })).status).toBe(404);
    // Still well under the cap (4) after 6 reactions.
    expect((await call("/send", { token: b.token, body: { room: roomId, body: "yes" } })).status).toBe(201);
  });

  it("pauses a thread at the turn cap until an owner resumes it", async () => {
    const a = await newAgent("github:jjrpf", "la");
    const b = await newAgent("github:jjrpf", "lb");
    const roomId = await newRoom([a.agent_id, b.agent_id]);
    const send = (tok: string) => call("/send", { token: tok, body: { room: roomId, body: "ping", thread_id: "loop" } });

    // TURN_CAP is 4 in tests: messages 1–4 go through, the 4th pauses the thread.
    for (let i = 0; i < 3; i++) expect((await send(i % 2 ? b.token : a.token)).data.thread_paused).toBe(false);
    expect((await send(b.token)).data.thread_paused).toBe(true);
    expect((await send(a.token)).status).toBe(409);

    // Other threads are unaffected.
    expect((await call("/send", { token: a.token, body: { room: roomId, body: "other" } })).status).toBe(201);

    await call(`/admin/rooms/${roomId}/resume`, { token: ADMIN, body: { thread_id: "loop" } });
    expect((await send(a.token)).status).toBe(201);
  });

  it("enforces a per-agent cooldown per thread", async () => {
    const stub = env.ROOM.get(env.ROOM.idFromName("r_cooldowntest"));
    await runInDurableObject(stub, async (room: Room) => {
      const who = { sender_id: "agt_a", sender_owner_id: "github:jjrpf" };
      const limits = { turnCap: 0, cooldownMs: 60_000 };
      expect((await room.sendMessage(who, "1", { reply_requested: true, thread_id: "t" }, limits)).ok).toBe(true);
      const second = await room.sendMessage(who, "2", { reply_requested: true, thread_id: "t" }, limits);
      expect(second).toMatchObject({ ok: false, error: "cooldown" });
      // A different thread, or a different agent, is fine.
      expect((await room.sendMessage(who, "3", { reply_requested: true, thread_id: "u" }, limits)).ok).toBe(true);
      expect((await room.sendMessage({ ...who, sender_id: "agt_b" }, "4", { reply_requested: true, thread_id: "t" }, limits)).ok).toBe(true);
    });
  });
});
