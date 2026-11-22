import { Hono } from "hono";
import { z } from "zod";
import { organizationRole } from "./authorization";
import { allowedTypes, DEFAULT_MAX_UPLOAD, hasExpectedSignature, parsePositiveInteger, safeFilename, toHex } from "./files";
import { newId } from "./security";
import type { AppEnv } from "./types";

const router = new Hono<AppEnv>();
const objectSchema = z.record(z.string().max(100), z.unknown()).refine((value) => !containsCredentialField(value), {
  message: "Passwords, tokens, and service credentials cannot be stored in onboarding text.",
});
const updateSchema = z.object({
  answers: objectSchema.optional(),
  checklist: z.record(z.string().max(100), z.boolean()).optional(),
  submit: z.boolean().optional().default(false),
});

router.get("/api/orgs/:organizationId/onboarding", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  const organizationId = c.req.param("organizationId");
  const role = await organizationRole(c.env, actor, organizationId);
  if (!role || role === "specialist") return c.json({ error: "not_found" }, 404);
  const row = await c.env.DB.prepare(`SELECT id, status, answers_json, checklist_json, reviewed_by, reviewed_at, updated_at
    FROM onboarding_records WHERE organization_id = ?`).bind(organizationId)
    .first<{ id: string; status: string; answers_json: string; checklist_json: string; reviewed_by: string | null; reviewed_at: string | null; updated_at: string }>();
  if (!row) return c.json({ error: "onboarding_not_found" }, 404);
  const files = await c.env.DB.prepare(`SELECT f.id, f.original_name, f.media_type, f.byte_size, f.scan_state, f.created_at,
      u.display_name AS uploader_name
    FROM onboarding_assets f JOIN app_users u ON u.id = f.uploader_user_id
    WHERE f.organization_id = ? AND f.onboarding_id = ? AND f.deleted_at IS NULL
    ORDER BY f.created_at DESC`).bind(organizationId, row.id).all();
  return c.json({ onboarding: {
    id: row.id,
    status: row.status,
    answers: JSON.parse(row.answers_json) as Record<string, unknown>,
    checklist: JSON.parse(row.checklist_json) as Record<string, boolean>,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    updatedAt: row.updated_at,
    files: files.results,
  } });
});

router.post("/api/orgs/:organizationId/onboarding/files", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  const organizationId = c.req.param("organizationId");
  const role = await organizationRole(c.env, actor, organizationId);
  if (!role || role === "specialist") return c.json({ error: "not_found" }, 404);
  if (role === "client_member") {
    const membership = await c.env.DB.prepare(`SELECT can_submit FROM memberships WHERE organization_id = ? AND user_id = ?`)
      .bind(organizationId, actor.id).first<{ can_submit: number }>();
    if (membership?.can_submit !== 1) return c.json({ error: "request_permission_required" }, 403);
  }
  const onboarding = await c.env.DB.prepare(`SELECT id FROM onboarding_records WHERE organization_id = ?`)
    .bind(organizationId).first<{ id: string }>();
  if (!onboarding) return c.json({ error: "onboarding_not_found" }, 404);
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
  const objectKey = `org/${organizationId}/onboarding/${onboarding.id}/${fileId}`;
  const digest = toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())));
  const filename = safeFilename(file.name);
  try {
    await c.env.FILES.put(objectKey, file.stream(), {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: { organizationId, onboardingId: onboarding.id, fileId },
    });
  } catch {
    return c.json({ error: "upload_storage_unavailable" }, 503);
  }
  const scanJobId = newId();
  const idempotencyKey = newId();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO onboarding_assets
        (id, organization_id, onboarding_id, uploader_user_id, object_key, original_name, media_type, byte_size, sha256, scan_state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_scan')`)
        .bind(fileId, organizationId, onboarding.id, actor.id, objectKey, filename, mediaType, file.size, digest),
      c.env.DB.prepare(`INSERT INTO onboarding_file_scan_jobs (id, organization_id, onboarding_asset_id, idempotency_key, state)
        VALUES (?, ?, ?, ?, 'pending')`).bind(scanJobId, organizationId, fileId, idempotencyKey),
      c.env.DB.prepare(`INSERT INTO audit_events (id, actor_user_id, organization_id, action, subject_type, subject_id, reason, after_json)
        VALUES (?, ?, ?, 'onboarding_file_uploaded', 'file', ?, 'Quarantined for malware scanning', json_object('scan_state', 'pending_scan', 'byte_size', ?))`)
        .bind(newId(), actor.id, organizationId, fileId, file.size),
    ]);
  } catch {
    await c.env.FILES.delete(objectKey).catch(() => undefined);
    return c.json({ error: "file_record_creation_failed" }, 409);
  }
  return c.json({ file: { id: fileId, name: filename, byteSize: file.size, mediaType, scanState: "pending_scan" } }, 201);
});

