CREATE UNIQUE INDEX one_current_backup_pm
  ON pm_assignments(organization_id)
  WHERE assignment_role = 'backup' AND ends_at IS NULL;
