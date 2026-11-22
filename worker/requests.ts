import { Hono, type Context } from "hono";
import { z } from "zod";
import { canClientApprove, canAccessOrganization, organizationRole, type OrganizationRole } from "./authorization";
import { newId } from "./security";
import type { Actor, AppEnv } from "./types";

const router = new Hono<AppEnv>();
const requestStatus = z.enum([
  "draft", "submitted", "pm_review", "needs_client_info", "brief_ready", "queued", "in_progress",
  "internal_review", "client_review", "revision_requested", "approved", "delivered", "waiting_on_client", "on_hold", "cancelled",
]);
const priority = z.enum(["low", "normal", "high"]);
const createRequestSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().trim().min(3).max(180),
  summary: z.string().trim().max(10000).optional().default(""),
  objective: z.string().trim().max(4000).optional().default(""),
  serviceType: z.string().trim().max(120).optional().default(""),
  priority: priority.default("normal"),
  desiredTiming: z.string().trim().max(500).optional().default(""),
  references: z.array(z.string().trim().url().max(1000)).max(15).default([]),
  submit: z.boolean().default(true),
});
const transitionSchema = z.object({
  toStatus: requestStatus,
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().max(1000).optional().default(""),
});
const commentSchema = z.object({
  body: z.string().trim().min(1).max(10000),
  visibility: z.enum(["client", "internal"]).default("client"),
});
const reorderSchema = z.object({
  requestIds: z.array(z.string().uuid()).min(1).refine((ids) => new Set(ids).size === ids.length, "Queue IDs must be unique."),
});
const allocateSchema = z.object({ expectedVersion: z.number().int().positive() });
const releaseSchema = z.object({ reason: z.string().trim().min(3).max(500) });

interface RequestRow {
  id: string;
  organization_id: string;
  project_id: string;
  project_name: string;
  title: string;
  summary: string;
  objective: string;
  service_type: string | null;
  status: z.infer<typeof requestStatus>;
  version: number;
  priority: z.infer<typeof priority>;
  desired_timing: string | null;
  references_json: string;
  queue_position: number;
  created_by: string;
  created_by_name: string;
  created_at: string;
  updated_at: string;
  lane_number: number | null;
  active_task_count: number;
}

router.get("/api/orgs/:organizationId/requests", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  const organizationId = c.req.param("organizationId");
  const role = await organizationRole(c.env, actor, organizationId);
  if (!role) return c.json({ error: "not_found" }, 404);
  const scope = await requestScopeClause(actor, role);
  const rows = await c.env.DB.prepare(`
    SELECT r.id, r.organization_id, r.project_id, p.name AS project_name, r.title, r.summary, r.objective, r.service_type,
      r.status, r.version, r.priority, r.desired_timing, r.references_json, r.queue_position, r.created_by,
      creator.display_name AS created_by_name, r.created_at, r.updated_at,
      a.lane_number, (SELECT COUNT(*) FROM specialist_tasks t WHERE t.organization_id = r.organization_id
        AND t.request_id = r.id AND t.status <> 'done') AS active_task_count
    FROM requests r
    JOIN projects p ON p.organization_id = r.organization_id AND p.id = r.project_id
    JOIN app_users creator ON creator.id = r.created_by
    LEFT JOIN lane_allocations a ON a.organization_id = r.organization_id AND a.request_id = r.id AND a.released_at IS NULL
    WHERE r.organization_id = ? AND r.deleted_at IS NULL ${scope.sql}
    ORDER BY CASE WHEN r.status = 'queued' THEN 0 ELSE 1 END, r.queue_position, r.updated_at DESC
  `).bind(organizationId, ...scope.params).all<RequestRow>();
  const clientView = role === "client_owner" || role === "client_member";
  return c.json({ requests: rows.results.map((row) => shapeRequest(row, clientView)) });
});

