import { Hono } from "hono";
import { z } from "zod";
import { canAccessOrganization, organizationRole } from "./authorization";
import { hashPassword, newId, normalizeEmail, randomPassword } from "./security";
import type { Actor, AppEnv } from "./types";

const router = new Hono<AppEnv>();
const entitlementSchema = z.enum(["pending", "active", "paused"]);
const planSchema = z.enum(["foundation", "growth", "scale"]);
const objectiveWorkflow = [
  ["draft", "pm_review", "pm", 0],
  ["draft", "submitted", "client_owner", 1],
  ["draft", "submitted", "client_member", 1],
  ["submitted", "pm_review", "pm", 0],
  ["pm_review", "needs_client_info", "pm", 1],
  ["needs_client_info", "submitted", "client_owner", 1],
  ["needs_client_info", "submitted", "client_member", 1],
  ["pm_review", "brief_ready", "pm", 1],
  ["brief_ready", "queued", "pm", 1],
  ["brief_ready", "revision_requested", "client_owner", 1],
  ["brief_ready", "revision_requested", "client_member", 1],
  ["revision_requested", "brief_ready", "pm", 1],
  ["in_progress", "internal_review", "specialist", 0],
  ["in_progress", "internal_review", "pm", 0],
  ["internal_review", "in_progress", "pm", 0],
  ["internal_review", "client_review", "pm", 1],
  ["client_review", "revision_requested", "client_owner", 1],
  ["client_review", "revision_requested", "client_member", 1],
  ["client_review", "approved", "client_owner", 1],
  ["client_review", "approved", "client_member", 1],
  ["revision_requested", "in_progress", "pm", 0],
  ["approved", "delivered", "pm", 1],
  ["pm_review", "waiting_on_client", "pm", 1],
  ["in_progress", "waiting_on_client", "pm", 1],
  ["waiting_on_client", "submitted", "client_owner", 1],
  ["waiting_on_client", "submitted", "client_member", 1],
  ["in_progress", "on_hold", "pm", 1],
  ["on_hold", "in_progress", "pm", 0],
  ["draft", "cancelled", "client_owner", 1],
  ["submitted", "cancelled", "client_owner", 1],
  ["submitted", "cancelled", "pm", 1],
] as const;

const createOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(160),
  industry: z.string().trim().max(120).optional().default(""),
  websiteUrl: z.string().trim().url().max(500).optional().or(z.literal("")),
  timezone: z.string().trim().max(100).optional().default("Asia/Colombo"),
  ownerEmail: z.string().trim().email().max(254),
  ownerDisplayName: z.string().trim().min(1).max(120),
  primaryPmUserId: z.string().uuid(),
  planId: planSchema,
  extraLanes: z.number().int().min(0).default(0),
  billingPeriod: z.enum(["monthly", "annual"]).nullable().default(null),
  subscriptionState: entitlementSchema.default("pending"),
  reason: z.string().trim().min(3).max(500),
  paymentNote: z.string().trim().max(1000).optional().default(""),
});

const inviteMemberSchema = z.object({
  email: z.string().trim().email().max(254),
  displayName: z.string().trim().min(1).max(120),
  canSubmit: z.boolean().default(true),
  canApprove: z.boolean().default(false),
  canManageMembers: z.boolean().default(false),
});

const projectSchema = z.object({
  name: z.string().trim().min(2).max(160),
  summary: z.string().trim().max(3000).optional().default(""),
});

router.get("/api/organizations", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  return c.json({ organizations: await listOrganizations(c.env.DB, actor) });
});

