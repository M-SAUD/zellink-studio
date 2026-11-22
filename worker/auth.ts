import { Hono, type Context, type Next } from "hono";
import { z } from "zod";
import type { Actor, AppEnv, GlobalRole } from "./types";
import {
  clearSessionCookie,
  constantTimeEqual,
  hashPassword,
  normalizeEmail,
  newId,
  PASSWORD_ITERATIONS,
  randomToken,
  readCookie,
  sessionCookie,
  sessionCookieName,
  sha256,
  verifyPassword,
} from "./security";

const authRouter = new Hono<AppEnv>();
const SESSION_SQL = `
  SELECT s.id AS session_id, s.token_hash, u.id, u.email, u.display_name, u.global_role, u.must_change_password
  FROM auth_sessions s
  JOIN app_users u ON u.id = s.user_id
  WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    AND u.disabled_at IS NULL
`;

interface SessionRow {
  session_id: string;
  token_hash: string;
  id: string;
  email: string;
  display_name: string;
  global_role: GlobalRole;
  must_change_password: number;
}

interface CredentialRow extends SessionRow {
  password_hash: string;
  password_salt: string;
  iterations: number;
  disabled_at: string | null;
}

const loginSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(256),
});
const bootstrapSchema = z.object({
  email: z.string().trim().email().max(254),
  displayName: z.string().trim().min(1).max(120),
  password: z.string().min(12).max(128),
});
const changePasswordSchema = z.object({
  currentPassword: z.string().max(256).optional(),
  newPassword: z.string().min(12).max(128),
});

export async function loadActor(c: Context<AppEnv>, next: Next) {
  const token = readCookie(c.req.raw, sessionCookieName(c.env.APP_MODE));
  if (token) {
    const tokenHash = await sha256(token);
    const row = await c.env.DB.prepare(SESSION_SQL).bind(tokenHash).first<SessionRow>();
    if (row) {
      c.set("actor", actorFromRow(row));
      c.set("sessionHash", tokenHash);
      c.set("sessionId", row.session_id);
    }
  }
  await next();
}

export async function enforcePasswordChange(c: Context<AppEnv>, next: Next) {
  const actor = c.get("actor");
  const path = new URL(c.req.url).pathname;
  const allowed = ["/api/auth/session", "/api/auth/logout", "/api/auth/change-password"];
  if (actor?.mustChangePassword && !allowed.includes(path)) {
    return c.json({ error: "password_change_required" }, 403);
  }
  await next();
}

authRouter.post("/login", async (c) => {
  const parsed = loginSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return c.json({ error: "invalid_credentials" }, 400);

  const email = normalizeEmail(parsed.data.email);
  const bucketHashes = await loginBucketHashes(email, c.req.raw);
  if (await isRateLimited(c.env.DB, bucketHashes)) return c.json({ error: "invalid_credentials" }, 429);

  const row = await c.env.DB.prepare(`
    SELECT u.id, u.email, u.display_name, u.global_role, u.must_change_password, u.disabled_at,
           p.password_hash, p.password_salt, p.iterations
    FROM app_users u JOIN password_credentials p ON p.user_id = u.id
    WHERE u.email = ? COLLATE NOCASE
  `).bind(email).first<CredentialRow>();

  // Run the same work for an unknown email to avoid making account discovery cheap.
  const matches = row
    ? await verifyPassword(parsed.data.password, row.password_salt, row.password_hash, row.iterations)
    : await verifyPassword(parsed.data.password, "00000000000000000000000000000000", "0000000000000000000000000000000000000000000000000000000000000000", PASSWORD_ITERATIONS);
  if (!row || !matches || row.disabled_at) {
    await recordLoginFailure(c.env.DB, bucketHashes);
    return c.json({ error: "invalid_credentials" }, 401);
  }

  const rawToken = randomToken();
  const tokenHash = await sha256(rawToken);
  const sessionId = newId();
  await c.env.DB.prepare(`
    INSERT INTO auth_sessions (id, user_id, token_hash, expires_at)
    VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+12 hours'))
  `).bind(sessionId, row.id, tokenHash).run();
  await c.env.DB.prepare(`
    UPDATE auth_rate_limit_buckets SET failures = 0, blocked_until = NULL,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE bucket_hash = ?
  `).bind(bucketHashes[0]).run();

  c.header("Set-Cookie", sessionCookie(rawToken, c.env.APP_MODE));
  c.header("Cache-Control", "no-store");
  return c.json({ authenticated: true, actor: actorFromRow(row) });
});