router.post("/api/orgs/:organizationId/requests", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  const organizationId = c.req.param("organizationId");
  const role = await organizationRole(c.env, actor, organizationId);
  if (!role) return c.json({ error: "not_found" }, 404);
  if (!["admin", "super_admin", "pm", "client_owner", "client_member"].includes(role)) return c.json({ error: "forbidden" }, 403);
  if (role === "client_member") {
    const permission = await c.env.DB.prepare(`SELECT can_submit FROM memberships WHERE organization_id = ? AND user_id = ?`)
      .bind(organizationId, actor.id).first<{ can_submit: number }>();
    if (permission?.can_submit !== 1) return c.json({ error: "request_permission_required" }, 403);
  }

  const parsed = createRequestSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return c.json({ error: "invalid_request", details: parsed.error.flatten() }, 400);
  const org = await c.env.DB.prepare(`SELECT status, (SELECT subscription_state FROM organization_entitlements e
    WHERE e.organization_id = organizations.id) AS subscription_state FROM organizations WHERE id = ?`)
    .bind(organizationId).first<{ status: string; subscription_state: string | null }>();
  if (!org || org.status === "closed") return c.json({ error: "not_found" }, 404);
  if (org.status === "paused" || org.subscription_state === "paused") return c.json({ error: "organization_paused" }, 409);
  const onboarding = await c.env.DB.prepare(`SELECT status FROM onboarding_records WHERE organization_id = ?`)
    .bind(organizationId).first<{ status: string }>();
  if ((role === "client_owner" || role === "client_member") && onboarding?.status !== "complete") {
    return c.json({ error: "onboarding_incomplete" }, 409);
  }

  const project = await c.env.DB.prepare(`SELECT id FROM projects WHERE organization_id = ? AND id = ? AND state <> 'closed'`)
    .bind(organizationId, parsed.data.projectId).first<{ id: string }>();
  if (!project) return c.json({ error: "project_not_found" }, 404);

  const requestId = newId();
  const status = parsed.data.submit && (role === "client_owner" || role === "client_member") ? "submitted" : "draft";
  const transitionRole = role === "client_owner" || role === "client_member" ? role : null;
  const maxPosition = await c.env.DB.prepare(`SELECT COALESCE(MAX(queue_position), 0) AS position FROM requests
    WHERE organization_id = ? AND status = 'queued' AND deleted_at IS NULL`).bind(organizationId).first<{ position: number }>();
  const position = (maxPosition?.position ?? 0) + 1;
  const commonInsert = c.env.DB.prepare(`INSERT INTO requests
    (id, organization_id, project_id, title, summary, objective, service_type, status, created_by, updated_by,
     last_transition_role, last_transition_reason, priority, desired_timing, references_json, queue_position)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, NULL, ?, ?, ?, ?)`)
    .bind(requestId, organizationId, project.id, parsed.data.title, parsed.data.summary, parsed.data.objective,
      parsed.data.serviceType || null, actor.id, actor.id, transitionRole, parsed.data.priority,
      parsed.data.desiredTiming || null, JSON.stringify(parsed.data.references), position);
  const statements = [commonInsert];
  if (status === "submitted") {
    statements.push(c.env.DB.prepare(`UPDATE requests SET status = 'submitted', version = version + 1,
      last_transition_role = ?, updated_by = ?, last_transition_reason = 'Client submitted request',
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE organization_id = ? AND id = ? AND status = 'draft'`)
      .bind(transitionRole, actor.id, organizationId, requestId));
  }
  try {
    await c.env.DB.batch(statements);
  } catch (error) {
    return mapRequestError(c, error);
  }
  const row = await getRequest(c.env, organizationId, requestId);
  return c.json({ request: row ? shapeRequest(row, role === "client_owner" || role === "client_member") : null }, 201);
});

