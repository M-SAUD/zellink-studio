ALTER TABLE approvals ADD COLUMN submitted_version INTEGER NOT NULL DEFAULT 0 CHECK (submitted_version >= 0);

CREATE TRIGGER request_approval_guard
BEFORE UPDATE OF status ON requests
WHEN (OLD.status = 'brief_ready' AND NEW.status = 'queued'
    AND NOT EXISTS (
      SELECT 1 FROM approvals a
      WHERE a.organization_id = OLD.organization_id AND a.request_id = OLD.id
        AND a.approval_kind = 'first_brief' AND a.state = 'approved' AND a.submitted_version = OLD.version
    ))
  OR (OLD.status = 'brief_ready' AND NEW.status = 'revision_requested'
    AND NOT EXISTS (
      SELECT 1 FROM approvals a
      WHERE a.organization_id = OLD.organization_id AND a.request_id = OLD.id
        AND a.approval_kind = 'first_brief' AND a.state = 'revision_requested' AND a.submitted_version = OLD.version
    ))
  OR (OLD.status = 'client_review' AND NEW.status IN ('approved', 'revision_requested')
    AND NOT EXISTS (
      SELECT 1 FROM approvals a
      WHERE a.organization_id = OLD.organization_id AND a.request_id = OLD.id
        AND a.approval_kind = 'deliverable' AND a.state = NEW.status AND a.submitted_version = OLD.version
    ))
BEGIN
  SELECT RAISE(ABORT, 'approval_required_for_transition');
END;
