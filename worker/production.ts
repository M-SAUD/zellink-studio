import { Hono } from "hono";
import { z } from "zod";
import { canClientApprove, organizationRole, type OrganizationRole } from "./authorization";
import { newId } from "./security";
import type { AppEnv } from "./types";

const router = new Hono<AppEnv>();
const briefSchema = z.object({ content: z.string().trim().min(20).max(30000) });
const decisionSchema = z.object({
  decision: z.enum(["approved", "revision_requested"]),
  note: z.string().trim().max(3000).optional().default(""),
  expectedRequestVersion: z.number().int().positive().optional(),
});
const taskCreateSchema = z.object({
  title: z.string().trim().min(3).max(180),
  internalScope: z.string().trim().max(10000).optional().default(""),
  specialistIds: z.array(z.string().uuid()).min(1).max(20),
});
const assignmentSchema = z.object({ specialistUserId: z.string().uuid(), reason: z.string().trim().min(3).max(500) });
const taskUpdateSchema = z.object({
  status: z.enum(["assigned", "in_progress", "submitted", "pm_review", "complete", "blocked"]).transform((value) => {
    const mapped: Record<string, string> = { submitted: "internal_review", pm_review: "internal_review", complete: "done" };
    return mapped[value] ?? value;
  }),
  blockReason: z.string().trim().max(2000).optional().default(""),
});

router.get("/api/orgs/:organizationId/specialists", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  const organizationId = c.req.param("organizationId");
  const role = await organizationRole(c.env, actor, organizationId);
  if (!role) return c.json({ error: "not_found" }, 404);
  if (!(role === "pm" || role === "admin" || role === "super_admin")) return c.json({ error: "forbidden" }, 403);
  const specialists = await c.env.DB.prepare(`SELECT id, display_name FROM app_users
    WHERE global_role = 'specialist' AND disabled_at IS NULL ORDER BY display_name`).all();
  return c.json({ specialists: specialists.results });
});

router.get("/api/orgs/:organizationId/requests/:requestId/briefs", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  const organizationId = c.req.param("organizationId");
  const requestId = c.req.param("requestId");
  const role = await organizationRole(c.env, actor, organizationId);
  if (!role || !(await requestAccessible(c.env, actor.id, organizationId, requestId, role))) return c.json({ error: "not_found" }, 404);
  const client = role === "client_owner" || role === "client_member";
  const rows = await c.env.DB.prepare(`SELECT b.id, b.version_number, b.content, b.is_first_brief, b.created_at,
      u.display_name AS created_by_name, a.id AS approval_id, a.state AS approval_state, a.decision_note
    FROM brief_versions b JOIN app_users u ON u.id = b.created_by
    LEFT JOIN approvals a ON a.organization_id = b.organization_id AND a.request_id = b.request_id
      AND a.brief_version_id = b.id AND a.approval_kind = 'first_brief'
    JOIN requests r ON r.organization_id = b.organization_id AND r.id = b.request_id
    WHERE b.organization_id = ? AND b.request_id = ? ${client ? "AND (b.is_first_brief = 1 OR r.status IN ('client_review', 'revision_requested', 'approved', 'delivered'))" : ""}
    ORDER BY b.version_number DESC`).bind(organizationId, requestId).all();
  return c.json({ briefs: rows.results });
});

router.get("/api/orgs/:organizationId/requests/:requestId/approvals", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  const organizationId = c.req.param("organizationId");
  const requestId = c.req.param("requestId");
  const role = await organizationRole(c.env, actor, organizationId);
  if (!role || !(await requestAccessible(c.env, actor.id, organizationId, requestId, role))) return c.json({ error: "not_found" }, 404);
  const result = await c.env.DB.prepare(`SELECT a.id, a.approval_kind, a.state, a.decision_note, a.submitted_version,
      r.status, r.version
    FROM approvals a JOIN requests r ON r.organization_id = a.organization_id AND r.id = a.request_id
    WHERE a.organization_id = ? AND a.request_id = ? AND r.deleted_at IS NULL
    ORDER BY a.created_at DESC`).bind(organizationId, requestId).all();
  return c.json({ approvals: result.results });
});

