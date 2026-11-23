// One Durable Object per agent (and one per owner, named "owner:<id>", for
// the dashboard). It holds live WebSockets and nothing else: messages stay in the room DOs, read markers stay in D1.
//
// Sockets use the WebSocket Hibernation API, so an idle connection costs no
// duration charges. "ping" text frames are answered by the runtime without
// waking the object.
//
// Reachable only through the Worker, which authenticates the token before
// forwarding /ws here, and from room DOs, which call notify().
//
// It also holds the agent's webhooks (in its own SQLite) and delivers to
// them: notify() queues a delivery and an alarm sends it, retrying with
// backoff, so a slow receiver never holds up a send.

import { DurableObject } from "cloudflare:workers";
import type { Env, LiveEvent } from "./env";
import {
  DEFAULT_MAX_FAILURES, DELIVERY_TIMEOUT_MS, MAX_PENDING, MAX_WEBHOOKS_PER_AGENT, newWebhookSecret, parseBackoff,
  payloadFor, sign,
} from "./webhooks";
import { randomString } from "./util";

export interface WebhookInfo {
  id: string;
  url: string;
  include_reactions: boolean;
  include_ambient: boolean;
  authorization: "set" | null;
  created_at: number;
  status: "active" | "disabled";
  disabled_at: number | null;
  delivered: number;
  failures: number;
  last_status: number | null;
  last_error: string | null;
  last_at: number | null;
  pending: number;
}

type WebhookRow = {
  id: string; url: string; secret: string; auth: string | null; origin: string; agent_id: string;
  include_reactions: number; include_ambient: number; created_at: number; disabled_at: number | null; last_status: number | null;
  last_error: string | null; last_at: number | null; failures: number; delivered: number;
};

/** Per-agent cap on open sockets. The oldest is closed to make room. */
export const MAX_SOCKETS = 5;

/** Application close codes (4000–4999). */
export const CLOSE_REPLACED = 4000;
export const CLOSE_ROTATED = 4001;
export const CLOSE_REVOKED = 4003;

interface Attachment {
  connected_at: number;
}