router.post("/api/admin/organizations", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  if (!isAdmin(actor)) return c.json({ error: "forbidden" }, 403);
  const parsed = createOrganizationSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return c.json({ error: "invalid_organization", details: parsed.error.flatten() }, 400);

  const data = parsed.data;
  const pm = await c.env.DB.prepare(`SELECT id FROM app_users WHERE id = ? AND global_role = 'pm' AND disabled_at IS NULL`)
    .bind(data.primaryPmUserId).first<{ id: string }>();
  if (!pm) return c.json({ error: "project_manager_not_found" }, 400);
  const plan = await c.env.DB.prepare(`SELECT id, included_lanes FROM plan_catalog WHERE id = ? AND active = 1`)
    .bind(data.planId).first<{ id: string; included_lanes: number }>();
  if (!plan) return c.json({ error: "plan_not_available" }, 400);

  const email = normalizeEmail(data.ownerEmail);
  const existing = await c.env.DB.prepare(`SELECT id, global_role FROM app_users WHERE email = ? COLLATE NOCASE`)
    .bind(email).first<{ id: string; global_role: string }>();
  if (existing && existing.global_role !== "client") return c.json({ error: "email_already_used_by_staff" }, 409);

  const organizationId = newId();
  const ownerId = existing?.id ?? newId();
  const onboardingId = newId();
  const projectManagerAssignmentId = newId();
  const planChangeId = newId();
  const auditId = newId();
  const temporaryPassword = existing ? undefined : randomPassword();
  const credential = temporaryPassword ? await hashPassword(temporaryPassword) : undefined;
  const statements = [];
  if (!existing && credential) {
    statements.push(c.env.DB.prepare(`INSERT INTO app_users (id, email, display_name, global_role, must_change_password)
      VALUES (?, ?, ?, 'client', 1)`).bind(ownerId, email, data.ownerDisplayName));
    statements.push(c.env.DB.prepare(`INSERT INTO password_credentials (user_id, password_hash, password_salt, iterations)
      VALUES (?, ?, ?, ?)`).bind(ownerId, credential.hash, credential.salt, credential.iterations));
  }
  statements.push(
    c.env.DB.prepare(`INSERT INTO organizations (id, name, status, industry, website_url, timezone)
      VALUES (?, ?, 'onboarding', ?, ?, ?)`)
      .bind(organizationId, data.name, data.industry || null, data.websiteUrl || null, data.timezone || null),
    c.env.DB.prepare(`INSERT INTO memberships (organization_id, user_id, client_role, can_submit, can_approve, can_manage_members, can_manage_billing, invited_by)
      VALUES (?, ?, 'owner', 1, 1, 1, 1, ?)`)
      .bind(organizationId, ownerId, actor.id),
    c.env.DB.prepare(`INSERT INTO pm_assignments (id, organization_id, pm_user_id, assignment_role, assigned_by, reason)
      VALUES (?, ?, ?, 'primary', ?, ?)`)
      .bind(projectManagerAssignmentId, organizationId, data.primaryPmUserId, actor.id, data.reason),
    c.env.DB.prepare(`INSERT INTO organization_entitlements
      (organization_id, plan_id, extra_lanes, billing_period, subscription_state, allow_new_while_paused, allow_release_while_paused, recorded_by, reason)
      VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?)`)
      .bind(organizationId, data.planId, data.extraLanes, data.billingPeriod, data.subscriptionState, actor.id, data.reason),
    c.env.DB.prepare(`INSERT INTO plan_changes
      (id, organization_id, old_plan_id, new_plan_id, old_extra_lanes, new_extra_lanes, billing_period, effective_at, recorded_by, reason, payment_note)
      VALUES (?, ?, NULL, ?, 0, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?, ?)`)
      .bind(planChangeId, organizationId, data.planId, data.extraLanes, data.billingPeriod, actor.id, data.reason, data.paymentNote || null),
    c.env.DB.prepare(`INSERT INTO onboarding_records (id, organization_id, status, created_by)
      VALUES (?, ?, 'not_started', ?)`)
      .bind(onboardingId, organizationId, ownerId),
    c.env.DB.prepare(`INSERT INTO audit_events (id, actor_user_id, organization_id, action, subject_type, subject_id, reason, after_json)
      VALUES (?, ?, ?, 'client_organization_created', 'organization', ?, ?, json_object('owner_id', ?, 'primary_pm_user_id', ?, 'plan_id', ?))`)
      .bind(auditId, actor.id, organizationId, organizationId, data.reason, ownerId, data.primaryPmUserId, data.planId),
  );
  statements.push(...objectiveWorkflow.map(([fromStatus, toStatus, actorRole, clientVisible]) =>
    c.env.DB.prepare(`INSERT INTO workflow_transitions
      (organization_id, from_status, to_status, actor_role, client_visible, enabled, policy_source, configured_by, configured_at)
      VALUES (?, ?, ?, ?, ?, 1, 'manual', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
      .bind(organizationId, fromStatus, toStatus, actorRole, clientVisible, actor.id)));
  try {
    await c.env.DB.batch(statements);
  } catch {
    return c.json({ error: "organization_creation_conflict" }, 409);
  }
  return c.json({
    organization: { id: organizationId, name: data.name, status: "onboarding" },
    owner: { id: ownerId, email, displayName: data.ownerDisplayName, alreadyHadAccount: Boolean(existing) },
    temporaryPassword,
    passwordMustBeChanged: Boolean(temporaryPassword),
    plan: { id: data.planId, includedLanes: plan.included_lanes, extraLanes: data.extraLanes, state: data.subscriptionState, paymentVerified: false },
  }, 201);
});

router.get("/api/orgs/:organizationId/members", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  const organizationId = c.req.param("organizationId");
  const role = await organizationRole(c.env, actor, organizationId);
  if (!role) return c.json({ error: "not_found" }, 404);
  if (!(role === "admin" || role === "super_admin" || role === "client_owner")) return c.json({ error: "forbidden" }, 403);

  const members = await c.env.DB.prepare(`SELECT u.id, u.email, u.display_name, m.client_role, m.can_submit, m.can_approve,
      m.can_manage_members, m.can_manage_billing, m.joined_at
    FROM memberships m JOIN app_users u ON u.id = m.user_id
    WHERE m.organization_id = ? AND u.disabled_at IS NULL ORDER BY m.client_role, u.display_name`)
    .bind(organizationId).all();
  return c.json({ members: members.results });
});

router.post("/api/orgs/:organizationId/members", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  const organizationId = c.req.param("organizationId");
  const role = await organizationRole(c.env, actor, organizationId);
  if (!role) return c.json({ error: "not_found" }, 404);
  if (!(role === "admin" || role === "super_admin" || role === "client_owner")) return c.json({ error: "forbidden" }, 403);
  if (role === "client_owner") {
    const permission = await c.env.DB.prepare(`SELECT can_manage_members FROM memberships WHERE organization_id = ? AND user_id = ?`)
      .bind(organizationId, actor.id).first<{ can_manage_members: number }>();
    if (permission?.can_manage_members !== 1) return c.json({ error: "forbidden" }, 403);
  }

  const parsed = inviteMemberSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return c.json({ error: "invalid_member", details: parsed.error.flatten() }, 400);
  const email = normalizeEmail(parsed.data.email);
  const existing = await c.env.DB.prepare(`SELECT id, global_role FROM app_users WHERE email = ? COLLATE NOCASE`)
    .bind(email).first<{ id: string; global_role: string }>();
  if (existing && existing.global_role !== "client") return c.json({ error: "email_already_used_by_staff" }, 409);
  const userId = existing?.id ?? newId();
  const temporaryPassword = existing ? undefined : randomPassword();
  const credential = temporaryPassword ? await hashPassword(temporaryPassword) : undefined;
  const statements = [];
  if (!existing && credential) {
    statements.push(c.env.DB.prepare(`INSERT INTO app_users (id, email, display_name, global_role, must_change_password)
      VALUES (?, ?, ?, 'client', 1)`).bind(userId, email, parsed.data.displayName));
    statements.push(c.env.DB.prepare(`INSERT INTO password_credentials (user_id, password_hash, password_salt, iterations)
      VALUES (?, ?, ?, ?)`).bind(userId, credential.hash, credential.salt, credential.iterations));
  }
  statements.push(
    c.env.DB.prepare(`INSERT INTO memberships
      (organization_id, user_id, client_role, can_submit, can_approve, can_manage_members, invited_by)
      VALUES (?, ?, 'member', ?, ?, ?, ?)`)
      .bind(organizationId, userId, parsed.data.canSubmit ? 1 : 0, parsed.data.canApprove ? 1 : 0, parsed.data.canManageMembers ? 1 : 0, actor.id),
    c.env.DB.prepare(`INSERT INTO audit_events (id, actor_user_id, organization_id, action, subject_type, subject_id, reason)
      VALUES (?, ?, ?, 'client_member_added', 'user', ?, 'Client member added')`)
      .bind(newId(), actor.id, organizationId, userId),
  );
  try {
    await c.env.DB.batch(statements);
  } catch {
    return c.json({ error: "member_creation_conflict" }, 409);
  }
  return c.json({
    member: { id: userId, email, displayName: parsed.data.displayName, clientRole: "member", canSubmit: parsed.data.canSubmit, canApprove: parsed.data.canApprove },
    temporaryPassword,
    passwordMustBeChanged: Boolean(temporaryPassword),
  }, 201);
});

router.get("/api/orgs/:organizationId/projects", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  const organizationId = c.req.param("organizationId");
  if (!(await canAccessOrganization(c.env, actor, organizationId))) return c.json({ error: "not_found" }, 404);
  const projects = await c.env.DB.prepare(`SELECT p.id, p.name, p.summary, p.state, p.created_at, p.updated_at,
      COUNT(r.id) AS request_count
    FROM projects p LEFT JOIN requests r ON r.organization_id = p.organization_id AND r.project_id = p.id AND r.deleted_at IS NULL
    WHERE p.organization_id = ? GROUP BY p.id ORDER BY p.updated_at DESC`)
    .bind(organizationId).all();
  return c.json({ projects: projects.results });
});

router.post("/api/orgs/:organizationId/projects", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  const organizationId = c.req.param("organizationId");
  const role = await organizationRole(c.env, actor, organizationId);
  if (!role) return c.json({ error: "not_found" }, 404);
  if (!(role === "admin" || role === "super_admin" || role === "pm" || role === "client_owner" || role === "client_member")) {
    return c.json({ error: "forbidden" }, 403);
  }
  const parsed = projectSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return c.json({ error: "invalid_project", details: parsed.error.flatten() }, 400);
  const policy = await c.env.DB.prepare(`SELECT o.status, e.subscription_state, ob.status AS onboarding_status
    FROM organizations o
    LEFT JOIN organization_entitlements e ON e.organization_id = o.id
    LEFT JOIN onboarding_records ob ON ob.organization_id = o.id
    WHERE o.id = ?`).bind(organizationId)
    .first<{ status: string; subscription_state: string | null; onboarding_status: string | null }>();
  if (!policy || policy.status === "closed") return c.json({ error: "not_found" }, 404);
  if (policy.status === "paused" || policy.subscription_state === "paused") return c.json({ error: "organization_paused" }, 409);
  if ((role === "client_owner" || role === "client_member") && policy.onboarding_status !== "complete") {
    return c.json({ error: "onboarding_incomplete" }, 409);
  }
  if (role === "client_member") {
    const membership = await c.env.DB.prepare(`SELECT can_submit FROM memberships WHERE organization_id = ? AND user_id = ?`)
      .bind(organizationId, actor.id).first<{ can_submit: number }>();
    if (membership?.can_submit !== 1) return c.json({ error: "request_permission_required" }, 403);
  }
  const projectId = newId();
  const result = await c.env.DB.prepare(`INSERT INTO projects (id, organization_id, name, summary, state, created_by)
    VALUES (?, ?, ?, ?, 'active', ?)`).bind(projectId, organizationId, parsed.data.name, parsed.data.summary, actor.id).run();
  if (result.meta.changes !== 1) return c.json({ error: "project_creation_failed" }, 409);
  return c.json({ project: { id: projectId, organizationId, name: parsed.data.name, summary: parsed.data.summary, state: "active" } }, 201);
});

export function routeOrganizations(app: Hono<AppEnv>): void {
  app.route("/", router);
}

async function listOrganizations(db: D1Database, actor: Actor) {
  if (isAdmin(actor)) {
    return (await db.prepare(`SELECT o.id, o.name, o.status, o.industry, o.website_url, o.created_at,
      a.pm_user_id AS primary_pm_user_id, p.display_name AS primary_pm,
      e.plan_id, pc.display_name AS plan_name, pc.included_lanes, e.extra_lanes, e.billing_period, e.subscription_state,
      (SELECT COUNT(*) FROM lane_allocations la WHERE la.organization_id = o.id AND la.released_at IS NULL) AS active_lanes,
      (SELECT COUNT(*) FROM requests r WHERE r.organization_id = o.id AND r.status = 'queued' AND r.deleted_at IS NULL) AS queued_requests,
      (SELECT status FROM onboarding_records ob WHERE ob.organization_id = o.id) AS onboarding_status
      FROM organizations o
      LEFT JOIN pm_assignments a ON a.organization_id = o.id AND a.assignment_role = 'primary' AND a.ends_at IS NULL
      LEFT JOIN app_users p ON p.id = a.pm_user_id
      LEFT JOIN organization_entitlements e ON e.organization_id = o.id
      LEFT JOIN plan_catalog pc ON pc.id = e.plan_id
      ORDER BY o.created_at DESC`).all()).results;
  }
  if (actor.globalRole === "pm") {
    return (await db.prepare(`SELECT o.id, o.name, o.status, o.industry, o.website_url,
      p.display_name AS primary_pm, e.plan_id, e.extra_lanes, e.subscription_state
      FROM organizations o JOIN pm_assignments mine ON mine.organization_id = o.id AND mine.pm_user_id = ? AND mine.ends_at IS NULL
      LEFT JOIN pm_assignments a ON a.organization_id = o.id AND a.assignment_role = 'primary' AND a.ends_at IS NULL
      LEFT JOIN app_users p ON p.id = a.pm_user_id
      LEFT JOIN organization_entitlements e ON e.organization_id = o.id
      WHERE o.status <> 'closed' ORDER BY o.name`).bind(actor.id).all()).results;
  }
  if (actor.globalRole === "client") {
    return (await db.prepare(`SELECT o.id, o.name, o.status, o.industry, o.website_url,
      p.display_name AS primary_pm, e.plan_id, e.extra_lanes, e.subscription_state
      FROM organizations o JOIN memberships m ON m.organization_id = o.id AND m.user_id = ?
      LEFT JOIN pm_assignments a ON a.organization_id = o.id AND a.assignment_role = 'primary' AND a.ends_at IS NULL
      LEFT JOIN app_users p ON p.id = a.pm_user_id
      LEFT JOIN organization_entitlements e ON e.organization_id = o.id
      WHERE o.status <> 'closed' ORDER BY o.name`).bind(actor.id).all()).results;
  }
  return (await db.prepare(`SELECT DISTINCT o.id, o.name, o.status, o.industry, o.website_url,
      p.display_name AS primary_pm, e.plan_id, e.extra_lanes, e.subscription_state
      FROM organizations o JOIN specialist_tasks t ON t.organization_id = o.id
      JOIN task_assignments mine ON mine.organization_id = t.organization_id AND mine.task_id = t.id AND mine.specialist_user_id = ? AND mine.ended_at IS NULL
      LEFT JOIN pm_assignments a ON a.organization_id = o.id AND a.assignment_role = 'primary' AND a.ends_at IS NULL
      LEFT JOIN app_users p ON p.id = a.pm_user_id
      LEFT JOIN organization_entitlements e ON e.organization_id = o.id
      WHERE o.status <> 'closed' ORDER BY o.name`).bind(actor.id).all()).results;
}

function isAdmin(actor: Actor): boolean {
  return actor.globalRole === "admin" || actor.globalRole === "super_admin";
}
