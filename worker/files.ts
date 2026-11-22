import { Hono } from "hono";
import { organizationRole, type OrganizationRole } from "./authorization";
import { newId } from "./security";
import type { AppEnv, FileScanMessage, OnboardingFileScanMessage, RequestFileScanMessage } from "./types";

const router = new Hono<AppEnv>();
export const DEFAULT_MAX_UPLOAD = 20 * 1024 * 1024;
const MAX_SIGNATURE_AGE_MS = 24 * 60 * 60 * 1000;
export const allowedTypes = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf", "text/plain", "text/csv",
  "application/zip", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

interface StoredFile {
  id: string;
  organization_id: string;
  request_id: string;
  uploader_user_id: string;
  object_key: string;
  original_name: string;
  media_type: string;
  byte_size: number;
  sha256: string | null;
  scan_state: string;
  client_visible: number;
  scanner_name: string | null;
  scanner_signature_at: string | null;
  scanned_at: string | null;
  created_at: string;
  uploader_name: string;
}

router.get("/api/orgs/:organizationId/requests/:requestId/files", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  const organizationId = c.req.param("organizationId");
  const requestId = c.req.param("requestId");
  const role = await organizationRole(c.env, actor, organizationId);
  if (!role || !(await requestAccessible(c.env, actor.id, organizationId, requestId, role))) return c.json({ error: "not_found" }, 404);
  const client = role === "client_owner" || role === "client_member";
  const rows = await c.env.DB.prepare(`SELECT f.id, f.organization_id, f.request_id, f.uploader_user_id, f.original_name,
      f.media_type, f.byte_size, f.scan_state, f.client_visible, f.scanner_name, f.scanner_signature_at, f.scanned_at,
      f.created_at, u.display_name AS uploader_name
    FROM file_versions f JOIN app_users u ON u.id = f.uploader_user_id
    WHERE f.organization_id = ? AND f.request_id = ? AND f.deleted_at IS NULL
      ${client ? "AND f.client_visible = 1 AND f.scan_state = 'clean'" : ""}
    ORDER BY f.created_at DESC`).bind(organizationId, requestId).all();
  return c.json({ files: rows.results });
});

