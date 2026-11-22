CREATE TABLE onboarding_assets (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  onboarding_id TEXT NOT NULL REFERENCES onboarding_records(id) ON DELETE RESTRICT,
  uploader_user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  object_key TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  sha256 TEXT,
  scan_state TEXT NOT NULL DEFAULT 'pending_scan'
    CHECK (scan_state IN ('pending_scan', 'clean', 'rejected', 'scan_error')),
  scanner_name TEXT,
  scanner_signature_at TEXT,
  scanned_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at TEXT
);
CREATE INDEX onboarding_assets_by_org ON onboarding_assets(organization_id, onboarding_id, created_at DESC);

CREATE TRIGGER onboarding_assets_scope_guard
BEFORE INSERT ON onboarding_assets
WHEN NOT EXISTS (
  SELECT 1 FROM onboarding_records o WHERE o.id = NEW.onboarding_id AND o.organization_id = NEW.organization_id
)
BEGIN
  SELECT RAISE(ABORT, 'onboarding_asset_scope_mismatch');
END;

CREATE TABLE onboarding_file_scan_jobs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  onboarding_asset_id TEXT NOT NULL UNIQUE REFERENCES onboarding_assets(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'queued', 'scanning', 'clean', 'rejected', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX onboarding_file_scan_jobs_pending ON onboarding_file_scan_jobs(state, created_at);