router.post("/api/orgs/:organizationId/requests/:requestId/briefs", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  const organizationId = c.req.param("organizationId");
  const requestId = c.req.param("requestId");
  const role = await organizationRole(c.env, actor, organizationId);
  if (!role || !(role === "pm" || role === "admin" || role === "super_admin")) return c.json({ error: "forbidden" }, 403);
  if (!(await requestAccessible(c.env, actor.id, organizationId, requestId, role))) return c.json({ error: "not_found" }, 404);
  const parsed = briefSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return c.json({ error: "invalid_brief", details: parsed.error.flatten() }, 400);
  const status = await c.env.DB.prepare(`SELECT status, version FROM requests WHERE organization_id = ? AND id = ? AND deleted_at IS NULL`)
    .bind(organizationId, requestId).first<{ status: string; version: number }>();
  if (!status) return c.json({ error: "not_found" }, 404);
  if (!["pm_review", "revision_requested"].includes(status.status)) return c.json({ error: "brief_not_allowed_in_current_state" }, 409);
  const prior = await c.env.DB.prepare(`SELECT COALESCE(MAX(version_number), 0) AS version FROM brief_versions
    WHERE organization_id = ? AND request_id = ?`).bind(organizationId, requestId).first<{ version: number }>();
  const latestFirstBriefDecision = await c.env.DB.prepare(`SELECT a.state FROM approvals a
    JOIN brief_versions b ON b.organization_id = a.organization_id AND b.id = a.brief_version_id
    WHERE a.organization_id = ? AND a.request_id = ? AND a.approval_kind = 'first_brief'
    ORDER BY b.version_number DESC LIMIT 1`).bind(organizationId, requestId).first<{ state: string }>();
  const firstBrief = (prior?.version ?? 0) === 0 || (status.status === "revision_requested" && latestFirstBriefDecision?.state === "revision_requested");
  if (!firstBrief || !(status.status === "pm_review" || status.status === "revision_requested")) {
    return c.json({ error: "brief_not_allowed_in_current_state" }, 409);
  }
  const briefId = newId();
  const approvalId = newId();
  const statements = [c.env.DB.prepare(`INSERT INTO brief_versions (id, organization_id, request_id, version_number, content, is_first_brief, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(briefId, organizationId, requestId, (prior?.version ?? 0) + 1, parsed.data.content, firstBrief ? 1 : 0, actor.id)];
  if (firstBrief) {
    statements.push(c.env.DB.prepare(`INSERT INTO approvals (id, organization_id, request_id, brief_version_id, approval_kind, state, submitted_version)
      VALUES (?, ?, ?, ?, 'first_brief', 'pending', ?)`)
      .bind(approvalId, organizationId, requestId, briefId, status.version + 1));
    statements.push(c.env.DB.prepare(`UPDATE requests SET status = 'brief_ready', version = version + 1, updated_by = ?,
      last_transition_role = ?, last_transition_reason = 'First brief prepared', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE organization_id = ? AND id = ? AND status = ? AND version = ?`)
      .bind(actor.id, role, organizationId, requestId, status.status, status.version));
  }
  statements.push(c.env.DB.prepare(`INSERT INTO audit_events (id, actor_user_id, organization_id, action, subject_type, subject_id, reason, after_json, request_id)
    VALUES (?, ?, ?, 'brief_version_created', 'brief', ?, ?, json_object('version_number', ?, 'first_brief', ?), ?)`)
    .bind(newId(), actor.id, organizationId, briefId, firstBrief ? "First brief prepared for client approval" : "Brief version prepared", (prior?.version ?? 0) + 1, firstBrief ? 1 : 0, requestId));
  try {
    await c.env.DB.batch(statements);
  } catch (error) {
    if (String(error).includes("workflow_transition_not_configured")) return c.json({ error: "transition_not_configured" }, 409);
    return c.json({ error: "brief_creation_conflict" }, 409);
  }
  return c.json({ brief: { id: briefId, versionNumber: (prior?.version ?? 0) + 1, content: parsed.data.content, firstBrief,
    approvalId: firstBrief ? approvalId : null } }, 201);
});

router.post("/api/orgs/:organizationId/requests/:requestId/submit-deliverable", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  const organizationId = c.req.param("organizationId");
  const requestId = c.req.param("requestId");
  const role = await organizationRole(c.env, actor, organizationId);
  if (!role || !(role === "pm" || role === "admin" || role === "super_admin")) return c.json({ error: "forbidden" }, 403);
  if (!(await requestAccessible(c.env, actor.id, organizationId, requestId, role))) return c.json({ error: "not_found" }, 404);
  const current = await c.env.DB.prepare(`SELECT status, version FROM requests WHERE organization_id = ? AND id = ? AND deleted_at IS NULL`)
    .bind(organizationId, requestId).first<{ status: string; version: number }>();
  if (!current) return c.json({ error: "not_found" }, 404);
  if (current.status !== "internal_review" || !(await hasCleanClientFile(c.env, organizationId, requestId))) {
    return c.json({ error: "deliverable_requires_internal_review_and_clean_file" }, 409);
  }
  const approvalId = newId();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO approvals (id, organization_id, request_id, approval_kind, state, submitted_version)
        VALUES (?, ?, ?, 'deliverable', 'pending', ?)`)
        .bind(approvalId, organizationId, requestId, current.version + 1),
      c.env.DB.prepare(`UPDATE requests SET status = 'client_review', version = version + 1, updated_by = ?,
        last_transition_role = ?, last_transition_reason = 'Deliverable submitted for client review',
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE organization_id = ? AND id = ? AND status = 'internal_review' AND version = ?`)
        .bind(actor.id, role, organizationId, requestId, current.version),
      c.env.DB.prepare(`INSERT INTO audit_events (id, actor_user_id, organization_id, action, subject_type, subject_id, reason, request_id)
        VALUES (?, ?, ?, 'deliverable_submitted', 'request', ?, 'Submitted for client review', ?)`)
        .bind(newId(), actor.id, organizationId, requestId, requestId),
    ]);
  } catch (error) {
    if (String(error).includes("workflow_transition_not_configured")) return c.json({ error: "transition_not_configured" }, 409);
    return c.json({ error: "deliverable_submission_conflict" }, 409);
  }
  return c.json({ approval: { id: approvalId, state: "pending", kind: "deliverable" } }, 201);
});

