import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import worker from "../worker/index";
import { newId, sessionCookie, sha256 } from "../worker/security";

type Fixture = {
  organizationId: string;
  projectId: string;
  adminId: string;
  pmId: string;
  ownerId: string;
};

async function createOrganization(options: { plan?: "foundation" | "growth" | "scale"; subscriptionState?: "active" | "paused"; onboardingStatus?: "complete" | "in_progress" } = {}): Promise<Fixture> {
  const organizationId = newId();
  const adminId = newId();
  const pmId = newId();
  const ownerId = newId();
  const projectId = newId();
  const onboardingId = newId();
  const assignmentId = newId();
  const plan = options.plan ?? "foundation";

  await env.DB.batch([
    env.DB.prepare(`INSERT INTO app_users (id, email, display_name, global_role) VALUES (?, ?, 'Test Admin', 'admin')`).bind(adminId, `${adminId}@test.invalid`),
    env.DB.prepare(`INSERT INTO app_users (id, email, display_name, global_role) VALUES (?, ?, 'Test PM', 'pm')`).bind(pmId, `${pmId}@test.invalid`),
    env.DB.prepare(`INSERT INTO app_users (id, email, display_name, global_role) VALUES (?, ?, 'Test Owner', 'client')`).bind(ownerId, `${ownerId}@test.invalid`),
    env.DB.prepare(`INSERT INTO organizations (id, name, status) VALUES (?, 'Test tenant', 'active')`).bind(organizationId),
    env.DB.prepare(`INSERT INTO memberships (organization_id, user_id, client_role, can_submit, can_approve, can_manage_members, invited_by)
      VALUES (?, ?, 'owner', 1, 1, 1, ?)`).bind(organizationId, ownerId, adminId),
    env.DB.prepare(`INSERT INTO pm_assignments (id, organization_id, pm_user_id, assignment_role, assigned_by, reason)
      VALUES (?, ?, ?, 'primary', ?, 'Acceptance fixture')`).bind(assignmentId, organizationId, pmId, adminId),
    env.DB.prepare(`INSERT INTO organization_entitlements (organization_id, plan_id, subscription_state, allow_new_while_paused, allow_release_while_paused, recorded_by, reason)
      VALUES (?, ?, ?, 0, 1, ?, 'Acceptance fixture')`).bind(organizationId, plan, options.subscriptionState ?? "active", adminId),
    env.DB.prepare(`INSERT INTO onboarding_records (id, organization_id, status, checklist_json, created_by)
      VALUES (?, ?, ?, '{"goals":true}', ?)`).bind(onboardingId, organizationId, options.onboardingStatus ?? "complete", ownerId),
    env.DB.prepare(`INSERT INTO projects (id, organization_id, name, created_by) VALUES (?, ?, 'Test project', ?)`).bind(projectId, organizationId, adminId),
  ]);
  return { organizationId, projectId, adminId, pmId, ownerId };
}

async function createRequest(fixture: Fixture, status: string, createdBy = fixture.ownerId) {
  const requestId = newId();
  await env.DB.prepare(`INSERT INTO requests (id, organization_id, project_id, title, status, created_by, updated_by)
    VALUES (?, ?, ?, 'Acceptance request', ?, ?, ?)`).bind(requestId, fixture.organizationId, fixture.projectId, status, createdBy, createdBy).run();
  return requestId;
}

async function expectSqlRejects(operation: Promise<unknown>, pattern: RegExp) {
  await expect(operation).rejects.toThrow(pattern);
}

async function createSession(userId: string) {
  const token = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO auth_sessions (id, user_id, token_hash, expires_at)
    VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+12 hours'))`)
    .bind(newId(), userId, await sha256(token)).run();
  return sessionCookie(token, "test").split(";", 1)[0]!;
}

async function requestAs(cookie: string, path: string, method = "GET", body?: unknown) {
  const multipart = body instanceof FormData;
  return worker.fetch(new Request(`https://zellink.test${path}`, {
    method,
    headers: { Cookie: cookie, ...(body && !multipart ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: multipart ? body : JSON.stringify(body) } : {}),
  }), env, createExecutionContext());
}

