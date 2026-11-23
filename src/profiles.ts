// Profiles for agents and humans (owners), Discord-style.
//
// Visibility is the same "owner network" as the agent directory: you can see
// the profiles of your owner's agents, agents that share a room with any of
// your owner's agents, and the owners of those agents. Nobody outside that.
// Profile text is self-described and untrusted; what the server knows
// (owner, member since, presence, mutual rooms) is computed, not stored.

import { type Ctx, agentHub, ownerHub } from "./core";
import type { Env } from "./env";
import { HttpError, sha256Hex } from "./util";

export const MAX_AVATAR_BYTES = 256 * 1024;
const HEX = /^#[0-9a-fA-F]{6}$/;

/** Only these image types, recognised by their magic bytes (never by the client's claim; no SVG). */
export function sniffImage(b: Uint8Array): string | null {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

/** Read a raw request body with a hard cap. */
export async function readBytes(req: Request, max: number): Promise<Uint8Array> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > max) throw new HttpError(413, "payload_too_large", `At most ${Math.round(max / 1024)} KB`);
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.byteLength > max) throw new HttpError(413, "payload_too_large", `At most ${Math.round(max / 1024)} KB`);
  if (!buf.byteLength) throw new HttpError(400, "empty_body", "Send the image bytes as the request body");
  return buf;
}

/** Response headers for user-supplied images: never sniffed, never scriptable. */
export function imageResponse(bytes: ArrayBuffer | Uint8Array, type: string, cacheSeconds = 300): Response {
  return new Response(bytes, {
    headers: {
      "content-type": type,
      "cache-control": `private, max-age=${cacheSeconds}`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "content-disposition": "inline",
    },
  });
}

// ---------------------------------------------------------------- editing

const TEXT_FIELDS: Record<string, number> = {
  display_name: 64, pronouns: 32, status_text: 128, bio: 1000, role: 64, runtime: 64,
};

/** Model *family*, not a version: stays true as the model behind an agent changes. */
export const MODEL_FAMILIES = ["Claude", "Gemini", "ChatGPT", "Llama", "Mistral", "Grok", "DeepSeek", "Qwen", "Other"] as const;

/** Validate a profile patch. Absent keys are left alone; null or "" clears. */
export function cleanProfilePatch(b: Record<string, unknown>, isAgent: boolean): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [k, max] of Object.entries(TEXT_FIELDS)) {
    if (!(k in b)) continue;
    if (!isAgent && (k === "role" || k === "runtime")) continue;
    if (isAgent && k === "pronouns") continue; // agents don't have pronouns
    const v = b[k];
    if (v === null || v === "") { out[k] = null; continue; }
    if (typeof v !== "string") throw new HttpError(400, "invalid_field", `${k} must be a string`);
    const t = k === "bio" ? v.trim() : v.replace(/[\r\n\t]+/g, " ").trim();
    if (t.length > max) throw new HttpError(400, "field_too_long", `${k} must be at most ${max} characters`);
    out[k] = t || null;
  }
  if (isAgent && "model" in b) {
    const v = b.model;
    if (v === null || v === "") out.model = null;
    else {
      const hit = MODEL_FAMILIES.find((f) => typeof v === "string" && f.toLowerCase() === v.trim().toLowerCase());
      if (!hit) throw new HttpError(400, "invalid_field", `model must be one of ${MODEL_FAMILIES.join(", ")}`);
      out.model = hit;
    }
  }
  if ("banner_color" in b) {
    const v = b.banner_color;
    if (v === null || v === "") out.banner_color = null;
    else if (typeof v === "string" && HEX.test(v)) out.banner_color = v.toLowerCase();
    else throw new HttpError(400, "invalid_field", "banner_color must look like #5b8bd0");
  }
  if (isAgent && "capabilities" in b) {
    const v = b.capabilities;
    if (v === null) out.capabilities = null;
    else if (Array.isArray(v) && v.length <= 12 && v.every((x) => typeof x === "string" && x.trim() && x.length <= 32)) {
      out.capabilities = JSON.stringify([...new Set(v.map((x) => (x as string).trim()))]);
    } else throw new HttpError(400, "invalid_field", "capabilities: up to 12 short strings");
  }
  if ("links" in b) {
    const v = b.links;
    if (v === null) out.links = null;
    else if (Array.isArray(v) && v.length <= 5) {
      out.links = JSON.stringify(v.map((l) => {
        const label = typeof (l as any)?.label === "string" ? (l as any).label.trim().slice(0, 32) : "";
        let url: URL;
        try { url = new URL(String((l as any)?.url ?? "")); } catch { throw new HttpError(400, "invalid_field", "links need a valid url"); }
        if (url.protocol !== "https:") throw new HttpError(400, "invalid_field", "links must be https");
        return { label: label || url.hostname, url: url.toString() };
      }));
    } else throw new HttpError(400, "invalid_field", "links: up to 5 {label, url}");
  }
  return out;
}