router.post("/api/orgs/:organizationId/requests/:requestId/files", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  const organizationId = c.req.param("organizationId");
  const requestId = c.req.param("requestId");
  const role = await organizationRole(c.env, actor, organizationId);
  if (!role || !(await requestAccessible(c.env, actor.id, organizationId, requestId, role))) return c.json({ error: "not_found" }, 404);
  if (role === "client_member") {
    const permission = await c.env.DB.prepare(`SELECT can_submit FROM memberships WHERE organization_id = ? AND user_id = ?`)
      .bind(organizationId, actor.id).first<{ can_submit: number }>();
    if (permission?.can_submit !== 1) return c.json({ error: "request_permission_required" }, 403);
  }
  const request = await c.env.DB.prepare(`SELECT status FROM requests WHERE organization_id = ? AND id = ? AND deleted_at IS NULL`)
    .bind(organizationId, requestId).first<{ status: string }>();
  if (!request) return c.json({ error: "not_found" }, 404);
  if (c.env.FILE_UPLOADS_ENABLED === "false") return c.json({ error: "file_scanning_not_configured" }, 503);
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return c.json({ error: "file_required" }, 400);
  const maxUpload = parsePositiveInteger(c.env.MAX_UPLOAD_BYTES) ?? DEFAULT_MAX_UPLOAD;
  if (file.size < 1 || file.size > maxUpload) return c.json({ error: "upload_size_not_allowed", maxBytes: maxUpload }, 413);
  const mediaType = file.type.trim().toLowerCase();
  if (!allowedTypes.has(mediaType)) return c.json({ error: "file_type_not_allowed" }, 415);
  const prefix = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  if (!hasExpectedSignature(mediaType, prefix)) return c.json({ error: "file_signature_mismatch" }, 415);

  const fileId = newId();
  const scanJobId = newId();
  const idempotencyKey = newId();
  const objectKey = `org/${organizationId}/request/${requestId}/${fileId}`;
  const originalName = safeFilename(file.name);
  const digestBytes = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  const digest = toHex(new Uint8Array(digestBytes));
  try {
    await c.env.FILES.put(objectKey, file.stream(), {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: { organizationId, fileId },
    });
  } catch {
    return c.json({ error: "upload_storage_unavailable" }, 503);
  }
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO file_versions
        (id, organization_id, request_id, uploader_user_id, object_key, original_name, media_type, byte_size, sha256, scan_state, client_visible)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_scan', 0)`)
        .bind(fileId, organizationId, requestId, actor.id, objectKey, originalName, mediaType, file.size, digest),
      c.env.DB.prepare(`INSERT INTO file_scan_jobs (id, organization_id, file_version_id, idempotency_key, state)
        VALUES (?, ?, ?, ?, 'pending')`).bind(scanJobId, organizationId, fileId, idempotencyKey),
      c.env.DB.prepare(`INSERT INTO audit_events (id, actor_user_id, organization_id, action, subject_type, subject_id, reason, after_json, request_id)
        VALUES (?, ?, ?, 'file_uploaded', 'file', ?, 'Quarantined for malware scanning', json_object('scan_state', 'pending_scan', 'byte_size', ?), ?)`)
        .bind(newId(), actor.id, organizationId, fileId, file.size, requestId),
    ]);
  } catch {
    await c.env.FILES.delete(objectKey).catch(() => undefined);
    return c.json({ error: "file_record_creation_failed" }, 409);
  }
  return c.json({ file: { id: fileId, name: originalName, byteSize: file.size, mediaType, scanState: "pending_scan", clientVisible: false } }, 201);
});

router.patch("/api/orgs/:organizationId/files/:fileId/visibility", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  const organizationId = c.req.param("organizationId");
  const fileId = c.req.param("fileId");
  const role = await organizationRole(c.env, actor, organizationId);
  if (!role || !(role === "pm" || role === "admin" || role === "super_admin")) return c.json({ error: "forbidden" }, 403);
  const body = await c.req.json().catch(() => undefined) as { clientVisible?: unknown } | undefined;
  if (typeof body?.clientVisible !== "boolean") return c.json({ error: "invalid_visibility" }, 400);
  const file = await c.env.DB.prepare(`SELECT request_id, scan_state, client_visible FROM file_versions
    WHERE organization_id = ? AND id = ? AND deleted_at IS NULL`).bind(organizationId, fileId)
    .first<{ request_id: string; scan_state: string; client_visible: number }>();
  if (!file) return c.json({ error: "not_found" }, 404);
  if (body.clientVisible && file.scan_state !== "clean") return c.json({ error: "file_not_clean" }, 409);
  if (!(await requestAccessible(c.env, actor.id, organizationId, file.request_id, role))) return c.json({ error: "not_found" }, 404);
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE file_versions SET client_visible = ? WHERE organization_id = ? AND id = ? AND scan_state = 'clean'`)
      .bind(body.clientVisible ? 1 : 0, organizationId, fileId),
    c.env.DB.prepare(`INSERT INTO audit_events (id, actor_user_id, organization_id, action, subject_type, subject_id, reason, before_json, after_json, request_id)
      VALUES (?, ?, ?, 'file_visibility_changed', 'file', ?, ?, json_object('client_visible', ?), json_object('client_visible', ?), ?)`)
      .bind(newId(), actor.id, organizationId, fileId, body.clientVisible ? "File shared with client" : "File hidden from client",
        file.client_visible, body.clientVisible ? 1 : 0, file.request_id),
  ]);
  return c.json({ fileId, clientVisible: body.clientVisible });
});

router.get("/api/orgs/:organizationId/files/:fileId/download", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  const organizationId = c.req.param("organizationId");
  const fileId = c.req.param("fileId");
  const role = await organizationRole(c.env, actor, organizationId);
  if (!role) return c.json({ error: "not_found" }, 404);
  const file = await c.env.DB.prepare(`SELECT f.request_id, f.object_key, f.original_name, f.media_type, f.scan_state, f.client_visible
    FROM file_versions f WHERE f.organization_id = ? AND f.id = ? AND f.deleted_at IS NULL`)
    .bind(organizationId, fileId).first<Pick<StoredFile, "request_id" | "object_key" | "original_name" | "media_type" | "scan_state" | "client_visible">>();
  if (!file || file.scan_state !== "clean" || ((role === "client_owner" || role === "client_member") && file.client_visible !== 1)) {
    return c.json({ error: "not_found" }, 404);
  }
  if (!(await requestAccessible(c.env, actor.id, organizationId, file.request_id, role))) return c.json({ error: "not_found" }, 404);
  const object = await c.env.FILES.get(file.object_key);
  if (!object) return c.json({ error: "file_not_found" }, 404);
  const headers = new Headers({
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.original_name)}`,
    "Content-Length": String(object.size),
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox",
  });
  return new Response(object.body, { status: 200, headers });
});

