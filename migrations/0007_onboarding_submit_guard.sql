CREATE TRIGGER requests_onboarding_submit_guard
BEFORE UPDATE OF status ON requests
WHEN NEW.status = 'submitted'
  AND NOT EXISTS (
    SELECT 1 FROM onboarding_records ob
    WHERE ob.organization_id = NEW.organization_id AND ob.status = 'complete'
  )
BEGIN
  SELECT RAISE(ABORT, 'onboarding_incomplete');
END;