router.post("/api/orgs/:organizationId/requests/:requestId/approvals/:approvalId/decision", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  const organizationId = c.req.param("organizationId");
  const requestId = c.req.param("requestId");
  const approvalId = c.req.param("approvalId");
  const role = await organizationRole(c.env, actor, organizationId);
  if (!role || !(role === "client_owner" || role === "client_member")) return c.json({ error: "forbidden" }, 403);
  if (!(await canClientApprove(c.env, actor, organizationId))) return c.json({ error: "approval_permission_required" }, 403);
  const parsed = decisionSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return c.json({ error: "invalid_approval", details: parsed.error.flatten() }, 400);
  const approval = await c.env.DB.prepare(`SELECT a.state, a.approval_kind, a.submitted_version, r.status, r.version
    FROM approvals a JOIN requests r ON r.organization_id = a.organization_id AND r.id = a.request_id
    WHERE a.organization_id = ? AND a.request_id = ? AND a.id = ? AND r.deleted_at IS NULL`)
    .bind(organizationId, requestId, approvalId).first<{ state: string; approval_kind: string; submitted_version: number; status: string; version: number }>();
  if (!approval) return c.json({ error: "not_found" }, 404);
  if (approval.state !== "pending") return c.json({ error: "approval_already_decided" }, 409);
  if (parsed.data.expectedRequestVersion !== undefined && parsed.data.expectedRequestVersion !== approval.version) {
    return c.json({ error: "request_changed_or_stale" }, 409);
  }
  if (approval.submitted_version !== approval.version) return c.json({ error: "approval_version_stale" }, 409);

  const changesRequestState = approval.approval_kind === "deliverable" ||
    (approval.approval_kind === "first_brief" && parsed.data.decision === "revision_requested");
  let nextStatus: string | null = null;
  if (approval.approval_kind === "first_brief" && approval.status !== "brief_ready") return c.json({ error: "brief_not_reviewable" }, 409);
  if (changesRequestState) {
    if (approval.approval_kind === "deliverable" && approval.status !== "client_review") return c.json({ error: "deliverable_not_reviewable" }, 409);
    nextStatus = parsed.data.decision === "approved" ? "approved" : "revision_requested";
    const allowed = await c.env.DB.prepare(`SELECT 1 FROM workflow_transitions WHERE organization_id = ?
      AND from_status = ? AND to_status = ? AND actor_role = ? AND enabled = 1`)
      .bind(organizationId, approval.status, nextStatus, role).first();
    if (!allowed) return c.json({ error: "transition_not_configured" }, 409);
  }

  const statements = [c.env.DB.prepare(`UPDATE approvals SET state = ?, decided_by = ?, decision_note = ?,
      decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE organization_id = ? AND request_id = ? AND id = ? AND state = 'pending'`)
    .bind(parsed.data.decision, actor.id, parsed.data.note || null, organizationId, requestId, approvalId)];
  if (nextStatus) {
    statements.push(c.env.DB.prepare(`UPDATE requests SET status = ?, version = version + 1, updated_by = ?,
      last_transition_role = ?, last_transition_reason = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE organization_id = ? AND id = ? AND status = ? AND version = ?`)
      .bind(nextStatus, actor.id, role, parsed.data.note || null, organizationId, requestId, approval.status, approval.version));
  }
  statements.push(c.env.DB.prepare(`INSERT INTO audit_events (id, actor_user_id, organization_id, action, subject_type, subject_id, reason, after_json, client_visible, request_id)
    VALUES (?, ?, ?, 'approval_decided', 'approval', ?, ?, json_object('state', ?), 1, ?)`)
    .bind(newId(), actor.id, organizationId, approvalId, parsed.data.note || "Approval decision recorded", parsed.data.decision, requestId));
  try {
    await c.env.DB.batch(statements);
  } catch (error) {
    if (String(error).includes("workflow_transition_not_configured")) return c.json({ error: "transition_not_configured" }, 409);
    return c.json({ error: "approval_conflict" }, 409);
  }
  return c.json({ approval: { id: approvalId, state: parsed.data.decision, decidedBy: actor.id }, requestStatus: nextStatus ?? approval.status });
});

