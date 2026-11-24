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
import { attentionFor, ownerHubName, tierFor, type Env, type Notice, type Recipient } from "./env";

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
  // Set by the server only (clients can't send these directly):
  /** Agent ids mentioned with @name / @agt_… */
  mentions?: string[];
  /** @everyone */
  everyone?: true;
  /** A reply to this message (same room), and who sent it. */
  reply_to?: string;
  reply_to_sender?: string;
  /** A forwarded copy: who originally sent it, and when. */
  forwarded?: { id: string; sender_id: string; sender_owner_id: string; sender_kind: "agent" | "human"; created_at: number };
  forward_comment?: string;
  /** Polls: the options (the question is the body). */
  poll?: { options: string[]; multi: boolean; closes_at: number | null };
  /** Images attached to this message; bytes are fetched separately. */
  images?: ImageRef[];
}

export interface ImageRef { id: string; type: string; size: number; alt?: string }

export interface PollState {
  options: string[]; multi: boolean; closes_at: number | null; closed: boolean;
  counts: number[]; voters: number; mine: number[];
}

/** Per-room cap on stored image bytes, and how long an unattached upload lives. */
export const ROOM_IMAGE_BYTES = 100 * 1024 * 1024;
const UNATTACHED_TTL_MS = 60 * 60 * 1000;

export interface StoredMessage {
  seq: number;
  kind: "message" | "reaction" | "poll";
  poll?: PollState;
  sender_id: string;
  sender_owner_id: string;
  body: string | null;
  meta: MessageMeta | null;
  target_seq: number | null; // reactions: the message reacted to
  emoji: string | null;
  created_at: number;
  edited_at?: number | null;
  deleted_at?: number | null;
  deleted_by?: string | null;
  pinned_at?: number | null;
  pinned_by?: string | null;
}

export interface Limits {
  turnCap: number;
  cooldownMs: number;
}

/** Who to notify after an append. The Worker fills this from D1 memberships. */
export interface Fanout {
  roomId: string;
  recipients: Recipient[];
  /** A DM (agent↔agent or human↔agent) or a two-member room: every message there is for you. */
  direct?: boolean;
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
      CREATE TABLE IF NOT EXISTS votes (
        poll_seq  INTEGER NOT NULL,
        voter_id  TEXT NOT NULL,
        option    INTEGER NOT NULL,
        voted_at  INTEGER NOT NULL,
        PRIMARY KEY (poll_seq, voter_id, option)
      );
      CREATE TABLE IF NOT EXISTS images (
        id          TEXT PRIMARY KEY,
        uploader    TEXT NOT NULL,
        type        TEXT NOT NULL,
        size        INTEGER NOT NULL,
        data        BLOB NOT NULL,
        claimed     INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pins (
        seq        INTEGER PRIMARY KEY,
        pinned_by  TEXT NOT NULL,
        pinned_at  INTEGER NOT NULL
      );
    `);
    const cols = new Set(this.sql.exec<{ name: string }>("PRAGMA table_info(messages)").toArray().map((c) => c.name));
    if (!cols.has("edited_at")) this.sql.exec("ALTER TABLE messages ADD COLUMN edited_at INTEGER");
    if (!cols.has("deleted_at")) this.sql.exec("ALTER TABLE messages ADD COLUMN deleted_at INTEGER");
    if (!cols.has("deleted_by")) this.sql.exec("ALTER TABLE messages ADD COLUMN deleted_by TEXT");
  }

  /** Append an agent message, applying the turn cap and cooldown. */
  async sendMessage(
    env: Envelope, body: string, meta: MessageMeta, limits: Limits, fanout?: Fanout, kind: "message" | "poll" = "message",
  ): Promise<AppendResult> {
    const now = Date.now();
    const thread = meta.thread_id ?? "";

    const t = this.sql.exec<{ agent_streak: number; paused: number }>(
      "SELECT agent_streak, paused FROM threads WHERE thread_id = ?", thread,
    ).toArray()[0] ?? { agent_streak: 0, paused: 0 };
    if (limits.turnCap > 0 && t.paused) return { ok: false, error: "thread_paused" };

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
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
      kind, env.sender_id, env.sender_owner_id, body, JSON.stringify(meta), thread, now,
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
    this.fanOut(env, seq, false, fanout, meta);
    return { ok: true, seq, created_at: now, paused: pause === 1 };
  }

  /**
   * A message from a human owner (dashboard). It is the human input the turn
   * cap waits for: it resets the thread's agent streak and unpauses it.
   * No cooldown applies.
   */
  async sendHuman(env: Envelope, body: string, meta: MessageMeta, fanout?: Fanout, kind: "message" | "poll" = "message"): Promise<{ seq: number; created_at: number }> {
    const now = Date.now();
    const thread = meta.thread_id ?? "";
    const seq = this.sql.exec<{ seq: number }>(
      `INSERT INTO messages (kind, sender_id, sender_owner_id, body, meta, thread_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
      kind, env.sender_id, env.sender_owner_id, body, JSON.stringify(meta), thread, now,
    ).one().seq;
    this.sql.exec(
      `INSERT INTO threads (thread_id, agent_streak, paused) VALUES (?, 0, 0)
       ON CONFLICT(thread_id) DO UPDATE SET agent_streak = 0, paused = 0`,
      thread,
    );
    this.fanOut(env, seq, false, fanout, meta);
    return { seq, created_at: now };
  }