router.get("/api/orgs/:organizationId/onboarding/files/:fileId/download", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  const organizationId = c.req.param("organizationId");
  const role = await organizationRole(c.env, actor, organizationId);
  if (!role || role === "specialist") return c.json({ error: "not_found" }, 404);
  const file = await c.env.DB.prepare(`SELECT object_key, original_name, byte_size, scan_state
    FROM onboarding_assets WHERE organization_id = ? AND id = ? AND deleted_at IS NULL`)
    .bind(organizationId, c.req.param("fileId"))
    .first<{ object_key: string; original_name: string; byte_size: number; scan_state: string }>();
  if (!file || file.scan_state !== "clean") return c.json({ error: "not_found" }, 404);
  const object = await c.env.FILES.get(file.object_key);
  if (!object) return c.json({ error: "file_not_found" }, 404);
  return new Response(object.body, { status: 200, headers: {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.original_name)}`,
    "Content-Length": String(object.size),
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox",
  } });
});

router.put("/api/orgs/:organizationId/onboarding", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  const organizationId = c.req.param("organizationId");
  const role = await organizationRole(c.env, actor, organizationId);
  if (!role) return c.json({ error: "not_found" }, 404);
  const parsed = updateSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return c.json({ error: "invalid_onboarding", details: parsed.error.flatten() }, 400);
  const current = await c.env.DB.prepare(`SELECT answers_json, checklist_json, status FROM onboarding_records WHERE organization_id = ?`)
    .bind(organizationId).first<{ answers_json: string; checklist_json: string; status: string }>();
  if (!current) return c.json({ error: "onboarding_not_found" }, 404);

  const clientRole = role === "client_owner" || role === "client_member";
  if (clientRole && parsed.data.checklist) return c.json({ error: "checklist_is_pm_managed" }, 403);
  if (role === "specialist") return c.json({ error: "forbidden" }, 403);
  if (clientRole && role === "client_member") {
    const membership = await c.env.DB.prepare(`SELECT can_submit FROM memberships WHERE organization_id = ? AND user_id = ?`)
      .bind(organizationId, actor.id).first<{ can_submit: number }>();
    if (membership?.can_submit !== 1) return c.json({ error: "request_permission_required" }, 403);
  }

  const answers = parsed.data.answers ?? JSON.parse(current.answers_json) as Record<string, unknown>;
  const checklist = parsed.data.checklist ?? JSON.parse(current.checklist_json) as Record<string, boolean>;
  const status = clientRole && parsed.data.submit ? "submitted" :
    clientRole && parsed.data.answers !== undefined ? "in_progress" :
    role === "pm" && parsed.data.checklist ? "pm_review" :
    current.status === "not_started" ? "in_progress" : current.status;
  const submittedAt = parsed.data.submit && clientRole;
  const reviewedByPm = role === "pm" && Boolean(parsed.data.checklist);
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE onboarding_records SET answers_json = ?, checklist_json = ?, status = ?,
      reviewed_by = CASE WHEN ? THEN ? ELSE NULL END,
      reviewed_at = CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE NULL END,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE organization_id = ?`)
      .bind(JSON.stringify(answers), JSON.stringify(checklist), status, reviewedByPm ? 1 : 0, actor.id,
        reviewedByPm ? 1 : 0, organizationId),
    c.env.DB.prepare(`INSERT INTO audit_events (id, actor_user_id, organization_id, action, subject_type, subject_id, reason, client_visible)
      SELECT ?, ?, ?, 'onboarding_updated', 'onboarding', id, ?, ? FROM onboarding_records WHERE organization_id = ?`)
      .bind(newId(), actor.id, organizationId, submittedAt ? "Client submitted onboarding details" : "Onboarding details updated", submittedAt ? 1 : 0, organizationId),
  ]);
  return c.json({ onboarding: { status, answers, checklist } });
});

