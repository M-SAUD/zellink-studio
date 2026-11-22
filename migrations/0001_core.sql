PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS app_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL,
  global_role TEXT NOT NULL CHECK (global_role IN ('client', 'pm', 'specialist', 'admin', 'super_admin')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  disabled_at TEXT
);

CREATE TABLE IF NOT EXISTS magic_link_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  session_token_hash TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS magic_links_by_user ON magic_link_tokens(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS auth_sessions_by_user ON auth_sessions(user_id, revoked_at, expires_at);

CREATE TRIGGER IF NOT EXISTS consume_magic_link_creates_session
AFTER UPDATE OF used_at ON magic_link_tokens
WHEN OLD.used_at IS NULL AND NEW.used_at IS NOT NULL AND NEW.session_token_hash IS NOT NULL
BEGIN
  INSERT INTO auth_sessions (id, user_id, token_hash, expires_at)
  VALUES (lower(hex(randomblob(16))), NEW.user_id, NEW.session_token_hash, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+12 hours'));
END;

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'onboarding' CHECK (status IN ('onboarding', 'active', 'paused', 'closed')),
  industry TEXT,
  website_url TEXT,
  timezone TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (id, name)
);

CREATE TABLE IF NOT EXISTS memberships (
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  client_role TEXT NOT NULL CHECK (client_role IN ('owner', 'member')),
  can_submit INTEGER NOT NULL DEFAULT 1 CHECK (can_submit IN (0, 1)),
  can_approve INTEGER NOT NULL DEFAULT 0 CHECK (can_approve IN (0, 1)),
  can_manage_members INTEGER NOT NULL DEFAULT 0 CHECK (can_manage_members IN (0, 1)),
  can_manage_billing INTEGER NOT NULL DEFAULT 0 CHECK (can_manage_billing IN (0, 1)),
  invited_by TEXT REFERENCES app_users(id),
  joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (organization_id, user_id),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS pm_assignments (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  pm_user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  assignment_role TEXT NOT NULL CHECK (assignment_role IN ('primary', 'backup')),
  assigned_by TEXT NOT NULL REFERENCES app_users(id),
  reason TEXT,
  starts_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ends_at TEXT,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_current_primary_pm
  ON pm_assignments(organization_id) WHERE assignment_role = 'primary' AND ends_at IS NULL;
CREATE INDEX IF NOT EXISTS pm_assignments_by_pm
  ON pm_assignments(pm_user_id, ends_at, organization_id);

CREATE TABLE IF NOT EXISTS plan_catalog (
  id TEXT PRIMARY KEY CHECK (id IN ('foundation', 'growth', 'scale')),
  display_name TEXT NOT NULL,
  included_lanes INTEGER NOT NULL CHECK (included_lanes > 0),
  monthly_rate_cents INTEGER CHECK (monthly_rate_cents IS NULL OR monthly_rate_cents >= 0),
  currency_code TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);
INSERT OR IGNORE INTO plan_catalog (id, display_name, included_lanes, monthly_rate_cents)
VALUES ('foundation', 'Foundation', 1, NULL), ('growth', 'Growth', 2, NULL), ('scale', 'Scale', 3, NULL);

CREATE TABLE IF NOT EXISTS organization_entitlements (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE RESTRICT,
  plan_id TEXT REFERENCES plan_catalog(id),
  extra_lanes INTEGER NOT NULL DEFAULT 0 CHECK (extra_lanes >= 0),
  billing_period TEXT CHECK (billing_period IS NULL OR billing_period IN ('monthly', 'annual')),
  subscription_state TEXT NOT NULL DEFAULT 'pending' CHECK (subscription_state IN ('pending', 'active', 'paused', 'ended')),
  allow_new_while_paused INTEGER CHECK (allow_new_while_paused IS NULL OR allow_new_while_paused IN (0, 1)),
  allow_release_while_paused INTEGER CHECK (allow_release_while_paused IS NULL OR allow_release_while_paused IN (0, 1)),
  recorded_by TEXT REFERENCES app_users(id),
  reason TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS plan_changes (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  old_plan_id TEXT REFERENCES plan_catalog(id),
  new_plan_id TEXT REFERENCES plan_catalog(id),
  old_extra_lanes INTEGER NOT NULL DEFAULT 0,
  new_extra_lanes INTEGER NOT NULL DEFAULT 0 CHECK (new_extra_lanes >= 0),
  billing_period TEXT CHECK (billing_period IS NULL OR billing_period IN ('monthly', 'annual')),
  effective_at TEXT NOT NULL,
  recorded_by TEXT NOT NULL REFERENCES app_users(id),
  reason TEXT NOT NULL,
  payment_note TEXT,
  payment_verified INTEGER NOT NULL DEFAULT 0 CHECK (payment_verified = 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS onboarding_records (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'in_progress', 'submitted', 'pm_review', 'complete')),
  answers_json TEXT NOT NULL DEFAULT '{}',
  checklist_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL REFERENCES app_users(id),
  reviewed_by TEXT REFERENCES app_users(id),
  reviewed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  summary TEXT,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('draft', 'active', 'on_hold', 'closed')),
  created_by TEXT NOT NULL REFERENCES app_users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (organization_id, id)
);
CREATE INDEX IF NOT EXISTS projects_by_org ON projects(organization_id, state, created_at DESC);

CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  service_type TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'pm_review', 'needs_client_info', 'brief_ready', 'queued', 'in_progress', 'internal_review', 'client_review', 'revision_requested', 'approved', 'delivered', 'waiting_on_client', 'on_hold', 'cancelled')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by TEXT NOT NULL REFERENCES app_users(id),
  updated_by TEXT REFERENCES app_users(id),
  last_transition_role TEXT,
  last_transition_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at TEXT,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS requests_by_org_status ON requests(organization_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS requests_by_project ON requests(organization_id, project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS workflow_transitions (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('client_owner', 'client_member', 'pm', 'specialist', 'admin', 'super_admin')),
  client_visible INTEGER NOT NULL CHECK (client_visible IN (0, 1)),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  policy_source TEXT NOT NULL DEFAULT 'manual' CHECK (policy_source IN ('manual', 'demo', 'test')),
  configured_by TEXT REFERENCES app_users(id),
  configured_at TEXT,
  PRIMARY KEY (organization_id, from_status, to_status, actor_role),
  CHECK (from_status <> to_status)
);

CREATE TABLE IF NOT EXISTS request_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  actor_user_id TEXT REFERENCES app_users(id),
  from_status TEXT,
  to_status TEXT,
  event_type TEXT NOT NULL,
  reason TEXT,
  client_visible INTEGER NOT NULL DEFAULT 0 CHECK (client_visible IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (organization_id, request_id) REFERENCES requests(organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS request_events_by_request ON request_events(organization_id, request_id, created_at DESC);

CREATE TABLE IF NOT EXISTS brief_versions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  content TEXT NOT NULL,
  is_first_brief INTEGER NOT NULL DEFAULT 0 CHECK (is_first_brief IN (0, 1)),
  created_by TEXT NOT NULL REFERENCES app_users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (organization_id, request_id, version_number),
  FOREIGN KEY (organization_id, request_id) REFERENCES requests(organization_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  brief_version_id TEXT REFERENCES brief_versions(id) ON DELETE RESTRICT,
  approval_kind TEXT NOT NULL CHECK (approval_kind IN ('first_brief', 'deliverable', 'other')),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'revision_requested')),
  decided_by TEXT REFERENCES app_users(id),
  decision_note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  decided_at TEXT,
  FOREIGN KEY (organization_id, request_id) REFERENCES requests(organization_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS specialist_tasks (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  title TEXT NOT NULL,
  internal_scope TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'unassigned' CHECK (status IN ('unassigned', 'assigned', 'in_progress', 'internal_review', 'done', 'blocked')),
  created_by TEXT NOT NULL REFERENCES app_users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, request_id) REFERENCES requests(organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS tasks_by_request ON specialist_tasks(organization_id, request_id, status);

CREATE TABLE IF NOT EXISTS task_assignments (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  specialist_user_id TEXT NOT NULL REFERENCES app_users(id),
  assigned_by TEXT NOT NULL REFERENCES app_users(id),
  reason TEXT,
  assigned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ended_at TEXT,
  FOREIGN KEY (organization_id, task_id) REFERENCES specialist_tasks(organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS task_assignments_by_specialist ON task_assignments(specialist_user_id, ended_at, organization_id);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  author_user_id TEXT NOT NULL REFERENCES app_users(id),
  body TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('client', 'internal')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  edited_at TEXT,
  deleted_at TEXT,
  FOREIGN KEY (organization_id, request_id) REFERENCES requests(organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS comments_by_request ON comments(organization_id, request_id, created_at);

CREATE TABLE IF NOT EXISTS file_versions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  uploader_user_id TEXT NOT NULL REFERENCES app_users(id),
  object_key TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  sha256 TEXT,
  scan_state TEXT NOT NULL DEFAULT 'pending_upload' CHECK (scan_state IN ('pending_upload', 'pending_scan', 'clean', 'rejected', 'scan_error')),
  client_visible INTEGER NOT NULL DEFAULT 0 CHECK (client_visible IN (0, 1)),
  scanner_name TEXT,
  scanner_signature_at TEXT,
  scanned_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at TEXT,
  FOREIGN KEY (organization_id, request_id) REFERENCES requests(organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS files_by_request ON file_versions(organization_id, request_id, created_at DESC);

CREATE TABLE IF NOT EXISTS file_scan_jobs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  file_version_id TEXT NOT NULL UNIQUE REFERENCES file_versions(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'queued', 'scanning', 'clean', 'rejected', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS file_scan_jobs_pending ON file_scan_jobs(state, created_at);

CREATE TABLE IF NOT EXISTS lane_allocations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  lane_number INTEGER NOT NULL CHECK (lane_number > 0),
  allocated_by TEXT NOT NULL REFERENCES app_users(id),
  allocated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  released_by TEXT REFERENCES app_users(id),
  released_at TEXT,
  release_reason TEXT,
  FOREIGN KEY (organization_id, request_id) REFERENCES requests(organization_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_lane_per_request
  ON lane_allocations(organization_id, request_id) WHERE released_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS one_request_per_active_lane
  ON lane_allocations(organization_id, lane_number) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS lanes_by_org_state ON lane_allocations(organization_id, released_at, lane_number);

CREATE TABLE IF NOT EXISTS lane_allocation_history (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  allocation_id TEXT NOT NULL REFERENCES lane_allocations(id) ON DELETE RESTRICT,
  lane_number INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('allocated', 'released')),
  actor_user_id TEXT NOT NULL REFERENCES app_users(id),
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (organization_id, request_id) REFERENCES requests(organization_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  request_id TEXT,
  event_key TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (user_id, event_key),
  FOREIGN KEY (organization_id, request_id) REFERENCES requests(organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS notifications_unread ON notifications(user_id, read_at, created_at DESC);

CREATE TABLE IF NOT EXISTS notification_outbox (
  id TEXT PRIMARY KEY,
  organization_id TEXT REFERENCES organizations(id) ON DELETE RESTRICT,
  event_key TEXT NOT NULL UNIQUE,
  delivery_kind TEXT NOT NULL CHECK (delivery_kind IN ('email', 'slack')),
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'queued', 'sent', 'skipped', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS outbox_pending ON notification_outbox(state, created_at);

CREATE TABLE IF NOT EXISTS delivery_attempts (
  id TEXT PRIMARY KEY,
  outbox_id TEXT NOT NULL REFERENCES notification_outbox(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('sent', 'failed', 'skipped')),
  response_code INTEGER,
  error_message TEXT,
  attempted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (provider, idempotency_key)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT REFERENCES app_users(id),
  organization_id TEXT REFERENCES organizations(id) ON DELETE RESTRICT,
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  reason TEXT,
  before_json TEXT,
  after_json TEXT,
  client_visible INTEGER NOT NULL DEFAULT 0 CHECK (client_visible IN (0, 1)),
  request_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (organization_id, request_id) REFERENCES requests(organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS audit_by_org_created ON audit_events(organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS integration_status (
  provider_key TEXT PRIMARY KEY,
  configured INTEGER NOT NULL DEFAULT 0 CHECK (configured IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'unconfigured' CHECK (status IN ('unconfigured', 'ready', 'degraded', 'disabled')),
  last_checked_at TEXT,
  status_detail TEXT,
  updated_by TEXT REFERENCES app_users(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT OR IGNORE INTO integration_status (provider_key, configured, status)
VALUES ('auth', 0, 'unconfigured'), ('email', 0, 'unconfigured'), ('slack', 0, 'unconfigured'), ('scanner', 0, 'unconfigured');

CREATE TABLE IF NOT EXISTS policy_settings (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  policy_key TEXT NOT NULL,
  value_json TEXT,
  configured_by TEXT REFERENCES app_users(id),
  configured_at TEXT,
  PRIMARY KEY (organization_id, policy_key)
);

CREATE TRIGGER IF NOT EXISTS lane_allocation_guard
BEFORE INSERT ON lane_allocations
WHEN NOT EXISTS (
  SELECT 1
  FROM requests r
  JOIN organization_entitlements e ON e.organization_id = r.organization_id
  JOIN plan_catalog p ON p.id = e.plan_id
  WHERE r.id = NEW.request_id
    AND r.organization_id = NEW.organization_id
    AND r.status = 'queued'
    AND p.active = 1
    AND (
      e.subscription_state = 'active'
      OR (e.subscription_state = 'paused' AND e.allow_new_while_paused = 1)
    )
    AND NEW.lane_number <= p.included_lanes + e.extra_lanes
)
OR EXISTS (
  SELECT 1 FROM lane_allocations a
  WHERE a.organization_id = NEW.organization_id
    AND a.released_at IS NULL
    AND (a.request_id = NEW.request_id OR a.lane_number = NEW.lane_number)
)
BEGIN
  SELECT RAISE(ABORT, 'lane_unavailable_or_policy_pending');
END;

CREATE TRIGGER IF NOT EXISTS request_transition_guard
BEFORE UPDATE OF status ON requests
WHEN OLD.status <> NEW.status
  AND NOT (
    OLD.status = 'queued'
    AND NEW.status = 'in_progress'
    AND EXISTS (
      SELECT 1 FROM lane_allocations a
      WHERE a.organization_id = NEW.organization_id
        AND a.request_id = NEW.id
        AND a.released_at IS NULL
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM workflow_transitions t
    WHERE t.organization_id = NEW.organization_id
      AND t.from_status = OLD.status
      AND t.to_status = NEW.status
      AND t.actor_role = NEW.last_transition_role
      AND t.enabled = 1
  )
BEGIN
  SELECT RAISE(ABORT, 'workflow_transition_not_configured');
END;

CREATE TRIGGER IF NOT EXISTS request_transition_side_effects
AFTER UPDATE OF status ON requests
WHEN OLD.status <> NEW.status
BEGIN
  INSERT INTO request_events (id, organization_id, request_id, actor_user_id, from_status, to_status, event_type, reason, client_visible)
    VALUES (lower(hex(randomblob(16))), NEW.organization_id, NEW.id, NEW.updated_by, OLD.status, NEW.status,
      CASE WHEN OLD.status = 'queued' AND NEW.status = 'in_progress' THEN 'lane_allocated' ELSE 'status_changed' END,
      NEW.last_transition_reason,
      CASE WHEN OLD.status = 'queued' AND NEW.status = 'in_progress' THEN 1 ELSE COALESCE((
        SELECT client_visible FROM workflow_transitions t
        WHERE t.organization_id = NEW.organization_id
          AND t.from_status = OLD.status AND t.to_status = NEW.status
          AND t.actor_role = NEW.last_transition_role AND t.enabled = 1
      ), 0) END);

  INSERT INTO audit_events (id, actor_user_id, organization_id, action, subject_type, subject_id, reason, before_json, after_json, client_visible, request_id)
    VALUES (lower(hex(randomblob(16))), NEW.updated_by, NEW.organization_id, 'request_status_changed', 'request', NEW.id,
      NEW.last_transition_reason, json_object('status', OLD.status, 'version', OLD.version),
      json_object('status', NEW.status, 'version', NEW.version), 0, NEW.id);

  INSERT OR IGNORE INTO notifications (id, user_id, organization_id, request_id, event_key, title, body)
    SELECT lower(hex(randomblob(16))), m.user_id, NEW.organization_id, NEW.id,
      'request:' || NEW.id || ':version:' || NEW.version || ':' || m.user_id,
      'Request updated', 'The request moved to ' || replace(NEW.status, '_', ' ') || '.'
    FROM memberships m
    WHERE m.organization_id = NEW.organization_id
      AND (
        (OLD.status = 'queued' AND NEW.status = 'in_progress')
        OR EXISTS (
          SELECT 1 FROM workflow_transitions t
          WHERE t.organization_id = NEW.organization_id
            AND t.from_status = OLD.status AND t.to_status = NEW.status
            AND t.actor_role = NEW.last_transition_role
            AND t.enabled = 1 AND t.client_visible = 1
        )
      );

END;

CREATE TRIGGER IF NOT EXISTS lane_allocation_side_effects
AFTER INSERT ON lane_allocations
BEGIN
  UPDATE requests
    SET status = 'in_progress', version = version + 1, updated_by = NEW.allocated_by,
      last_transition_role = 'system_lane', last_transition_reason = NULL,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE organization_id = NEW.organization_id AND id = NEW.request_id AND status = 'queued';

  INSERT INTO lane_allocation_history (id, organization_id, request_id, allocation_id, lane_number, event_type, actor_user_id)
    VALUES (lower(hex(randomblob(16))), NEW.organization_id, NEW.request_id, NEW.id, NEW.lane_number, 'allocated', NEW.allocated_by);
END;

CREATE TRIGGER IF NOT EXISTS lane_release_guard
BEFORE UPDATE OF released_at ON lane_allocations
WHEN OLD.released_at IS NULL AND NEW.released_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM organization_entitlements e
    WHERE e.organization_id = OLD.organization_id
      AND (e.subscription_state <> 'paused' OR e.allow_release_while_paused = 1)
  )
BEGIN
  SELECT RAISE(ABORT, 'lane_release_policy_pending');
END;

CREATE TRIGGER IF NOT EXISTS lane_release_side_effects
AFTER UPDATE OF released_at ON lane_allocations
WHEN OLD.released_at IS NULL AND NEW.released_at IS NOT NULL
BEGIN
  INSERT INTO lane_allocation_history (id, organization_id, request_id, allocation_id, lane_number, event_type, actor_user_id, reason)
    VALUES (lower(hex(randomblob(16))), NEW.organization_id, NEW.request_id, NEW.id, NEW.lane_number, 'released', NEW.released_by, NEW.release_reason);

  INSERT INTO audit_events (id, actor_user_id, organization_id, action, subject_type, subject_id, reason, before_json, after_json, request_id)
    VALUES (lower(hex(randomblob(16))), NEW.released_by, NEW.organization_id, 'lane_released', 'request', NEW.request_id, NEW.release_reason,
      json_object('allocation_id', NEW.id, 'lane_number', NEW.lane_number), json_object('released_at', NEW.released_at), NEW.request_id);
END;

CREATE TRIGGER IF NOT EXISTS entitlement_capacity_guard
BEFORE UPDATE OF plan_id, extra_lanes ON organization_entitlements
WHEN COALESCE((SELECT included_lanes FROM plan_catalog WHERE id = NEW.plan_id), 0) + NEW.extra_lanes
  < (SELECT COUNT(*) FROM lane_allocations WHERE organization_id = OLD.organization_id AND released_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'capacity_below_active_lanes');
END;
