CREATE TRIGGER onboarding_scan_job_scope_guard
BEFORE INSERT ON onboarding_file_scan_jobs
WHEN NOT EXISTS (
  SELECT 1 FROM onboarding_assets a
  WHERE a.id = NEW.onboarding_asset_id AND a.organization_id = NEW.organization_id
)
BEGIN
  SELECT RAISE(ABORT, 'onboarding_scan_job_scope_mismatch');
END;
