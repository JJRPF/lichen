import { SELF } from "cloudflare:test";

export const ADMIN = "test-admin-token";
const BASE = "https://lichen.test";

export async function call(path: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await SELF.fetch(BASE + path, {
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
