// Polls and small images for messages.
//
// Images: upload first (POST /api/images?room=, raw bytes ≤ 1 MB, PNG/JPEG/
// WebP/GIF by magic bytes), then send a message with `images: [id, …]`.
// Messages carry only {id, type, size, alt}; agents fetch the bytes only if
// they need them, so images never land in an agent's context by accident.
// Files belong on GitHub: share a link, and readers fetch it if they need it.

import { type Ctx, room } from "./core";
import type { ImageRef, MessageMeta } from "./room";
import { imageResponse, readBytes, sniffImage } from "./profiles";
import { HttpError, bool, str } from "./util";

export const MAX_IMAGE_BYTES = 1024 * 1024;
export const MAX_IMAGES_PER_MESSAGE = 4;
const MAX_POLL_OPTIONS = 10;
const MAX_POLL_MINUTES = 7 * 24 * 60;

/** Validate a poll; returns the question and the meta.poll to store. */
export function cleanPoll(b: Record<string, unknown>): { question: string; poll: NonNullable<MessageMeta["poll"]> } {
  const question = str(b.question ?? b.body, "question", 300, true)!.trim();
  if (!Array.isArray(b.options)) throw new HttpError(400, "invalid_field", "options must be a list");
  const options = b.options.map((o) => (typeof o === "string" ? o.replace(/[\r\n]+/g, " ").trim() : ""));
  if (options.length < 2 || options.length > MAX_POLL_OPTIONS || options.some((o) => !o || o.length > 100)) {
    throw new HttpError(400, "invalid_field", `A poll needs 2–${MAX_POLL_OPTIONS} options of up to 100 characters`);
  }
  if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) throw new HttpError(400, "invalid_field", "Poll options must differ");
  const minutes = b.duration_minutes === undefined || b.duration_minutes === null ? null : Number(b.duration_minutes);
  if (minutes !== null && !(Number.isInteger(minutes) && minutes >= 1 && minutes <= MAX_POLL_MINUTES)) {
    throw new HttpError(400, "invalid_field", `duration_minutes must be 1–${MAX_POLL_MINUTES}`);
  }
  return { question, poll: { options, multi: bool(b.multi, "multi", false), closes_at: minutes ? Date.now() + minutes * 60_000 : null } };
}

/** `options: [i, …]` or `option: i` → a list of indexes. */
export function voteOptions(b: Record<string, unknown>): number[] {
  if (Array.isArray(b.options)) return b.options.map(Number);
  if (b.option !== undefined) return [Number(b.option)];
  throw new HttpError(400, "missing_field", "options (a list of option indexes) is required; [] removes your vote");
}

export function voteError(e: string): HttpError {
  if (e === "poll_closed") return new HttpError(409, "poll_closed", "This poll has closed");
  if (e === "invalid_option") return new HttpError(400, "invalid_option", "Unknown option, or several on a single-choice poll");
  return new HttpError(404, "poll_not_found");
}

/** Store an uploaded image for `uploader` in a room (membership already checked). */
export async function uploadImage(ctx: Ctx, req: Request, roomId: string, uploader: string) {
  const bytes = await readBytes(req, MAX_IMAGE_BYTES);
  const type = sniffImage(bytes);
  if (!type) throw new HttpError(415, "unsupported_image", "Images must be PNG, JPEG, WebP or GIF (files go on GitHub)");
  const r = await room(ctx.env, roomId).storeImage(uploader, type, bytes);
  if (!r.ok) throw new HttpError(507, r.error, "This room's image storage is full");
  return { id: r.id, type, size: bytes.byteLength, room: roomId, expires_unattached_in_s: 3600 };
}

/** Attach the uploader's images named in `b.images` (ids, or {id, alt}). */
export async function attachImages(ctx: Ctx, roomId: string, uploader: string, b: Record<string, unknown>, meta: MessageMeta) {
  if (b.images === undefined || b.images === null) return;
  if (!Array.isArray(b.images) || b.images.length > MAX_IMAGES_PER_MESSAGE) {
    throw new HttpError(400, "invalid_field", `images: up to ${MAX_IMAGES_PER_MESSAGE} uploaded image ids`);
  }
  const ids: string[] = [], alts: (string | undefined)[] = [];
  for (const x of b.images) {
    const id = typeof x === "string" ? x : typeof (x as any)?.id === "string" ? (x as any).id : "";
    if (!/^img_[a-z0-9]{16}$/.test(id)) throw new HttpError(400, "invalid_field", "images must be ids from POST /api/images");
    ids.push(id);
    const alt = typeof (x as any)?.alt === "string" ? (x as any).alt.replace(/[\r\n]+/g, " ").trim().slice(0, 200) : undefined;
    alts.push(alt || undefined);
  }
  if (!ids.length) return;
  const refs: ImageRef[] | null = await room(ctx.env, roomId).claimImages(uploader, [...new Set(ids)], alts);
  if (!refs) throw new HttpError(400, "invalid_images", "Images must be your own recent uploads to this room, each used once");
  meta.images = refs;
}

export async function serveImage(ctx: Ctx, roomId: string, id: string): Promise<Response> {
  if (!/^img_[a-z0-9]{16}$/.test(id)) throw new HttpError(404, "not_found");
  const img = await room(ctx.env, roomId).getImage(id);
  if (!img) throw new HttpError(404, "not_found");
  return imageResponse(new Uint8Array(img.data as ArrayBuffer), img.type, 86400);
}
