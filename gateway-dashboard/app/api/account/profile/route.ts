import { readSessionCookie, revokeOtherSessions } from "@/lib/auth";
import { requireUser, unauthorized } from "@/lib/session";
import { checkPasswordStrength, setUserName, setUserPassword } from "@/lib/users";
import { createClient } from "@/lib/supabase/server";

export async function PATCH(request: Request) {
  const user = requireUser(request);
  if (!user) return unauthorized();

  let body: { name?: unknown; current_password?: unknown; password?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json(
      { error: { status: 400, code: "invalid_json", message: "Body must be valid JSON." } },
      { status: 400 },
    );
  }

  const supabase = await createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return unauthorized();

  if (typeof body.name === "string") {
    const name = body.name.trim();
    if (!name || name.length > 120) {
      return Response.json(
        { error: { status: 400, code: "invalid_name", message: "Enter a name of 1–120 characters." } },
        { status: 400 },
      );
    }

    const { error } = await supabase.auth.updateUser({ data: { name } });
    if (error) {
      return Response.json(
        { error: { status: 500, code: "profile_unavailable", message: "Could not update your profile." } },
        { status: 500 },
      );
    }
    setUserName(user.id, name);
  }

  if (typeof body.password === "string" && body.password) {
    const currentPassword = typeof body.current_password === "string" ? body.current_password : "";
    if (!currentPassword) {
      return Response.json(
        { error: { status: 400, code: "missing_current_password", message: "Enter your current password to set a new one." } },
        { status: 400 },
      );
    }

    if (body.password.toLowerCase() === user.email.toLowerCase()) {
      return Response.json(
        { error: { status: 400, code: "password_matches_email", message: "Your password must be different from your email address." } },
        { status: 400 },
      );
    }

    const weak = checkPasswordStrength(body.password);
    if (weak) {
      return Response.json(
        { error: { status: 400, code: "weak_password", message: weak } },
        { status: 400 },
      );
    }
    if (body.password === currentPassword) {
      return Response.json(
        { error: { status: 400, code: "password_unchanged", message: "The new password must differ from the current one." } },
        { status: 400 },
      );
    }
    if (!authData.user.email) return unauthorized();

    const { error: verifyError } = await supabase.auth.signInWithPassword({
      email: authData.user.email,
      password: currentPassword,
    });
    if (verifyError) {
      return Response.json(
        { error: { status: 401, code: "invalid_credentials", message: "Your current password is incorrect." } },
        { status: 401 },
      );
    }

    const { error: updateError } = await supabase.auth.updateUser({ password: body.password });
    if (updateError) {
      return Response.json(
        { error: { status: 400, code: "password_update_failed", message: "Could not update your password. Try a stronger password." } },
        { status: 400 },
      );
    }

    setUserPassword(user.id, body.password);
    revokeOtherSessions(user.id, readSessionCookie(request.headers.get("cookie")));
    await supabase.auth.signOut({ scope: "others" });
  }

  return Response.json({ ok: true });
}
