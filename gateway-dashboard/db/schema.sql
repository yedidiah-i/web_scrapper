-- Gateway ledger schema (SQLite).
-- Shared by lib/db.ts and scripts/seed.mjs so both stay in sync.

CREATE TABLE IF NOT EXISTS users (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  email                 TEXT NOT NULL UNIQUE,
  name                  TEXT NOT NULL,
  password_hash         TEXT NOT NULL,
  tier                  TEXT NOT NULL DEFAULT 'hobby',
  role                  TEXT NOT NULL DEFAULT 'user',
  monthly_credits       INTEGER NOT NULL DEFAULT 1000,
  rate_limit_per_minute INTEGER NOT NULL DEFAULT 30,
  concurrent_limit      INTEGER NOT NULL DEFAULT 5,
  last_login_at         INTEGER,
  created_at            INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label        TEXT NOT NULL DEFAULT 'default',
  key_prefix   TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_ledger (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL,
  api_key_id      INTEGER,
  job_id          TEXT,
  urls_count      INTEGER NOT NULL DEFAULT 0,
  credits_charged INTEGER NOT NULL DEFAULT 0,
  bytes_out       INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL,
  error           TEXT,
  latency_ms      INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_user_created ON usage_ledger(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_keys_user ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
