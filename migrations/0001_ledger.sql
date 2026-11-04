-- Credits ledger for app projects (one row per installed device).
CREATE TABLE IF NOT EXISTS devices (
  token      TEXT PRIMARY KEY,            -- bearer token the app stores
  project    TEXT NOT NULL,
  credits    INTEGER NOT NULL,            -- remaining
  granted    INTEGER NOT NULL,            -- lifetime: free grant + top-ups
  spent      INTEGER NOT NULL DEFAULT 0,
  day        TEXT NOT NULL DEFAULT '',    -- UTC day of day_used (YYYY-MM-DD)
  day_used   INTEGER NOT NULL DEFAULT 0,
  ip_hash    TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  last_seen  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS devices_registrations ON devices (project, ip_hash, created_at);

-- Every credit grant after the free one: top-ups, in-app purchases later.
CREATE TABLE IF NOT EXISTS grants (
  id         TEXT PRIMARY KEY,
  token      TEXT NOT NULL,
  credits    INTEGER NOT NULL,
  source     TEXT NOT NULL,               -- admin | iap:<receipt id> | ...
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS grants_token ON grants (token);
