-- App Store subscriptions, one row per (Apple subscription, device): the
-- same Apple ID's subscription restored on a second phone links there too.
CREATE TABLE IF NOT EXISTS subscriptions (
  original_transaction_id TEXT NOT NULL,
  token       TEXT NOT NULL,
  project     TEXT NOT NULL,
  product_id  TEXT NOT NULL,
  expires_ms  INTEGER NOT NULL,
  revoked     INTEGER NOT NULL DEFAULT 0,
  environment TEXT NOT NULL DEFAULT '',   -- Production | Sandbox
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (original_transaction_id, token)
);
CREATE INDEX IF NOT EXISTS subscriptions_token ON subscriptions (token, project);
