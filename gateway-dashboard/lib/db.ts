import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { config } from "./config";

/**
 * Additive migrations for ledgers created before a column existed.
 *
 * `db/schema.sql` only creates tables, so an existing database keeps its old
 * shape. Every migration here must be idempotent and safe to re-run.
 */
function migrate(database: DatabaseSync): void {
  const columns = new Set(
    (database.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );

  if (!columns.has("role")) {
    database.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
  }

  if (!columns.has("last_login_at")) {
    database.exec("ALTER TABLE users ADD COLUMN last_login_at INTEGER");
  }

  database.exec(
    "CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)",
  );
}

function openDatabase(): DatabaseSync {
  mkdirSync(path.dirname(config.dbPath), { recursive: true });
  const database = new DatabaseSync(config.dbPath);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  // Shared with scripts/seed.mjs so both stay in sync.
  const schema = readFileSync(path.join(process.cwd(), "db", "schema.sql"), "utf8");
  database.exec(schema);
  migrate(database);
  return database;
}

// Reuse a single connection across hot reloads in development.
const globalForDb = globalThis as unknown as { __gatewayDb?: DatabaseSync };

export const db: DatabaseSync =
  globalForDb.__gatewayDb ?? (globalForDb.__gatewayDb = openDatabase());

export type UserRole = "user" | "admin";

export type UserRow = {
  id: number;
  email: string;
  name: string;
  password_hash: string;
  tier: string;
  role: UserRole;
  monthly_credits: number;
  rate_limit_per_minute: number;
  concurrent_limit: number;
  last_login_at: number | null;
  created_at: number;
};

export type ApiKeyRow = {
  id: number;
  user_id: number;
  label: string;
  key_prefix: string;
  key_hash: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
};

export type UsageRow = {
  id: number;
  user_id: number;
  api_key_id: number | null;
  job_id: string | null;
  urls_count: number;
  credits_charged: number;
  bytes_out: number;
  status: string;
  error: string | null;
  latency_ms: number;
  created_at: number;
};