router.get("/api/admin/integrations", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  if (!(actor.globalRole === "admin" || actor.globalRole === "super_admin")) return c.json({ error: "forbidden" }, 403);
  await checkScannerHealth(c.env);
  const result = await c.env.DB.prepare(`SELECT provider_key, configured, status, status_detail, last_checked_at, updated_at
    FROM integration_status ORDER BY provider_key`).all();
  return c.json({ integrations: result.results });
});

router.post("/api/admin/integrations/scanner/check", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  if (!(actor.globalRole === "admin" || actor.globalRole === "super_admin")) return c.json({ error: "forbidden" }, 403);
  const status = await checkScannerHealth(c.env);
  return c.json({ scanner: status }, status.status === "ready" ? 200 : 503);
});

export function routeFiles(app: Hono<AppEnv>): void {
  app.route("/", router);
}

export async function checkScannerHealth(env: AppEnv["Bindings"]): Promise<{ status: string; signatureAt?: string; scannerVersion?: string }> {
  if (!env.SCANNER) {
    await updateScannerStatus(env, false, "unconfigured", "Container binding is unavailable.");
    return { status: "unconfigured" };
  }
  try {
    const stub = env.SCANNER.get(env.SCANNER.idFromName("zellink-clamav-scanner"));
    const response = await stub.fetch("https://scanner.internal/health", { method: "GET" });
    const body = await response.json() as { ok?: boolean; signatureAt?: string | null; scannerVersion?: string };
    const timestamp = body.signatureAt ? Date.parse(body.signatureAt) : Number.NaN;
    const fresh = response.ok && body.ok === true && Number.isFinite(timestamp) && Date.now() - timestamp <= MAX_SIGNATURE_AGE_MS && timestamp <= Date.now() + 5 * 60 * 1000;
    const status = fresh ? "ready" : "degraded";
    const detail = fresh ? `Signatures checked at ${body.signatureAt}.` : "Scanner is unavailable or its signatures are stale.";
    await updateScannerStatus(env, true, status, detail);
    return { status, signatureAt: body.signatureAt ?? undefined, scannerVersion: body.scannerVersion };
  } catch {
    await updateScannerStatus(env, true, "degraded", "Scanner health check failed.");
    return { status: "degraded" };
  }
}

