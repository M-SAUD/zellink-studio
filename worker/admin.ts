import { Hono } from "hono";
import { z } from "zod";
import { hashPassword, newId, normalizeEmail, randomPassword } from "./security";
import type { Actor, AppEnv } from "./types";

const router = new Hono<AppEnv>();
const planSchema = z.enum(["foundation", "growth", "scale"]);
const stateSchema = z.enum(["pending", "active", "paused", "ended"]);
const requestStatuses = ["draft", "submitted", "pm_review", "needs_client_info", "brief_ready", "queued", "in_progress", "internal_review", "client_review", "revision_requested", "approved", "delivered", "waiting_on_client", "on_hold", "cancelled"] as const;
const actorRoles = ["client_owner", "client_member", "pm", "specialist", "admin", "super_admin"] as const;

const staffSchema = z.object({
  email: z.string().trim().email().max(254),
  displayName: z.string().trim().min(1).max(120),
  role: z.enum(["pm", "specialist", "admin", "super_admin"]),
});
const entitlementSchema = z.object({
  planId: planSchema,
  extraLanes: z.number().int().min(0),
  billingPeriod: z.enum(["monthly", "annual"]).nullable(),
  subscriptionState: stateSchema,
  reason: z.string().trim().min(3).max(500),
  paymentNote: z.string().trim().max(1000).optional().default(""),
});
const organizationStateSchema = z.object({
  status: z.enum(["onboarding", "active", "paused", "closed"]),
  reason: z.string().trim().min(3).max(500),
});
const userAccessSchema = z.object({ disabled: z.boolean(), reason: z.string().trim().min(3).max(500) });
const backupEndSchema = z.object({ reason: z.string().trim().min(3).max(500) });
const resetPasswordSchema = z.object({ reason: z.string().trim().min(3).max(500) });
const pmAssignmentSchema = z.object({
  pmUserId: z.string().uuid(),
  assignmentRole: z.enum(["primary", "backup"]),
  reason: z.string().trim().min(3).max(500),
});
const workflowSchema = z.object({
  reason: z.string().trim().min(3).max(500),
  transitions: z.array(z.object({
    fromStatus: z.enum(requestStatuses),
    toStatus: z.enum(requestStatuses),
    actorRole: z.enum(actorRoles),
    clientVisible: z.boolean(),
    enabled: z.boolean(),
  })).max(80),
}).superRefine((data, context) => {
  const keys = new Set<string>();
  for (const [index, transition] of data.transitions.entries()) {
    const key = `${transition.fromStatus}:${transition.toStatus}:${transition.actorRole}`;
    if (transition.fromStatus === transition.toStatus) context.addIssue({ code: "custom", path: ["transitions", index], message: "A transition must change status." });
    if (keys.has(key)) context.addIssue({ code: "custom", path: ["transitions", index], message: "Duplicate transition." });
    keys.add(key);
    if (transition.fromStatus === "queued" && transition.toStatus === "in_progress") {
      context.addIssue({ code: "custom", path: ["transitions", index], message: "Lane allocation controls this transition." });
    }
  }
});

router.get("/api/admin/users", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  if (!isAdmin(actor)) return c.json({ error: "forbidden" }, 403);
  const role = c.req.query("role");
  const allowedRoles = ["client", "pm", "specialist", "admin", "super_admin"];
  if (role && !allowedRoles.includes(role)) return c.json({ error: "invalid_role_filter" }, 400);
  const result = role
    ? await c.env.DB.prepare(`SELECT id, email, display_name, global_role, disabled_at, created_at FROM app_users WHERE global_role = ? ORDER BY display_name`)
      .bind(role).all()
    : await c.env.DB.prepare(`SELECT id, email, display_name, global_role, disabled_at, created_at FROM app_users ORDER BY global_role, display_name`).all();
  return c.json({ users: result.results });
});

