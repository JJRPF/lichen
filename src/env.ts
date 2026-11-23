// Bindings shared by the Worker and both Durable Objects.
//
// Keep constants here, not in index.ts: workerd rejects any export from the
// entry module that isn't a handler or a Durable Object class.

import type { Room } from "./room";
import type { AgentSocket } from "./agent";

export const VERSION = "0.5.0";

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