router.post("/api/orgs/:organizationId/requests/:requestId/transition", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  const organizationId = c.req.param("organizationId");
  const requestId = c.req.param("requestId");
  const role = await organizationRole(c.env, actor, organizationId);
  if (!role) return c.json({ error: "not_found" }, 404);
  const parsed = transitionSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return c.json({ error: "invalid_transition", details: parsed.error.flatten() }, 400);
  if (role === "specialist" && !(await specialistAssignedToRequest(c.env, actor.id, organizationId, requestId))) {
    return c.json({ error: "not_found" }, 404);
  }
  if (role === "client_member" && (parsed.data.toStatus === "approved" || parsed.data.toStatus === "revision_requested") &&
    !(await canClientApprove(c.env, actor, organizationId))) return c.json({ error: "approval_permission_required" }, 403);
  if (role === "client_member" && parsed.data.toStatus === "submitted") {
    const membership = await c.env.DB.prepare(`SELECT can_submit FROM memberships WHERE organization_id = ? AND user_id = ?`)
      .bind(organizationId, actor.id).first<{ can_submit: number }>();
    if (membership?.can_submit !== 1) return c.json({ error: "request_permission_required" }, 403);
  }

  const current = await c.env.DB.prepare(`SELECT status, version FROM requests
    WHERE organization_id = ? AND id = ? AND deleted_at IS NULL`).bind(organizationId, requestId)
    .first<{ status: z.infer<typeof requestStatus>; version: number }>();
  if (!current) return c.json({ error: "not_found" }, 404);
  const permitted = await c.env.DB.prepare(`SELECT client_visible FROM workflow_transitions
    WHERE organization_id = ? AND from_status = ? AND to_status = ? AND actor_role = ? AND enabled = 1`)
    .bind(organizationId, current.status, parsed.data.toStatus, role).first<{ client_visible: number }>();
  if (!permitted) return c.json({ error: "transition_not_configured", from: current.status, to: parsed.data.toStatus }, 409);
  let updates: D1Result[];
  try {
    const transition = c.env.DB.prepare(`UPDATE requests SET status = ?, version = version + 1, updated_by = ?,
      last_transition_role = ?, last_transition_reason = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE organization_id = ? AND id = ? AND status = ? AND version = ?`)
      .bind(parsed.data.toStatus, actor.id, role, parsed.data.reason || null, organizationId, requestId, current.status, parsed.data.expectedVersion);
    const statements = [transition];
    const resumesTasks = current.status === "revision_requested" && parsed.data.toStatus === "in_progress";
    if (resumesTasks) {
      const taskStatuses = "'internal_review', 'submitted', 'pm_review', 'done'";
      const resumedRequest = `EXISTS (SELECT 1 FROM requests r WHERE r.organization_id = specialist_tasks.organization_id
        AND r.id = specialist_tasks.request_id AND r.status = 'in_progress' AND r.version = ? AND r.updated_by = ?)`;
      statements.push(c.env.DB.prepare(`INSERT INTO audit_events
        (id, actor_user_id, organization_id, action, subject_type, subject_id, reason, before_json, after_json, request_id)
        SELECT lower(hex(randomblob(16))), ?, organization_id, 'specialist_task_reopened_for_revision', 'task', id,
          'Client requested a revision', json_object('status', status), json_object('status', 'in_progress'), request_id
        FROM specialist_tasks WHERE organization_id = ? AND request_id = ? AND status IN (${taskStatuses})
          AND ${resumedRequest}`)
        .bind(actor.id, organizationId, requestId, current.version + 1, actor.id));
      statements.push(c.env.DB.prepare(`UPDATE specialist_tasks SET status = 'in_progress', block_reason = NULL,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE organization_id = ? AND request_id = ? AND status IN (${taskStatuses}) AND ${resumedRequest}`)
        .bind(organizationId, requestId, current.version + 1, actor.id));
    }
    updates = await c.env.DB.batch(statements);
  } catch (error) {
    return mapRequestError(c, error);
  }
  // D1 includes trigger side effects in meta.changes, so a valid transition can affect several rows.
  if (updates[0]?.meta.changes === 0) return c.json({ error: "request_changed_or_stale" }, 409);
  const row = await getRequest(c.env, organizationId, requestId);
  return c.json({ request: row ? shapeRequest(row, role === "client_owner" || role === "client_member") : null, clientVisible: permitted.client_visible === 1 });
});

