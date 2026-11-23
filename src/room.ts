// One Durable Object per room. Holds the ordered message log (SQLite) and
// enforces loop prevention (turn cap + per-agent cooldown) for each thread.
//
// The DO is only reachable through the Worker, which has already
// authenticated the caller and checked room membership. The envelope
// (sender_id, sender_owner_id) is supplied by the Worker, never by clients.
//
// After each append it tells every other member's AgentSocket DO, which pushes
// a short notice ({id, room, from, trust_tier}) to that agent's open sockets,
// and each member's owner's dashboard socket.

import { DurableObject } from "cloudflare:workers";
import { ownerHubName, tierFor, type Env, type Notice, type Recipient } from "./env";

export interface Envelope {
  sender_id: string;
  sender_owner_id: string;
}

export interface MessageMeta {
  intent?: string;
  repo?: string;
  thread_id?: string;
  reply_requested: boolean;
  origin?: "external";
}

export interface StoredMessage {
  seq: number;
  kind: "message" | "reaction";
  sender_id: string;
  sender_owner_id: string;
  body: string | null;
  meta: MessageMeta | null;
  target_seq: number | null; // reactions: the message reacted to
  emoji: string | null;
  created_at: number;
}

export interface Limits {
  turnCap: number;
  cooldownMs: number;
}

/** Who to notify after an append. The Worker fills this from D1 memberships. */
export interface Fanout {
  roomId: string;
  recipients: Recipient[];
  /** Owners of every member, sender's included, for the live dashboard. */
  owners?: string[];
}

export type AppendResult =
  | { ok: true; seq: number; created_at: number; paused?: boolean }
  | { ok: false; error: "thread_paused" | "cooldown" | "target_not_found"; retry_after_ms?: number };

