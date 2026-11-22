import type { Actor, AppEnv } from "./types";

export type OrganizationRole = "client_owner" | "client_member" | "pm" | "specialist" | "admin" | "super_admin";

export async function canAccessOrganization(env: AppEnv["Bindings"], actor: Actor, organizationId: string): Promise<boolean> {
  if (actor.globalRole === "admin" || actor.globalRole === "super_admin") return true;
  if (actor.globalRole === "client") {
    return Boolean(await env.DB.prepare(`SELECT 1 FROM memberships WHERE organization_id = ? AND user_id = ?`)
      .bind(organizationId, actor.id).first());
  }
  if (actor.globalRole === "pm") {
    return Boolean(await env.DB.prepare(`SELECT 1 FROM pm_assignments WHERE organization_id = ? AND pm_user_id = ? AND ends_at IS NULL`)
      .bind(organizationId, actor.id).first());
  }
  return Boolean(await env.DB.prepare(`SELECT 1 FROM specialist_tasks t
    JOIN task_assignments a ON a.organization_id = t.organization_id AND a.task_id = t.id
    WHERE t.organization_id = ? AND a.specialist_user_id = ? AND a.ended_at IS NULL LIMIT 1`)
    .bind(organizationId, actor.id).first());
}

export async function organizationRole(env: AppEnv["Bindings"], actor: Actor, organizationId: string): Promise<OrganizationRole | null> {
  if (actor.globalRole === "admin" || actor.globalRole === "super_admin") return actor.globalRole;
  if (actor.globalRole === "pm") {
    const assignment = await env.DB.prepare(`SELECT assignment_role FROM pm_assignments
      WHERE organization_id = ? AND pm_user_id = ? AND ends_at IS NULL LIMIT 1`).bind(organizationId, actor.id)
      .first<{ assignment_role: "primary" | "backup" }>();
    return assignment ? "pm" : null;
  }
  if (actor.globalRole === "client") {
    const membership = await env.DB.prepare(`SELECT client_role FROM memberships
      WHERE organization_id = ? AND user_id = ?`).bind(organizationId, actor.id)
      .first<{ client_role: "owner" | "member" }>();
    return membership ? (membership.client_role === "owner" ? "client_owner" : "client_member") : null;
  }
  return (await canAccessOrganization(env, actor, organizationId)) ? "specialist" : null;
}

export async function canActAs(env: AppEnv["Bindings"], actor: Actor, organizationId: string, allowed: OrganizationRole[]): Promise<boolean> {
  const role = await organizationRole(env, actor, organizationId);
  return role !== null && allowed.includes(role);
}

export async function canClientApprove(env: AppEnv["Bindings"], actor: Actor, organizationId: string): Promise<boolean> {
  if (actor.globalRole !== "client") return false;
  const membership = await env.DB.prepare(`SELECT client_role, can_approve FROM memberships
    WHERE organization_id = ? AND user_id = ?`).bind(organizationId, actor.id)
    .first<{ client_role: "owner" | "member"; can_approve: number }>();
  return Boolean(membership && (membership.client_role === "owner" || membership.can_approve === 1));
}