router.post("/api/orgs/:organizationId/requests/:requestId/allocate", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  const organizationId = c.req.param("organizationId");
  const requestId = c.req.param("requestId");
  const role = await organizationRole(c.env, actor, organizationId);
  if (!role) return c.json({ error: "not_found" }, 404);
  if (!(role === "admin" || role === "super_admin" || role === "pm")) return c.json({ error: "forbidden" }, 403);
  const parsed = allocateSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return c.json({ error: "invalid_allocation", details: parsed.error.flatten() }, 400);
  const request = await c.env.DB.prepare(`SELECT status, version FROM requests WHERE organization_id = ? AND id = ? AND deleted_at IS NULL`)
    .bind(organizationId, requestId).first<{ status: string; version: number }>();
  if (!request) return c.json({ error: "not_found" }, 404);
  if (request.status !== "queued" || request.version !== parsed.data.expectedVersion) return c.json({ error: "request_changed_or_stale" }, 409);

  const allocationId = newId();
  try {
    const result = await c.env.DB.prepare(`
      WITH RECURSIVE slots(n) AS (
        SELECT 1
        UNION ALL
        SELECT n + 1 FROM slots
        WHERE n < (SELECT p.included_lanes + e.extra_lanes FROM organization_entitlements e
          JOIN plan_catalog p ON p.id = e.plan_id WHERE e.organization_id = ? AND e.subscription_state = 'active')
      )
      INSERT INTO lane_allocations (id, organization_id, request_id, lane_number, allocated_by)
      SELECT ?, ?, ?, slots.n, ? FROM slots
      WHERE NOT EXISTS (SELECT 1 FROM lane_allocations a WHERE a.organization_id = ?
        AND a.lane_number = slots.n AND a.released_at IS NULL)
        AND EXISTS (SELECT 1 FROM organization_entitlements e WHERE e.organization_id = ? AND e.subscription_state = 'active')
      ORDER BY slots.n LIMIT 1
    `).bind(organizationId, allocationId, organizationId, requestId, actor.id, organizationId, organizationId).run();
    // The insert trigger also changes the request and appends history, audit, and notifications.
    if (result.meta.changes === 0) return c.json({ error: "no_lane_available" }, 409);
  } catch (error) {
    return mapRequestError(c, error);
  }
  const allocation = await c.env.DB.prepare(`SELECT lane_number, allocated_at FROM lane_allocations WHERE id = ?`)
    .bind(allocationId).first<{ lane_number: number; allocated_at: string }>();
  return c.json({ allocation }, 201);
});

router.post("/api/orgs/:organizationId/requests/:requestId/release-lane", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  const organizationId = c.req.param("organizationId");
  const requestId = c.req.param("requestId");
  const role = await organizationRole(c.env, actor, organizationId);
  if (!role) return c.json({ error: "not_found" }, 404);
  if (!(role === "admin" || role === "super_admin" || role === "pm")) return c.json({ error: "forbidden" }, 403);
  const parsed = releaseSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return c.json({ error: "invalid_release", details: parsed.error.flatten() }, 400);
  const result = await c.env.DB.prepare(`UPDATE lane_allocations SET released_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      released_by = ?, release_reason = ?
    WHERE organization_id = ? AND request_id = ? AND released_at IS NULL
      AND EXISTS (SELECT 1 FROM requests r WHERE r.organization_id = lane_allocations.organization_id
        AND r.id = lane_allocations.request_id AND r.status = 'delivered')`)
    .bind(actor.id, parsed.data.reason, organizationId, requestId).run();
  // The release trigger records lane history and audit details in the same statement.
  if (result.meta.changes === 0) return c.json({ error: "lane_release_requires_delivered_request" }, 409);
  return c.json({ released: true });
});