router.patch("/api/admin/users/:userId/access", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  if (!isAdmin(actor)) return c.json({ error: "forbidden" }, 403);
  const parsed = userAccessSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return c.json({ error: "invalid_user_access_change", details: parsed.error.flatten() }, 400);
  const userId = c.req.param("userId");
  const target = await c.env.DB.prepare(`SELECT id, global_role, disabled_at FROM app_users WHERE id = ?`)
    .bind(userId).first<{ id: string; global_role: string; disabled_at: string | null }>();
  if (!target) return c.json({ error: "user_not_found" }, 404);
  if ((target.global_role === "admin" || target.global_role === "super_admin") && actor.globalRole !== "super_admin") {
    return c.json({ error: "super_admin_required" }, 403);
  }
  if (parsed.data.disabled && actor.id === userId) return c.json({ error: "cannot_suspend_self" }, 409);
  const currentlyDisabled = target.disabled_at !== null;
  if (currentlyDisabled === parsed.data.disabled) return c.json({ user: { id: userId, disabled: currentlyDisabled } });
  const disabledAt = parsed.data.disabled ? new Date().toISOString() : null;
  const results = await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE app_users SET disabled_at = ? WHERE id = ? AND disabled_at IS ?
      AND (? = 0 OR global_role <> 'super_admin' OR
        (SELECT COUNT(*) FROM app_users WHERE global_role = 'super_admin' AND disabled_at IS NULL) > 1)`)
      .bind(disabledAt, userId, target.disabled_at, parsed.data.disabled ? 1 : 0),
    c.env.DB.prepare(`INSERT INTO audit_events (id, actor_user_id, action, subject_type, subject_id, reason, before_json, after_json)
      SELECT ?, ?, 'user_access_changed', 'user', ?, ?, json_object('disabled', ?), json_object('disabled', ?)
      WHERE changes() > 0`)
      .bind(newId(), actor.id, userId, parsed.data.reason, currentlyDisabled ? 1 : 0, parsed.data.disabled ? 1 : 0),
    ...(parsed.data.disabled ? [c.env.DB.prepare(`UPDATE auth_sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE user_id = ? AND revoked_at IS NULL`).bind(userId)] : []),
  ]);
  if (results[0]?.meta.changes === 0) {
    if (target.global_role === "super_admin" && parsed.data.disabled) return c.json({ error: "last_super_admin_cannot_be_disabled" }, 409);
    return c.json({ error: "user_changed_or_stale" }, 409);
  }
  return c.json({ user: { id: userId, disabled: parsed.data.disabled, disabledAt } });
});

router.post("/api/admin/users/:userId/reset-password", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  if (!isAdmin(actor)) return c.json({ error: "forbidden" }, 403);
  const parsed = resetPasswordSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return c.json({ error: "invalid_password_reset", details: parsed.error.flatten() }, 400);
  const userId = c.req.param("userId");
  const target = await c.env.DB.prepare(`SELECT id, global_role, must_change_password FROM app_users WHERE id = ?`)
    .bind(userId).first<{ id: string; global_role: string; must_change_password: number }>();
  if (!target) return c.json({ error: "user_not_found" }, 404);
  if ((target.global_role === "admin" || target.global_role === "super_admin") && actor.globalRole !== "super_admin") {
    return c.json({ error: "super_admin_required" }, 403);
  }
  if (actor.id === userId) return c.json({ error: "cannot_reset_own_password" }, 409);

  const temporaryPassword = randomPassword();
  const credential = await hashPassword(temporaryPassword);
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE app_users SET must_change_password = 1 WHERE id = ?`).bind(userId),
    c.env.DB.prepare(`INSERT INTO password_credentials (user_id, password_hash, password_salt, iterations)
      VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET password_hash = excluded.password_hash,
        password_salt = excluded.password_salt, iterations = excluded.iterations`)
      .bind(userId, credential.hash, credential.salt, credential.iterations),
    c.env.DB.prepare(`UPDATE auth_sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE user_id = ? AND revoked_at IS NULL`).bind(userId),
    c.env.DB.prepare(`INSERT INTO audit_events (id, actor_user_id, action, subject_type, subject_id, reason,
        before_json, after_json)
      VALUES (?, ?, 'user_password_reset', 'user', ?, ?, json_object('must_change_password', ?),
        json_object('must_change_password', 1))`)
      .bind(newId(), actor.id, userId, parsed.data.reason, target.must_change_password),
  ]);
  c.header("Cache-Control", "no-store");
  return c.json({ user: { id: userId, mustChangePassword: true }, temporaryPassword }, 200);
});

