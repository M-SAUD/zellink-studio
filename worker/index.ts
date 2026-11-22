import { Hono } from "hono";
import { routeAdministration } from "./admin";
import { routeAuth, loadActor, enforcePasswordChange } from "./auth";
import { routeDashboard } from "./dashboard";
import { checkScannerHealth, processFileScanMessage, routeFiles } from "./files";
import { routeOnboarding } from "./onboarding";
import { routeOrganizations } from "./organizations";
import { routeProduction } from "./production";
import { routeRequests } from "./requests";
import { ScannerContainer } from "./scanner-container";
import type { AppEnv, FileScanMessage, OnboardingFileScanMessage } from "./types";

const app = new Hono<AppEnv>();

app.use("*", async (c, next) => {
  const requestId = crypto.randomUUID();
  c.header("X-Request-ID", requestId);
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  c.header("Cross-Origin-Resource-Policy", "same-origin");
  c.header("Content-Security-Policy", "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; img-src 'self' data: blob:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'");
  if (c.env.APP_MODE !== "development") c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  if (new URL(c.req.url).pathname.startsWith("/api/")) c.header("Cache-Control", "no-store");
  await next();
});

app.use("/api/*", loadActor);
app.use("/api/*", enforcePasswordChange);
app.use("/api/*", async (c, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return next();
  const origin = c.req.header("Origin");
  if (origin) {
    try {
      const source = new URL(origin);
      const destination = new URL(c.req.url);
      const localDevelopment = c.env.APP_MODE === "development" &&
        ["127.0.0.1", "localhost"].includes(source.hostname) && ["127.0.0.1", "localhost"].includes(destination.hostname);
      if (!localDevelopment && source.origin !== destination.origin) return c.json({ error: "cross_origin_request_rejected" }, 403);
    } catch {
      return c.json({ error: "cross_origin_request_rejected" }, 403);
    }
  } else if (c.req.header("Sec-Fetch-Site") === "cross-site") {
    return c.json({ error: "cross_origin_request_rejected" }, 403);
  }
  return next();
});

app.get("/api/health", (c) => c.json({
  ok: true,
  mode: c.env.APP_MODE,
  fileUploadsEnabled: c.env.FILE_UPLOADS_ENABLED !== "false",
}));

routeAuth(app);
routeAdministration(app);
routeOrganizations(app);
routeOnboarding(app);
routeRequests(app);
routeProduction(app);
routeDashboard(app);
routeFiles(app);

app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));
app.all("*", async (c) => c.env.ASSETS.fetch(c.req.raw));

app.onError((error, c) => {
  const requestId = c.res.headers.get("X-Request-ID") ?? "unknown";
  console.error(JSON.stringify({ event: "request_error", requestId, name: error.name }));
  return c.json({ error: "internal_server_error", requestId }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: AppEnv["Bindings"], ctx: ExecutionContext) {
    ctx.waitUntil(runScheduledWork(env));
  },
  async queue(batch: MessageBatch<FileScanMessage>, env: AppEnv["Bindings"]) {
    for (const message of batch.messages) {
      const outcome = await processFileScanMessage(env, message.body, batch.queue.endsWith("-dlq"));
      if (outcome === "retry") message.retry({ delaySeconds: 60 });
      else message.ack();
    }
  },
};

export { ScannerContainer };

async function runScheduledWork(env: AppEnv["Bindings"]): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM auth_sessions WHERE (revoked_at IS NOT NULL OR expires_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days'))`),
    env.DB.prepare(`DELETE FROM auth_rate_limit_buckets WHERE updated_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')`),
  ]);
  if (env.FILE_UPLOADS_ENABLED === "false") return;
  const scannerStatus = await env.DB.prepare(`SELECT status, last_checked_at FROM integration_status WHERE provider_key = 'scanner'`)
    .first<{ status: string; last_checked_at: string | null }>();
  const lastChecked = scannerStatus?.last_checked_at ? Date.parse(scannerStatus.last_checked_at) : 0;
  if (!lastChecked || Date.now() - lastChecked > 15 * 60 * 1000 || !env.SCANNER) {
    await checkScannerHealth(env);
  }
  if (!env.SCANNER) return;
  const status = await env.DB.prepare(`SELECT status FROM integration_status WHERE provider_key = 'scanner'`).first<{ status: string }>();
  if (status?.status !== "ready") return;
  const jobs = await env.DB.prepare(`SELECT id, organization_id, file_version_id, idempotency_key
    FROM file_scan_jobs WHERE state = 'pending' ORDER BY created_at LIMIT 20`).all<{
      id: string; organization_id: string; file_version_id: string; idempotency_key: string;
    }>();
  for (const job of jobs.results) {
    const body: FileScanMessage = { idempotencyKey: job.idempotency_key, fileVersionId: job.file_version_id, organizationId: job.organization_id };
    try {
      await env.FILE_SCANS.send(body, { contentType: "json" });
      await env.DB.prepare(`UPDATE file_scan_jobs SET state = 'queued', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ? AND state = 'pending'`).bind(job.id).run();
    } catch {
      await env.DB.prepare(`UPDATE file_scan_jobs SET attempts = attempts + 1, last_error = 'queue_unavailable',
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND state = 'pending'`).bind(job.id).run();
    }
  }
  const onboardingJobs = await env.DB.prepare(`SELECT id, organization_id, onboarding_asset_id, idempotency_key
    FROM onboarding_file_scan_jobs WHERE state = 'pending' ORDER BY created_at LIMIT 20`).all<{
      id: string; organization_id: string; onboarding_asset_id: string; idempotency_key: string;
    }>();
  for (const job of onboardingJobs.results) {
    const body: OnboardingFileScanMessage = {
      idempotencyKey: job.idempotency_key,
      organizationId: job.organization_id,
      onboardingAssetId: job.onboarding_asset_id,
      assetType: "onboarding",
    };
    try {
      await env.FILE_SCANS.send(body, { contentType: "json" });
      await env.DB.prepare(`UPDATE onboarding_file_scan_jobs SET state = 'queued', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ? AND state = 'pending'`).bind(job.id).run();
    } catch {
      await env.DB.prepare(`UPDATE onboarding_file_scan_jobs SET attempts = attempts + 1, last_error = 'queue_unavailable',
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND state = 'pending'`).bind(job.id).run();
    }
  }
}
