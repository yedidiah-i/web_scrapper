import { NextRequest } from "next/server";

import { checkPasswordStrength, isValidEmail } from "@/lib/users";
import { createLocalSession, ensureLocalAccount } from "@/lib/supabase/local-account";
import { createClient } from "@/lib/supabase/server";

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
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!name || name.length > 120) {
    return Response.json(
      { error: { status: 400, code: "invalid_name", message: "Enter a name of 1–120 characters." } },
      { status: 400 },
    );
  }
  if (!isValidEmail(email)) {
    return Response.json(
      { error: { status: 400, code: "invalid_email", message: "Enter a valid email address." } },
      { status: 400 },
    );
  }
  if (password.toLowerCase() === email) {
    return Response.json(
      { error: { status: 400, code: "password_matches_email", message: "Your password must be different from your email address." } },
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

  const supabase = await createClient();
  const redirectTo =
    process.env.NEXT_PUBLIC_DEV_SUPABASE_REDIRECT_URL ??
    `${request.nextUrl.origin}/auth/callback`;
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: redirectTo, data: { name } },
  });

  if (error) {
    if (error.status === 429 || error.code === "over_email_send_rate_limit") {
      return Response.json(
        { error: { status: 429, code: "rate_limited", message: "Too many requests. Try again later." } },
        { status: 429 },
      );
    }
    if (error.code === "email_not_authorized") {
      return Response.json(
        { error: { status: 403, code: "email_not_authorized", message: "This project can only send confirmation emails to authorized addresses. Contact the project owner to configure email delivery." } },
        { status: 403 },
      );
    }
    if (error.code === "weak_password") {
      return Response.json(
        { error: { status: 400, code: "weak_password", message: "Choose a stronger password." } },
        { status: 400 },
      );
    }
    return Response.json(
      { error: { status: 500, code: "signup_unavailable", message: "Account creation is temporarily unavailable." } },
      { status: 500 },
    );
  }

  if (data.session && data.user) {
    try {
      const localUser = ensureLocalAccount(data.user);
      const session = createLocalSession(localUser);
      return Response.json({ user: session.user, confirmation_required: false }, {
        status: 201,
        headers: { "Set-Cookie": session.cookie },
      });
    } catch {
      return Response.json(
        { error: { status: 500, code: "account_unavailable", message: "Your account could not be prepared." } },
        { status: 500 },
      );
    }
  }

  return Response.json(
    { confirmation_required: true, message: "If the address can be registered, a confirmation link is on its way." },
    { status: 201 },
  );
}
