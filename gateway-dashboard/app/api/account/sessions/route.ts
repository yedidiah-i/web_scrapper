import { listUserSessions, readSessionCookie, revokeOtherSessions } from "@/lib/auth";
import { requireUser, unauthorized } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const user = requireUser(request);
  if (!user) return unauthorized();

  return Response.json(
    { sessions: listUserSessions(user.id) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function DELETE(request: Request) {
  const user = requireUser(request);
  if (!user) return unauthorized();

  const revoked = revokeOtherSessions(
    user.id,
    readSessionCookie(request.headers.get("cookie")),
  );
  const supabase = await createClient();
  await supabase.auth.signOut({ scope: "others" });

  return Response.json({ revoked });
}
