import { Hono } from "hono";
import type { Actor, AppEnv } from "./types";

const router = new Hono<AppEnv>();

router.get("/api/dashboard", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  if (actor.globalRole === "client") return c.json({ dashboard: await clientDashboard(c.env, actor) });
  if (actor.globalRole === "pm") return c.json({ dashboard: await pmDashboard(c.env, actor) });
  if (actor.globalRole === "specialist") return c.json({ dashboard: await specialistDashboard(c.env, actor) });
  return c.json({ dashboard: await adminDashboard(c.env) });
});

router.get("/api/notifications", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  const rows = await c.env.DB.prepare(`SELECT id, organization_id, request_id, event_key, title, body, read_at, created_at
    FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`).bind(actor.id).all();
  return c.json({ notifications: rows.results });
});

router.post("/api/notifications/:notificationId/read", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  const result = await c.env.DB.prepare(`UPDATE notifications SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ? AND user_id = ? AND read_at IS NULL`).bind(c.req.param("notificationId"), actor.id).run();
  if (result.meta.changes === 0) return c.json({ error: "not_found_or_already_read" }, 404);
  return c.json({ read: true });
});

router.post("/api/notifications/read-all", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  const result = await c.env.DB.prepare(`UPDATE notifications SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE user_id = ? AND read_at IS NULL`).bind(actor.id).run();
  return c.json({ markedRead: result.meta.changes });
});

export function routeDashboard(app: Hono<AppEnv>): void {
  app.route("/", router);
}

async function clientDashboard(env: AppEnv["Bindings"], actor: Actor) {
  const organizations = await env.DB.prepare(`SELECT o.id, o.name, o.status, o.industry, o.website_url,
      m.client_role, m.can_submit, m.can_approve, m.can_manage_members,
      p.display_name AS primary_pm, p.email AS primary_pm_email,
      e.plan_id, pc.display_name AS plan_name, pc.included_lanes, e.extra_lanes, e.subscription_state,
      (SELECT COUNT(*) FROM lane_allocations a WHERE a.organization_id = o.id AND a.released_at IS NULL) AS active_lanes,
      (SELECT COUNT(*) FROM requests r WHERE r.organization_id = o.id AND r.status = 'queued' AND r.deleted_at IS NULL) AS queued_requests,
      (SELECT COUNT(*) FROM requests r WHERE r.organization_id = o.id AND r.status IN ('client_review', 'brief_ready') AND r.deleted_at IS NULL) AS needs_review,
      (SELECT status FROM onboarding_records ob WHERE ob.organization_id = o.id) AS onboarding_status
    FROM organizations o JOIN memberships m ON m.organization_id = o.id AND m.user_id = ?
    LEFT JOIN pm_assignments pa ON pa.organization_id = o.id AND pa.assignment_role = 'primary' AND pa.ends_at IS NULL
    LEFT JOIN app_users p ON p.id = pa.pm_user_id
    LEFT JOIN organization_entitlements e ON e.organization_id = o.id
    LEFT JOIN plan_catalog pc ON pc.id = e.plan_id
    WHERE o.status <> 'closed' ORDER BY o.name`).bind(actor.id).all();
  return { role: "client", organizations: organizations.results };
}

async function pmDashboard(env: AppEnv["Bindings"], actor: Actor) {
  const organizations = await env.DB.prepare(`SELECT o.id, o.name, o.status, o.industry,
      e.plan_id, e.extra_lanes, e.subscription_state,
      (SELECT COUNT(*) FROM requests r WHERE r.organization_id = o.id AND r.status = 'submitted' AND r.deleted_at IS NULL) AS awaiting_review,
      (SELECT COUNT(*) FROM requests r WHERE r.organization_id = o.id AND r.status = 'waiting_on_client' AND r.deleted_at IS NULL) AS waiting_on_client,
      (SELECT COUNT(*) FROM requests r WHERE r.organization_id = o.id AND r.status IN ('in_progress', 'internal_review') AND r.deleted_at IS NULL) AS active_work,
      (SELECT COUNT(*) FROM onboarding_records ob WHERE ob.organization_id = o.id AND ob.status IN ('submitted', 'pm_review')) AS onboarding_review
    FROM organizations o JOIN pm_assignments p ON p.organization_id = o.id AND p.pm_user_id = ? AND p.ends_at IS NULL
    LEFT JOIN organization_entitlements e ON e.organization_id = o.id
    WHERE o.status <> 'closed' ORDER BY o.name`).bind(actor.id).all();
  const unread = await env.DB.prepare(`SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND read_at IS NULL`)
    .bind(actor.id).first<{ count: number }>();
  return { role: "pm", organizations: organizations.results, unreadNotifications: unread?.count ?? 0 };
}

async function specialistDashboard(env: AppEnv["Bindings"], actor: Actor) {
  const result = await env.DB.prepare(`SELECT t.id, t.organization_id, o.name AS organization_name, t.request_id,
      r.title AS request_title, p.name AS project_name, t.title, t.internal_scope, t.status, t.block_reason, t.updated_at
    FROM specialist_tasks t JOIN task_assignments a ON a.organization_id = t.organization_id AND a.task_id = t.id
    JOIN requests r ON r.organization_id = t.organization_id AND r.id = t.request_id
    JOIN projects p ON p.organization_id = t.organization_id AND p.id = r.project_id
    JOIN organizations o ON o.id = t.organization_id
    WHERE a.specialist_user_id = ? AND a.ended_at IS NULL ORDER BY t.updated_at DESC`).bind(actor.id).all();
  return { role: "specialist", tasks: result.results };
}

async function adminDashboard(env: AppEnv["Bindings"]) {
  const [organizations, statuses, integrations, onboarding] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN o.status = 'active' THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN o.status = 'onboarding' THEN 1 ELSE 0 END) AS onboarding,
        SUM(CASE WHEN o.status = 'paused' OR e.subscription_state = 'paused' THEN 1 ELSE 0 END) AS paused
      FROM organizations o LEFT JOIN organization_entitlements e ON e.organization_id = o.id
      WHERE o.status <> 'closed'`).first(),
    env.DB.prepare(`SELECT status, COUNT(*) AS count FROM requests WHERE deleted_at IS NULL GROUP BY status`).all(),
    env.DB.prepare(`SELECT provider_key, configured, status, status_detail, last_checked_at FROM integration_status ORDER BY provider_key`).all(),
    env.DB.prepare(`SELECT status, COUNT(*) AS count FROM onboarding_records GROUP BY status`).all(),
  ]);
  return { role: "admin", organizations, requestStatuses: statuses.results, integrations: integrations.results, onboarding: onboarding.results };
}
