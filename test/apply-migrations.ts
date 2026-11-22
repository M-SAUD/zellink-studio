import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll } from "vitest";
import type { D1Migration } from "cloudflare:test";

beforeAll(async () => {
  const migrations = env.TEST_MIGRATIONS as D1Migration[];
  await applyD1Migrations(env.DB, migrations);
});
