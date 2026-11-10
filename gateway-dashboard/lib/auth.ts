import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

import { config, SESSION_COOKIE } from "./config";
import { db, type ApiKeyRow, type UserRow } from "./db";

/* -------------------------------------------------------------------------- */
/* Passwords                                                                    */
/* -------------------------------------------------------------------------- */

/** Hash a password with scrypt and a random salt. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derived}`;
}

/** Constant-time password verification. */
export function verifyPassword(password: string, stored: string): boolean {
  const [salt, expected] = stored.split(":");
  if (!salt || !expected) return false;
  const derived = scryptSync(password, salt, 64);
  const expectedBuffer = Buffer.from(expected, "hex");
  if (derived.length !== expectedBuffer.length) return false;
  return timingSafeEqual(derived, expectedBuffer);
}

/* -------------------------------------------------------------------------- */
/* API keys                                                                     */
/* -------------------------------------------------------------------------- */

/** Generate a new secret API key. The plaintext is only returned once. */
export function generateApiKey(): { plaintext: string; prefix: string; hash: string } {
  const plaintext = `sk_live_${randomBytes(24).toString("base64url")}`;
  return {
    plaintext,
    prefix: `${plaintext.slice(0, 12)}...${plaintext.slice(-4)}`,
    hash: hashApiKey(plaintext),
  };
}

/** Hash an API key for storage. Plaintext keys are never persisted. */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Look up the owner of a presented API key. */
export function findUserByApiKey(key: string): { user: UserRow; apiKey: ApiKeyRow } | null {
  const row = db
    .prepare("SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL")
    .get(hashApiKey(key)) as ApiKeyRow | undefined;

  if (!row) return null;

  const user = db
    .prepare("SELECT * FROM users WHERE id = ?")
    .get(row.user_id) as UserRow | undefined;

  if (!user) return null;
  return { user, apiKey: row };
}

/** Record that an API key was used. */
export function touchApiKey(apiKeyId: number): void {
  db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(Date.now(), apiKeyId);
}

/* -------------------------------------------------------------------------- */
/* Sessions                                                                     */
/* -------------------------------------------------------------------------- */

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Create a session token for a user. The plaintext token is stored in a cookie. */
export function createSession(userId: number): { token: string; expiresAt: number } {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const expiresAt = now + config.sessionTtlMs;

  db.prepare(
    "INSERT INTO sessions (user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)",
  ).run(userId, hashToken(token), now, expiresAt);

  return { token, expiresAt };
}

/** Resolve a session token to its user. */
export function userFromSessionToken(token: string | undefined): UserRow | null {
  if (!token) return null;

  const session = db
    .prepare("SELECT * FROM sessions WHERE token_hash = ?")
    .get(hashToken(token)) as
    | { id: number; user_id: number; expires_at: number }
    | undefined;

  if (!session) return null;
  if (session.expires_at < Date.now()) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(session.id);
    return null;
  }

  const user = db
    .prepare("SELECT * FROM users WHERE id = ?")
    .get(session.user_id) as UserRow | undefined;

  return user ?? null;
}

/** Read the session cookie value from a request cookie header. */
export function readSessionCookie(cookieHeader: string | null): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

/** Build the `Set-Cookie` header value for a session cookie. */
export function buildSessionCookie(token: string, expiresAt: number): string {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    process.env.NODE_ENV === "production" ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

/** Build the `Set-Cookie` header value that clears the session. */
export function buildClearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** Remove expired sessions. */
export function pruneSessions(): void {
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
}

/** Delete the session behind a presented token. */
export function deleteSession(token: string | undefined): void {
  if (!token) return;
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
}

/**
 * Revoke every session of a user except the one behind `keepToken`.
 *
 * Used by "sign out everywhere else" on the account page. Returns the number
 * of sessions that were removed.
 */
export function revokeOtherSessions(userId: number, keepToken: string | undefined): number {
  const keepHash = keepToken ? hashToken(keepToken) : "";
  const result = db
    .prepare(
      "DELETE FROM sessions WHERE user_id = ? AND token_hash != ? AND expires_at >= ?",
    )
    .run(userId, keepHash, Date.now());
  return Number(result.changes);
}

/** Count the active sessions of a user. */
export function countActiveSessions(userId: number): number {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = ? AND expires_at >= ?")
    .get(userId, Date.now()) as { count: number };
  return row.count ?? 0;
}

/** A session row as shown on the account page. */
export type SessionSummary = {
  id: number;
  created_at: number;
  expires_at: number;
  expired: boolean;
};

/** List the sessions of a user, newest first. */
export function listUserSessions(userId: number): SessionSummary[] {
  const rows = db
    .prepare(
      "SELECT id, created_at, expires_at FROM sessions WHERE user_id = ? ORDER BY created_at DESC",
    )
    .all(userId) as Array<{ id: number; created_at: number; expires_at: number }>;

  const now = Date.now();
  return rows.map((row) => ({
    id: row.id,
    created_at: row.created_at,
    expires_at: row.expires_at,
    expired: row.expires_at < now,
  }));
}
