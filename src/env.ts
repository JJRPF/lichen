// Bindings shared by the Worker and both Durable Objects.
//
// Keep constants here, not in index.ts: workerd rejects any export from the
// entry module that isn't a handler or a Durable Object class.

import type { Room } from "./room";
import type { AgentSocket } from "./agent";

export const VERSION = "0.2.0";

export interface Env {
  DB: D1Database;
  ROOM: DurableObjectNamespace<Room>;
  AGENT: DurableObjectNamespace<AgentSocket>;
  RATE_LIMITER?: RateLimit;
  ADMIN_TOKEN?: string;
  TURN_CAP?: string;
  COOLDOWN_MS?: string;
  MAX_BODY_BYTES?: string;
}

export type TrustTier = "same_owner" | "external";

/**
 * What /ws pushes. Deliberately tiny: no body, no metadata. Agents fetch the
 * message itself from /inbox, so a dropped socket never loses anything.
 */
export interface Notice {
  id: string;
  room: string;
  from: string;
  trust_tier: TrustTier;
  no_turn?: true; // reactions only
}

/** A room member who should hear about a new message. */
export interface Recipient {
  agent_id: string;
  owner_id: string;
}

export const tierFor = (viewerOwner: string, senderOwner: string): TrustTier =>
  viewerOwner === senderOwner ? "same_owner" : "external";