router.post("/api/orgs/:organizationId/onboarding/complete", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  const organizationId = c.req.param("organizationId");
  const role = await organizationRole(c.env, actor, organizationId);
  if (!role) return c.json({ error: "not_found" }, 404);
  if (!(role === "pm" || role === "admin" || role === "super_admin")) return c.json({ error: "forbidden" }, 403);

  const record = await c.env.DB.prepare(`SELECT status, checklist_json FROM onboarding_records WHERE organization_id = ?`)
    .bind(organizationId).first<{ status: string; checklist_json: string }>();
  if (!record) return c.json({ error: "onboarding_not_found" }, 404);
  if (record.status === "complete") return c.json({ onboarding: { status: "complete", organizationId } });
  const checklist = JSON.parse(record.checklist_json) as Record<string, boolean>;
  const incompleteItems = Object.entries(checklist).filter(([, complete]) => !complete).map(([key]) => key);
  if (record.status !== "pm_review" || Object.keys(checklist).length === 0 || incompleteItems.length > 0) {
    return c.json({ error: "onboarding_checklist_incomplete", incompleteItems }, 409);
  }

  const completed = await c.env.DB.prepare(`UPDATE onboarding_records SET status = 'complete', reviewed_by = ?,
    reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE organization_id = ? AND status = 'pm_review' AND checklist_json = ?`)
    .bind(actor.id, organizationId, record.checklist_json).run();
  if (completed.meta.changes !== 1) return c.json({ error: "onboarding_changed_or_stale" }, 409);

  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE organizations SET status = 'active' WHERE id = ? AND status = 'onboarding'`)
      .bind(organizationId),
    c.env.DB.prepare(`INSERT INTO audit_events (id, actor_user_id, organization_id, action, subject_type, subject_id, reason, client_visible)
      SELECT ?, ?, ?, 'onboarding_completed', 'organization', ?, 'Project manager completed the reviewed onboarding checklist', 1
      WHERE EXISTS (SELECT 1 FROM onboarding_records WHERE organization_id = ? AND status = 'complete' AND reviewed_by = ?)`)
      .bind(newId(), actor.id, organizationId, organizationId, organizationId, actor.id),
    c.env.DB.prepare(`INSERT OR IGNORE INTO notifications (id, user_id, organization_id, event_key, title, body)
      SELECT ?, m.user_id, ?, 'onboarding:complete', 'Onboarding complete', 'Your project manager has completed the onboarding checklist.'
      FROM memberships m WHERE m.organization_id = ? AND m.user_id <> ?`)
      .bind(newId(), organizationId, organizationId, actor.id),
  ]);
  return c.json({ onboarding: { status: "complete", organizationId } });
});

export function routeOnboarding(app: Hono<AppEnv>): void {
  app.route("/", router);
}

function containsCredentialField(value: unknown, depth = 0): boolean {
  if (depth > 5) return true;
  if (Array.isArray(value)) return value.some((item) => containsCredentialField(item, depth + 1));
  if (typeof value !== "object" || value === null) return false;
  for (const [key, item] of Object.entries(value)) {
    if (/(?:password|secret|token|api[_-]?key|private[_-]?key|credential)/iu.test(key)) return true;
    if (containsCredentialField(item, depth + 1)) return true;
  }
  return false;
}
