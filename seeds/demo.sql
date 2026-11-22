PRAGMA foreign_keys = ON;

INSERT OR IGNORE INTO app_users (id, email, display_name, global_role) VALUES
  ('demo-admin', 'morgan.admin@example.test', 'Morgan Lane', 'admin'),
  ('demo-super-admin', 'root.admin@example.test', 'Alex Morgan', 'super_admin'),
  ('demo-pm', 'avery.pm@example.test', 'Avery Chen', 'pm'),
  ('demo-specialist', 'samir.specialist@example.test', 'Samir Patel', 'specialist'),
  ('demo-client-owner', 'jordan.owner@example.test', 'Jordan Lee', 'client'),
  ('demo-client-member', 'taylor.member@example.test', 'Taylor West', 'client');

INSERT OR IGNORE INTO organizations (id, name, status, industry, website_url, timezone)
VALUES ('demo-morrow-goods', 'Morrow Goods', 'active', 'Retail', 'https://example.test/morrow-goods', 'Asia/Colombo');

INSERT OR IGNORE INTO memberships
  (organization_id, user_id, client_role, can_submit, can_approve, can_manage_members, can_manage_billing)
VALUES
  ('demo-morrow-goods', 'demo-client-owner', 'owner', 1, 1, 1, 1),
  ('demo-morrow-goods', 'demo-client-member', 'member', 1, 0, 0, 0);

INSERT OR IGNORE INTO pm_assignments (id, organization_id, pm_user_id, assignment_role, assigned_by, reason)
VALUES ('demo-pm-assignment', 'demo-morrow-goods', 'demo-pm', 'primary', 'demo-admin', 'Synthetic demo setup');

INSERT OR IGNORE INTO organization_entitlements
  (organization_id, plan_id, extra_lanes, billing_period, subscription_state, recorded_by, reason)
VALUES ('demo-morrow-goods', 'growth', 0, NULL, 'active', 'demo-admin', 'Synthetic demo capacity; plan price is intentionally unset');

INSERT OR IGNORE INTO onboarding_records (id, organization_id, status, answers_json, checklist_json, created_by)
VALUES
  ('demo-onboarding', 'demo-morrow-goods', 'complete',
   '{"business":"Morrow Goods","goal":"Example launch work only"}',
   '{"access":true,"brand_assets":true,"approval_contact":true}', 'demo-client-owner');

INSERT OR IGNORE INTO projects (id, organization_id, name, summary, state, created_by)
VALUES ('demo-project-brand', 'demo-morrow-goods', 'Brand launch', 'Fictional sample project for the local demo.', 'active', 'demo-client-owner');

INSERT OR IGNORE INTO requests (id, organization_id, project_id, title, summary, service_type, status, created_by)
VALUES
  ('demo-request-review', 'demo-morrow-goods', 'demo-project-brand', 'Brand launch page', 'Review the first sample page direction.', 'Web design', 'queued', 'demo-client-owner'),
  ('demo-request-progress', 'demo-morrow-goods', 'demo-project-brand', 'Welcome email series', 'Draft three sample welcome emails.', 'Email strategy', 'queued', 'demo-client-owner'),
  ('demo-request-queued', 'demo-morrow-goods', 'demo-project-brand', 'Product story kit', 'Prepare a sample product story outline.', 'Brand strategy', 'queued', 'demo-client-owner');

INSERT OR IGNORE INTO lane_allocations (id, organization_id, request_id, lane_number, allocated_by)
SELECT 'demo-allocation-review', 'demo-morrow-goods', 'demo-request-review', 1, 'demo-pm'
WHERE NOT EXISTS (SELECT 1 FROM lane_allocations WHERE id = 'demo-allocation-review')
  AND EXISTS (SELECT 1 FROM requests WHERE organization_id = 'demo-morrow-goods' AND id = 'demo-request-review' AND status = 'queued');

INSERT OR IGNORE INTO lane_allocations (id, organization_id, request_id, lane_number, allocated_by)
SELECT 'demo-allocation-progress', 'demo-morrow-goods', 'demo-request-progress', 2, 'demo-pm'
WHERE NOT EXISTS (SELECT 1 FROM lane_allocations WHERE id = 'demo-allocation-progress')
  AND EXISTS (SELECT 1 FROM requests WHERE organization_id = 'demo-morrow-goods' AND id = 'demo-request-progress' AND status = 'queued');