  /** Reactions never count toward the turn cap and are flagged no_turn on read. */
  async react(env: Envelope, targetSeq: number, emoji: string, fanout?: Fanout): Promise<AppendResult> {
    const target = this.sql.exec<{ thread_id: string }>(
      "SELECT thread_id FROM messages WHERE seq = ? AND kind IN ('message', 'poll') AND deleted_at IS NULL", targetSeq,
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
  private fanOut(from: Envelope, seq: number, noTurn: boolean, fanout?: Fanout, meta?: MessageMeta) {
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
          ...(noTurn ? { no_turn: true as const } : { attention: attentionFor(r.agent_id, !!fanout.direct, meta ?? null) }),
        };
        return this.env.AGENT.get(this.env.AGENT.idFromName(r.agent_id)).notify(notice);
      })]);
    this.ctx.waitUntil(work);
  }

  private mapRow(r: Record<string, string | number | null>, voterId?: string): StoredMessage {
    const m: StoredMessage = {
      seq: r.seq as number,
      kind: r.kind as StoredMessage["kind"],
      sender_id: r.sender_id as string,
      sender_owner_id: r.sender_owner_id as string,
      body: (r.body as string | null) ?? null,
      meta: r.meta ? (JSON.parse(r.meta as string) as MessageMeta) : null,
      target_seq: (r.target_seq as number | null) ?? null,
      emoji: (r.emoji as string | null) ?? null,
      created_at: r.created_at as number,
      ...(r.edited_at ? { edited_at: r.edited_at as number } : {}),
      ...(r.deleted_at ? { deleted_at: r.deleted_at as number, deleted_by: (r.deleted_by as string | null) ?? null } : {}),
      ...(r.pinned_at ? { pinned_at: r.pinned_at as number, pinned_by: (r.pinned_by as string | null) ?? null } : {}),
    };
    if (m.kind === "poll" && m.meta?.poll && !m.deleted_at) m.poll = this.pollState(m.seq, m.meta.poll, voterId);
    return m;
  }

  /** One message by seq, or null. */
  async getMessage(seq: number): Promise<StoredMessage | null> {
    return (await this.list({ afterSeq: seq - 1, beforeSeq: seq + 1, limit: 1 }))[0] ?? null;
  }

  /** Messages with seq > afterSeq, oldest first. */
  async list(opts: { afterSeq?: number; beforeSeq?: number; threadId?: string; excludeSender?: string; limit: number; voterId?: string }): Promise<StoredMessage[]> {
    const where: string[] = ["m.seq > ?"];
    const args: (string | number)[] = [opts.afterSeq ?? 0];
    if (opts.beforeSeq !== undefined) { where.push("m.seq < ?"); args.push(opts.beforeSeq); }
    if (opts.threadId !== undefined) { where.push("m.thread_id = ?"); args.push(opts.threadId); }
    if (opts.excludeSender) { where.push("m.sender_id != ?"); args.push(opts.excludeSender); }

    // /history with `before` reads backwards; everything else reads forwards.
    const backwards = opts.beforeSeq !== undefined && opts.afterSeq === undefined;
    const rows = this.sql.exec<Record<string, string | number | null>>(
      `SELECT m.*, p.pinned_at, p.pinned_by FROM messages m LEFT JOIN pins p ON p.seq = m.seq
       WHERE ${where.join(" AND ")} ORDER BY m.seq ${backwards ? "DESC" : "ASC"} LIMIT ?`,
      ...args, opts.limit,
    ).toArray();
    if (backwards) rows.reverse();
    return rows.map((r) => this.mapRow(r, opts.voterId));
  }

  private notifyOwners(roomId: string, seq: number, actorId: string, actorOwner: string, owners: string[]) {
    if (!owners.length) return;
    const n: Notice = { id: `${roomId}:${seq}`, room: roomId, from: actorId, trust_tier: "same_owner", no_turn: true };
    this.ctx.waitUntil(Promise.allSettled([...new Set(owners)].map((o) =>
      this.env.AGENT.get(this.env.AGENT.idFromName(ownerHubName(o))).notify({ ...n, trust_tier: tierFor(o, actorOwner) }))));
  }

  /** Edit a message's body. Agents edit only their own; owners can edit their own or their agents'. */
  async editMessage(
    seq: number, body: string, actorId: string, actorOwner: string, isOwner: boolean, owners: string[], roomId: string,
  ): Promise<{ ok: true; message: StoredMessage } | { ok: false; error: "message_not_found" | "forbidden" | "not_editable" }> {
    const row = this.sql.exec<Record<string, string | number | null>>(
      "SELECT * FROM messages WHERE seq = ?", seq,
    ).toArray()[0];
    if (!row || row.deleted_at) return { ok: false, error: "message_not_found" };
    if (row.kind !== "message") return { ok: false, error: "not_editable" };
    const allowed = isOwner ? row.sender_owner_id === actorOwner : row.sender_id === actorId;
    if (!allowed) return { ok: false, error: "forbidden" };
    const now = Date.now();
    this.sql.exec("UPDATE messages SET body = ?, edited_at = ? WHERE seq = ?", body, now, seq);
    this.notifyOwners(roomId, seq, actorId, actorOwner, owners);
    const updated = await this.getMessage(seq);
    return { ok: true, message: updated! };
  }

  /** Soft-delete a message. Agents delete only their own; owners delete their own, their agents', or any in rooms they created. */
  async deleteMessage(
    seq: number, actorId: string, actorOwner: string, canModerate: boolean, owners: string[], roomId: string,
  ): Promise<{ ok: true; deleted_at: number } | { ok: false; error: "message_not_found" | "forbidden" }> {
    const row = this.sql.exec<{ sender_id: string; sender_owner_id: string; deleted_at: number | null }>(
      "SELECT sender_id, sender_owner_id, deleted_at FROM messages WHERE seq = ?", seq,
    ).toArray()[0];
    if (!row || row.deleted_at) return { ok: false, error: "message_not_found" };
    const allowed = canModerate || row.sender_id === actorId || (actorId === actorOwner && row.sender_owner_id === actorOwner);
    if (!allowed) return { ok: false, error: "forbidden" };
    const now = Date.now();
    this.sql.exec("UPDATE messages SET body = NULL, deleted_at = ?, deleted_by = ? WHERE seq = ?", now, actorId, seq);
    this.sql.exec("DELETE FROM pins WHERE seq = ?", seq);
    this.sql.exec("DELETE FROM votes WHERE poll_seq = ?", seq);
    this.notifyOwners(roomId, seq, actorId, actorOwner, owners);
    return { ok: true, deleted_at: now };
  }

  // ---------------------------------------------------------------- pins & search

  async pinMessage(
    seq: number, actorId: string, actorOwner: string, owners: string[], roomId: string,
  ): Promise<{ ok: true; pinned_at: number } | { ok: false; error: "message_not_found" }> {
    const row = this.sql.exec<{ kind: string; deleted_at: number | null }>(
      "SELECT kind, deleted_at FROM messages WHERE seq = ?", seq,
    ).toArray()[0];
    if (!row || row.deleted_at || (row.kind !== "message" && row.kind !== "poll")) return { ok: false, error: "message_not_found" };
    const now = Date.now();
    this.sql.exec(
      "INSERT INTO pins (seq, pinned_by, pinned_at) VALUES (?, ?, ?) ON CONFLICT(seq) DO UPDATE SET pinned_by = excluded.pinned_by, pinned_at = excluded.pinned_at",
      seq, actorId, now,
    );
    this.notifyOwners(roomId, seq, actorId, actorOwner, owners);
    return { ok: true, pinned_at: now };
  }

  async unpinMessage(seq: number, actorId: string, actorOwner: string, owners: string[], roomId: string): Promise<boolean> {
    const existing = this.sql.exec<{ seq: number }>("SELECT seq FROM pins WHERE seq = ?", seq).toArray()[0];
    if (!existing) return false;
    this.sql.exec("DELETE FROM pins WHERE seq = ?", seq);
    this.notifyOwners(roomId, seq, actorId, actorOwner, owners);
    return true;
  }

  async listPins(voterId?: string): Promise<StoredMessage[]> {
    const rows = this.sql.exec<Record<string, string | number | null>>(
      `SELECT m.*, p.pinned_at, p.pinned_by FROM pins p JOIN messages m ON m.seq = p.seq
       WHERE m.deleted_at IS NULL ORDER BY p.pinned_at DESC LIMIT 100`,
    ).toArray();
    return rows.map((r) => this.mapRow(r, voterId));
  }

  /** Case-insensitive substring search over non-deleted messages and polls in this room. */
  async search(query: string, limit: number, voterId?: string): Promise<StoredMessage[]> {
    const like = "%" + query.toLowerCase().replace(/[\\%_]/g, (c) => "\\" + c) + "%";
    const rows = this.sql.exec<Record<string, string | number | null>>(
      `SELECT m.*, p.pinned_at, p.pinned_by FROM messages m LEFT JOIN pins p ON p.seq = m.seq
       WHERE m.deleted_at IS NULL AND m.kind IN ('message', 'poll') AND lower(COALESCE(m.body, '')) LIKE ? ESCAPE '\\'
       ORDER BY m.seq DESC LIMIT ?`,
      like, limit,
    ).toArray();
    return rows.map((r) => this.mapRow(r, voterId));
  }

  /** Wipe all data when a room is deleted. */
  async purge(): Promise<void> {
    this.sql.exec("DELETE FROM pins; DELETE FROM votes; DELETE FROM images; DELETE FROM cooldowns; DELETE FROM threads; DELETE FROM messages;");
  }

  // ---------------------------------------------------------------- polls

  private pollState(seq: number, p: NonNullable<MessageMeta["poll"]>, voterId?: string): PollState {
    const counts = p.options.map(() => 0);
    for (const r of this.sql.exec<{ option: number; n: number }>(
      "SELECT option, COUNT(*) AS n FROM votes WHERE poll_seq = ? GROUP BY option", seq,
    ).toArray()) if (r.option < counts.length) counts[r.option] = r.n;
    const voters = this.sql.exec<{ n: number }>("SELECT COUNT(DISTINCT voter_id) AS n FROM votes WHERE poll_seq = ?", seq).one().n;
    const mine = voterId
      ? this.sql.exec<{ option: number }>("SELECT option FROM votes WHERE poll_seq = ? AND voter_id = ? ORDER BY option", seq, voterId).toArray().map((r) => r.option)
      : [];
    return { options: p.options, multi: p.multi, closes_at: p.closes_at, closed: !!p.closes_at && p.closes_at <= Date.now(), counts, voters, mine };
  }

  /**
   * Replace `voterId`'s votes on a poll (an empty list removes them). Votes
   * never start a turn: only owners' dashboards are told, so results update live.
   */
  async vote(voterId: string, voterOwner: string, seq: number, options: number[], owners: string[], roomId: string):
    Promise<{ ok: true; poll: PollState } | { ok: false; error: "poll_not_found" | "poll_closed" | "invalid_option" }> {
    const row = this.sql.exec<{ meta: string }>("SELECT meta FROM messages WHERE seq = ? AND kind = 'poll' AND deleted_at IS NULL", seq).toArray()[0];
    if (!row) return { ok: false, error: "poll_not_found" };
    const p = (JSON.parse(row.meta) as MessageMeta).poll!;
    if (p.closes_at && p.closes_at <= Date.now()) return { ok: false, error: "poll_closed" };
    const uniq = [...new Set(options)];
    if (uniq.some((o) => !Number.isInteger(o) || o < 0 || o >= p.options.length) || (!p.multi && uniq.length > 1)) {
      return { ok: false, error: "invalid_option" };
    }
    this.sql.exec("DELETE FROM votes WHERE poll_seq = ? AND voter_id = ?", seq, voterId);
    for (const o of uniq) this.sql.exec("INSERT INTO votes (poll_seq, voter_id, option, voted_at) VALUES (?, ?, ?, ?)", seq, voterId, o, Date.now());
    const n: Notice = { id: `${roomId}:${seq}`, room: roomId, from: voterId, trust_tier: "same_owner", no_turn: true };
    this.ctx.waitUntil(Promise.allSettled([...new Set(owners)].map((o) =>
      this.env.AGENT.get(this.env.AGENT.idFromName(ownerHubName(o))).notify({ ...n, trust_tier: tierFor(o, voterOwner) }))));
    return { ok: true, poll: this.pollState(seq, p, voterId) };
  }

  // ---------------------------------------------------------------- images

  /** Keep an uploaded image until a message claims it (or it expires unclaimed). */
  async storeImage(uploader: string, type: string, data: Uint8Array):
    Promise<{ ok: true; id: string } | { ok: false; error: "room_storage_full" }> {
    const now = Date.now();
    this.sql.exec("DELETE FROM images WHERE claimed = 0 AND created_at < ?", now - UNATTACHED_TTL_MS);
    const used = this.sql.exec<{ n: number | null }>("SELECT SUM(size) AS n FROM images").one().n ?? 0;
    if (used + data.byteLength > ROOM_IMAGE_BYTES) return { ok: false, error: "room_storage_full" };
    const id = "img_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    this.sql.exec("INSERT INTO images (id, uploader, type, size, data, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      id, uploader, type, data.byteLength, data, now);
    return { ok: true, id };
  }

  /** Claim the uploader's own unclaimed images for a message. All or nothing. */
  async claimImages(uploader: string, ids: string[], alts: (string | undefined)[]): Promise<ImageRef[] | null> {
    const refs: ImageRef[] = [];
    for (const [i, id] of ids.entries()) {
      const r = this.sql.exec<{ type: string; size: number }>(
        "SELECT type, size FROM images WHERE id = ? AND uploader = ? AND claimed = 0", id, uploader,
      ).toArray()[0];
      if (!r) return null;
      refs.push({ id, type: r.type, size: r.size, ...(alts[i] ? { alt: alts[i] } : {}) });
    }
    for (const id of ids) this.sql.exec("UPDATE images SET claimed = 1 WHERE id = ?", id);
    return refs;
  }

  async getImage(id: string): Promise<{ type: string; data: ArrayBuffer } | null> {
    const r = this.sql.exec<{ type: string; data: ArrayBuffer }>("SELECT type, data FROM images WHERE id = ? AND claimed = 1", id).toArray()[0];
    return r ?? null;
  }

  /** Latest message, for sidebars: seq, time, sender and a short preview. */
  async summary(): Promise<{ last_seq: number; last_at: number | null; last: { sender_id: string; kind: string; preview: string } | null }> {
    const r = this.sql.exec<{ seq: number; created_at: number; sender_id: string; kind: string; body: string | null; emoji: string | null }>(
      "SELECT seq, created_at, sender_id, kind, body, emoji FROM messages WHERE deleted_at IS NULL ORDER BY seq DESC LIMIT 1",
    ).toArray()[0];
    if (!r) return { last_seq: 0, last_at: null, last: null };
    const preview = r.kind === "reaction" ? (r.emoji ?? "") : (r.body ?? "").replace(/\s+/g, " ").slice(0, 140);
    return { last_seq: r.seq, last_at: r.created_at, last: { sender_id: r.sender_id, kind: r.kind, preview } };
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

  /** Unpause all threads in this room (used when disabling auto-pause). */
  async resumeAll(): Promise<void> {
    this.sql.exec("UPDATE threads SET agent_streak = 0, paused = 0");
  }
}
