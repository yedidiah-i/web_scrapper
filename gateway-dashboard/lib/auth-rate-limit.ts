import { createHash } from "node:crypto";

import { db } from "@/lib/db";
import { normalizeEmail } from "@/lib/users";

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 8;

function emailKey(email: string) {
  return createHash("sha256").update(normalizeEmail(email)).digest("hex");
}

export function isLoginRateLimited(email: string): boolean {
  db.prepare("DELETE FROM auth_login_attempts WHERE window_started_at < ?").run(Date.now() - 24 * 60 * 60 * 1000);
  const row = db
    .prepare("SELECT attempts, window_started_at FROM auth_login_attempts WHERE email_hash = ?")
    .get(emailKey(email)) as { attempts: number; window_started_at: number } | undefined;

  if (!row || Date.now() - row.window_started_at >= WINDOW_MS) return false;
  return row.attempts >= MAX_FAILED_ATTEMPTS;
}

export function recordFailedLogin(email: string): void {
  const key = emailKey(email);
  const now = Date.now();
  const row = db
    .prepare("SELECT attempts, window_started_at FROM auth_login_attempts WHERE email_hash = ?")
    .get(key) as { attempts: number; window_started_at: number } | undefined;

  if (!row || now - row.window_started_at >= WINDOW_MS) {
    db.prepare(
      `INSERT INTO auth_login_attempts (email_hash, attempts, window_started_at)
       VALUES (?, 1, ?)
       ON CONFLICT(email_hash) DO UPDATE SET attempts = 1, window_started_at = excluded.window_started_at`,
    ).run(key, now);
    return;
  }

  db.prepare("UPDATE auth_login_attempts SET attempts = attempts + 1 WHERE email_hash = ?").run(key);
}

export function clearLoginFailures(email: string): void {
  db.prepare("DELETE FROM auth_login_attempts WHERE email_hash = ?").run(emailKey(email));
}