authRouter.post("/bootstrap", async (c) => {
  const expectedSecret = c.env.BOOTSTRAP_SECRET;
  const suppliedSecret = c.req.header("X-Setup-Secret") ?? "";
  if (!expectedSecret || !constantTimeEqual(expectedSecret, suppliedSecret)) {
    return c.json({ error: "setup_unavailable" }, expectedSecret ? 403 : 404);
  }
  const parsed = bootstrapSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return c.json({ error: "invalid_bootstrap_details", details: parsed.error.flatten() }, 400);

  const state = await c.env.DB.prepare("SELECT state FROM system_bootstrap WHERE id = 1").first<{ state: string }>();
  if (!state || state.state !== "pending") return c.json({ error: "bootstrap_already_completed" }, 409);

  const userId = newId();
  const sessionId = newId();
  const rawToken = randomToken();
  const tokenHash = await sha256(rawToken);
  const credential = await hashPassword(parsed.data.password);
  const results = await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO app_users (id, email, display_name, global_role)
      SELECT ?, ?, ?, 'super_admin' WHERE EXISTS (SELECT 1 FROM system_bootstrap WHERE id = 1 AND state = 'pending')`)
      .bind(userId, normalizeEmail(parsed.data.email), parsed.data.displayName.trim()),
    c.env.DB.prepare(`UPDATE system_bootstrap SET state = 'claimed', user_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = 1 AND state = 'pending' AND EXISTS (SELECT 1 FROM app_users WHERE id = ?)`)
      .bind(userId, userId),
    c.env.DB.prepare(`INSERT INTO password_credentials (user_id, password_hash, password_salt, iterations)
      SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM app_users WHERE id = ?)`)
      .bind(userId, credential.hash, credential.salt, credential.iterations, userId),
    c.env.DB.prepare(`INSERT INTO audit_events (id, actor_user_id, action, subject_type, subject_id, reason, after_json)
      SELECT ?, ?, 'bootstrap_admin_created', 'user', ?, 'Initial setup', json_object('global_role', 'super_admin')
      WHERE EXISTS (SELECT 1 FROM app_users WHERE id = ?)`)
      .bind(newId(), userId, userId, userId),
    c.env.DB.prepare(`INSERT INTO auth_sessions (id, user_id, token_hash, expires_at)
      SELECT ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+12 hours')
      WHERE EXISTS (SELECT 1 FROM app_users WHERE id = ?)`)
      .bind(sessionId, userId, tokenHash, userId),
  ]);
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) return c.json({ error: "bootstrap_already_completed" }, 409);

  c.header("Set-Cookie", sessionCookie(rawToken, c.env.APP_MODE));
  c.header("Cache-Control", "no-store");
  const actor: Actor = {
    id: userId,
    email: normalizeEmail(parsed.data.email),
    displayName: parsed.data.displayName.trim(),
    globalRole: "super_admin",
    mustChangePassword: false,
  };
  return c.json({ authenticated: true, actor }, 201);
});

authRouter.post("/demo", async (c) => {
  if (c.env.APP_MODE !== "development") return c.notFound();
  const parsed = z.object({ userId: z.string().min(1).max(100) }).safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return c.json({ error: "invalid_demo_user" }, 400);

  const row = await c.env.DB.prepare(`
    SELECT id, email, display_name, global_role, must_change_password
    FROM app_users WHERE id = ? AND id GLOB 'demo-*' AND email LIKE '%@example.test' AND disabled_at IS NULL
  `).bind(parsed.data.userId).first<SessionRow>();
  if (!row) return c.json({ error: "demo_user_not_found" }, 404);

  const rawToken = randomToken();
  const tokenHash = await sha256(rawToken);
  await c.env.DB.prepare(`INSERT INTO auth_sessions (id, user_id, token_hash, expires_at)
    VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+12 hours'))`)
    .bind(newId(), row.id, tokenHash).run();
  c.header("Set-Cookie", sessionCookie(rawToken, c.env.APP_MODE));
  c.header("Cache-Control", "no-store");
  return c.json({ authenticated: true, actor: actorFromRow(row) });
});

authRouter.get("/session", async (c) => {
  c.header("Cache-Control", "no-store");
  const actor = c.get("actor");
  if (!actor) return c.json({ authenticated: false });
  const organizations = await listActorOrganizations(c.env.DB, actor);
  return c.json({ authenticated: true, actor, organizations });
});

authRouter.post("/logout", async (c) => {
  const token = readCookie(c.req.raw, sessionCookieName(c.env.APP_MODE));
  if (token) {
    await c.env.DB.prepare(`UPDATE auth_sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE token_hash = ? AND revoked_at IS NULL`).bind(await sha256(token)).run();
  }
  c.header("Set-Cookie", clearSessionCookie(c.env.APP_MODE));
  c.header("Cache-Control", "no-store");
  return c.json({ ok: true });
});

