import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { generateKeyPairSync } from "node:crypto";

// A throwaway RSA key standing in for the Cloudflare Access signing key.
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pub = { ...publicKey.export({ format: "jwk" }), kid: "test-kid", alg: "RS256", use: "sig" };
const priv = { ...privateKey.export({ format: "jwk" }), kid: "test-kid", alg: "RS256" };

// Fake webhook receivers. Outbound fetches from the Worker land here (in Node):
// ok.example answers 200, fail.example 500; everything is recorded, and
// inspect.example/requests returns the log (inspect.example/reset clears it).
const received: { url: string; headers: Record<string, string>; body: string; status: number }[] = [];
async function outbound(req: Request): Promise<Response> {
  const u = new URL(req.url);
  if (u.hostname === "inspect.example") {
    if (u.pathname === "/reset") received.length = 0;
    return Response.json(received);
  }
  const status = u.hostname === "fail.example" ? 500 : u.hostname === "ok.example" ? 200 : 404;
  received.push({ url: req.url, headers: Object.fromEntries(req.headers), body: await req.text(), status });
  return new Response(status === 200 ? "ok" : "nope", { status });
}

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          outboundService: outbound,
          bindings: {
            TEST_MIGRATIONS: migrations,
            ADMIN_TOKEN: "test-admin-token",
            TURN_CAP: "4",
            COOLDOWN_MS: "0",
            MAX_BODY_BYTES: "1024",
            ACCESS_TEAM_DOMAIN: "https://test.cloudflareaccess.com",
            ACCESS_AUD: "test-aud",
            ACCESS_JWKS: JSON.stringify({ keys: [pub] }),
            TEST_ACCESS_PRIVATE_JWK: JSON.stringify(priv),
            NTFY_BASE: "",
            WEBHOOK_BACKOFF_MS: "30,30",
            WEBHOOK_MAX_FAILURES: "4",
          },
        },
      }),
    ],
    test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/apply-migrations.ts"] },
  };
});