router.post("/api/admin/users", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  if (!isAdmin(actor)) return c.json({ error: "forbidden" }, 403);
  const parsed = staffSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return c.json({ error: "invalid_staff_user", details: parsed.error.flatten() }, 400);
  if ((parsed.data.role === "admin" || parsed.data.role === "super_admin") && actor.globalRole !== "super_admin") {
    return c.json({ error: "super_admin_required" }, 403);
  }
  const email = normalizeEmail(parsed.data.email);
  const exists = await c.env.DB.prepare(`SELECT 1 FROM app_users WHERE email = ? COLLATE NOCASE`).bind(email).first();
  if (exists) return c.json({ error: "email_already_exists" }, 409);

  const userId = newId();
  const temporaryPassword = randomPassword();
  const credential = await hashPassword(temporaryPassword);
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO app_users (id, email, display_name, global_role, must_change_password)
      VALUES (?, ?, ?, ?, 1)`).bind(userId, email, parsed.data.displayName, parsed.data.role),
    c.env.DB.prepare(`INSERT INTO password_credentials (user_id, password_hash, password_salt, iterations)
      VALUES (?, ?, ?, ?)`).bind(userId, credential.hash, credential.salt, credential.iterations),
    c.env.DB.prepare(`INSERT INTO audit_events (id, actor_user_id, action, subject_type, subject_id, reason, after_json)
      VALUES (?, ?, 'staff_user_created', 'user', ?, 'Manual account provisioning', json_object('global_role', ?))`)
      .bind(newId(), actor.id, userId, parsed.data.role),
  ]);
  return c.json({ user: { id: userId, email, displayName: parsed.data.displayName, role: parsed.data.role }, temporaryPassword, passwordMustBeChanged: true }, 201);
});

router.patch("/api/admin/orgs/:organizationId/entitlement", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  if (!isAdmin(actor)) return c.json({ error: "forbidden" }, 403);
  const organizationId = c.req.param("organizationId");
  const parsed = entitlementSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return c.json({ error: "invalid_entitlement", details: parsed.error.flatten() }, 400);
  const data = parsed.data;
  const old = await c.env.DB.prepare(`SELECT plan_id, extra_lanes FROM organization_entitlements WHERE organization_id = ?`)
    .bind(organizationId).first<{ plan_id: string | null; extra_lanes: number }>();
  if (!old) return c.json({ error: "organization_not_found" }, 404);
  const plan = await c.env.DB.prepare(`SELECT included_lanes FROM plan_catalog WHERE id = ? AND active = 1`).bind(data.planId)
    .first<{ included_lanes: number }>();
  if (!plan) return c.json({ error: "plan_not_available" }, 400);

  const planChangeId = newId();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE organization_entitlements SET plan_id = ?, extra_lanes = ?, billing_period = ?, subscription_state = ?,
        allow_new_while_paused = 0, allow_release_while_paused = 1, recorded_by = ?, reason = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE organization_id = ?`)
        .bind(data.planId, data.extraLanes, data.billingPeriod, data.subscriptionState, actor.id, data.reason, organizationId),
      c.env.DB.prepare(`INSERT INTO plan_changes
        (id, organization_id, old_plan_id, new_plan_id, old_extra_lanes, new_extra_lanes, billing_period, effective_at, recorded_by, reason, payment_note)
        VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?, ?)`)
        .bind(planChangeId, organizationId, old.plan_id, data.planId, old.extra_lanes, data.extraLanes, data.billingPeriod, actor.id, data.reason, data.paymentNote || null),
      c.env.DB.prepare(`INSERT INTO audit_events (id, actor_user_id, organization_id, action, subject_type, subject_id, reason,
        before_json, after_json)
        VALUES (?, ?, ?, 'entitlement_changed', 'organization', ?, ?, json_object('plan_id', ?, 'extra_lanes', ?),
          json_object('plan_id', ?, 'extra_lanes', ?, 'subscription_state', ?, 'payment_verified', 0))`)
        .bind(newId(), actor.id, organizationId, organizationId, data.reason, old.plan_id, old.extra_lanes,
          data.planId, data.extraLanes, data.subscriptionState),
    ]);
  } catch (error) {
    if (String(error).includes("capacity_below_active_lanes")) return c.json({ error: "capacity_below_active_lanes" }, 409);
    return c.json({ error: "entitlement_change_failed" }, 409);
  }
  return c.json({ entitlement: { planId: data.planId, includedLanes: plan.included_lanes, extraLanes: data.extraLanes,
    billingPeriod: data.billingPeriod, subscriptionState: data.subscriptionState, paymentVerified: false } });
});