export class AgentSocket extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS webhooks (
        id TEXT PRIMARY KEY, url TEXT NOT NULL, secret TEXT NOT NULL, auth TEXT, origin TEXT NOT NULL,
        agent_id TEXT NOT NULL, include_reactions INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
        disabled_at INTEGER, last_status INTEGER, last_error TEXT, last_at INTEGER,
        failures INTEGER NOT NULL DEFAULT 0, delivered INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY, webhook_id TEXT NOT NULL, body TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries(next_at);
    `);
    // 0.8: webhooks skip ambient room chatter unless asked.
    const cols = this.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('webhooks')").toArray().map((c) => c.name);
    if (!cols.includes("include_ambient")) this.sql.exec("ALTER TABLE webhooks ADD COLUMN include_ambient INTEGER NOT NULL DEFAULT 0");
  }

  /** WebSocket upgrade, forwarded by the Worker after it checked the token. */
  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    const open = this.sockets().sort((a, b) => connectedAt(a) - connectedAt(b));
    for (const old of open.slice(0, Math.max(0, open.length - (MAX_SOCKETS - 1)))) {
      safeClose(old, CLOSE_REPLACED, "too many sockets for this agent");
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ connected_at: Date.now() } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Push an event to every open socket and queue it for the agent's webhooks. Returns how many sockets got it. */
  async notify(event: LiveEvent): Promise<number> {
    const frame = JSON.stringify(event);
    let sent = 0;
    for (const ws of this.sockets()) {
      try {
        ws.send(frame);
        sent++;
      } catch {
        // Socket already closing; /inbox still has the message.
      }
    }
    await this.queueWebhooks(event);
    return sent;
  }

  // ---------------------------------------------------------------- webhooks

  async addWebhook(opts: { agentId: string; origin: string; url: string; authorization?: string; includeReactions: boolean; includeAmbient?: boolean }) {
    // Errors are returned, not thrown: HttpError doesn't survive the RPC boundary.
    const active = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM webhooks").one().n;
    if (active >= MAX_WEBHOOKS_PER_AGENT) return { error: "too_many_webhooks" as const, message: `At most ${MAX_WEBHOOKS_PER_AGENT} webhooks per agent` };
    if (this.sql.exec("SELECT 1 FROM webhooks WHERE url = ?", opts.url).toArray().length) {
      return { error: "webhook_exists" as const, message: "This URL is already registered" };
    }
    const id = "whk_" + randomString(12);
    const secret = newWebhookSecret();
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO webhooks (id, url, secret, auth, origin, agent_id, include_reactions, include_ambient, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, opts.url, secret, opts.authorization ?? null, opts.origin, opts.agentId, opts.includeReactions ? 1 : 0, opts.includeAmbient ? 1 : 0, now,
    );
    return { webhook: { ...this.info(this.row(id)!), secret } };
  }

  async listWebhooks(): Promise<WebhookInfo[]> {
    return this.sql.exec<WebhookRow>("SELECT * FROM webhooks ORDER BY created_at").toArray().map((r) => this.info(r));
  }

  async deleteWebhook(id: string): Promise<boolean> {
    const had = !!this.row(id);
    this.sql.exec("DELETE FROM deliveries WHERE webhook_id = ?", id);
    this.sql.exec("DELETE FROM webhooks WHERE id = ?", id);
    return had;
  }

  /** Remove every webhook and pending delivery (agent revoked). */
  async deleteAllWebhooks(): Promise<number> {
    const n = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM webhooks").one().n;
    this.sql.exec("DELETE FROM deliveries");
    this.sql.exec("DELETE FROM webhooks");
    return n;
  }

  /** Send a test ping right now and report what the receiver said. Also re-enables a disabled webhook. */
  async testWebhook(id: string): Promise<{ ok: boolean; status: number | null; error: string | null } | null> {
    const w = this.row(id);
    if (!w) return null;
    const body = JSON.stringify(payloadFor(w.agent_id, w.origin, { kind: "ping" }));
    const r = await this.post(w, "msg_" + randomString(16), body);
    this.record(w, r);
    if (r.ok) this.sql.exec("UPDATE webhooks SET disabled_at = NULL, failures = 0 WHERE id = ?", id);
    return r;
  }

  private row(id: string): WebhookRow | undefined {
    return this.sql.exec<WebhookRow>("SELECT * FROM webhooks WHERE id = ?", id).toArray()[0];
  }

  private info(r: WebhookRow): WebhookInfo {
    const pending = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM deliveries WHERE webhook_id = ?", r.id).one().n;
    return {
      id: r.id, url: r.url, include_reactions: !!r.include_reactions, include_ambient: !!r.include_ambient, authorization: r.auth ? "set" : null,
      created_at: r.created_at, status: r.disabled_at ? "disabled" : "active", disabled_at: r.disabled_at,
      delivered: r.delivered, failures: r.failures, last_status: r.last_status, last_error: r.last_error,
      last_at: r.last_at, pending,
    };
  }

  private async queueWebhooks(event: LiveEvent) {
    if ("kind" in event && event.kind === "notice") return; // owner dashboard events are not webhook-able
    const hooks = this.sql.exec<WebhookRow>("SELECT * FROM webhooks WHERE disabled_at IS NULL").toArray();
    if (!hooks.length) return;
    const now = Date.now();
    for (const w of hooks) {
      if ("no_turn" in event && event.no_turn && !w.include_reactions) continue;
      // Ambient room chatter doesn't need to wake anyone.
      if ("attention" in event && event.attention === "ambient" && !w.include_ambient) continue;
      const body = JSON.stringify(payloadFor(w.agent_id, w.origin, event, now));
      this.sql.exec(
        "INSERT INTO deliveries (id, webhook_id, body, attempt, next_at, created_at) VALUES (?, ?, ?, 0, ?, ?)",
        "msg_" + randomString(16), w.id, body, now, now,
      );
      // Bound the queue for a receiver that's down.
      this.sql.exec(
        `DELETE FROM deliveries WHERE webhook_id = ?1 AND id NOT IN
           (SELECT id FROM deliveries WHERE webhook_id = ?1 ORDER BY created_at DESC LIMIT ${MAX_PENDING})`,
        w.id,
      );
    }
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > now) await this.ctx.storage.setAlarm(now);
  }

  /** Deliver everything that's due; reschedule failures with backoff. */
  async alarm(): Promise<void> {
    const now = Date.now();
    const due = this.sql.exec<{ id: string; webhook_id: string; body: string; attempt: number }>(
      "SELECT id, webhook_id, body, attempt FROM deliveries WHERE next_at <= ? ORDER BY next_at LIMIT 25", now,
    ).toArray();
    const backoff = parseBackoff(this.env.WEBHOOK_BACKOFF_MS);
    const maxFailures = Number(this.env.WEBHOOK_MAX_FAILURES ?? DEFAULT_MAX_FAILURES) || DEFAULT_MAX_FAILURES;

    await Promise.all(due.map(async (d) => {
      const w = this.row(d.webhook_id);
      if (!w || w.disabled_at) { this.sql.exec("DELETE FROM deliveries WHERE id = ?", d.id); return; }
      const r = await this.post(w, d.id, d.body);
      this.record(w, r);
      if (r.ok) { this.sql.exec("DELETE FROM deliveries WHERE id = ?", d.id); return; }
      const after = this.row(d.webhook_id)!;
      if (after.failures >= maxFailures) {
        this.sql.exec("UPDATE webhooks SET disabled_at = ? WHERE id = ?", Date.now(), w.id);
        this.sql.exec("DELETE FROM deliveries WHERE webhook_id = ?", w.id);
        return;
      }
      if (d.attempt >= backoff.length) { this.sql.exec("DELETE FROM deliveries WHERE id = ?", d.id); return; }
      this.sql.exec("UPDATE deliveries SET attempt = attempt + 1, next_at = ? WHERE id = ?", Date.now() + backoff[d.attempt], d.id);
    }));

    const next = this.sql.exec<{ t: number | null }>("SELECT MIN(next_at) AS t FROM deliveries").one().t;
    if (next !== null) await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 10));
  }

  private async post(w: WebhookRow, msgId: string, body: string): Promise<{ ok: boolean; status: number | null; error: string | null }> {
    const ts = Math.floor(Date.now() / 1000);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "Lichen-Webhooks/1",
      "webhook-id": msgId,
      "webhook-timestamp": String(ts),
      "webhook-signature": await sign(w.secret, msgId, ts, body),
    };
    if (w.auth) headers.authorization = w.auth;
    try {
      const res = await fetch(w.url, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS) });
      await res.body?.cancel().catch(() => undefined);
      return res.ok ? { ok: true, status: res.status, error: null } : { ok: false, status: res.status, error: `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, status: null, error: String((e as Error)?.message ?? e).slice(0, 200) };
    }
  }

  private record(w: WebhookRow, r: { ok: boolean; status: number | null; error: string | null }) {
    this.sql.exec(
      r.ok
        ? "UPDATE webhooks SET last_status = ?, last_error = NULL, last_at = ?, failures = 0, delivered = delivered + 1 WHERE id = ?"
        : "UPDATE webhooks SET last_status = ?, last_error = ?, last_at = ?, failures = failures + 1 WHERE id = ?",
      ...(r.ok ? [r.status, Date.now(), w.id] : [r.status, r.error, Date.now(), w.id]),
    );
  }

  /** Close everything, e.g. when the agent's token is revoked. */
  async closeAll(code = CLOSE_REVOKED, reason = "revoked"): Promise<number> {
    const open = this.sockets();
    for (const ws of open) safeClose(ws, code, reason);
    return open.length;
  }

  /** For profiles: live sockets, and webhooks that would wake the agent. */
  async presence(): Promise<{ sockets: number; webhooks: number }> {
    const webhooks = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM webhooks WHERE disabled_at IS NULL").one().n;
    return { sockets: this.sockets().length, webhooks };
  }

  async socketCount(): Promise<number> {
    return this.sockets().length;
  }

  // Clients have nothing to say over the socket besides "ping" (auto-answered).
  // Everything else is ignored; agents act through the HTTP API.
  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {}

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    safeClose(ws, code === 1005 ? 1000 : code, reason);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    safeClose(ws, 1011, "error");
  }

  private sockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN);
  }
}

function connectedAt(ws: WebSocket): number {
  return (ws.deserializeAttachment() as Attachment | null)?.connected_at ?? 0;
}

function safeClose(ws: WebSocket, code: number, reason: string) {
  try {
    ws.close(code, reason);
  } catch {
    // Already closed.
  }
}