export async function processFileScanMessage(env: AppEnv["Bindings"], message: FileScanMessage, deadLetter = false): Promise<"ack" | "retry"> {
  if (message.assetType === "onboarding") return processOnboardingFileScanMessage(env, message, deadLetter);
  const job = await env.DB.prepare(`SELECT j.state, j.file_version_id, j.organization_id, f.object_key, f.byte_size, f.uploader_user_id
    FROM file_scan_jobs j JOIN file_versions f ON f.id = j.file_version_id AND f.organization_id = j.organization_id
    WHERE j.idempotency_key = ?`).bind(message.idempotencyKey)
    .first<{ state: string; file_version_id: string; organization_id: string; object_key: string; byte_size: number; uploader_user_id: string }>();
  if (!job || ["clean", "rejected", "failed"].includes(job.state)) return "ack";
  if (deadLetter) {
    await markFileScanFailure(env, message, job.uploader_user_id, "scan_retries_exhausted");
    return "ack";
  }

async function processOnboardingFileScanMessage(env: AppEnv["Bindings"], message: OnboardingFileScanMessage, deadLetter: boolean): Promise<"ack" | "retry"> {
  const job = await env.DB.prepare(`SELECT j.state, j.organization_id, a.object_key, a.byte_size, a.uploader_user_id
    FROM onboarding_file_scan_jobs j JOIN onboarding_assets a
      ON a.id = j.onboarding_asset_id AND a.organization_id = j.organization_id
    WHERE j.idempotency_key = ? AND j.onboarding_asset_id = ?`)
    .bind(message.idempotencyKey, message.onboardingAssetId)
    .first<{ state: string; organization_id: string; object_key: string; byte_size: number; uploader_user_id: string }>();
  if (!job || ["clean", "rejected", "failed"].includes(job.state)) return "ack";
  if (deadLetter) {
    await markOnboardingScanFailure(env, message, job.uploader_user_id, "scan_retries_exhausted");
    return "ack";
  }
  if (!env.SCANNER) return "retry";
  const claim = await env.DB.prepare(`UPDATE onboarding_file_scan_jobs SET state = 'scanning', attempts = attempts + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE idempotency_key = ? AND state IN ('pending', 'queued')`)
    .bind(message.idempotencyKey).run();
  if (claim.meta.changes !== 1) return "ack";
  const object = await env.FILES.get(job.object_key);
  if (!object) {
    await markOnboardingScanFailure(env, message, job.uploader_user_id, "object_missing");
    return "ack";
  }
  try {
    const scanner = env.SCANNER.get(env.SCANNER.idFromName("zellink-clamav-scanner"));
    const response = await scanner.fetch("https://scanner.internal/scan", {
      method: "POST",
      headers: { "Content-Length": String(object.size), "Content-Type": "application/octet-stream" },
      body: object.body,
    });
    if (!response.ok) {
      await resetOnboardingScanJob(env, message.idempotencyKey, "scanner_unavailable");
      return "retry";
    }
    const result = await response.json() as { result?: string; scannerVersion?: string; signatureAt?: string };
    const signatureTime = result.signatureAt ? Date.parse(result.signatureAt) : Number.NaN;
    if (!Number.isFinite(signatureTime) || Date.now() - signatureTime > MAX_SIGNATURE_AGE_MS || signatureTime > Date.now() + 5 * 60 * 1000) {
      await resetOnboardingScanJob(env, message.idempotencyKey, "scanner_signatures_stale");
      await updateScannerStatus(env, true, "degraded", "Scanner signatures are stale.");
      return "retry";
    }
    if (result.result === "infected") {
      await markOnboardingFileRejected(env, message, job.uploader_user_id, result.scannerVersion ?? "ClamAV", result.signatureAt);
      return "ack";
    }
    if (result.result !== "clean") {
      await resetOnboardingScanJob(env, message.idempotencyKey, "scanner_result_invalid");
      return "retry";
    }
    await markOnboardingFileClean(env, message, job.uploader_user_id, result.scannerVersion ?? "ClamAV", result.signatureAt);
    await updateScannerStatus(env, true, "ready", `Signatures checked at ${result.signatureAt}.`);
    return "ack";
  } catch {
    await resetOnboardingScanJob(env, message.idempotencyKey, "scanner_request_failed");
    return "retry";
  }
}

async function resetOnboardingScanJob(env: AppEnv["Bindings"], idempotencyKey: string, reason: string): Promise<void> {
  await env.DB.prepare(`UPDATE onboarding_file_scan_jobs SET state = 'queued', last_error = ?,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE idempotency_key = ? AND state = 'scanning'`)
    .bind(reason, idempotencyKey).run();
}

async function markOnboardingFileClean(env: AppEnv["Bindings"], message: OnboardingFileScanMessage, uploaderId: string, scanner: string, signatureAt?: string): Promise<void> {
  const fileId = message.onboardingAssetId;
  await env.DB.batch([
    env.DB.prepare(`UPDATE onboarding_assets SET scan_state = 'clean', scanner_name = ?, scanner_signature_at = ?,
      scanned_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE organization_id = ? AND id = ? AND scan_state = 'pending_scan'`)
      .bind(scanner, signatureAt ?? null, message.organizationId, fileId),
    env.DB.prepare(`UPDATE onboarding_file_scan_jobs SET state = 'clean', last_error = NULL,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE idempotency_key = ? AND state = 'scanning'`)
      .bind(message.idempotencyKey),
    env.DB.prepare(`INSERT OR IGNORE INTO notifications (id, user_id, organization_id, event_key, title, body)
      SELECT ?, ?, ?, ?, 'Onboarding file is ready', 'The uploaded brand or reference file passed its safety check.'
      WHERE EXISTS (SELECT 1 FROM onboarding_assets WHERE organization_id = ? AND id = ?)`)
      .bind(newId(), uploaderId, message.organizationId, `onboarding-file:${fileId}:clean:${uploaderId}`, message.organizationId, fileId),
    env.DB.prepare(`INSERT OR IGNORE INTO notifications (id, user_id, organization_id, event_key, title, body)
      SELECT ?, a.pm_user_id, ?, ?, 'Onboarding file is ready', 'A client onboarding file passed its safety check.'
      FROM pm_assignments a WHERE a.organization_id = ? AND a.assignment_role = 'primary' AND a.ends_at IS NULL AND a.pm_user_id <> ?
        AND EXISTS (SELECT 1 FROM onboarding_assets WHERE organization_id = ? AND id = ?)`)
      .bind(newId(), message.organizationId, `onboarding-file:${fileId}:clean:pm`, message.organizationId, uploaderId, message.organizationId, fileId),
    env.DB.prepare(`INSERT INTO audit_events (id, organization_id, action, subject_type, subject_id, reason, after_json)
      VALUES (?, ?, 'onboarding_file_scan_completed', 'file', ?, 'Clean scan result', json_object('scanner', ?, 'signature_at', ?))`)
      .bind(newId(), message.organizationId, fileId, scanner, signatureAt ?? null),
  ]);
}

async function markOnboardingFileRejected(env: AppEnv["Bindings"], message: OnboardingFileScanMessage, uploaderId: string, scanner: string, signatureAt?: string): Promise<void> {
  const fileId = message.onboardingAssetId;
  await env.DB.batch([
    env.DB.prepare(`UPDATE onboarding_assets SET scan_state = 'rejected', scanner_name = ?, scanner_signature_at = ?,
      scanned_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE organization_id = ? AND id = ? AND scan_state = 'pending_scan'`)
      .bind(scanner, signatureAt ?? null, message.organizationId, fileId),
    env.DB.prepare(`UPDATE onboarding_file_scan_jobs SET state = 'rejected', last_error = 'malware_detected',
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE idempotency_key = ? AND state = 'scanning'`)
      .bind(message.idempotencyKey),
    env.DB.prepare(`INSERT OR IGNORE INTO notifications (id, user_id, organization_id, event_key, title, body)
      SELECT ?, ?, ?, ?, 'Onboarding file could not be shared', 'This file did not pass its safety check and remains blocked.'
      WHERE EXISTS (SELECT 1 FROM onboarding_assets WHERE organization_id = ? AND id = ?)`)
      .bind(newId(), uploaderId, message.organizationId, `onboarding-file:${fileId}:rejected:${uploaderId}`, message.organizationId, fileId),
    env.DB.prepare(`INSERT INTO audit_events (id, organization_id, action, subject_type, subject_id, reason, after_json)
      VALUES (?, ?, 'onboarding_file_scan_rejected', 'file', ?, 'Malware detected', json_object('scanner', ?, 'signature_at', ?))`)
      .bind(newId(), message.organizationId, fileId, scanner, signatureAt ?? null),
  ]);
}

async function markOnboardingScanFailure(env: AppEnv["Bindings"], message: OnboardingFileScanMessage, uploaderId: string, reason: string): Promise<void> {
  const fileId = message.onboardingAssetId;
  await env.DB.batch([
    env.DB.prepare(`UPDATE onboarding_assets SET scan_state = 'scan_error', scanner_name = 'unavailable'
      WHERE organization_id = ? AND id = ? AND scan_state = 'pending_scan'`).bind(message.organizationId, fileId),
    env.DB.prepare(`UPDATE onboarding_file_scan_jobs SET state = 'failed', attempts = attempts + 1, last_error = ?,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE idempotency_key = ? AND state IN ('pending', 'queued', 'scanning')`)
      .bind(reason, message.idempotencyKey),
    env.DB.prepare(`INSERT OR IGNORE INTO notifications (id, user_id, organization_id, event_key, title, body)
      SELECT ?, ?, ?, ?, 'Onboarding file could not be checked', 'The file remains unavailable because its safety check did not finish.'
      WHERE EXISTS (SELECT 1 FROM onboarding_assets WHERE organization_id = ? AND id = ?)`)
      .bind(newId(), uploaderId, message.organizationId, `onboarding-file:${fileId}:failed:${uploaderId}`, message.organizationId, fileId),
    env.DB.prepare(`INSERT INTO audit_events (id, organization_id, action, subject_type, subject_id, reason)
      VALUES (?, ?, 'onboarding_file_scan_failed', 'file', ?, ?)`)
      .bind(newId(), message.organizationId, fileId, reason),
  ]);
}
  if (!env.SCANNER) return "retry";
  const claim = await env.DB.prepare(`UPDATE file_scan_jobs SET state = 'scanning', attempts = attempts + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE idempotency_key = ? AND state IN ('pending', 'queued')`)
    .bind(message.idempotencyKey).run();
  if (claim.meta.changes !== 1) return "ack";

  const object = await env.FILES.get(job.object_key);
  if (!object) {
    await markFileScanFailure(env, message, job.uploader_user_id, "object_missing");
    return "ack";
  }
  try {
    const scanner = env.SCANNER.get(env.SCANNER.idFromName("zellink-clamav-scanner"));
    const response = await scanner.fetch("https://scanner.internal/scan", {
      method: "POST",
      headers: { "Content-Length": String(object.size), "Content-Type": "application/octet-stream" },
      body: object.body,
    });
    if (!response.ok) {
      await env.DB.prepare(`UPDATE file_scan_jobs SET state = 'queued', last_error = 'scanner_unavailable',
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE idempotency_key = ? AND state = 'scanning'`)
        .bind(message.idempotencyKey).run();
      return "retry";
    }
    const result = await response.json() as { result?: string; scannerVersion?: string; signatureAt?: string };
    const signatureTime = result.signatureAt ? Date.parse(result.signatureAt) : Number.NaN;
    if (!Number.isFinite(signatureTime) || Date.now() - signatureTime > MAX_SIGNATURE_AGE_MS || signatureTime > Date.now() + 5 * 60 * 1000) {
      await env.DB.prepare(`UPDATE file_scan_jobs SET state = 'queued', last_error = 'scanner_signatures_stale',
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE idempotency_key = ? AND state = 'scanning'`)
        .bind(message.idempotencyKey).run();
      await updateScannerStatus(env, true, "degraded", "Scanner signatures are stale.");
      return "retry";
    }
    if (result.result === "infected") {
      await markFileRejected(env, message, job.uploader_user_id, result.scannerVersion ?? "ClamAV", result.signatureAt);
      return "ack";
    }
    if (result.result !== "clean") {
      await env.DB.prepare(`UPDATE file_scan_jobs SET state = 'queued', last_error = 'scanner_result_invalid',
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE idempotency_key = ? AND state = 'scanning'`)
        .bind(message.idempotencyKey).run();
      return "retry";
    }
    await markFileClean(env, message, job.uploader_user_id, result.scannerVersion ?? "ClamAV", result.signatureAt);
    await updateScannerStatus(env, true, "ready", `Signatures checked at ${result.signatureAt}.`);
    return "ack";
  } catch {
    await env.DB.prepare(`UPDATE file_scan_jobs SET state = 'queued', last_error = 'scanner_request_failed',
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE idempotency_key = ? AND state = 'scanning'`)
      .bind(message.idempotencyKey).run();
    return "retry";
  }
}

