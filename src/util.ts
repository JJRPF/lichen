// Small helpers shared by the Worker and the room Durable Object.

export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message ?? code);
  }
}

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) return json({ error: err.code, message: err.message }, err.status);
  console.error(err);
  return json({ error: "internal_error" }, 500);
}

const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"; // no 0/1/l/o

/** Random id/code from a 32-char alphabet (5 bits per char). */
export function randomString(length: number, alphabet = ALPHABET): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length]; // 256 % 32 == 0, so no bias
  return out;
}

export const newId = (prefix: string, length = 12) => `${prefix}_${randomString(length)}`;

/** 256-bit bearer token. Only its hash is stored. */
export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let b64 = btoa(String.fromCharCode(...bytes));
  b64 = b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `lch_${b64}`;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string compare (for the admin token). */
export function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

export const MAX_REQUEST_BYTES = 64 * 1024;

/** Read a JSON or form body with a hard size cap. Returns a plain object. */
export async function readBody(req: Request): Promise<Record<string, unknown>> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_REQUEST_BYTES) throw new HttpError(413, "payload_too_large");
  const buf = await req.arrayBuffer();
  if (buf.byteLength > MAX_REQUEST_BYTES) throw new HttpError(413, "payload_too_large");
  const text = new TextDecoder().decode(buf);
  if (!text.trim()) return {};

  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  // Default to JSON (curl -d @file.json sends form content-type, so sniff it too).
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    if (!type.includes("json")) return Object.fromEntries(new URLSearchParams(text));
  }
  throw new HttpError(400, "invalid_body", "Body must be a JSON object or form data");
}

export function str(v: unknown, field: string, max: number, required = false): string | undefined {
  if (v === undefined || v === null || v === "") {
    if (required) throw new HttpError(400, "missing_field", `${field} is required`);
    return undefined;
  }
  if (typeof v !== "string") throw new HttpError(400, "invalid_field", `${field} must be a string`);
  if (v.length > max) throw new HttpError(400, "field_too_long", `${field} must be at most ${max} characters`);
  return v;
}

export function bool(v: unknown, field: string, fallback: boolean): boolean {
  if (v === undefined || v === null || v === "") return fallback;
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  throw new HttpError(400, "invalid_field", `${field} must be a boolean`);
}

/** Inbox cursors are opaque to clients: base64url JSON of {room_id: seq}. */
export type Cursor = Record<string, number>;

export function encodeCursor(c: Cursor): string {
  return btoa(JSON.stringify(c)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeCursor(s: string | null | undefined): Cursor {
  if (!s) return {};
  try {
    const raw = JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/")));
    const out: Cursor = {};
    for (const [k, v] of Object.entries(raw)) if (typeof v === "number" && v >= 0) out[k] = Math.floor(v);
    return out;
  } catch {
    throw new HttpError(400, "invalid_cursor");
  }
}

/** Message ids are "<room_id>:<seq>". */
export function parseMessageId(id: string): { roomId: string; seq: number } {
  const m = /^(r_[a-z0-9]+):(\d+)$/.exec(id);
  if (!m) throw new HttpError(400, "invalid_message_id");
  return { roomId: m[1], seq: Number(m[2]) };
}
