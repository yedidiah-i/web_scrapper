import { NextRequest } from "next/server";

import { createLocalSession, ensureLocalAccount } from "@/lib/supabase/local-account";
import { createClient } from "@/lib/supabase/server";
import { clearLoginFailures, isLoginRateLimited, recordFailedLogin } from "@/lib/auth-rate-limit";

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
      { error: { status: 400, code: "missing_credentials", message: "Email and password are required." } },
      { status: 400 },
    );
  }

  if (isLoginRateLimited(email)) {
    return Response.json(
      { error: { status: 429, code: "rate_limited", message: "Too many sign-in attempts. Try again in 15 minutes." } },
      { status: 429 },
    );
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    if (error.code === "email_not_confirmed") {
      return Response.json(
        { error: { status: 403, code: "email_not_confirmed", message: "Confirm your email using the link we sent before signing in." } },
        { status: 403 },
      );
    }
    if (error.status === 429) {
      return Response.json(
        { error: { status: 429, code: "rate_limited", message: "Too many sign-in attempts. Try again shortly." } },
        { status: 429 },
      );
    }
    if (error.code === "invalid_credentials" || error.code === "user_not_found") {
      recordFailedLogin(email);
      return Response.json(
        { error: { status: 401, code: "invalid_credentials", message: "Invalid email or password." } },
        { status: 401 },
      );
    }
    return Response.json(
      { error: { status: 500, code: "auth_unavailable", message: "Sign in is temporarily unavailable." } },
      { status: 500 },
    );
  }

  if (!data.user) {
    return Response.json(
      { error: { status: 401, code: "invalid_credentials", message: "Invalid email or password." } },
      { status: 401 },
    );
  }

  clearLoginFailures(email);
  try {
    const localUser = ensureLocalAccount(data.user);
    const session = createLocalSession(localUser);
    return Response.json({ user: session.user }, { headers: { "Set-Cookie": session.cookie } });
  } catch {
    return Response.json(
      { error: { status: 500, code: "account_unavailable", message: "Your account could not be loaded." } },
      { status: 500 },
    );
  }
}