router.post("/api/orgs/:organizationId/requests/reorder", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  const organizationId = c.req.param("organizationId");
  const role = await organizationRole(c.env, actor, organizationId);
  if (!role) return c.json({ error: "not_found" }, 404);
  if (!(role === "admin" || role === "super_admin" || role === "pm" || role === "client_owner" || role === "client_member")) {
    return c.json({ error: "forbidden" }, 403);
  }
  if (role === "client_member") {
    const membership = await c.env.DB.prepare(`SELECT can_submit FROM memberships WHERE organization_id = ? AND user_id = ?`)
      .bind(organizationId, actor.id).first<{ can_submit: number }>();
    if (membership?.can_submit !== 1) return c.json({ error: "request_permission_required" }, 403);
  }
  const parsed = reorderSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return c.json({ error: "invalid_queue_order", details: parsed.error.flatten() }, 400);
  const current = await c.env.DB.prepare(`SELECT id FROM requests WHERE organization_id = ? AND status = 'queued' AND deleted_at IS NULL ORDER BY queue_position`)
    .bind(organizationId).all<{ id: string }>();
  const currentIds = current.results.map((row) => row.id).sort();
  const proposedIds = [...parsed.data.requestIds].sort();
  if (currentIds.length !== proposedIds.length || currentIds.some((id, index) => id !== proposedIds[index])) {
    return c.json({ error: "queue_changed_or_incomplete" }, 409);
  }
  const orderedBefore = current.results.map((row) => row.id);
  const orderedAfterJson = JSON.stringify(parsed.data.requestIds);
  const beforeJson = JSON.stringify(orderedBefore);
  try {
    const results = await c.env.DB.batch([
      c.env.DB.prepare(`WITH proposed AS (
          SELECT value AS id, CAST(key AS INTEGER) + 1 AS position FROM json_each(?)
        )
        UPDATE requests SET queue_position = (SELECT position FROM proposed WHERE proposed.id = requests.id),
          version = version + 1, updated_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE organization_id = ? AND status = 'queued' AND deleted_at IS NULL
          AND id IN (SELECT id FROM proposed)
          AND (SELECT COUNT(*) FROM requests WHERE organization_id = ? AND status = 'queued' AND deleted_at IS NULL)
            = (SELECT COUNT(*) FROM proposed)
          AND NOT EXISTS (SELECT 1 FROM requests q WHERE q.organization_id = ? AND q.status = 'queued'
            AND q.deleted_at IS NULL AND q.id NOT IN (SELECT id FROM proposed))`)
        .bind(orderedAfterJson, actor.id, organizationId, organizationId, organizationId),
      c.env.DB.prepare(`INSERT INTO audit_events
        (id, actor_user_id, organization_id, action, subject_type, subject_id, reason, before_json, after_json)
        SELECT ?, ?, ?, 'request_queue_reordered', 'organization', ?, 'Queue order changed', ?, ?
        WHERE (SELECT COUNT(*) FROM requests WHERE organization_id = ? AND status = 'queued' AND deleted_at IS NULL)
            = (SELECT COUNT(*) FROM json_each(?))
          AND NOT EXISTS (SELECT 1 FROM requests q WHERE q.organization_id = ? AND q.status = 'queued'
            AND q.deleted_at IS NULL AND q.id NOT IN (SELECT value FROM json_each(?)))
          AND NOT EXISTS (SELECT 1 FROM json_each(?) p WHERE NOT EXISTS (
            SELECT 1 FROM requests r WHERE r.organization_id = ? AND r.id = p.value AND r.status = 'queued'
              AND r.deleted_at IS NULL AND r.queue_position = CAST(p.key AS INTEGER) + 1))`)
        .bind(newId(), actor.id, organizationId, organizationId, beforeJson, orderedAfterJson,
          organizationId, orderedAfterJson, organizationId, orderedAfterJson, orderedAfterJson,
          organizationId),
    ]);
    if (results[0]?.meta.changes !== parsed.data.requestIds.length || results[1]?.meta.changes !== 1) {
      return c.json({ error: "queue_changed_or_incomplete" }, 409);
    }
  } catch {
    return c.json({ error: "queue_changed_or_incomplete" }, 409);
  }
  return c.json({ orderedRequestIds: parsed.data.requestIds });
});