async function markFileClean(env: AppEnv["Bindings"], message: RequestFileScanMessage, uploaderId: string, scanner: string, signatureAt?: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`UPDATE file_versions SET scan_state = 'clean', scanner_name = ?, scanner_signature_at = ?, scanned_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE organization_id = ? AND id = ? AND scan_state = 'pending_scan'`).bind(scanner, signatureAt ?? null, message.organizationId, message.fileVersionId),
    env.DB.prepare(`UPDATE file_scan_jobs SET state = 'clean', last_error = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE idempotency_key = ? AND state = 'scanning'`).bind(message.idempotencyKey),
    env.DB.prepare(`INSERT OR IGNORE INTO notifications (id, user_id, organization_id, request_id, event_key, title, body)
      SELECT ?, ?, ?, request_id, ?, 'File is ready for review', 'The uploaded file passed its safety check and is ready for the project manager.'
      FROM file_versions WHERE id = ? AND organization_id = ?`)
      .bind(newId(), uploaderId, message.organizationId, `file:${message.fileVersionId}:clean`, message.fileVersionId, message.organizationId),
    env.DB.prepare(`INSERT INTO audit_events (id, organization_id, action, subject_type, subject_id, reason, after_json)
      VALUES (?, ?, 'file_scan_completed', 'file', ?, 'Clean scan result', json_object('scanner', ?, 'signature_at', ?))`)
      .bind(newId(), message.organizationId, message.fileVersionId, scanner, signatureAt ?? null),
  ]);
}