INSERT OR IGNORE INTO brief_versions (id, organization_id, request_id, version_number, content, is_first_brief, created_by)
VALUES
  ('demo-brief-v1', 'demo-morrow-goods', 'demo-request-review', 1, 'A fictional launch page brief used only to demonstrate the review flow.', 1, 'demo-pm');

INSERT OR IGNORE INTO approvals
  (id, organization_id, request_id, brief_version_id, approval_kind, state, decided_by, decision_note, decided_at)
VALUES
  ('demo-first-brief-approval', 'demo-morrow-goods', 'demo-request-review', 'demo-brief-v1', 'first_brief', 'approved', 'demo-client-owner', 'Synthetic demo approval.', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT OR IGNORE INTO specialist_tasks (id, organization_id, request_id, title, internal_scope, status, created_by)
VALUES ('demo-task-email-draft', 'demo-morrow-goods', 'demo-request-progress', 'Draft email sequence', 'Internal work assignment for demo only.', 'in_progress', 'demo-pm');

INSERT OR IGNORE INTO task_assignments (id, organization_id, task_id, specialist_user_id, assigned_by, reason)
VALUES ('demo-task-assignment', 'demo-morrow-goods', 'demo-task-email-draft', 'demo-specialist', 'demo-pm', 'Synthetic demo assignment');

INSERT OR IGNORE INTO comments (id, organization_id, request_id, author_user_id, body, visibility)
VALUES ('demo-comment-review', 'demo-morrow-goods', 'demo-request-review', 'demo-pm', 'This is fictional sample activity. Approve the first direction or request a revision.', 'client');

INSERT OR IGNORE INTO workflow_transitions
  (organization_id, from_status, to_status, actor_role, client_visible, enabled, policy_source)
VALUES
  ('demo-morrow-goods', 'draft', 'submitted', 'client_owner', 1, 1, 'demo'),
  ('demo-morrow-goods', 'draft', 'submitted', 'client_member', 1, 1, 'demo'),
  ('demo-morrow-goods', 'submitted', 'pm_review', 'pm', 0, 1, 'demo'),
  ('demo-morrow-goods', 'pm_review', 'needs_client_info', 'pm', 1, 1, 'demo'),
  ('demo-morrow-goods', 'needs_client_info', 'submitted', 'client_owner', 1, 1, 'demo'),
  ('demo-morrow-goods', 'needs_client_info', 'submitted', 'client_member', 1, 1, 'demo'),
  ('demo-morrow-goods', 'pm_review', 'brief_ready', 'pm', 1, 1, 'demo'),
  ('demo-morrow-goods', 'brief_ready', 'queued', 'client_owner', 1, 1, 'demo'),
  ('demo-morrow-goods', 'brief_ready', 'queued', 'client_member', 1, 1, 'demo'),
  ('demo-morrow-goods', 'in_progress', 'internal_review', 'specialist', 0, 1, 'demo'),
  ('demo-morrow-goods', 'in_progress', 'internal_review', 'pm', 0, 1, 'demo'),
  ('demo-morrow-goods', 'internal_review', 'in_progress', 'pm', 0, 1, 'demo'),
  ('demo-morrow-goods', 'internal_review', 'client_review', 'pm', 1, 1, 'demo'),
  ('demo-morrow-goods', 'client_review', 'revision_requested', 'client_owner', 1, 1, 'demo'),
  ('demo-morrow-goods', 'client_review', 'revision_requested', 'client_member', 1, 1, 'demo'),
  ('demo-morrow-goods', 'client_review', 'approved', 'client_owner', 1, 1, 'demo'),
  ('demo-morrow-goods', 'revision_requested', 'in_progress', 'pm', 0, 1, 'demo'),
  ('demo-morrow-goods', 'approved', 'delivered', 'pm', 1, 1, 'demo'),
  ('demo-morrow-goods', 'in_progress', 'on_hold', 'pm', 1, 1, 'demo'),
  ('demo-morrow-goods', 'on_hold', 'in_progress', 'pm', 0, 1, 'demo');

UPDATE requests
SET status = 'internal_review', version = version + 1, updated_by = 'demo-pm', last_transition_role = 'pm',
    last_transition_reason = 'Synthetic sample activity', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 'demo-request-review' AND organization_id = 'demo-morrow-goods' AND status = 'in_progress';

UPDATE requests
SET status = 'client_review', version = version + 1, updated_by = 'demo-pm', last_transition_role = 'pm',
    last_transition_reason = 'Synthetic sample activity', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 'demo-request-review' AND organization_id = 'demo-morrow-goods' AND status = 'internal_review';