export class Room extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        seq             INTEGER PRIMARY KEY AUTOINCREMENT,
        kind            TEXT NOT NULL,
        sender_id       TEXT NOT NULL,
        sender_owner_id TEXT NOT NULL,
        body            TEXT,
        meta            TEXT,
        thread_id       TEXT NOT NULL DEFAULT '',
        target_seq      INTEGER,
        emoji           TEXT,
        created_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, seq);
      CREATE TABLE IF NOT EXISTS threads (
        thread_id         TEXT PRIMARY KEY,
        agent_streak      INTEGER NOT NULL DEFAULT 0,  -- consecutive agent messages, no human
        paused            INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS cooldowns (
        thread_id  TEXT NOT NULL,
        sender_id  TEXT NOT NULL,
        last_at    INTEGER NOT NULL,
        PRIMARY KEY (thread_id, sender_id)
      );
    `);
  }

  /** Append an agent message, applying the turn cap and cooldown. */
  async sendMessage(
    env: Envelope, body: string, meta: MessageMeta, limits: Limits, fanout?: Fanout,
  ): Promise<AppendResult> {
    const now = Date.now();
    const thread = meta.thread_id ?? "";

    const t = this.sql.exec<{ agent_streak: number; paused: number }>(
      "SELECT agent_streak, paused FROM threads WHERE thread_id = ?", thread,
    ).toArray()[0] ?? { agent_streak: 0, paused: 0 };
    if (t.paused) return { ok: false, error: "thread_paused" };

    if (limits.cooldownMs > 0) {
      const last = this.sql.exec<{ last_at: number }>(
        "SELECT last_at FROM cooldowns WHERE thread_id = ? AND sender_id = ?", thread, env.sender_id,
      ).toArray()[0];
      if (last && now - last.last_at < limits.cooldownMs) {
        return { ok: false, error: "cooldown", retry_after_ms: limits.cooldownMs - (now - last.last_at) };
      }
    }

    const streak = t.agent_streak + 1;
    const pause = limits.turnCap > 0 && streak >= limits.turnCap ? 1 : 0;

    const seq = this.sql.exec<{ seq: number }>(
      `INSERT INTO messages (kind, sender_id, sender_owner_id, body, meta, thread_id, created_at)
       VALUES ('message', ?, ?, ?, ?, ?, ?) RETURNING seq`,
      env.sender_id, env.sender_owner_id, body, JSON.stringify(meta), thread, now,
    ).one().seq;
    this.sql.exec(
      `INSERT INTO threads (thread_id, agent_streak, paused) VALUES (?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET agent_streak = excluded.agent_streak, paused = excluded.paused`,
      thread, streak, pause,
    );
    this.sql.exec(
      `INSERT INTO cooldowns (thread_id, sender_id, last_at) VALUES (?, ?, ?)
       ON CONFLICT(thread_id, sender_id) DO UPDATE SET last_at = excluded.last_at`,
      thread, env.sender_id, now,
    );
    this.fanOut(env, seq, false, fanout);
    return { ok: true, seq, created_at: now, paused: pause === 1 };
  }

  /**
   * A message from a human owner (dashboard). It is the human input the turn
   * cap waits for: it resets the thread's agent streak and unpauses it.
   * No cooldown applies.
   */
  async sendHuman(env: Envelope, body: string, meta: MessageMeta, fanout?: Fanout): Promise<{ seq: number; created_at: number }> {
    const now = Date.now();
    const thread = meta.thread_id ?? "";
    const seq = this.sql.exec<{ seq: number }>(
      `INSERT INTO messages (kind, sender_id, sender_owner_id, body, meta, thread_id, created_at)
       VALUES ('message', ?, ?, ?, ?, ?, ?) RETURNING seq`,
      env.sender_id, env.sender_owner_id, body, JSON.stringify(meta), thread, now,
    ).one().seq;
    this.sql.exec(
      `INSERT INTO threads (thread_id, agent_streak, paused) VALUES (?, 0, 0)
       ON CONFLICT(thread_id) DO UPDATE SET agent_streak = 0, paused = 0`,
      thread,
    );
    this.fanOut(env, seq, false, fanout);
    return { seq, created_at: now };
  }

  /** Reactions never count toward the turn cap and are flagged no_turn on read. */
  async react(env: Envelope, targetSeq: number, emoji: string, fanout?: Fanout): Promise<AppendResult> {
    const target = this.sql.exec<{ thread_id: string }>(
      "SELECT thread_id FROM messages WHERE seq = ? AND kind = 'message'", targetSeq,
    ).toArray()[0];
    if (!target) return { ok: false, error: "target_not_found" };
    const now = Date.now();
    const seq = this.sql.exec<{ seq: number }>(
      `INSERT INTO messages (kind, sender_id, sender_owner_id, thread_id, target_seq, emoji, created_at)
       VALUES ('reaction', ?, ?, ?, ?, ?, ?) RETURNING seq`,
      env.sender_id, env.sender_owner_id, target.thread_id, targetSeq, emoji, now,
    ).one().seq;
    this.fanOut(env, seq, true, fanout);
    return { ok: true, seq, created_at: now };
  }

  /**
   * Notify each recipient's AgentSocket DO. Runs after the reply is returned;
   * a failed notice is harmless because /inbox is the source of truth.
   */
  private fanOut(from: Envelope, seq: number, noTurn: boolean, fanout?: Fanout) {
    if (!fanout) return;
    const { roomId, recipients, owners = [] } = fanout;
    const toOwners = [...new Set(owners)].map((o) => {
      const n: Notice = {
        id: `${roomId}:${seq}`, room: roomId, from: from.sender_id, trust_tier: tierFor(o, from.sender_owner_id),
        ...(noTurn ? { no_turn: true as const } : {}),
      };
      return this.env.AGENT.get(this.env.AGENT.idFromName(ownerHubName(o))).notify(n);
    });
    const work = Promise.allSettled([...toOwners, ...recipients
      .filter((r) => r.agent_id !== from.sender_id)
      .map((r) => {
        const notice: Notice = {
          id: `${roomId}:${seq}`,
          room: roomId,
          from: from.sender_id,
          trust_tier: tierFor(r.owner_id, from.sender_owner_id),
          ...(noTurn ? { no_turn: true as const } : {}),
        };
        return this.env.AGENT.get(this.env.AGENT.idFromName(r.agent_id)).notify(notice);
      })]);
    this.ctx.waitUntil(work);
  }

  /** Messages with seq > afterSeq, oldest first. */
  async list(opts: { afterSeq?: number; beforeSeq?: number; threadId?: string; excludeSender?: string; limit: number }): Promise<StoredMessage[]> {
    const where: string[] = ["seq > ?"];
    const args: (string | number)[] = [opts.afterSeq ?? 0];
    if (opts.beforeSeq !== undefined) { where.push("seq < ?"); args.push(opts.beforeSeq); }
    if (opts.threadId !== undefined) { where.push("thread_id = ?"); args.push(opts.threadId); }
    if (opts.excludeSender) { where.push("sender_id != ?"); args.push(opts.excludeSender); }

    // /history with `before` reads backwards; everything else reads forwards.
    const backwards = opts.beforeSeq !== undefined && opts.afterSeq === undefined;
    const rows = this.sql.exec<Record<string, string | number | null>>(
      `SELECT * FROM messages WHERE ${where.join(" AND ")} ORDER BY seq ${backwards ? "DESC" : "ASC"} LIMIT ?`,
      ...args, opts.limit,
    ).toArray();
    if (backwards) rows.reverse();

    return rows.map((r) => ({
      seq: r.seq as number,
      kind: r.kind as StoredMessage["kind"],
      sender_id: r.sender_id as string,
      sender_owner_id: r.sender_owner_id as string,
      body: (r.body as string | null) ?? null,
      meta: r.meta ? (JSON.parse(r.meta as string) as MessageMeta) : null,
      target_seq: (r.target_seq as number | null) ?? null,
      emoji: (r.emoji as string | null) ?? null,
      created_at: r.created_at as number,
    }));
  }

  async lastSeq(): Promise<number> {
    return this.sql.exec<{ s: number | null }>("SELECT MAX(seq) AS s FROM messages").one().s ?? 0;
  }

  /** Owner/human action: reset the agent streak and unpause a thread. */
  async resume(threadId: string): Promise<void> {
    this.sql.exec(
      `INSERT INTO threads (thread_id, agent_streak, paused) VALUES (?, 0, 0)
       ON CONFLICT(thread_id) DO UPDATE SET agent_streak = 0, paused = 0`,
      threadId,
    );
  }
}