router.get("/api/tasks", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  let rows;
  if (actor.globalRole === "specialist") {
    rows = await c.env.DB.prepare(`SELECT t.id, t.organization_id, o.name AS organization_name, t.request_id,
      r.title AS request_title, r.summary AS request_summary, r.objective,
      (SELECT b.content FROM brief_versions b JOIN approvals a
        ON a.organization_id = b.organization_id AND a.request_id = b.request_id AND a.brief_version_id = b.id
        WHERE b.organization_id = t.organization_id AND b.request_id = t.request_id
          AND b.is_first_brief = 1 AND a.approval_kind = 'first_brief' AND a.state = 'approved'
        ORDER BY b.version_number DESC LIMIT 1) AS approved_brief,
      (SELECT a.decision_note FROM approvals a WHERE a.organization_id = t.organization_id AND a.request_id = t.request_id
        AND a.approval_kind = 'deliverable' AND a.state = 'revision_requested' AND a.decision_note IS NOT NULL
        ORDER BY a.decided_at DESC LIMIT 1) AS latest_feedback,
      t.title, t.internal_scope, t.status, t.block_reason, t.updated_at
      FROM specialist_tasks t JOIN task_assignments a ON a.organization_id = t.organization_id AND a.task_id = t.id
      JOIN requests r ON r.organization_id = t.organization_id AND r.id = t.request_id
      JOIN organizations o ON o.id = t.organization_id
      WHERE a.specialist_user_id = ? AND a.ended_at IS NULL ORDER BY t.updated_at DESC`)
      .bind(actor.id).all();
  } else if (actor.globalRole === "pm") {
    rows = await c.env.DB.prepare(`SELECT t.id, t.organization_id, o.name AS organization_name, t.request_id,
      r.title AS request_title, r.summary AS request_summary, r.objective,
      (SELECT b.content FROM brief_versions b JOIN approvals a
        ON a.organization_id = b.organization_id AND a.request_id = b.request_id AND a.brief_version_id = b.id
        WHERE b.organization_id = t.organization_id AND b.request_id = t.request_id
          AND b.is_first_brief = 1 AND a.approval_kind = 'first_brief' AND a.state = 'approved'
        ORDER BY b.version_number DESC LIMIT 1) AS approved_brief,
      (SELECT a.decision_note FROM approvals a WHERE a.organization_id = t.organization_id AND a.request_id = t.request_id
        AND a.approval_kind = 'deliverable' AND a.state = 'revision_requested' AND a.decision_note IS NOT NULL
        ORDER BY a.decided_at DESC LIMIT 1) AS latest_feedback,
      t.title, t.internal_scope, t.status, t.block_reason, t.updated_at
      FROM specialist_tasks t JOIN pm_assignments p ON p.organization_id = t.organization_id AND p.pm_user_id = ? AND p.ends_at IS NULL
      JOIN requests r ON r.organization_id = t.organization_id AND r.id = t.request_id
      JOIN organizations o ON o.id = t.organization_id ORDER BY t.updated_at DESC`).bind(actor.id).all();
  } else if (actor.globalRole === "admin" || actor.globalRole === "super_admin") {
    rows = await c.env.DB.prepare(`SELECT t.id, t.organization_id, o.name AS organization_name, t.request_id,
      r.title AS request_title, r.summary AS request_summary, r.objective,
      (SELECT b.content FROM brief_versions b JOIN approvals a
        ON a.organization_id = b.organization_id AND a.request_id = b.request_id AND a.brief_version_id = b.id
        WHERE b.organization_id = t.organization_id AND b.request_id = t.request_id
          AND b.is_first_brief = 1 AND a.approval_kind = 'first_brief' AND a.state = 'approved'
        ORDER BY b.version_number DESC LIMIT 1) AS approved_brief,
      (SELECT a.decision_note FROM approvals a WHERE a.organization_id = t.organization_id AND a.request_id = t.request_id
        AND a.approval_kind = 'deliverable' AND a.state = 'revision_requested' AND a.decision_note IS NOT NULL
        ORDER BY a.decided_at DESC LIMIT 1) AS latest_feedback,
      t.title, t.internal_scope, t.status, t.block_reason, t.updated_at
      FROM specialist_tasks t JOIN requests r ON r.organization_id = t.organization_id AND r.id = t.request_id
      JOIN organizations o ON o.id = t.organization_id ORDER BY t.updated_at DESC`).all();
  } else {
    return c.json({ error: "forbidden" }, 403);
  }
  return c.json({ tasks: rows.results });
});