async function markFileRejected(env: AppEnv["Bindings"], message: RequestFileScanMessage, uploaderId: string, scanner: string, signatureAt?: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`UPDATE file_versions SET scan_state = 'rejected', client_visible = 0, scanner_name = ?, scanner_signature_at = ?, scanned_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE organization_id = ? AND id = ? AND scan_state = 'pending_scan'`).bind(scanner, signatureAt ?? null, message.organizationId, message.fileVersionId),
    env.DB.prepare(`UPDATE file_scan_jobs SET state = 'rejected', last_error = 'malware_detected', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE idempotency_key = ? AND state = 'scanning'`).bind(message.idempotencyKey),
    env.DB.prepare(`INSERT OR IGNORE INTO notifications (id, user_id, organization_id, request_id, event_key, title, body)
      SELECT ?, ?, ?, request_id, ?, 'File could not be shared', 'The uploaded file did not pass its safety check and has been blocked.'
      FROM file_versions WHERE id = ? AND organization_id = ?`)
      .bind(newId(), uploaderId, message.organizationId, `file:${message.fileVersionId}:rejected`, message.fileVersionId, message.organizationId),
    env.DB.prepare(`INSERT INTO audit_events (id, organization_id, action, subject_type, subject_id, reason, after_json)
      VALUES (?, ?, 'file_scan_rejected', 'file', ?, 'Malware detected', json_object('scanner', ?, 'signature_at', ?))`)
      .bind(newId(), message.organizationId, message.fileVersionId, scanner, signatureAt ?? null),
  ]);
}