router.patch("/api/admin/orgs/:organizationId/status", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  if (!isAdmin(actor)) return c.json({ error: "forbidden" }, 403);
  const organizationId = c.req.param("organizationId");
  const parsed = organizationStateSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return c.json({ error: "invalid_organization_status", details: parsed.error.flatten() }, 400);
  const before = await c.env.DB.prepare(`SELECT status FROM organizations WHERE id = ?`).bind(organizationId).first<{ status: string }>();
  if (!before) return c.json({ error: "organization_not_found" }, 404);
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE organizations SET status = ? WHERE id = ?`).bind(parsed.data.status, organizationId),
    c.env.DB.prepare(`INSERT INTO audit_events (id, actor_user_id, organization_id, action, subject_type, subject_id, reason, before_json, after_json)
      VALUES (?, ?, ?, 'organization_status_changed', 'organization', ?, ?, json_object('status', ?), json_object('status', ?))`)
      .bind(newId(), actor.id, organizationId, organizationId, parsed.data.reason, before.status, parsed.data.status),
  ]);
  return c.json({ organization: { id: organizationId, status: parsed.data.status, retainedPermanently: true } });
});

router.post("/api/admin/orgs/:organizationId/pm-assignments", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  if (!isAdmin(actor)) return c.json({ error: "forbidden" }, 403);
  const organizationId = c.req.param("organizationId");
  const parsed = pmAssignmentSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return c.json({ error: "invalid_pm_assignment", details: parsed.error.flatten() }, 400);
  const user = await c.env.DB.prepare(`SELECT id FROM app_users WHERE id = ? AND global_role = 'pm' AND disabled_at IS NULL`)
    .bind(parsed.data.pmUserId).first();
  if (!user) return c.json({ error: "project_manager_not_found" }, 400);
  const organization = await c.env.DB.prepare(`SELECT id FROM organizations WHERE id = ?`).bind(organizationId).first();
  if (!organization) return c.json({ error: "organization_not_found" }, 404);

  if (parsed.data.assignmentRole === "backup") {
    const primary = await c.env.DB.prepare(`SELECT pm_user_id FROM pm_assignments
      WHERE organization_id = ? AND assignment_role = 'primary' AND ends_at IS NULL`).bind(organizationId)
      .first<{ pm_user_id: string }>();
    if (primary?.pm_user_id === parsed.data.pmUserId) return c.json({ error: "backup_must_differ_from_primary" }, 409);
  }

  const assignmentId = newId();
  const statements = [];
  if (parsed.data.assignmentRole === "primary") {
    statements.push(c.env.DB.prepare(`UPDATE pm_assignments SET ends_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE organization_id = ? AND assignment_role = 'primary' AND ends_at IS NULL`).bind(organizationId));
    statements.push(c.env.DB.prepare(`UPDATE pm_assignments SET ends_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE organization_id = ? AND assignment_role = 'backup' AND pm_user_id = ? AND ends_at IS NULL`).bind(organizationId, parsed.data.pmUserId));
  } else {
    statements.push(c.env.DB.prepare(`UPDATE pm_assignments SET ends_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE organization_id = ? AND assignment_role = 'backup' AND ends_at IS NULL`).bind(organizationId));
  }
  statements.push(
    c.env.DB.prepare(`INSERT INTO pm_assignments (id, organization_id, pm_user_id, assignment_role, assigned_by, reason)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(assignmentId, organizationId, parsed.data.pmUserId, parsed.data.assignmentRole, actor.id, parsed.data.reason),
    c.env.DB.prepare(`INSERT INTO audit_events (id, actor_user_id, organization_id, action, subject_type, subject_id, reason, after_json)
      VALUES (?, ?, ?, 'pm_assigned', 'organization', ?, ?, json_object('pm_user_id', ?, 'assignment_role', ?))`)
      .bind(newId(), actor.id, organizationId, organizationId, parsed.data.reason, parsed.data.pmUserId, parsed.data.assignmentRole),
  );
  try {
    await c.env.DB.batch(statements);
  } catch {
    return c.json({ error: "pm_assignment_conflict" }, 409);
  }
  return c.json({ assignment: { id: assignmentId, organizationId, pmUserId: parsed.data.pmUserId, role: parsed.data.assignmentRole } }, 201);
});