router.post("/api/orgs/:organizationId/requests/:requestId/tasks", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  const organizationId = c.req.param("organizationId");
  const requestId = c.req.param("requestId");
  const role = await organizationRole(c.env, actor, organizationId);
  if (!role || !(role === "pm" || role === "admin" || role === "super_admin")) return c.json({ error: "forbidden" }, 403);
  if (!(await requestAccessible(c.env, actor.id, organizationId, requestId, role))) return c.json({ error: "not_found" }, 404);
  const parsed = taskCreateSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return c.json({ error: "invalid_task", details: parsed.error.flatten() }, 400);
  const eligible = await c.env.DB.prepare(`SELECT COUNT(*) AS count FROM app_users WHERE global_role = 'specialist' AND disabled_at IS NULL
    AND id IN (${parsed.data.specialistIds.map(() => "?").join(",")})`).bind(...parsed.data.specialistIds).first<{ count: number }>();
  if (eligible?.count !== parsed.data.specialistIds.length) return c.json({ error: "specialist_not_found" }, 400);
  const taskId = newId();
  const statements = [
    c.env.DB.prepare(`INSERT INTO specialist_tasks (id, organization_id, request_id, title, internal_scope, status, created_by)
      VALUES (?, ?, ?, ?, ?, 'assigned', ?)`)
      .bind(taskId, organizationId, requestId, parsed.data.title, parsed.data.internalScope, actor.id),
    ...parsed.data.specialistIds.map((specialistId) => c.env.DB.prepare(`INSERT INTO task_assignments
      (id, organization_id, task_id, specialist_user_id, assigned_by, reason) VALUES (?, ?, ?, ?, ?, 'Assigned by project manager')`)
      .bind(newId(), organizationId, taskId, specialistId, actor.id)),
    c.env.DB.prepare(`INSERT INTO audit_events (id, actor_user_id, organization_id, action, subject_type, subject_id, reason, after_json, request_id)
      VALUES (?, ?, ?, 'specialist_task_created', 'task', ?, 'Specialist assignment created', json_object('assignee_ids', ?), ?)`)
      .bind(newId(), actor.id, organizationId, taskId, JSON.stringify(parsed.data.specialistIds), requestId),
  ];
  await c.env.DB.batch(statements);
  return c.json({ task: { id: taskId, organizationId, requestId, title: parsed.data.title, status: "assigned", specialistIds: parsed.data.specialistIds } }, 201);
});

