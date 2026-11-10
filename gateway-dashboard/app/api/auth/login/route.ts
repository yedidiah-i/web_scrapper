import { NextRequest } from "next/server";

import {
  buildSessionCookie,
  createSession,
  verifyPassword,
} from "@/lib/auth";
import { db, type UserRow } from "@/lib/db";
import { TIERS, isTier } from "@/lib/pricing";
import { touchLastLogin } from "@/lib/users";

/** Sign in with email + password and start a session. */
export async function POST(request: NextRequest) {
  let body: { email?: unknown; password?: unknown };
  try {
    body = (await request.json()) as { email?: unknown; password?: unknown };
  } catch {
    return Response.json(
      { error: { status: 400, code: "invalid_json", message: "Body must be valid JSON." } },
      { status: 400 },
    );
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!email || !password) {
    return Response.json(
      {
        error: { status: 400, code: "missing_credentials", message: "Email and password are required." },
      },
      { status: 400 },
    );
  }

  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email) as
    | UserRow
    | undefined;

  if (!user || !verifyPassword(password, user.password_hash)) {
    return Response.json(
      {
        error: { status: 401, code: "invalid_credentials", message: "Incorrect email or password." },
      },
      { status: 401 },
    );
  }

  const { token, expiresAt } = createSession(user.id);
  touchLastLogin(user.id);

  return Response.json(
    {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        tier: user.tier,
        tier_label: isTier(user.tier) ? TIERS[user.tier].label : user.tier,
        role: user.role,
        monthly_credits: user.monthly_credits,
      },
    },
    { headers: { "Set-Cookie": buildSessionCookie(token, expiresAt) } },
  );
}