router.post("/api/admin/orgs/:organizationId/pm-assignments/backup/end", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  if (!isAdmin(actor)) return c.json({ error: "forbidden" }, 403);
  const organizationId = c.req.param("organizationId");
  const parsed = backupEndSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return c.json({ error: "invalid_backup_end", details: parsed.error.flatten() }, 400);
  const current = await c.env.DB.prepare(`SELECT id FROM pm_assignments
    WHERE organization_id = ? AND assignment_role = 'backup' AND ends_at IS NULL`).bind(organizationId)
    .first<{ id: string }>();
  if (!current) return c.json({ error: "backup_assignment_not_found" }, 404);
  const endedAt = new Date().toISOString();
  const results = await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE pm_assignments SET ends_at = ? WHERE id = ? AND ends_at IS NULL`).bind(endedAt, current.id),
    c.env.DB.prepare(`INSERT INTO audit_events (id, actor_user_id, organization_id, action, subject_type, subject_id, reason, before_json, after_json)
      SELECT ?, ?, ?, 'pm_backup_ended', 'organization', ?, ?, json_object('backup_assignment_id', ?), json_object('backup_assignment_id', NULL)
      WHERE EXISTS (SELECT 1 FROM pm_assignments WHERE id = ? AND ends_at = ?)`)
      .bind(newId(), actor.id, organizationId, organizationId, parsed.data.reason, current.id, current.id, endedAt),
  ]);
  if (results[0]?.meta.changes === 0) return c.json({ error: "backup_assignment_changed" }, 409);
  return c.json({ assignment: { organizationId, role: "backup", active: false } });
});

router.get("/api/admin/orgs/:organizationId/history", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  if (!isAdmin(actor)) return c.json({ error: "forbidden" }, 403);
  const organizationId = c.req.param("organizationId");
  const exists = await c.env.DB.prepare(`SELECT 1 FROM organizations WHERE id = ?`).bind(organizationId).first();
  if (!exists) return c.json({ error: "organization_not_found" }, 404);
  const [plans, assignments, events] = await Promise.all([
    c.env.DB.prepare(`SELECT pc.id, old_plan.display_name AS old_plan_name, new_plan.display_name AS new_plan_name,
        pc.old_extra_lanes, pc.new_extra_lanes, pc.billing_period, pc.effective_at, pc.reason, pc.payment_note,
        u.display_name AS recorded_by_name
      FROM plan_changes pc
      LEFT JOIN plan_catalog old_plan ON old_plan.id = pc.old_plan_id
      LEFT JOIN plan_catalog new_plan ON new_plan.id = pc.new_plan_id
      JOIN app_users u ON u.id = pc.recorded_by
      WHERE pc.organization_id = ? ORDER BY pc.effective_at DESC LIMIT 50`).bind(organizationId).all(),
    c.env.DB.prepare(`SELECT a.id, a.assignment_role, a.pm_user_id, assigned.display_name AS pm_name,
        a.assigned_by, a.reason, a.starts_at AS assigned_at, a.ends_at
      FROM pm_assignments a JOIN app_users assigned ON assigned.id = a.pm_user_id
      WHERE a.organization_id = ? ORDER BY a.starts_at DESC LIMIT 50`).bind(organizationId).all(),
    c.env.DB.prepare(`SELECT e.action, e.subject_type, e.reason, e.before_json, e.after_json, e.client_visible, e.created_at,
        u.display_name AS actor_name
      FROM audit_events e LEFT JOIN app_users u ON u.id = e.actor_user_id
      WHERE e.organization_id = ? ORDER BY e.created_at DESC LIMIT 50`).bind(organizationId).all(),
  ]);
  return c.json({ planChanges: plans.results, pmAssignments: assignments.results, auditEvents: events.results });
});

router.get("/api/admin/orgs/:organizationId/workflow", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  if (!isAdmin(actor)) return c.json({ error: "forbidden" }, 403);
  const organizationId = c.req.param("organizationId");
  const rows = await c.env.DB.prepare(`SELECT from_status, to_status, actor_role, client_visible, enabled, policy_source, configured_at
    FROM workflow_transitions WHERE organization_id = ? ORDER BY from_status, to_status, actor_role`).bind(organizationId).all();
  return c.json({ transitions: rows.results });
});

router.put("/api/admin/orgs/:organizationId/workflow", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  if (!isAdmin(actor)) return c.json({ error: "forbidden" }, 403);
  const organizationId = c.req.param("organizationId");
  const parsed = workflowSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return c.json({ error: "invalid_workflow", details: parsed.error.flatten() }, 400);
  const exists = await c.env.DB.prepare(`SELECT id FROM organizations WHERE id = ?`).bind(organizationId).first();
  if (!exists) return c.json({ error: "organization_not_found" }, 404);
  const before = await c.env.DB.prepare(`SELECT from_status, to_status, actor_role, client_visible, enabled
    FROM workflow_transitions WHERE organization_id = ? ORDER BY from_status, to_status, actor_role`)
    .bind(organizationId).all();
  const statements = [c.env.DB.prepare(`UPDATE workflow_transitions SET enabled = 0, configured_by = ?, configured_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE organization_id = ?`).bind(actor.id, organizationId)];
  for (const transition of parsed.data.transitions) {
    statements.push(c.env.DB.prepare(`INSERT INTO workflow_transitions
      (organization_id, from_status, to_status, actor_role, client_visible, enabled, policy_source, configured_by, configured_at)
      VALUES (?, ?, ?, ?, ?, ?, 'manual', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT(organization_id, from_status, to_status, actor_role) DO UPDATE SET
        client_visible = excluded.client_visible, enabled = excluded.enabled, policy_source = 'manual',
        configured_by = excluded.configured_by, configured_at = excluded.configured_at`)
      .bind(organizationId, transition.fromStatus, transition.toStatus, transition.actorRole,
        transition.clientVisible ? 1 : 0, transition.enabled ? 1 : 0, actor.id));
  }
  statements.push(c.env.DB.prepare(`INSERT INTO audit_events (id, actor_user_id, organization_id, action, subject_type, subject_id, reason, before_json, after_json)
    VALUES (?, ?, ?, 'workflow_policy_changed', 'organization', ?, ?, ?, ?)`)
    .bind(newId(), actor.id, organizationId, organizationId, parsed.data.reason, JSON.stringify(before.results), JSON.stringify(parsed.data.transitions)));
  await c.env.DB.batch(statements);
  return c.json({ transitions: parsed.data.transitions });
});

export function routeAdministration(app: Hono<AppEnv>): void {
  app.route("/", router);
}

function isAdmin(actor: Actor): boolean {
  return actor.globalRole === "admin" || actor.globalRole === "super_admin";
}
