import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { generateKeyPairSync } from "node:crypto";

// A throwaway RSA key standing in for the Cloudflare Access signing key.
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pub = { ...publicKey.export({ format: "jwk" }), kid: "test-kid", alg: "RS256", use: "sig" };
const priv = { ...privateKey.export({ format: "jwk" }), kid: "test-kid", alg: "RS256" };

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
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
          },
        },
      }),
    ],
    test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/apply-migrations.ts"] },
  };
});
