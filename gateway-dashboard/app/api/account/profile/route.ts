import {
  readSessionCookie,
  revokeOtherSessions,
  verifyPassword,
} from "@/lib/auth";
import { requireUser, unauthorized } from "@/lib/session";
import { checkPasswordStrength, setUserName, setUserPassword } from "@/lib/users";

/**
 * Update the profile of the signed-in account.
 *
 * Accepts `name` to change the display name and `password` to set a new
 * password. A password change requires the current password.
 */
export async function PATCH(request: Request) {
  const user = requireUser(request);
  if (!user) return unauthorized();

  let body: {
    name?: unknown;
    current_password?: unknown;
    password?: unknown;
  };

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json(
      { error: { status: 400, code: "invalid_json", message: "Body must be valid JSON." } },
      { status: 400 },
    );
  }

  /* --- Display name ------------------------------------------------------ */
  if (typeof body.name === "string") {
    const name = body.name.trim();

    if (!name) {
      return Response.json(
        { error: { status: 400, code: "missing_name", message: "Name cannot be empty." } },
        { status: 400 },
      );
    }

    if (name.length > 120) {
      return Response.json(
        {
          error: {
            status: 400,
            code: "name_too_long",
            message: "Name must be 120 characters or fewer.",
          },
        },
        { status: 400 },
      );
    }

    setUserName(user.id, name);
  }

  /* --- Password ---------------------------------------------------------- */
  if (typeof body.password === "string" && body.password) {
    const currentPassword =
      typeof body.current_password === "string" ? body.current_password : "";

    if (!currentPassword) {
      return Response.json(
        {
          error: {
            status: 400,
            code: "missing_current_password",
            message: "Enter your current password to set a new one.",
          },
        },
        { status: 400 },
      );
    }

    if (!verifyPassword(currentPassword, user.password_hash)) {
      return Response.json(
        {
          error: {
            status: 401,
            code: "invalid_credentials",
            message: "Your current password is incorrect.",
          },
        },
        { status: 401 },
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
        {
          error: {
            status: 400,
            code: "password_unchanged",
            message: "The new password must differ from the current one.",
          },
        },
        { status: 400 },
      );
    }

    setUserPassword(user.id, body.password);

    // A password change ends every other session so a stolen cookie on
    // another device cannot outlive the credential it was issued against.
    revokeOtherSessions(user.id, readSessionCookie(request.headers.get("cookie")));
  }

  return Response.json({ ok: true });
}
