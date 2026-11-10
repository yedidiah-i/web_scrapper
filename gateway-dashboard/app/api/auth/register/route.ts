import { NextRequest } from "next/server";

import { buildSessionCookie, createSession, generateApiKey } from "@/lib/auth";
import { db } from "@/lib/db";
import { TIERS, isTier } from "@/lib/pricing";
import {
  UserExistsError,
  checkPasswordStrength,
  createUser,
  isValidEmail,
  touchLastLogin,
} from "@/lib/users";

/**
 * Create an account.
 *
 * New accounts land on the Hobby plan. A successful signup starts a session
 * immediately so the user lands in the dashboard without signing in again.
 */
export async function POST(request: NextRequest) {
  let body: { name?: unknown; email?: unknown; password?: unknown };
  try {
    body = (await request.json()) as { name?: unknown; email?: unknown; password?: unknown };
  } catch {
    return Response.json(
      { error: { status: 400, code: "invalid_json", message: "Body must be valid JSON." } },
      { status: 400 },
    );
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!name) {
    return Response.json(
      { error: { status: 400, code: "missing_name", message: "Your name is required." } },
      { status: 400 },
    );
  }

  if (name.length > 120) {
    return Response.json(
      { error: { status: 400, code: "name_too_long", message: "Name must be 120 characters or fewer." } },
      { status: 400 },
    );
  }

  if (!email) {
    return Response.json(
      { error: { status: 400, code: "missing_email", message: "Email is required." } },
      { status: 400 },
    );
  }

  if (!isValidEmail(email)) {
    return Response.json(
      { error: { status: 400, code: "invalid_email", message: "Enter a valid email address." } },
      { status: 400 },
    );
  }

  if (!password) {
    return Response.json(
      { error: { status: 400, code: "missing_password", message: "Password is required." } },
      { status: 400 },
    );
  }

  const weak = checkPasswordStrength(password);
  if (weak) {
    return Response.json(
      { error: { status: 400, code: "weak_password", message: weak } },
      { status: 400 },
    );
  }

  let user;
  try {
    user = createUser({ name, email, password });
  } catch (error) {
    if (error instanceof UserExistsError) {
      return Response.json(
        {
          error: {
            status: 409,
            code: "email_taken",
            message: "An account already exists for that email. Sign in instead.",
          },
        },
        { status: 409 },
      );
    }
    throw error;
  }

  // Give every new account a first API key so the dashboard is immediately
  // useful. The plaintext is returned once and only its hash is stored.
  const key = generateApiKey();
  db.prepare(
    `INSERT INTO api_keys (user_id, label, key_prefix, key_hash, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(user.id, "default", key.prefix, key.hash, Date.now());

  touchLastLogin(user.id);

  const { token, expiresAt } = createSession(user.id);
  const tier = isTier(user.tier) ? TIERS[user.tier] : null;

  return Response.json(
    {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        tier: user.tier,
        tier_label: tier?.label ?? user.tier,
        role: user.role,
        monthly_credits: user.monthly_credits,
      },
      api_key: key.plaintext,
    },
    { status: 201, headers: { "Set-Cookie": buildSessionCookie(token, expiresAt) } },
  );
}