async function expectStatus(response: Response, status: number) {
  const checkNumber = (expectStatus as typeof expectStatus & { count?: number }).count = ((expectStatus as typeof expectStatus & { count?: number }).count ?? 0) + 1;
  const detail = response.headers.get("Content-Type")?.includes("json") ? await response.clone().text() : response.statusText;
  expect(response.status, `status check ${checkNumber}: ${detail}`).toBe(status);
}

afterEach(async () => {
  await env.DB.prepare(`DELETE FROM auth_sessions`).run();
});

describe("platform acceptance rules", () => {
  it("creates the first super-admin before claiming the foreign-keyed bootstrap record", async () => {
    const previous = await env.DB.prepare("SELECT user_id FROM system_bootstrap WHERE id = 1")
      .first<{ user_id: string | null }>();
    if (previous?.user_id) {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM auth_sessions WHERE user_id = ?").bind(previous.user_id),
        env.DB.prepare("DELETE FROM password_credentials WHERE user_id = ?").bind(previous.user_id),
        env.DB.prepare("DELETE FROM audit_events WHERE actor_user_id = ? AND action = 'bootstrap_admin_created'").bind(previous.user_id),
        env.DB.prepare(`UPDATE system_bootstrap SET state = 'pending', user_id = NULL,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = 1 AND user_id = ?`).bind(previous.user_id),
        env.DB.prepare("DELETE FROM app_users WHERE id = ?").bind(previous.user_id),
      ]);
    }

    const email = `bootstrap-${newId()}@test.invalid`;
    const password = "Correct Horse Battery Staple 2026!";
    const bootstrap = () => worker.fetch(new Request("https://zellink.test/api/auth/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Setup-Secret": env.BOOTSTRAP_SECRET ?? "" },
      body: JSON.stringify({ email, displayName: "Bootstrap Test", password }),
    }), env, createExecutionContext());

    const response = await bootstrap();
    await expectStatus(response, 201);
    expect(await response.json()).toMatchObject({
      authenticated: true,
      actor: { email, displayName: "Bootstrap Test", globalRole: "super_admin" },
    });
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");

    const state = await env.DB.prepare("SELECT state, user_id FROM system_bootstrap WHERE id = 1")
      .first<{ state: string; user_id: string }>();
    expect(state).toMatchObject({ state: "claimed" });
    expect(state?.user_id).toBeTruthy();

    const replay = await bootstrap();
    await expectStatus(replay, 409);
    const login = await requestAs("", "/api/auth/login", "POST", { email, password });
    await expectStatus(login, 200);
    expect(await login.json()).toMatchObject({ authenticated: true, actor: { globalRole: "super_admin" } });
  }, 30_000);

  it("reserves one lane atomically when two requests compete for Foundation capacity", async () => {
    const fixture = await createOrganization({ plan: "foundation" });
    const requests = await Promise.all([createRequest(fixture, "queued"), createRequest(fixture, "queued")]);
    const attempts = await Promise.allSettled(requests.map((requestId) => env.DB.prepare(`INSERT INTO lane_allocations
      (id, organization_id, request_id, lane_number, allocated_by) VALUES (?, ?, ?, 1, ?)`)
      .bind(newId(), fixture.organizationId, requestId, fixture.pmId).run()));
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const active = await env.DB.prepare(`SELECT COUNT(*) AS count FROM lane_allocations WHERE organization_id = ? AND released_at IS NULL`)
      .bind(fixture.organizationId).first<{ count: number }>();
    expect(active?.count).toBe(1);
  });

  it("blocks new paused work while allowing a request already waiting on the client to continue", async () => {
    const fixture = await createOrganization({ subscriptionState: "active" });
    const waitingRequestId = await createRequest(fixture, "waiting_on_client");
    await env.DB.prepare(`INSERT INTO workflow_transitions
      (organization_id, from_status, to_status, actor_role, client_visible, enabled)
      VALUES (?, 'waiting_on_client', 'submitted', 'client_owner', 1, 1)`).bind(fixture.organizationId).run();
    await env.DB.prepare(`UPDATE organization_entitlements SET subscription_state = 'paused' WHERE organization_id = ?`).bind(fixture.organizationId).run();

    const newRequest = env.DB.prepare(`INSERT INTO requests (id, organization_id, project_id, title, status, created_by)
      VALUES (?, ?, ?, 'New paused request', 'draft', ?)`)
      .bind(newId(), fixture.organizationId, fixture.projectId, fixture.ownerId).run();
    await expectSqlRejects(newRequest, /organization_paused/u);

    await env.DB.prepare(`UPDATE requests SET status = 'submitted', version = version + 1, updated_by = ?,
      last_transition_role = 'client_owner', last_transition_reason = 'Client replied'
      WHERE organization_id = ? AND id = ? AND status = 'waiting_on_client'`)
      .bind(fixture.ownerId, fixture.organizationId, waitingRequestId).run();
    const continued = await env.DB.prepare(`SELECT status FROM requests WHERE organization_id = ? AND id = ?`)
      .bind(fixture.organizationId, waitingRequestId).first<{ status: string }>();
    expect(continued?.status).toBe("submitted");
  });

  it("blocks lane allocation while paused even if the request is queued", async () => {
    const fixture = await createOrganization({ subscriptionState: "active" });
    const requestId = await createRequest(fixture, "queued");
    await env.DB.prepare(`UPDATE organization_entitlements SET subscription_state = 'paused' WHERE organization_id = ?`).bind(fixture.organizationId).run();
    const allocation = env.DB.prepare(`INSERT INTO lane_allocations (id, organization_id, request_id, lane_number, allocated_by)
      VALUES (?, ?, ?, 1, ?)`).bind(newId(), fixture.organizationId, requestId, fixture.pmId).run();
    await expectSqlRejects(allocation, /lane_unavailable_or_policy_pending/u);
  });

  it("requires a completed onboarding record before a draft can be submitted", async () => {
    const fixture = await createOrganization({ onboardingStatus: "in_progress" });
    const requestId = await createRequest(fixture, "draft");
    const submit = env.DB.prepare(`UPDATE requests SET status = 'submitted', version = version + 1, updated_by = ?,
      last_transition_role = 'client_owner' WHERE organization_id = ? AND id = ? AND status = 'draft'`)
      .bind(fixture.ownerId, fixture.organizationId, requestId).run();
    await expectSqlRejects(submit, /onboarding_incomplete/u);
  });

  it("requires a version-matched client approval before a deliverable can be approved", async () => {
    const fixture = await createOrganization();
    const requestId = await createRequest(fixture, "client_review");
    const approvalId = newId();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO workflow_transitions (organization_id, from_status, to_status, actor_role, client_visible, enabled)
        VALUES (?, 'client_review', 'approved', 'client_owner', 1, 1)`).bind(fixture.organizationId),
      env.DB.prepare(`INSERT INTO approvals (id, organization_id, request_id, approval_kind, state, submitted_version)
        VALUES (?, ?, ?, 'deliverable', 'pending', 1)`).bind(approvalId, fixture.organizationId, requestId),
    ]);
    const bypass = env.DB.prepare(`UPDATE requests SET status = 'approved', version = version + 1,
      updated_by = ?, last_transition_role = 'client_owner' WHERE organization_id = ? AND id = ?`)
      .bind(fixture.ownerId, fixture.organizationId, requestId).run();
    await expectSqlRejects(bypass, /approval_required_for_transition/u);

    await env.DB.prepare(`UPDATE approvals SET state = 'approved', decided_by = ? WHERE organization_id = ? AND id = ?`)
      .bind(fixture.ownerId, fixture.organizationId, approvalId).run();
    await env.DB.prepare(`UPDATE requests SET status = 'approved', version = version + 1,
      updated_by = ?, last_transition_role = 'client_owner' WHERE organization_id = ? AND id = ?`)
      .bind(fixture.ownerId, fixture.organizationId, requestId).run();
    const result = await env.DB.prepare(`SELECT status FROM requests WHERE organization_id = ? AND id = ?`)
      .bind(fixture.organizationId, requestId).first<{ status: string }>();
    expect(result?.status).toBe("approved");
  });

  it("hides a different organization’s requests from a client session", async () => {
    const own = await createOrganization();
    const other = await createOrganization();
    const cookie = await createSession(own.ownerId);
    const response = await requestAs(cookie, `/api/orgs/${other.organizationId}/requests`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "not_found" });
  });

  it("keeps onboarding files quarantined and tenant-scoped until an authorized clean download", async () => {
    const fixture = await createOrganization({ onboardingStatus: "in_progress" });
    const other = await createOrganization({ onboardingStatus: "in_progress" });
    const ownerCookie = await createSession(fixture.ownerId);
    const otherOwnerCookie = await createSession(other.ownerId);
    const form = new FormData();
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]);
    form.append("file", new File([pdfBytes], "brand-guidelines.pdf", { type: "application/pdf" }));
    const upload = await requestAs(ownerCookie, `/api/orgs/${fixture.organizationId}/onboarding/files`, "POST", form);
    await expectStatus(upload, 201);
    const uploaded = (await upload.json() as { file: { id: string; scanState: string } }).file;
    expect(uploaded.scanState).toBe("pending_scan");

    const listing = await requestAs(ownerCookie, `/api/orgs/${fixture.organizationId}/onboarding`);
    await expectStatus(listing, 200);
    const listed = (await listing.json() as { onboarding: { files: { id: string; scan_state: string }[] } }).onboarding.files;
    expect(listed).toEqual([expect.objectContaining({ id: uploaded.id, scan_state: "pending_scan" })]);

    const pendingDownload = await requestAs(ownerCookie, `/api/orgs/${fixture.organizationId}/onboarding/files/${uploaded.id}/download`);
    await expectStatus(pendingDownload, 404);
    const crossTenantDownload = await requestAs(otherOwnerCookie, `/api/orgs/${other.organizationId}/onboarding/files/${uploaded.id}/download`);
    await expectStatus(crossTenantDownload, 404);

    await env.DB.prepare(`UPDATE onboarding_assets SET scan_state = 'clean' WHERE organization_id = ? AND id = ?`)
      .bind(fixture.organizationId, uploaded.id).run();
    const cleanDownload = await requestAs(ownerCookie, `/api/orgs/${fixture.organizationId}/onboarding/files/${uploaded.id}/download`);
    await expectStatus(cleanDownload, 200);
    expect(new Uint8Array(await cleanDownload.arrayBuffer())).toEqual(pdfBytes);
  });

  it("suspends accounts by revoking sessions and restores new sign-in access", async () => {
    const fixture = await createOrganization();
    const adminCookie = await createSession(fixture.adminId);
    const oldPmCookie = await createSession(fixture.pmId);
    const suspended = await requestAs(adminCookie, `/api/admin/users/${fixture.pmId}/access`, "PATCH", {
      disabled: true, reason: "Temporary access review",
    });
    await expectStatus(suspended, 200);
    const oldSession = await requestAs(oldPmCookie, "/api/auth/session");
    expect(await oldSession.json()).toMatchObject({ authenticated: false });
    const blocked = await requestAs(oldPmCookie, "/api/organizations");
    await expectStatus(blocked, 401);
    const revoked = await env.DB.prepare(`SELECT revoked_at FROM auth_sessions WHERE user_id = ? AND revoked_at IS NOT NULL`)
      .bind(fixture.pmId).first<{ revoked_at: string }>();
    expect(revoked?.revoked_at).toBeTruthy();

    const restored = await requestAs(adminCookie, `/api/admin/users/${fixture.pmId}/access`, "PATCH", {
      disabled: false, reason: "Review completed",
    });
    await expectStatus(restored, 200);
    const newPmCookie = await createSession(fixture.pmId);
    const accessible = await requestAs(newPmCookie, `/api/orgs/${fixture.organizationId}/requests`);
    await expectStatus(accessible, 200);
  });

  it("resets a staff password once, revokes old sessions and requires a password change", async () => {
    const fixture = await createOrganization();
    const adminCookie = await createSession(fixture.adminId);
    const oldPmCookie = await createSession(fixture.pmId);
    const ownerCookie = await createSession(fixture.ownerId);
    const reset = await requestAs(adminCookie, `/api/admin/users/${fixture.pmId}/reset-password`, "POST", {
      reason: "The project manager cannot access their account",
    });
    await expectStatus(reset, 200);
    expect(reset.headers.get("Cache-Control")).toBe("no-store");
    const payload = await reset.json() as { user: { id: string; mustChangePassword: boolean }; temporaryPassword: string };
    expect(payload.user).toEqual({ id: fixture.pmId, mustChangePassword: true });
    expect(payload.temporaryPassword).toHaveLength(32);
    const revokedSession = await requestAs(oldPmCookie, "/api/auth/session");
    expect(await revokedSession.json()).toMatchObject({ authenticated: false });

    const login = await requestAs("", "/api/auth/login", "POST", {
      email: `${fixture.pmId}@test.invalid`, password: payload.temporaryPassword,
    });
    await expectStatus(login, 200);
    expect(await login.json()).toMatchObject({ authenticated: true, actor: { id: fixture.pmId, mustChangePassword: true } });
    const privilegedSelfReset = await requestAs(adminCookie, `/api/admin/users/${fixture.adminId}/reset-password`, "POST", { reason: "Self reset test" });
    await expectStatus(privilegedSelfReset, 403);
    const clientReset = await requestAs(ownerCookie, `/api/admin/users/${fixture.pmId}/reset-password`, "POST", { reason: "Unauthorized reset test" });
    await expectStatus(clientReset, 403);
  });

  it("lets admins provision client members and reset a client password", async () => {
    const fixture = await createOrganization();
    const adminCookie = await createSession(fixture.adminId);
    const added = await requestAs(adminCookie, `/api/orgs/${fixture.organizationId}/members`, "POST", {
      email: "new-member@test.invalid", displayName: "New Client Member", canSubmit: true, canApprove: false,
    });
    await expectStatus(added, 201);
    const created = await added.json() as { member: { id: string; email: string }; temporaryPassword: string };
    expect(created.member.email).toBe("new-member@test.invalid");
    expect(created.temporaryPassword).toHaveLength(32);

    const listing = await requestAs(adminCookie, `/api/orgs/${fixture.organizationId}/members`);
    await expectStatus(listing, 200);
    expect((await listing.json() as { members: { id: string }[] }).members).toContainEqual(expect.objectContaining({ id: created.member.id }));

    const reset = await requestAs(adminCookie, `/api/admin/users/${created.member.id}/reset-password`, "POST", {
      reason: "The client member cannot sign in",
    });
    await expectStatus(reset, 200);
    const temporaryPassword = (await reset.json() as { user: { mustChangePassword: boolean }; temporaryPassword: string }).temporaryPassword;
    const login = await requestAs("", "/api/auth/login", "POST", { email: created.member.email, password: temporaryPassword });
    await expectStatus(login, 200);
    expect(await login.json()).toMatchObject({ authenticated: true, actor: { id: created.member.id, globalRole: "client", mustChangePassword: true } });
  });

  it("gives one temporary backup PM scoped access and records the assignment history", async () => {
    const fixture = await createOrganization();
    const backupId = newId();
    await env.DB.prepare(`INSERT INTO app_users (id, email, display_name, global_role) VALUES (?, ?, 'Backup PM', 'pm')`)
      .bind(backupId, `${backupId}@test.invalid`).run();
    const adminCookie = await createSession(fixture.adminId);
    const backupCookie = await createSession(backupId);
    const assigned = await requestAs(adminCookie, `/api/admin/orgs/${fixture.organizationId}/pm-assignments`, "POST", {
      pmUserId: backupId, assignmentRole: "backup", reason: "Cover while the primary PM is away",
    });
    await expectStatus(assigned, 201);
    const requests = await requestAs(backupCookie, `/api/orgs/${fixture.organizationId}/requests`);
    await expectStatus(requests, 200);
    const history = await requestAs(adminCookie, `/api/admin/orgs/${fixture.organizationId}/history`);
    await expectStatus(history, 200);
    const assignments = (await history.json() as { pmAssignments: { pm_user_id: string; assignment_role: string; ends_at: string | null }[] }).pmAssignments;
    expect(assignments).toContainEqual(expect.objectContaining({ pm_user_id: backupId, assignment_role: "backup", ends_at: null }));

    const ended = await requestAs(adminCookie, `/api/admin/orgs/${fixture.organizationId}/pm-assignments/backup/end`, "POST", {
      reason: "Primary PM has returned",
    });
    await expectStatus(ended, 200);
    const revokedScope = await requestAs(backupCookie, `/api/orgs/${fixture.organizationId}/requests`);
    await expectStatus(revokedScope, 404);
  });

  it("reorders a queue larger than one hundred items and rejects an incomplete order", async () => {
    const fixture = await createOrganization();
    const ids = Array.from({ length: 101 }, () => newId());
    await env.DB.batch(ids.map((id, index) => env.DB.prepare(`INSERT INTO requests
      (id, organization_id, project_id, title, status, created_by, updated_by, queue_position)
      VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`)
      .bind(id, fixture.organizationId, fixture.projectId, `Queued item ${index + 1}`, fixture.ownerId, fixture.ownerId, index + 1)));
    const pmCookie = await createSession(fixture.pmId);
    const reorderedIds = [...ids].reverse();
    const reordered = await requestAs(pmCookie, `/api/orgs/${fixture.organizationId}/requests/reorder`, "POST", { requestIds: reorderedIds });
    await expectStatus(reordered, 200);
    const orderedRows = await env.DB.prepare(`SELECT id FROM requests WHERE organization_id = ? AND status = 'queued' ORDER BY queue_position`)
      .bind(fixture.organizationId).all<{ id: string }>();
    expect(orderedRows.results.map((row) => row.id)).toEqual(reorderedIds);

    const incomplete = await requestAs(pmCookie, `/api/orgs/${fixture.organizationId}/requests/reorder`, "POST", { requestIds: reorderedIds.slice(1) });
    await expectStatus(incomplete, 409);
  });

  it("runs a request from client submission through brief approval, specialist revision and final handoff", async () => {
    const fixture = await createOrganization({ plan: "foundation" });
    const specialistId = newId();
    let requestId = "";
    await env.DB.prepare(`INSERT INTO app_users (id, email, display_name, global_role) VALUES (?, ?, 'Test Specialist', 'specialist')`)
      .bind(specialistId, `${specialistId}@test.invalid`).run();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO workflow_transitions (organization_id, from_status, to_status, actor_role, client_visible, enabled) VALUES
        (?, 'draft', 'submitted', 'client_owner', 1, 1), (?, 'submitted', 'pm_review', 'pm', 0, 1),
        (?, 'pm_review', 'brief_ready', 'pm', 1, 1), (?, 'brief_ready', 'queued', 'pm', 1, 1),
        (?, 'internal_review', 'client_review', 'pm', 1, 1), (?, 'client_review', 'approved', 'client_owner', 1, 1),
        (?, 'client_review', 'revision_requested', 'client_owner', 1, 1), (?, 'revision_requested', 'in_progress', 'pm', 0, 1),
        (?, 'in_progress', 'internal_review', 'specialist', 0, 1), (?, 'approved', 'delivered', 'pm', 1, 1)`)
        .bind(...Array.from({ length: 10 }, () => fixture.organizationId)),
    ]);
    const clientCookie = await createSession(fixture.ownerId);
    const pmCookie = await createSession(fixture.pmId);
    const specialistCookie = await createSession(specialistId);

    const submitted = await requestAs(clientCookie, `/api/orgs/${fixture.organizationId}/requests`, "POST", {
      projectId: fixture.projectId, title: "Launch page", summary: "A clear first draft for the launch.",
      objective: "Help new customers understand the new product.", serviceType: "Web design", priority: "normal",
      desiredTiming: "Flexible", references: [], submit: true,
    });
    await expectStatus(submitted, 201);
    let request = (await submitted.json() as { request: { id: string; version: number; status: string } }).request;
    requestId = request.id;
    expect(request.status).toBe("submitted");
    const storedRequest = await env.DB.prepare(`SELECT status, version FROM requests WHERE organization_id = ? AND id = ?`)
      .bind(fixture.organizationId, requestId).first<{ status: string; version: number }>();
    expect({ status: request.status, version: request.version }).toEqual(storedRequest);

    const reviewed = await requestAs(pmCookie, `/api/orgs/${fixture.organizationId}/requests/${requestId}/transition`, "POST", { toStatus: "pm_review", expectedVersion: request.version });
    await expectStatus(reviewed, 200);
    request = (await reviewed.json() as { request: typeof request }).request;
    const briefResponse = await requestAs(pmCookie, `/api/orgs/${fixture.organizationId}/requests/${requestId}/briefs`, "POST", { content: "Goal: help new customers understand the product. Audience: first-time visitors. Direction: lead with the primary benefit, then show the proof points and next step." });
    await expectStatus(briefResponse, 201);
    const firstApprovals = await requestAs(clientCookie, `/api/orgs/${fixture.organizationId}/requests/${requestId}/approvals`);
    const firstApproval = (await firstApprovals.json() as { approvals: { id: string; version: number; approval_kind: string }[] }).approvals[0]!;
    expect(firstApproval.approval_kind).toBe("first_brief");
    const firstDecision = await requestAs(clientCookie, `/api/orgs/${fixture.organizationId}/requests/${requestId}/approvals/${firstApproval.id}/decision`, "POST", { decision: "approved", expectedRequestVersion: firstApproval.version });
    await expectStatus(firstDecision, 200);
    const queued = await requestAs(pmCookie, `/api/orgs/${fixture.organizationId}/requests/${requestId}/transition`, "POST", { toStatus: "queued", expectedVersion: firstApproval.version });
    await expectStatus(queued, 200);
    const queuedRequest = (await queued.json() as { request: { version: number } }).request;
    const allocation = await requestAs(pmCookie, `/api/orgs/${fixture.organizationId}/requests/${requestId}/allocate`, "POST", { expectedVersion: queuedRequest.version });
    await expectStatus(allocation, 201);

    const taskResult = await requestAs(pmCookie, `/api/orgs/${fixture.organizationId}/requests/${requestId}/tasks`, "POST", {
      title: "Design the launch page", internalScope: "Use the approved brief and the supplied product references.", specialistIds: [specialistId],
    });
    await expectStatus(taskResult, 201);
    const taskId = (await taskResult.json() as { task: { id: string } }).task.id;
    const specialistSubmission = await requestAs(specialistCookie, `/api/orgs/${fixture.organizationId}/tasks/${taskId}`, "PATCH", { status: "submitted" });
    await expectStatus(specialistSubmission, 200);

    const firstFileId = newId();
    const firstObjectKey = `org/${fixture.organizationId}/request/${requestId}/${firstFileId}`;
    await env.FILES.put(firstObjectKey, new Uint8Array([65, 66, 67]));
    await env.DB.prepare(`INSERT INTO file_versions (id, organization_id, request_id, uploader_user_id, object_key, original_name,
      media_type, byte_size, scan_state, client_visible) VALUES (?, ?, ?, ?, ?, 'launch-v1.pdf', 'application/pdf', 3, 'clean', 1)`)
      .bind(firstFileId, fixture.organizationId, requestId, fixture.pmId, firstObjectKey).run();
    const firstDelivery = await requestAs(pmCookie, `/api/orgs/${fixture.organizationId}/requests/${requestId}/submit-deliverable`, "POST", {});
    await expectStatus(firstDelivery, 201);
    let deliverableApproval = (await requestAs(clientCookie, `/api/orgs/${fixture.organizationId}/requests/${requestId}/approvals`).then((response) => response.json()) as { approvals: { id: string; version: number; approval_kind: string }[] }).approvals.find((approval) => approval.approval_kind === "deliverable")!;
    const revision = await requestAs(clientCookie, `/api/orgs/${fixture.organizationId}/requests/${requestId}/approvals/${deliverableApproval.id}/decision`, "POST", { decision: "revision_requested", note: "Please make the product benefits easier to scan.", expectedRequestVersion: deliverableApproval.version });
    await expectStatus(revision, 200);
    let currentRequest = (await requestAs(pmCookie, `/api/orgs/${fixture.organizationId}/requests`).then((response) => response.json()) as { requests: { id: string; version: number; status: string }[] }).requests.find((item) => item.id === requestId)!;
    expect(currentRequest.status).toBe("revision_requested");
    const restart = await requestAs(pmCookie, `/api/orgs/${fixture.organizationId}/requests/${requestId}/transition`, "POST", { toStatus: "in_progress", expectedVersion: currentRequest.version, reason: "Revision requested by client" });
    await expectStatus(restart, 200);
    const resubmittedTask = await requestAs(specialistCookie, `/api/orgs/${fixture.organizationId}/tasks/${taskId}`, "PATCH", { status: "submitted" });
    await expectStatus(resubmittedTask, 200);

    const secondFileId = newId();
    const secondObjectKey = `org/${fixture.organizationId}/request/${requestId}/${secondFileId}`;
    await env.FILES.put(secondObjectKey, new Uint8Array([68, 69, 70]));
    await env.DB.prepare(`INSERT INTO file_versions (id, organization_id, request_id, uploader_user_id, object_key, original_name,
      media_type, byte_size, scan_state, client_visible) VALUES (?, ?, ?, ?, ?, 'launch-v2.pdf', 'application/pdf', 3, 'clean', 1)`)
      .bind(secondFileId, fixture.organizationId, requestId, fixture.pmId, secondObjectKey).run();
    const secondDelivery = await requestAs(pmCookie, `/api/orgs/${fixture.organizationId}/requests/${requestId}/submit-deliverable`, "POST", {});
    await expectStatus(secondDelivery, 201);
    deliverableApproval = (await requestAs(clientCookie, `/api/orgs/${fixture.organizationId}/requests/${requestId}/approvals`).then((response) => response.json()) as { approvals: { id: string; version: number; approval_kind: string; state: string }[] }).approvals.find((approval) => approval.approval_kind === "deliverable" && approval.state === "pending")!;
    const approved = await requestAs(clientCookie, `/api/orgs/${fixture.organizationId}/requests/${requestId}/approvals/${deliverableApproval.id}/decision`, "POST", { decision: "approved", expectedRequestVersion: deliverableApproval.version });
    await expectStatus(approved, 200);
    currentRequest = (await requestAs(pmCookie, `/api/orgs/${fixture.organizationId}/requests`).then((response) => response.json()) as { requests: { id: string; version: number; status: string }[] }).requests.find((item) => item.id === requestId)!;
    const delivered = await requestAs(pmCookie, `/api/orgs/${fixture.organizationId}/requests/${requestId}/transition`, "POST", { toStatus: "delivered", expectedVersion: currentRequest.version });
    await expectStatus(delivered, 200);
    const released = await requestAs(pmCookie, `/api/orgs/${fixture.organizationId}/requests/${requestId}/release-lane`, "POST", { reason: "Final version delivered" });
    expect(released.status).toBe(200);
    const download = await requestAs(clientCookie, `/api/orgs/${fixture.organizationId}/files/${secondFileId}/download`);
    expect(download.status).toBe(200);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(new Uint8Array([68, 69, 70]));
  });
});
