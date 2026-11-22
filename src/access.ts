// Cloudflare Access JWT verification (RS256, WebCrypto, no dependencies).
//
// Checks: signature against the team's published keys (selected by kid, never
// from a URL in the token), alg = RS256, iss = the configured team domain,
// aud contains the configured AUD, exp/nbf with a small clock skew.

import type { Env } from "./env";

export interface AccessIdentity {
  email: string; // lowercase
  sub: string;
}

interface Jwk extends JsonWebKey {
  kid?: string;
}

const SKEW_S = 60;
const JWKS_TTL_MS = 10 * 60 * 1000;
let cache: { url: string; at: number; keys: Jwk[] } | undefined;

export const accessConfigured = (env: Env) => Boolean(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD);

function b64urlBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function b64urlJson(s: string): any {
  return JSON.parse(new TextDecoder().decode(b64urlBytes(s)));
}

function teamDomain(env: Env): string {
  return env.ACCESS_TEAM_DOMAIN!.replace(/\/+$/, "");
}

async function keys(env: Env, refresh = false): Promise<Jwk[]> {
  if (env.ACCESS_JWKS) return (JSON.parse(env.ACCESS_JWKS).keys ?? []) as Jwk[];
  const url = `${teamDomain(env)}/cdn-cgi/access/certs`;
  if (!refresh && cache && cache.url === url && Date.now() - cache.at < JWKS_TTL_MS) return cache.keys;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`certs ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  cache = { url, at: Date.now(), keys: body.keys ?? [] };
  return cache.keys;
}

/** The Access token from the header Access adds, or the CF_Authorization cookie. */
export function accessToken(req: Request): string | null {
  const h = req.headers.get("cf-access-jwt-assertion");
  if (h) return h;
  const cookie = req.headers.get("cookie") ?? "";
  const m = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie);
  return m ? m[1] : null;
}

/** Verify an Access JWT. Returns null for anything invalid. */
export async function verifyAccess(token: string, env: Env, now = Date.now()): Promise<AccessIdentity | null> {
  if (!accessConfigured(env)) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header: any, payload: any;
  try {
    header = b64urlJson(parts[0]);
    payload = b64urlJson(parts[1]);
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") return null;

  let jwk = (await keys(env)).find((k) => k.kid === header.kid);
  if (!jwk && !env.ACCESS_JWKS) jwk = (await keys(env, true)).find((k) => k.kid === header.kid); // key rotation
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    "jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"],
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key, b64urlBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!ok) return null;

  const t = Math.floor(now / 1000);
  if (payload.iss !== teamDomain(env)) return null;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) return null;
  if (typeof payload.exp !== "number" || payload.exp + SKEW_S < t) return null;
  if (typeof payload.nbf === "number" && payload.nbf - SKEW_S > t) return null;
  if (typeof payload.email !== "string" || !payload.email || typeof payload.sub !== "string") return null;
  return { email: payload.email.toLowerCase(), sub: payload.sub };
}
