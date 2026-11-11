import { randomBytes } from "node:crypto";
import type { User } from "@supabase/supabase-js";

import { createSession, buildSessionCookie } from "@/lib/auth";
import { db, type UserRow } from "@/lib/db";
import { createUser, findUserByEmail, findUserById, findUserBySupabaseId, setUserRole, touchLastLogin } from "@/lib/users";
import { isTier, TIERS } from "@/lib/pricing";

export function ensureLocalAccount(authUser: User): UserRow {
  if (!authUser.email) throw new Error("A verified email is required.");

  const email = authUser.email.trim().toLowerCase();
  const byId = findUserBySupabaseId(authUser.id);
  const byEmail = findUserByEmail(email);

  if (byId && byEmail && byId.id !== byEmail.id) {
    throw new Error("The Supabase identity is linked to a different local account.");
  }

  let user = byId ?? byEmail;
  if (!user) {
    const displayName =
      typeof authUser.user_metadata?.name === "string" && authUser.user_metadata.name.trim()
        ? authUser.user_metadata.name.trim().slice(0, 120)
        : email.split("@")[0].slice(0, 120);
    const bootstrapAdminEmail = (process.env.ADMIN_EMAIL ?? "futureksmeyedidiah@gmail.com").trim().toLowerCase();

    user = createUser({
      email,
      name: displayName,
      password: randomBytes(48).toString("base64url"),
      role: email === bootstrapAdminEmail ? "admin" : "user",
    });
  }

  const bootstrapAdminEmail = (process.env.ADMIN_EMAIL ?? "futureksmeyedidiah@gmail.com").trim().toLowerCase();
  const emailIsVerified = Boolean(authUser.email_confirmed_at ?? authUser.confirmed_at);
  if (email === bootstrapAdminEmail && emailIsVerified && user.role !== "admin") {
    setUserRole(user.id, "admin");
    user = findUserById(user.id) ?? user;
  }

  if (user.supabase_user_id && user.supabase_user_id !== authUser.id) {
    throw new Error("This account is already linked to another Supabase identity.");
  }

  if (user.supabase_user_id !== authUser.id) {
    db.prepare("UPDATE users SET supabase_user_id = ? WHERE id = ?").run(authUser.id, user.id);
    user = findUserById(user.id) ?? user;
  }

  touchLastLogin(user.id);
  return user;
}

export function createLocalSession(user: UserRow) {
  const { token, expiresAt } = createSession(user.id);
  const tier = isTier(user.tier) ? TIERS[user.tier] : null;

  return {
    cookie: buildSessionCookie(token, expiresAt),
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      tier: user.tier,
      tier_label: tier?.label ?? user.tier,
      role: user.role,
      monthly_credits: user.monthly_credits,
    },
  };
}