authRouter.post("/change-password", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  const parsed = changePasswordSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return c.json({ error: "invalid_password", details: parsed.error.flatten() }, 400);

  const row = await c.env.DB.prepare(`SELECT password_hash, password_salt, iterations
    FROM password_credentials WHERE user_id = ?`).bind(actor.id).first<Pick<CredentialRow, "password_hash" | "password_salt" | "iterations">>();
  if (!row) return c.json({ error: "credential_unavailable" }, 409);
  if (!actor.mustChangePassword) {
    if (!parsed.data.currentPassword || !(await verifyPassword(parsed.data.currentPassword, row.password_salt, row.password_hash, row.iterations))) {
      return c.json({ error: "current_password_invalid" }, 401);
    }
  }

  const nextCredential = await hashPassword(parsed.data.newPassword);
  const rawToken = randomToken();
  const tokenHash = await sha256(rawToken);
  const sessionId = newId();
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE password_credentials SET password_hash = ?, password_salt = ?, iterations = ?,
      changed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE user_id = ?`)
      .bind(nextCredential.hash, nextCredential.salt, nextCredential.iterations, actor.id),
    c.env.DB.prepare("UPDATE app_users SET must_change_password = 0 WHERE id = ?").bind(actor.id),
    c.env.DB.prepare(`UPDATE auth_sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE user_id = ? AND revoked_at IS NULL`).bind(actor.id),
    c.env.DB.prepare(`INSERT INTO auth_sessions (id, user_id, token_hash, expires_at)
      VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+12 hours'))`).bind(sessionId, actor.id, tokenHash),
    c.env.DB.prepare(`INSERT INTO audit_events (id, actor_user_id, action, subject_type, subject_id, reason)
      VALUES (?, ?, 'password_changed', 'user', ?, 'User changed password')`).bind(newId(), actor.id, actor.id),
  ]);
  c.header("Set-Cookie", sessionCookie(rawToken, c.env.APP_MODE));
  c.header("Cache-Control", "no-store");
  return c.json({ ok: true, actor: { ...actor, mustChangePassword: false } });
});

export function routeAuth(app: Hono<AppEnv>): void {
  app.route("/api/auth", authRouter);
}

function actorFromRow(row: Pick<SessionRow, "id" | "email" | "display_name" | "global_role" | "must_change_password">): Actor {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    globalRole: row.global_role,
    mustChangePassword: row.must_change_password === 1,
  };
}

async function listActorOrganizations(db: D1Database, actor: Actor) {
  if (actor.globalRole === "admin" || actor.globalRole === "super_admin") {
    return db.prepare(`SELECT id, name, status FROM organizations WHERE status <> 'closed' ORDER BY name`).all();
  }
  if (actor.globalRole === "pm") {
    return db.prepare(`SELECT o.id, o.name, o.status FROM organizations o JOIN pm_assignments p ON p.organization_id = o.id
      WHERE p.pm_user_id = ? AND p.ends_at IS NULL AND o.status <> 'closed' ORDER BY o.name`).bind(actor.id).all();
  }
  if (actor.globalRole === "client") {
    return db.prepare(`SELECT o.id, o.name, o.status FROM organizations o JOIN memberships m ON m.organization_id = o.id
      WHERE m.user_id = ? AND o.status <> 'closed' ORDER BY o.name`).bind(actor.id).all();
  }
  return db.prepare(`SELECT DISTINCT o.id, o.name, o.status FROM organizations o
    JOIN specialist_tasks t ON t.organization_id = o.id
    JOIN task_assignments a ON a.organization_id = t.organization_id AND a.task_id = t.id
    WHERE a.specialist_user_id = ? AND a.ended_at IS NULL AND o.status <> 'closed' ORDER BY o.name`).bind(actor.id).all();
}

async function loginBucketHashes(email: string, request: Request): Promise<[string, string]> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "local-or-unknown";
  return [await sha256(`email:${email}`), await sha256(`ip:${ip}`)];
}

async function isRateLimited(db: D1Database, hashes: string[]): Promise<boolean> {
  const placeholders = hashes.map(() => "?").join(", ");
  const row = await db.prepare(`SELECT 1 AS blocked FROM auth_rate_limit_buckets
    WHERE bucket_hash IN (${placeholders}) AND blocked_until > strftime('%Y-%m-%dT%H:%M:%fZ', 'now') LIMIT 1`)
    .bind(...hashes).first<{ blocked: number }>();
  return Boolean(row);
}

async function recordLoginFailure(db: D1Database, hashes: string[]): Promise<void> {
  await db.batch(hashes.map((hash) => db.prepare(`
    INSERT INTO auth_rate_limit_buckets (bucket_hash, failures, window_started_at, blocked_until)
    VALUES (?, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL)
    ON CONFLICT(bucket_hash) DO UPDATE SET
      failures = CASE WHEN julianday('now') - julianday(auth_rate_limit_buckets.window_started_at) > 0.0104167
        THEN 1 ELSE auth_rate_limit_buckets.failures + 1 END,
      window_started_at = CASE WHEN julianday('now') - julianday(auth_rate_limit_buckets.window_started_at) > 0.0104167
        THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE auth_rate_limit_buckets.window_started_at END,
      blocked_until = CASE WHEN (CASE WHEN julianday('now') - julianday(auth_rate_limit_buckets.window_started_at) > 0.0104167
        THEN 1 ELSE auth_rate_limit_buckets.failures + 1 END) >= 10
        THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+15 minutes') ELSE NULL END,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).bind(hash)));
}
