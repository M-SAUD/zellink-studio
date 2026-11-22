ALTER TABLE app_users
  ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1));

CREATE TABLE IF NOT EXISTS password_credentials (
  user_id TEXT PRIMARY KEY REFERENCES app_users(id) ON DELETE RESTRICT,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  iterations INTEGER NOT NULL CHECK (iterations BETWEEN 100000 AND 2000000),
  changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS auth_rate_limit_buckets (
  bucket_hash TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
  window_started_at TEXT NOT NULL,
  blocked_until TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

DROP TRIGGER IF EXISTS consume_magic_link_creates_session;
DROP TABLE IF EXISTS magic_link_tokens;

DROP TRIGGER IF EXISTS lane_allocation_guard;
CREATE TRIGGER lane_allocation_guard
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
    AND e.subscription_state = 'active'
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

DROP TRIGGER IF EXISTS lane_release_guard;

CREATE TRIGGER requests_paused_insert_guard
BEFORE INSERT ON requests
WHEN EXISTS (
  SELECT 1 FROM organization_entitlements e
  WHERE e.organization_id = NEW.organization_id
    AND e.subscription_state = 'paused'
)
BEGIN
  SELECT RAISE(ABORT, 'organization_paused');
END;

CREATE TRIGGER requests_paused_submit_guard
BEFORE UPDATE OF status ON requests
WHEN NEW.status = 'submitted'
  AND EXISTS (
    SELECT 1 FROM organization_entitlements e
    WHERE e.organization_id = NEW.organization_id
      AND e.subscription_state = 'paused'
  )
BEGIN
  SELECT RAISE(ABORT, 'organization_paused');
END;
