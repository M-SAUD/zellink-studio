CREATE TABLE IF NOT EXISTS system_bootstrap (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state TEXT NOT NULL CHECK (state IN ('pending', 'claimed')),
  user_id TEXT REFERENCES app_users(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((state = 'pending' AND user_id IS NULL) OR (state = 'claimed' AND user_id IS NOT NULL))
);

INSERT OR IGNORE INTO system_bootstrap (id, state) VALUES (1, 'pending');
