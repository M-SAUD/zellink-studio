import { cloudflareTest } from "@cloudflare/vitest-plugin";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [cloudflareTest(async () => {
    const { readD1Migrations } = await import("@cloudflare/vitest-plugin");
    const migrations = await readD1Migrations(path.join(root, "migrations"));
    return {
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
    };
  })],
  test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/apply-migrations.ts"], restoreMocks: true, testTimeout: 20_000 },
});