router.get("/api/orgs/:organizationId/requests/:requestId/events", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  const organizationId = c.req.param("organizationId");
  const requestId = c.req.param("requestId");
  const role = await organizationRole(c.env, actor, organizationId);
  if (!role || !(await requestBelongsToVisibleScope(c.env, actor, organizationId, requestId, role))) return c.json({ error: "not_found" }, 404);
  const client = role === "client_owner" || role === "client_member";
  const events = await c.env.DB.prepare(`SELECT e.id, e.event_type, e.from_status, e.to_status, e.reason,
      e.client_visible, e.created_at, u.display_name AS actor_name
    FROM request_events e LEFT JOIN app_users u ON u.id = e.actor_user_id
    WHERE e.organization_id = ? AND e.request_id = ? ${client ? "AND e.client_visible = 1" : ""}
    ORDER BY e.created_at DESC`)
    .bind(organizationId, requestId).all();
  return c.json({ events: events.results });
});

router.get("/api/orgs/:organizationId/requests/:requestId/comments", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  const organizationId = c.req.param("organizationId");
  const requestId = c.req.param("requestId");
  const role = await organizationRole(c.env, actor, organizationId);
  if (!role || !(await requestBelongsToVisibleScope(c.env, actor, organizationId, requestId, role))) return c.json({ error: "not_found" }, 404);
  const client = role === "client_owner" || role === "client_member";
  const comments = await c.env.DB.prepare(`SELECT c.id, c.body, c.visibility, c.created_at, u.id AS author_id, u.display_name AS author_name
    FROM comments c JOIN app_users u ON u.id = c.author_user_id
    WHERE c.organization_id = ? AND c.request_id = ? AND c.deleted_at IS NULL ${client ? "AND c.visibility = 'client'" : ""}
    ORDER BY c.created_at ASC`).bind(organizationId, requestId).all();
  return c.json({ comments: comments.results });
});

router.post("/api/orgs/:organizationId/requests/:requestId/comments", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  const organizationId = c.req.param("organizationId");
  const requestId = c.req.param("requestId");
  const role = await organizationRole(c.env, actor, organizationId);
  if (!role || !(await requestBelongsToVisibleScope(c.env, actor, organizationId, requestId, role))) return c.json({ error: "not_found" }, 404);
  const parsed = commentSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return c.json({ error: "invalid_comment", details: parsed.error.flatten() }, 400);
  if ((role === "client_owner" || role === "client_member") && parsed.data.visibility !== "client") {
    return c.json({ error: "client_visibility_required" }, 403);
  }
  if (role === "specialist" && parsed.data.visibility !== "internal") return c.json({ error: "internal_visibility_required" }, 403);
  const id = newId();
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO comments (id, organization_id, request_id, author_user_id, body, visibility)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(id, organizationId, requestId, actor.id, parsed.data.body, parsed.data.visibility),
    c.env.DB.prepare(`INSERT INTO audit_events (id, actor_user_id, organization_id, action, subject_type, subject_id, reason, client_visible, request_id)
      VALUES (?, ?, ?, 'comment_added', 'comment', ?, ?, ?, ?)`)
      .bind(newId(), actor.id, organizationId, id, parsed.data.visibility === "client" ? "Client-visible comment" : "Internal comment", parsed.data.visibility === "client" ? 1 : 0, requestId),
    ...(parsed.data.visibility === "client"
      ? [c.env.DB.prepare(`INSERT OR IGNORE INTO notifications (id, user_id, organization_id, request_id, event_key, title, body)
          SELECT ?, m.user_id, ?, ?, ?, 'New comment', 'There is a new update on a request.'
          FROM memberships m WHERE m.organization_id = ? AND m.user_id <> ?`)
          .bind(newId(), organizationId, requestId, `comment:${id}`, organizationId, actor.id)]
      : []),
  ]);
  return c.json({ comment: { id, body: parsed.data.body, visibility: parsed.data.visibility, authorId: actor.id, authorName: actor.displayName } }, 201);
});

export function routeRequests(app: Hono<AppEnv>): void {
  app.route("/", router);
}

function shapeRequest(row: RequestRow, clientView: boolean) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    projectName: row.project_name,
    title: row.title,
    summary: row.summary,
    objective: row.objective,
    serviceType: row.service_type,
    status: clientView && row.status === "internal_review" ? "in_progress" : row.status,
    version: row.version,
    priority: row.priority,
    desiredTiming: row.desired_timing,
    references: JSON.parse(row.references_json) as string[],
    queuePosition: row.queue_position,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    laneNumber: row.lane_number,
    activeTaskCount: row.active_task_count,
  };
}

