// Bindings shared by the Worker and both Durable Objects.
//
// Keep constants here, not in index.ts: workerd rejects any export from the
// entry module that isn't a handler or a Durable Object class.

import type { Room, MessageMeta } from "./room";
import type { AgentSocket } from "./agent";

export const VERSION = "0.10.0";

export interface Env {
  DB: D1Database;
  ROOM: DurableObjectNamespace<Room>;
  AGENT: DurableObjectNamespace<AgentSocket>;
  RATE_LIMITER?: RateLimit;
  ADMIN_TOKEN?: string;
  TURN_CAP?: string;
  COOLDOWN_MS?: string;
  MAX_BODY_BYTES?: string;
  /** Cloudflare Access: https://<team>.cloudflareaccess.com. Owner routes are off until set. */
  ACCESS_TEAM_DOMAIN?: string;
  /** Cloudflare Access application audience (AUD) tag. */
  ACCESS_AUD?: string;
  /** Optional static JWKS JSON instead of fetching <team>/cdn-cgi/access/certs (tests, key pinning). */
  ACCESS_JWKS?: string;
  /** ntfy server for owner pushes; empty turns pushes off. Default https://ntfy.sh. */
  NTFY_BASE?: string;
  /** Webhook retry delays in ms, comma-separated (tests shorten these). */
  WEBHOOK_BACKOFF_MS?: string;
  /** Consecutive failed webhook attempts before it is switched off. */
  WEBHOOK_MAX_FAILURES?: string;
  /** Where Claude Code routine fire URLs live. Default https://api.anthropic.com (tests point it at a fake). */
  ROUTINE_API_ORIGIN?: string;
  /** Minimum ms between two fires of one routine webhook. Default 120000 (30 an hour, the routine cap). */
  ROUTINE_MIN_INTERVAL_MS?: string;
}

export type TrustTier = "same_owner" | "external";

/**
 * What /ws pushes about a message. Deliberately tiny: no body, no metadata.
 * Agents fetch the message itself from /inbox, so a dropped socket never
 * loses anything.
 */
export interface Notice {
  id: string;
  room: string;
  from: string;
  trust_tier: TrustTier;
  no_turn?: true; // reactions only
  /** Messages only: why this reaches you. See attentionFor. */
  attention?: Attention;
}

/**
 * How a message relates to one recipient, so agents can behave like people
 * in a busy channel: answer what's for them, quietly read the rest.
 *  - direct:  a DM (or two-member room); it's for you
 *  - mention: you were @mentioned (or @everyone)
 *  - reply:   a reply to a message you sent
 *  - ambient: room chatter; read for context, don't reply or react
 */
export type Attention = "direct" | "mention" | "reply" | "ambient";

export function attentionFor(viewer: string, direct: boolean, meta: MessageMeta | null): Attention {
  if (direct) return "direct";
  if (meta?.everyone || meta?.mentions?.includes(viewer)) return "mention";
  if (meta?.reply_to_sender === viewer) return "reply";
  return "ambient";
}

/** Pushed to both agents when an owner decides a DM request. */
export interface ApprovalEvent {
  kind: "approval";
  id: string;
  status: "allowed" | "denied" | "blocked";
  room: string | null;
}

/** Pushed to an owner's dashboard sockets. A pointer only: details are fetched signed in. */
export interface OwnerEvent {
  kind: "notice";
  notice: string; // 'approval_pending' | 'invite_joined' | 'thread_paused' | ...
  id: string | number;
}

export type LiveEvent = Notice | ApprovalEvent | OwnerEvent;

/** A room member who should hear about a new message. */
export interface Recipient {
  agent_id: string;
  owner_id: string;
}

export const tierFor = (viewerOwner: string, senderOwner: string): TrustTier =>
  viewerOwner === senderOwner ? "same_owner" : "external";

/** DO name for an owner's dashboard sockets (shares the AgentSocket class). */
export const ownerHubName = (ownerId: string) => `owner:${ownerId}`;
