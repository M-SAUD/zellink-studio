ALTER TABLE requests ADD COLUMN objective TEXT NOT NULL DEFAULT '';
ALTER TABLE requests ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high'));
ALTER TABLE requests ADD COLUMN desired_timing TEXT;
ALTER TABLE requests ADD COLUMN references_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE requests ADD COLUMN queue_position INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS requests_queue_order
  ON requests(organization_id, status, queue_position, created_at);
