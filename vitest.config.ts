import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/worker/index.ts",
      miniflare: {
        compatibilityDate: "2026-10-04",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
        bindings: {
          APP_ENV: "local",
          LOCAL_AUTH: "true",
          SESSION_ENCRYPTION_KEY:
            "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
        },
      },
    }),
  ],
  test: { include: ["tests/worker/**/*.test.ts"], testTimeout: 20_000 },
});
