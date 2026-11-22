DROP TRIGGER IF EXISTS requests_paused_insert_guard;
CREATE TRIGGER requests_paused_insert_guard
BEFORE INSERT ON requests
WHEN EXISTS (
  SELECT 1 FROM organization_entitlements e
  WHERE e.organization_id = NEW.organization_id AND e.subscription_state = 'paused'
)
OR EXISTS (
  SELECT 1 FROM organizations o
  WHERE o.id = NEW.organization_id AND o.status IN ('paused', 'closed')
)
BEGIN
  SELECT RAISE(ABORT, 'organization_paused');
END;

DROP TRIGGER IF EXISTS requests_paused_submit_guard;
CREATE TRIGGER requests_paused_submit_guard
BEFORE UPDATE OF status ON requests
WHEN NEW.status = 'submitted'
  AND OLD.status = 'draft'
  AND (
    EXISTS (
      SELECT 1 FROM organization_entitlements e
      WHERE e.organization_id = NEW.organization_id AND e.subscription_state = 'paused'
    )
    OR EXISTS (
      SELECT 1 FROM organizations o
      WHERE o.id = NEW.organization_id AND o.status IN ('paused', 'closed')
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'organization_paused');
END;
