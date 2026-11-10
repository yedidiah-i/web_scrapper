import { listUserSessions, readSessionCookie, revokeOtherSessions } from "@/lib/auth";
import { requireUser, unauthorized } from "@/lib/session";

/** List the sessions of the signed-in account. */
export async function GET(request: Request) {
  const user = requireUser(request);
  if (!user) return unauthorized();

  return Response.json(
    { sessions: listUserSessions(user.id) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** Revoke every session of the signed-in account except the current one. */
export async function DELETE(request: Request) {
  const user = requireUser(request);
  if (!user) return unauthorized();

  const revoked = revokeOtherSessions(
    user.id,
    readSessionCookie(request.headers.get("cookie")),
  );

  return Response.json({ revoked });
}