router.post("/api/orgs/:organizationId/tasks/:taskId/assignments", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  const organizationId = c.req.param("organizationId");
  const taskId = c.req.param("taskId");
  const role = await organizationRole(c.env, actor, organizationId);
  if (!role || !(role === "pm" || role === "admin" || role === "super_admin")) return c.json({ error: "forbidden" }, 403);
  const parsed = assignmentSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return c.json({ error: "invalid_assignment", details: parsed.error.flatten() }, 400);
  const specialist = await c.env.DB.prepare(`SELECT id FROM app_users WHERE id = ? AND global_role = 'specialist' AND disabled_at IS NULL`)
    .bind(parsed.data.specialistUserId).first();
  if (!specialist) return c.json({ error: "specialist_not_found" }, 400);
  const task = await c.env.DB.prepare(`SELECT id, request_id FROM specialist_tasks WHERE organization_id = ? AND id = ?`)
    .bind(organizationId, taskId).first<{ id: string; request_id: string }>();
  if (!task) return c.json({ error: "not_found" }, 404);
  const assignmentId = newId();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE task_assignments SET ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE organization_id = ? AND task_id = ? AND specialist_user_id = ? AND ended_at IS NULL`)
        .bind(organizationId, taskId, parsed.data.specialistUserId),
      c.env.DB.prepare(`INSERT INTO task_assignments (id, organization_id, task_id, specialist_user_id, assigned_by, reason)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(assignmentId, organizationId, taskId, parsed.data.specialistUserId, actor.id, parsed.data.reason),
      c.env.DB.prepare(`INSERT INTO audit_events (id, actor_user_id, organization_id, action, subject_type, subject_id, reason, after_json, request_id)
        VALUES (?, ?, ?, 'specialist_assigned', 'task', ?, ?, json_object('specialist_user_id', ?), ?)`)
        .bind(newId(), actor.id, organizationId, taskId, parsed.data.reason, parsed.data.specialistUserId, task.request_id),
    ]);
  } catch {
    return c.json({ error: "assignment_conflict" }, 409);
  }
  return c.json({ assignment: { id: assignmentId, taskId, specialistUserId: parsed.data.specialistUserId } }, 201);
});

