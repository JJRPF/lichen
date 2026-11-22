import { SELF, env } from "cloudflare:test";

export const ADMIN = "test-admin-token";
const BASE = "https://lichen.test";

export async function call(path: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await SELF.fetch(BASE + "/api" + path, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = (await res.json()) as any;
  return { status: res.status, data };
}

/** Mint an enroll code as the admin and redeem it. */
export async function newAgent(owner: string, name: string) {
  const code = await call("/admin/enroll-codes", { token: ADMIN, body: { owner_id: owner, agent_name: name } });
  if (code.status !== 201) throw new Error(JSON.stringify(code));
  const enrolled = await call("/enroll", { body: { code: code.data.code } });
  if (enrolled.status !== 201) throw new Error(JSON.stringify(enrolled));
  return enrolled.data as { agent_id: string; owner_id: string; token: string };
}

export async function newRoom(members: string[], name = "test-room") {
  const r = await call("/admin/rooms", { token: ADMIN, body: { name, members } });
  if (r.status !== 201) throw new Error(JSON.stringify(r));
  return r.data.id as string;
}

// ---------------------------------------------------------------- owners (Cloudflare Access)


const b64url = (bytes: Uint8Array | string) => {
  const s = typeof bytes === "string" ? bytes : String.fromCharCode(...bytes);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** A Cloudflare Access JWT signed with the test key. Override claims to make bad ones. */
export async function accessJwt(email: string, claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
  const jwk = JSON.parse(env.TEST_ACCESS_PRIVATE_JWK);
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(JSON.stringify({ alg: "RS256", kid: "test-kid", typ: "JWT", ...header }));
  const p = b64url(JSON.stringify({
    aud: ["test-aud"], email, sub: "sub-" + email, iss: "https://test.cloudflareaccess.com", iat: now, exp: now + 3600, ...claims,
  }));
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${h}.${p}`)));
  return `${h}.${p}.${b64url(sig)}`;
}

/** Register github:<user> with an email, as the operator. */
export async function registerOwner(ownerId: string, email: string) {
  const r = await call("/admin/owners", { token: ADMIN, body: { owner_id: ownerId, email } });
  if (r.status !== 201) throw new Error(JSON.stringify(r));
}

/** Call an /owner route as a signed-in browser (Access JWT + same-origin), or as admin acting for an owner. */
export async function ownerCall(
  path: string,
  opts: { jwt?: string; as?: string; body?: unknown; method?: string; origin?: string | null; cookie?: boolean } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.jwt) {
    if (opts.cookie) headers.cookie = `CF_Authorization=${opts.jwt}`;
    else headers["cf-access-jwt-assertion"] = opts.jwt;
  }
  if (opts.as) { headers.authorization = `Bearer ${ADMIN}`; headers["x-lichen-owner"] = opts.as; }
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.origin !== null) headers.origin = opts.origin ?? BASE;
  const res = await SELF.fetch(BASE + "/api" + path, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, data, headers: res.headers };
}

// ---------------------------------------------------------------- sockets

export interface Socket {
  ws: WebSocket;
  next(ms?: number): Promise<any>;
  quiet(ms?: number): Promise<boolean>;
  closed: Promise<{ code: number; reason: string }>;
}

export async function openSocket(path: string, headers: Record<string, string>): Promise<Socket> {
  const res = await SELF.fetch(BASE + "/api" + path, { headers: { upgrade: "websocket", ...headers } });
  if (res.status !== 101) throw new Error(`socket ${res.status}: ${await res.text()}`);
  const ws = res.webSocket!;
  ws.accept();
  const frames: any[] = [];
  const waiters: ((v: any) => void)[] = [];
  ws.addEventListener("message", (e) => {
    const data = typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data as ArrayBuffer);
    let v: any = data;
    try { v = JSON.parse(data); } catch { /* plain text */ }
    const w = waiters.shift();
    if (w) w(v); else frames.push(v);
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.addEventListener("close", (e) => resolve({ code: e.code, reason: e.reason })));
  const next = (ms = 2000) => {
    if (frames.length) return Promise.resolve(frames.shift());
    return new Promise<any>((resolve, reject) => {
      const waiter = (v: any) => { clearTimeout(t); resolve(v); };
      const t = setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error(`no frame within ${ms}ms`)); }, ms);
      waiters.push(waiter);
    });
  };
  const quiet = async (ms = 300) => { try { await next(ms); return false; } catch { return true; } };
  return { ws, next, quiet, closed };
}