async function getRequest(env: AppEnv["Bindings"], organizationId: string, requestId: string) {
  return env.DB.prepare(`SELECT r.id, r.organization_id, r.project_id, p.name AS project_name, r.title, r.summary,
      r.objective, r.service_type, r.status, r.version, r.priority, r.desired_timing, r.references_json, r.queue_position,
      r.created_by, creator.display_name AS created_by_name, r.created_at, r.updated_at, a.lane_number,
      (SELECT COUNT(*) FROM specialist_tasks t WHERE t.organization_id = r.organization_id AND t.request_id = r.id AND t.status <> 'done') AS active_task_count
    FROM requests r JOIN projects p ON p.organization_id = r.organization_id AND p.id = r.project_id
    JOIN app_users creator ON creator.id = r.created_by
    LEFT JOIN lane_allocations a ON a.organization_id = r.organization_id AND a.request_id = r.id AND a.released_at IS NULL
    WHERE r.organization_id = ? AND r.id = ? AND r.deleted_at IS NULL`)
    .bind(organizationId, requestId).first<RequestRow>();
}

async function requestScopeClause(actor: Actor, role: OrganizationRole): Promise<{ sql: string; params: string[] }> {
  if (role === "admin" || role === "super_admin") return { sql: "", params: [] };
  if (role === "pm") return { sql: `AND EXISTS (SELECT 1 FROM pm_assignments a2 WHERE a2.organization_id = r.organization_id AND a2.pm_user_id = ? AND a2.ends_at IS NULL)`, params: [actor.id] };
  if (role === "client_owner" || role === "client_member") return { sql: `AND EXISTS (SELECT 1 FROM memberships m2 WHERE m2.organization_id = r.organization_id AND m2.user_id = ?)`, params: [actor.id] };
  return { sql: `AND EXISTS (SELECT 1 FROM specialist_tasks t2 JOIN task_assignments a2 ON a2.organization_id = t2.organization_id AND a2.task_id = t2.id
    WHERE t2.organization_id = r.organization_id AND t2.request_id = r.id AND a2.specialist_user_id = ? AND a2.ended_at IS NULL)`, params: [actor.id] };
}

async function requestBelongsToVisibleScope(env: AppEnv["Bindings"], actor: Actor, orgId: string, requestId: string, role: OrganizationRole): Promise<boolean> {
  if (role === "specialist") return specialistAssignedToRequest(env, actor.id, orgId, requestId);
  if (!(await canAccessOrganization(env, actor, orgId))) return false;
  return Boolean(await env.DB.prepare(`SELECT 1 FROM requests WHERE organization_id = ? AND id = ? AND deleted_at IS NULL`)
    .bind(orgId, requestId).first());
}

async function specialistAssignedToRequest(env: AppEnv["Bindings"], userId: string, orgId: string, requestId: string): Promise<boolean> {
  return Boolean(await env.DB.prepare(`SELECT 1 FROM specialist_tasks t JOIN task_assignments a
    ON a.organization_id = t.organization_id AND a.task_id = t.id
    WHERE t.organization_id = ? AND t.request_id = ? AND a.specialist_user_id = ? AND a.ended_at IS NULL LIMIT 1`)
    .bind(orgId, requestId, userId).first());
}

async function mapRequestError(c: Context<AppEnv>, error: unknown) {
  const message = String(error);
  if (message.includes("organization_paused")) return c.json({ error: "organization_paused" }, 409);
  if (message.includes("onboarding_incomplete")) return c.json({ error: "onboarding_incomplete" }, 409);
  if (message.includes("workflow_transition_not_configured")) return c.json({ error: "transition_not_configured" }, 409);
  if (message.includes("lane_unavailable_or_policy_pending")) return c.json({ error: "no_lane_available" }, 409);
  return c.json({ error: "request_conflict" }, 409);
}
