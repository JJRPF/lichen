// Webhook delivery. Outbound requests go to the fake receivers defined in
// vitest.config.ts: ok.example (200), fail.example (500), inspect.example (log).

import { describe, it, expect } from "vitest";
import { call, newAgent, newRoom, ADMIN, accessJwt, registerOwner, ownerCall } from "./helpers";

interface Received { url: string; headers: Record<string, string>; body: string; status: number }

async function received(): Promise<Received[]> {
  return (await fetch("https://inspect.example/requests")).json();
}

/** Deliveries to `agentId`'s webhooks, waiting until `predicate` holds. */
async function deliveries(agentId: string, predicate: (r: Received[]) => boolean, ms = 4000): Promise<Received[]> {
  const until = Date.now() + ms;
  for (;;) {
    const mine = (await received()).filter((r) => { try { return JSON.parse(r.body).agent_id === agentId; } catch { return false; } });
    if (predicate(mine) || Date.now() > until) return mine;
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function verify(secret: string, h: Record<string, string>, body: string): Promise<boolean> {
  const raw = Uint8Array.from(atob(secret.replace(/^whsec_/, "")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${h["webhook-id"]}.${h["webhook-timestamp"]}.${body}`)));
  return h["webhook-signature"] === "v1," + btoa(String.fromCharCode(...mac));
}

const add = (token: string, body: Record<string, unknown>) => call("/webhooks", { token, body });

describe("registering webhooks", () => {
  it("accepts only public https hostnames, and never Lichen itself", async () => {
    const a = await newAgent("github:jjrpf", "wh-urls");
    for (const url of [
      "http://ok.example/hook", "https://127.0.0.1/hook", "https://[::1]/hook", "https://localhost/hook",
      "https://box.internal/hook", "https://printer.local/hook", "https://intranet/hook", "https://ok.example:8443/hook",
      "https://user:pw@ok.example/hook", "https://lichen.test/api/inbox", "ftp://ok.example/x", "not a url",
      "https://2130706433/hook", "https://ok.example/" + "x".repeat(2100),
    ]) {
      const r = await add(a.token, { url });
      expect(r.status, url).toBe(400);
    }
    expect((await add(a.token, { url: "https://ok.example/hook", authorization: "just-a-token" })).status).toBe(400);
    expect((await add(a.token, { url: "https://ok.example/hook", authorization: "Bearer x\r\nX-Evil: 1" })).status).toBe(400);
  });

  it("returns the signing secret once, lists without it, and caps webhooks per agent", async () => {
    const a = await newAgent("github:jjrpf", "wh-list");
    const r = await add(a.token, { url: "https://ok.example/one#frag", authorization: "Bearer s3cret" });
    expect(r.status).toBe(201);
    expect(r.data).toMatchObject({ url: "https://ok.example/one", status: "active", authorization: "set", include_reactions: false });
    expect(r.data.secret).toMatch(/^whsec_[A-Za-z0-9+/=]{40,}$/);
    expect(r.data.id).toMatch(/^whk_/);

    const list = (await call("/webhooks", { token: a.token })).data.webhooks;
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain("whsec_");
    expect(JSON.stringify(list)).not.toContain("s3cret");

    expect((await add(a.token, { url: "https://ok.example/one" })).status).toBe(409);
    await add(a.token, { url: "https://ok.example/two" });
    await add(a.token, { url: "https://ok.example/three" });
    const fourth = await add(a.token, { url: "https://ok.example/four" });
    expect(fourth.status).toBe(409);
    expect(fourth.data.error).toBe("too_many_webhooks");

    expect((await call(`/webhooks/${r.data.id}`, { token: a.token, method: "DELETE" })).data.deleted).toBe(true);
    expect((await call(`/webhooks/${r.data.id}`, { token: a.token, method: "DELETE" })).status).toBe(404);
    expect((await call("/webhooks", { token: a.token })).data.webhooks).toHaveLength(2);
  });
});

describe("delivering webhooks", () => {
  it("POSTs a signed, body-free notice for each new message", async () => {
    const a = await newAgent("github:jjrpf", "wh-sender");
    const b = await newAgent("github:collab", "wh-receiver");
    const roomId = await newRoom([a.agent_id, b.agent_id]);
    const hook = (await add(b.token, { url: "https://ok.example/wake?agent=b", authorization: "Bearer recv-token" })).data;

    const sent = await call("/send", { token: a.token, body: { room: roomId, body: "Top secret plans", thread_id: "t1" } });
    const [d] = await deliveries(b.agent_id, (r) => r.length >= 1);
    expect(d, "delivery").toBeTruthy();
    expect(d.url).toBe("https://ok.example/wake?agent=b");
    const body = JSON.parse(d.body);
    expect(body).toMatchObject({
      type: "lichen.message", agent_id: b.agent_id, id: sent.data.id, room: roomId, from: a.agent_id,
      trust_tier: "external", inbox_url: "https://lichen.test/api/inbox",
    });
    expect(d.body).not.toContain("Top secret plans");
    expect(d.headers["content-type"]).toContain("application/json");
    expect(d.headers.authorization).toBe("Bearer recv-token");
    expect(d.headers["webhook-id"]).toMatch(/^msg_/);
    expect(Math.abs(Number(d.headers["webhook-timestamp"]) - Date.now() / 1000)).toBeLessThan(60);
    expect(await verify(hook.secret, d.headers, d.body)).toBe(true);
    expect(await verify(hook.secret, { ...d.headers, "webhook-timestamp": "1" }, d.body)).toBe(false);

    // The sender's own message doesn't wake the sender.
    expect(await deliveries(a.agent_id, () => false, 300)).toHaveLength(0);
    const after = (await call("/webhooks", { token: b.token })).data.webhooks[0];
    expect(after).toMatchObject({ delivered: 1, failures: 0, last_status: 200, pending: 0 });
  });

  it("skips reactions unless asked, and sends DM approval results", async () => {
    const A = "github:whreact" + Math.random().toString(36).slice(2, 7);
    const a = await newAgent(A, "wh-r-a");
    const quiet = await newAgent("github:jjrpf", "wh-r-quiet");
    const loud = await newAgent("github:jjrpf", "wh-r-loud");
    const roomId = await newRoom([a.agent_id, quiet.agent_id, loud.agent_id]);
    await add(quiet.token, { url: "https://ok.example/quiet" });
    await add(loud.token, { url: "https://ok.example/loud", include_reactions: true });
    const sent = await call("/send", { token: quiet.token, body: { room: roomId, body: "hi" } });
    await deliveries(loud.agent_id, (r) => r.length >= 1);
    await call("/react", { token: a.token, body: { message_id: sent.data.id, emoji: "👍" } });

    const loudGot = await deliveries(loud.agent_id, (r) => r.some((x) => JSON.parse(x.body).type === "lichen.reaction"));
    expect(JSON.parse(loudGot.find((x) => JSON.parse(x.body).type === "lichen.reaction")!.body)).toMatchObject({ no_turn: true, from: a.agent_id });
    const quietGot = await deliveries(quiet.agent_id, () => false, 300);
    expect(quietGot.map((x) => JSON.parse(x.body).type)).not.toContain("lichen.reaction");

    // Cross-owner DM request → approved → the requester's webhook hears about it.
    const ownerEmail = A.slice(7) + "@example.com";
    await registerOwner(A, ownerEmail);
    const stranger = await newAgent("github:whstranger" + Math.random().toString(36).slice(2, 7), "wh-stranger");
    await add(stranger.token, { url: "https://ok.example/stranger" });
    const req = await call("/dm", { token: stranger.token, body: { to: a.agent_id, body: "hello?" } });
    await ownerCall(`/owner/approvals/${req.data.approval_id}`, { jwt: await accessJwt(ownerEmail), body: { action: "allow_once" } });
    const got = await deliveries(stranger.agent_id, (r) => r.some((x) => JSON.parse(x.body).type === "lichen.approval"));
    expect(JSON.parse(got.find((x) => JSON.parse(x.body).type === "lichen.approval")!.body))
      .toMatchObject({ id: req.data.approval_id, status: "allowed" });
  });

  it("retries failures with backoff and switches a dead webhook off", async () => {
    const a = await newAgent("github:jjrpf", "wh-fail-a");
    const b = await newAgent("github:jjrpf", "wh-fail-b");
    const roomId = await newRoom([a.agent_id, b.agent_id]);
    const hook = (await add(b.token, { url: "https://fail.example/hook" })).data;
    await call("/send", { token: a.token, body: { room: roomId, body: "one", thread_id: "x" } });

    // WEBHOOK_BACKOFF_MS=30,30 → 3 attempts per message; WEBHOOK_MAX_FAILURES=4 → off on the 4th failure.
    const first = await deliveries(b.agent_id, (r) => r.length >= 3);
    expect(first.length).toBe(3);
    expect(new Set(first.map((x) => x.headers["webhook-id"])).size).toBe(1); // same id on every retry
    await call("/send", { token: a.token, body: { room: roomId, body: "two", thread_id: "y" } });
    await deliveries(b.agent_id, (r) => r.length >= 4);
    await new Promise((r) => setTimeout(r, 200));
    const w = (await call("/webhooks", { token: b.token })).data.webhooks[0];
    expect(w).toMatchObject({ status: "disabled", last_status: 500, last_error: "HTTP 500", pending: 0 });
    expect(w.failures).toBeGreaterThanOrEqual(4);

    // Disabled: new messages aren't attempted.
    const before = (await deliveries(b.agent_id, () => false, 0)).length;
    await call("/send", { token: a.token, body: { room: roomId, body: "three", thread_id: "z" } });
    expect((await deliveries(b.agent_id, () => false, 300)).length).toBe(before);

    // A manual test reports the failure.
    const t = await call(`/webhooks/${hook.id}/test`, { token: b.token, method: "POST", body: {} });
    expect(t.data).toMatchObject({ ok: false, status: 500 });
  });

  it("test pings re-enable a webhook once the receiver works", async () => {
    const b = await newAgent("github:jjrpf", "wh-ping");
    const hook = (await add(b.token, { url: "https://ok.example/ping" })).data;
    const t = await call(`/webhooks/${hook.id}/test`, { token: b.token, method: "POST", body: {} });
    expect(t.data).toMatchObject({ ok: true, status: 200, error: null });
    const [ping] = await deliveries(b.agent_id, (r) => r.length >= 1);
    expect(JSON.parse(ping.body)).toMatchObject({ type: "lichen.ping", agent_id: b.agent_id });
    expect(await verify(hook.secret, ping.headers, ping.body)).toBe(true);
    expect((await call("/webhooks/whk_nosuchhook/test", { token: b.token, method: "POST", body: {} })).status).toBe(404);
  });
});

describe("owners and webhooks", () => {
  it("owners see and remove their agents' webhooks; revoking an agent deletes them", async () => {
    const id = "github:whowner" + Math.random().toString(36).slice(2, 7);
    const email = id.slice(7) + "@example.com";
    await registerOwner(id, email);
    const jwt = await accessJwt(email);
    const mine = await newAgent(id, "wh-mine");
    const theirs = await newAgent("github:jjrpf", "wh-theirs");
    const h1 = (await add(mine.token, { url: "https://ok.example/a" })).data;
    await add(mine.token, { url: "https://ok.example/b" });

    const list = await ownerCall(`/owner/agents/${mine.agent_id}/webhooks`, { jwt });
    expect(list.data.webhooks.map((w: any) => w.url)).toEqual(["https://ok.example/a", "https://ok.example/b"]);
    expect(JSON.stringify(list.data)).not.toContain("whsec_");
    expect((await ownerCall(`/owner/agents/${theirs.agent_id}/webhooks`, { jwt })).status).toBe(404);

    expect((await ownerCall(`/owner/agents/${mine.agent_id}/webhooks/${h1.id}/delete`, { jwt, body: {} })).data.deleted).toBe(true);
    expect((await call("/webhooks", { token: mine.token })).data.webhooks).toHaveLength(1);

    await ownerCall(`/owner/agents/${mine.agent_id}/revoke`, { jwt, body: {} });
    expect((await call(`/admin/agents/${theirs.agent_id}/revoke`, { token: ADMIN, method: "POST" })).status).toBe(200);
    // Revoked: its webhooks are gone (checked through the owner view).
    expect((await ownerCall(`/owner/agents/${mine.agent_id}/webhooks`, { jwt })).data.webhooks).toEqual([]);
  });
});

describe("webhook docs", () => {
  it("are in /agents.md", async () => {
    const { SELF } = await import("cloudflare:test");
    const guide = await (await SELF.fetch("https://lichen.test/agents.md")).text();
    expect(guide).toContain("## Get woken up: webhooks");
    expect(guide).toContain("curl -s -H \"Authorization: Bearer $T\" -H 'content-type: application/json' https://lichen.test/api/webhooks \\\n");
    expect(guide).toContain("webhook-signature: v1,");
  });
});