async function markFileScanFailure(env: AppEnv["Bindings"], message: RequestFileScanMessage, uploaderId: string, reason: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`UPDATE file_versions SET scan_state = 'scan_error', client_visible = 0, scanner_name = 'unavailable'
      WHERE organization_id = ? AND id = ? AND scan_state IN ('pending_upload', 'pending_scan')`)
      .bind(message.organizationId, message.fileVersionId),
    env.DB.prepare(`UPDATE file_scan_jobs SET state = 'failed', attempts = attempts + 1, last_error = ?,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE idempotency_key = ? AND state IN ('pending', 'queued', 'scanning')`)
      .bind(reason, message.idempotencyKey),
    env.DB.prepare(`INSERT OR IGNORE INTO notifications (id, user_id, organization_id, request_id, event_key, title, body)
      SELECT ?, ?, ?, request_id, ?, 'File could not be checked', 'The file remains unavailable because its safety check did not finish.'
      FROM file_versions WHERE id = ? AND organization_id = ?`)
      .bind(newId(), uploaderId, message.organizationId, `file:${message.fileVersionId}:failed`, message.fileVersionId, message.organizationId),
    env.DB.prepare(`INSERT INTO audit_events (id, organization_id, action, subject_type, subject_id, reason)
      VALUES (?, ?, 'file_scan_failed', 'file', ?, ?)`)
      .bind(newId(), message.organizationId, message.fileVersionId, reason),
  ]);
}

