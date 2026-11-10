import type { UserRow } from "./db";
import { readSessionCookie, userFromSessionToken } from "./auth";

/**
 * Resolve the signed-in user from a request.
 *
 * Returns null when there is no valid session; route handlers turn that into
 * a 401 response.
 */
export function requireUser(request: Request): UserRow | null {
  return userFromSessionToken(readSessionCookie(request.headers.get("cookie")));
}

/** Standard 401 payload used across the dashboard API. */
export function unauthorized() {
  return Response.json(
    { error: { status: 401, code: "not_authenticated", message: "Sign in to continue." } },
    { status: 401, headers: { "Cache-Control": "no-store" } },
  );
}

/** Standard 403 payload used by the admin API. */
export function forbidden() {
  return Response.json(
    {
      error: {
        status: 403,
        code: "admin_required",
        message: "This action requires an administrator account.",
      },
    },
    { status: 403, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * Resolve the signed-in user and require the admin role.
 *
 * Returns null when there is no session or the account is not an admin;
 * route handlers turn that into 401 or 403.
 */
export function requireAdmin(request: Request): UserRow | null {
  const user = requireUser(request);
  if (!user || user.role !== "admin") return null;
  return user;
}
