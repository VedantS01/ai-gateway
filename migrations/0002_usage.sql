-- Token usage per project, day and model: what the provider bill will say.
CREATE TABLE IF NOT EXISTS usage_daily (
  project           TEXT NOT NULL,
  day               TEXT NOT NULL,   -- UTC YYYY-MM-DD
  model             TEXT NOT NULL,
  calls             INTEGER NOT NULL DEFAULT 0,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  devices           INTEGER NOT NULL DEFAULT 0,   -- distinct devices that day (approximate: first call per device per day)
  PRIMARY KEY (project, day, model)
);
