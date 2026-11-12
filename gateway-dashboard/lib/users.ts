import { hashPassword } from "./auth";
import { db, type UserRole, type UserRow } from "./db";
import { isTier, TIERS, type Tier } from "./pricing";

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Minimum password length accepted for an account. */
export const MIN_PASSWORD_LENGTH = 10;

/** Normalise an email for storage and comparison. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Check that an email is syntactically valid. */
export function isValidEmail(email: string): boolean {
  return EMAIL_PATTERN.test(normalizeEmail(email)) && email.length <= 254;
}

/**
 * Validate a signup password.
 *
 * Returns null when the password is acceptable, otherwise the reason it is
 * rejected. Length is the hard requirement; letter/number diversity is
 * encouraged but not enforced so passphrases stay usable.
 */
export function checkPasswordStrength(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > 200) {
    return "Password must be 200 characters or fewer.";
  }
  if (!/[a-zA-Z]/.test(password)) {
    return "Password must contain at least one letter.";
  }
  if (!/[0-9]/.test(password)) {
    return "Password must contain at least one number.";
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

/** Look up a user by email. */
export function findUserByEmail(email: string): UserRow | undefined {
  return db
    .prepare("SELECT * FROM users WHERE email = ?")
    .get(normalizeEmail(email)) as UserRow | undefined;
}

/** Look up a local account linked to a Supabase Auth user. */
export function findUserBySupabaseId(supabaseUserId: string): UserRow | undefined {
  return db
    .prepare("SELECT * FROM users WHERE supabase_user_id = ?")
    .get(supabaseUserId) as UserRow | undefined;
}

/** Look up a user by primary key. */
export function findUserById(id: number): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
}

/** True when the user holds the admin role. */
export function isAdmin(user: UserRow): boolean {
  return user.role === "admin";
}

/** Every account, newest first, with usage rolled up. */
export function listUsers(): Array<
  UserRow & { api_key_count: number; active_key_count: number; requests: number }
> {
  const rows = db
    .prepare(
      `SELECT u.*,
              (SELECT COUNT(*) FROM api_keys k WHERE k.user_id = u.id) AS api_key_count,
              (SELECT COUNT(*) FROM api_keys k WHERE k.user_id = u.id AND k.revoked_at IS NULL)
                AS active_key_count,
              (SELECT COUNT(*) FROM usage_ledger l WHERE l.user_id = u.id) AS requests
         FROM users u
        ORDER BY u.created_at DESC`,
    )
    .all() as Array<UserRow & { api_key_count: number; active_key_count: number; requests: number }>;

  return rows;
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                      */
/* -------------------------------------------------------------------------- */

/** Options accepted when provisioning an account. */
export type CreateUserInput = {
  email: string;
  name: string;
  password: string;
  tier?: Tier;
  role?: UserRole;
  monthlyCredits?: number;
  rateLimitPerMinute?: number;
  concurrentLimit?: number;
};

export class UserExistsError extends Error {
  constructor(email: string) {
    super(`An account already exists for ${email}.`);
    this.name = "UserExistsError";
  }
}

/**
 * Create an account.
 *
 * Tier limits are mirrored onto the row so a plan change can be rolled out
 * per account without a code deploy.
 */
export function createUser(input: CreateUserInput): UserRow {
  const email = normalizeEmail(input.email);
  const tier = input.tier ?? "hobby";
  const plan = TIERS[tier] ?? TIERS.hobby;

  if (findUserByEmail(email)) {
    throw new UserExistsError(email);
  }

  const result = db
    .prepare(
      `INSERT INTO users
         (email, name, password_hash, tier, role, monthly_credits,
          rate_limit_per_minute, concurrent_limit, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      email,
      input.name.trim(),
      hashPassword(input.password),
      tier,
      input.role ?? "user",
      input.monthlyCredits ?? plan.monthlyCredits,
      input.rateLimitPerMinute ?? plan.rateLimitPerMinute,
      input.concurrentLimit ?? plan.concurrentLimit,
      Date.now(),
    );

  const user = findUserById(Number(result.lastInsertRowid));
  if (!user) {
    throw new Error("Failed to create the account.");
  }
  return user;
}

/** Record a successful sign-in. */
export function touchLastLogin(userId: number): void {
  db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(Date.now(), userId);
}

/** Replace an account password. */
export function setUserPassword(userId: number, password: string): void {
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(
    hashPassword(password),
    userId,
  );
}

/** Update the plan of an account. */
export function setUserTier(userId: number, tier: Tier): void {
  const plan = TIERS[tier];
  db.prepare(
    `UPDATE users
        SET tier = ?, monthly_credits = ?, rate_limit_per_minute = ?, concurrent_limit = ?
      WHERE id = ?`,
  ).run(tier, plan.monthlyCredits, plan.rateLimitPerMinute, plan.concurrentLimit, userId);
}

/** Promote or demote an account between the user and admin roles. */
export function setUserRole(userId: number, role: UserRole): void {
  db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, userId);
}

/** Update the display name of an account. */
export function setUserName(userId: number, name: string): void {
  db.prepare("UPDATE users SET name = ? WHERE id = ?").run(name.trim(), userId);
}

/** Revoke every active API key of an account. */
export function revokeAllUserKeys(userId: number): number {
  const result = db
    .prepare(
      "UPDATE api_keys SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
    )
    .run(Date.now(), userId);
  return Number(result.changes);
}

/** Delete an account and everything attached to it. */
export function deleteUser(userId: number): void {
  db.prepare("DELETE FROM users WHERE id = ?").run(userId);
}

/* -------------------------------------------------------------------------- */
/* Plans                                                                       */
/* -------------------------------------------------------------------------- */

/** The tier list, re-exported so route handlers only import one module. */
export { isTier, TIERS, type Tier };