router.patch("/api/orgs/:organizationId/tasks/:taskId", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  const organizationId = c.req.param("organizationId");
  const taskId = c.req.param("taskId");
  const role = await organizationRole(c.env, actor, organizationId);
  if (!role) return c.json({ error: "not_found" }, 404);
  const parsed = taskUpdateSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return c.json({ error: "invalid_task_status", details: parsed.error.flatten() }, 400);
  const task = await c.env.DB.prepare(`SELECT t.request_id, t.status FROM specialist_tasks t WHERE t.organization_id = ? AND t.id = ?`)
    .bind(organizationId, taskId).first<{ request_id: string; status: string }>();
  if (!task) return c.json({ error: "not_found" }, 404);
  const assigned = role === "specialist" && Boolean(await c.env.DB.prepare(`SELECT 1 FROM task_assignments WHERE organization_id = ?
    AND task_id = ? AND specialist_user_id = ? AND ended_at IS NULL`).bind(organizationId, taskId, actor.id).first());
  if (role === "specialist" && !assigned) return c.json({ error: "not_found" }, 404);
  if (!(role === "specialist" || role === "pm" || role === "admin" || role === "super_admin")) return c.json({ error: "forbidden" }, 403);
  if (parsed.data.status === "blocked" && !parsed.data.blockReason) return c.json({ error: "block_reason_required" }, 400);

  const statements = [
    c.env.DB.prepare(`UPDATE specialist_tasks SET status = ?, block_reason = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE organization_id = ? AND id = ?`)
      .bind(parsed.data.status, parsed.data.status === "blocked" ? parsed.data.blockReason : null, organizationId, taskId),
    c.env.DB.prepare(`INSERT INTO audit_events (id, actor_user_id, organization_id, action, subject_type, subject_id, reason, before_json, after_json, request_id)
      VALUES (?, ?, ?, 'specialist_task_status_changed', 'task', ?, ?, json_object('status', ?), json_object('status', ?), ?)`)
      .bind(newId(), actor.id, organizationId, taskId, parsed.data.blockReason || `Task moved to ${parsed.data.status}`,
        task.status, parsed.data.status, task.request_id),
  ];
  if (parsed.data.status === "internal_review" && task.status !== "internal_review") {
    statements.push(c.env.DB.prepare(`UPDATE requests SET status = 'internal_review', version = version + 1, updated_by = ?,
      last_transition_role = ?, last_transition_reason = 'Specialist submitted work for PM review',
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE organization_id = ? AND id = ? AND status = 'in_progress'`)
      .bind(actor.id, role, organizationId, task.request_id));
  }
  try {
    await c.env.DB.batch(statements);
  } catch (error) {
    if (String(error).includes("workflow_transition_not_configured")) return c.json({ error: "transition_not_configured" }, 409);
    return c.json({ error: "task_update_conflict" }, 409);
  }
  return c.json({ task: { id: taskId, status: parsed.data.status, blockReason: parsed.data.status === "blocked" ? parsed.data.blockReason : null } });
});

export function routeProduction(app: Hono<AppEnv>): void {
  app.route("/", router);
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

async function hasCleanClientFile(env: AppEnv["Bindings"], orgId: string, requestId: string): Promise<boolean> {
  return Boolean(await env.DB.prepare(`SELECT 1 FROM file_versions WHERE organization_id = ? AND request_id = ?
    AND scan_state = 'clean' AND client_visible = 1 AND deleted_at IS NULL LIMIT 1`)
    .bind(orgId, requestId).first());
}