async function updateScannerStatus(env: AppEnv["Bindings"], configured: boolean, status: string, detail: string): Promise<void> {
  await env.DB.prepare(`INSERT INTO integration_status (provider_key, configured, status, status_detail, last_checked_at)
    VALUES ('scanner', ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(provider_key) DO UPDATE SET configured = excluded.configured, status = excluded.status,
      status_detail = excluded.status_detail, last_checked_at = excluded.last_checked_at,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
    .bind(configured ? 1 : 0, status, detail).run();
}

async function requestAccessible(env: AppEnv["Bindings"], userId: string, orgId: string, requestId: string, role: OrganizationRole): Promise<boolean> {
  if (role === "admin" || role === "super_admin" || role === "pm" || role === "client_owner" || role === "client_member") {
    return Boolean(await env.DB.prepare(`SELECT 1 FROM requests WHERE organization_id = ? AND id = ? AND deleted_at IS NULL`)
      .bind(orgId, requestId).first());
  }
  return Boolean(await env.DB.prepare(`SELECT 1 FROM specialist_tasks t JOIN task_assignments a
    ON a.organization_id = t.organization_id AND a.task_id = t.id
    WHERE t.organization_id = ? AND t.request_id = ? AND a.specialist_user_id = ? AND a.ended_at IS NULL LIMIT 1`)
    .bind(orgId, requestId, userId).first());
}

export function safeFilename(value: string): string {
  const normalized = value.normalize("NFC").replace(/[\u0000-\u001f\u007f]/gu, "").replace(/[\\/:]/gu, "_").trim();
  return (normalized || "file").slice(0, 255);
}

export function parsePositiveInteger(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function hasExpectedSignature(mediaType: string, bytes: Uint8Array): boolean {
  const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  if (mediaType === "image/jpeg") return starts(0xff, 0xd8, 0xff);
  if (mediaType === "image/png") return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  if (mediaType === "image/gif") return starts(0x47, 0x49, 0x46, 0x38) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61;
  if (mediaType === "image/webp") return starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  if (mediaType === "application/pdf") return starts(0x25, 0x50, 0x44, 0x46, 0x2d);
  if (mediaType.startsWith("application/zip") || mediaType.includes("openxmlformats")) return starts(0x50, 0x4b, 0x03, 0x04);
  if (mediaType === "text/plain" || mediaType === "text/csv") return !bytes.includes(0);
  return false;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