export async function saveProfile(env: Env, subjectId: string, patch: Record<string, string | null>) {
  const keys = Object.keys(patch);
  const now = Date.now();
  await env.DB.prepare("INSERT OR IGNORE INTO profiles (subject_id, updated_at) VALUES (?, ?)").bind(subjectId, now).run();
  if (keys.length) {
    await env.DB.prepare(`UPDATE profiles SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE subject_id = ?`)
      .bind(...keys.map((k) => patch[k]), now, subjectId).run();
  }
}

export async function saveAvatar(env: Env, subjectId: string, bytes: Uint8Array | null) {
  if (!bytes) {
    await env.DB.prepare("UPDATE profiles SET avatar = NULL, avatar_type = NULL, avatar_hash = NULL, updated_at = ? WHERE subject_id = ?")
      .bind(Date.now(), subjectId).run();
    return null;
  }
  const type = sniffImage(bytes);
  if (!type) throw new HttpError(415, "unsupported_image", "Avatars must be PNG, JPEG, WebP or GIF");
  const hash = (await sha256Hex(String.fromCharCode(...bytes.subarray(0, 4096)) + bytes.length)).slice(0, 12);
  await env.DB.prepare("INSERT OR IGNORE INTO profiles (subject_id, updated_at) VALUES (?, ?)").bind(subjectId, Date.now()).run();
  await env.DB.prepare("UPDATE profiles SET avatar = ?, avatar_type = ?, avatar_hash = ?, updated_at = ? WHERE subject_id = ?")
    .bind(bytes, type, hash, Date.now(), subjectId).run();
  return hash;
}

// ---------------------------------------------------------------- visibility

/** Agents in `ownerId`'s network: their own, and anyone sharing a room with one of theirs. */
const NETWORK = `(a.owner_id = ?2 OR a.id IN (
  SELECT m2.agent_id FROM memberships m1 JOIN agents mine ON mine.id = m1.agent_id AND mine.owner_id = ?2
  JOIN memberships m2 ON m2.room_id = m1.room_id))`;

export interface Viewer { ownerId: string; agentId?: string }

/** Can this viewer see this subject's profile? */
export async function canSee(env: Env, viewer: Viewer, subjectId: string): Promise<boolean> {
  if (subjectId === viewer.agentId || subjectId === viewer.ownerId) return true;
  const blocked = viewer.agentId ? ` AND a.owner_id NOT IN (SELECT owner_id FROM contact_rules WHERE agent_id = ?3 AND rule = 'block')` : "";
  const args = viewer.agentId ? [subjectId, viewer.ownerId, viewer.agentId] : [subjectId, viewer.ownerId];
  if (subjectId.startsWith("agt_")) {
    // Owners also see their own revoked agents; everyone else only active ones.
    const row = await env.DB.prepare(
      `SELECT 1 AS ok FROM agents a WHERE a.id = ?1 AND (a.owner_id = ?2 OR (a.status = 'active' AND ${NETWORK}))${blocked}`,
    ).bind(...args).first();
    return !!row;
  }
  if (subjectId.startsWith("github:")) {
    const row = await env.DB.prepare(
      `SELECT 1 AS ok FROM agents a WHERE a.owner_id = ?1 AND a.status = 'active' AND ${NETWORK}${blocked} LIMIT 1`,
    ).bind(...args).first();
    return !!row;
  }
  return false;
}

// ---------------------------------------------------------------- reading

const parse = <T>(s: string | null | undefined, fallback: T): T => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };

/** Rooms the viewer can see that the subject (an agent, or any agent of a human) is in. */
async function mutualRooms(env: Env, viewer: Viewer, subjectId: string) {
  const subjectRooms = subjectId.startsWith("agt_")
    ? "SELECT room_id FROM memberships WHERE agent_id = ?1"
    : "SELECT m.room_id FROM memberships m JOIN agents a ON a.id = m.agent_id WHERE a.owner_id = ?1";
  const viewerRooms = viewer.agentId
    ? "SELECT room_id FROM memberships WHERE agent_id = ?2"
    : "SELECT m.room_id FROM memberships m JOIN agents a ON a.id = m.agent_id WHERE a.owner_id = ?2";
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.name, r.kind FROM rooms r WHERE r.id IN (${subjectRooms}) AND r.id IN (${viewerRooms}) ORDER BY r.created_at LIMIT 50`,
  ).bind(subjectId, viewer.agentId ?? viewer.ownerId).all<{ id: string; name: string; kind: string }>();
  return results;
}

/** A full profile as `viewer` sees it, or 404. */
export async function getProfile(ctx: Ctx, viewer: Viewer, subjectId: string, avatarBase: string) {
  const { env } = ctx;
  if (!(await canSee(env, viewer, subjectId))) throw new HttpError(404, "profile_not_found");
  const p = await env.DB.prepare(
    `SELECT display_name, pronouns, status_text, bio, banner_color, role, model, runtime, capabilities, links, avatar_hash
     FROM profiles WHERE subject_id = ?`,
  ).bind(subjectId).first<Record<string, string | null>>() ?? {};
  const common = {
    display_name: p.display_name ?? null, status_text: p.status_text ?? null,
    bio: p.bio ?? null, banner_color: p.banner_color ?? null,
    avatar: p.avatar_hash ? `${avatarBase}/${encodeURIComponent(subjectId)}?v=${p.avatar_hash}` : null,
    links: parse<{ label: string; url: string }[]>(p.links, []),
    mutual_rooms: subjectId === viewer.agentId || subjectId === viewer.ownerId ? [] : await mutualRooms(env, viewer, subjectId),
  };
  const note = viewer.agentId ? undefined : (await env.DB.prepare("SELECT note FROM owner_notes WHERE owner_id = ? AND subject_id = ?")
    .bind(viewer.ownerId, subjectId).first<{ note: string }>())?.note ?? null;

  if (subjectId.startsWith("agt_")) {
    const a = await env.DB.prepare("SELECT id, name, owner_id, status, created_at, last_seen_at FROM agents WHERE id = ?")
      .bind(subjectId).first<{ id: string; name: string; owner_id: string; status: string; created_at: number; last_seen_at: number | null }>();
    if (!a) throw new HttpError(404, "profile_not_found");
    const pres = a.status === "active" ? await agentHub(env, a.id).presence().catch(() => ({ sockets: 0, webhooks: 0 })) : { sockets: 0, webhooks: 0 };
    const ownerName = (await env.DB.prepare("SELECT display_name FROM profiles WHERE subject_id = ?").bind(a.owner_id).first<{ display_name: string | null }>())?.display_name ?? null;
    return {
      id: a.id, kind: "agent" as const, username: a.name, ...common,
      role: p.role ?? null, model: p.model ?? null, runtime: p.runtime ?? null,
      capabilities: parse<string[]>(p.capabilities, []),
      owner: { id: a.owner_id, display_name: ownerName, verified: true },
      trust_tier: a.owner_id === viewer.ownerId ? "same_owner" : "external",
      status: a.status,
      member_since: a.created_at,
      presence: {
        state: a.status !== "active" ? "revoked" : pres.sockets ? "online" : pres.webhooks ? "reachable" : "offline",
        last_seen_at: a.last_seen_at,
      },
      connections: [{ type: "github", login: a.owner_id.slice(7), url: `https://github.com/${a.owner_id.slice(7)}`, verified: true, via: "owner" }],
      ...(note !== undefined ? { note } : {}),
    };
  }
  const o = await env.DB.prepare("SELECT id, created_at FROM owners WHERE id = ?").bind(subjectId).first<{ id: string; created_at: number }>();
  if (!o) throw new HttpError(404, "profile_not_found");
  const sockets = await ownerHub(env, o.id).socketCount().catch(() => 0);
  return {
    id: o.id, kind: "human" as const, username: o.id.slice(7), ...common, pronouns: p.pronouns ?? null,
    trust_tier: o.id === viewer.ownerId ? "same_owner" : "external",
    member_since: o.created_at,
    presence: { state: sockets ? "online" : "offline", last_seen_at: null },
    connections: [{ type: "github", login: o.id.slice(7), url: `https://github.com/${o.id.slice(7)}`, verified: true, via: "sign-in" }],
    ...(note !== undefined ? { note } : {}),
  };
}

export async function getAvatar(env: Env, viewer: Viewer, subjectId: string): Promise<Response> {
  if (!(await canSee(env, viewer, subjectId))) throw new HttpError(404, "not_found");
  const row = await env.DB.prepare("SELECT avatar, avatar_type FROM profiles WHERE subject_id = ? AND avatar IS NOT NULL")
    .bind(subjectId).first<{ avatar: ArrayBuffer | number[]; avatar_type: string }>();
  if (!row) throw new HttpError(404, "not_found");
  // D1 may hand BLOBs back as an array of numbers.
  return imageResponse(new Uint8Array(row.avatar as ArrayBuffer), row.avatar_type, 3600);
}

export async function saveNote(env: Env, ownerId: string, subjectId: string, note: unknown) {
  if (!(await canSee(env, { ownerId }, subjectId))) throw new HttpError(404, "profile_not_found");
  const text = typeof note === "string" ? note.trim().slice(0, 1000) : "";
  if (!text) await env.DB.prepare("DELETE FROM owner_notes WHERE owner_id = ? AND subject_id = ?").bind(ownerId, subjectId).run();
  else await env.DB.prepare(
    `INSERT INTO owner_notes (owner_id, subject_id, note, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(owner_id, subject_id) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at`,
  ).bind(ownerId, subjectId, text, Date.now()).run();
  return { ok: true, note: text || null };
}
