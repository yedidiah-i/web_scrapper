import { buildClearSessionCookie, deleteSession, readSessionCookie } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const supabase = await createClient();
  await supabase.auth.signOut();
  deleteSession(readSessionCookie(request.headers.get("cookie")));

  return Response.json({ ok: true }, { headers: { "Set-Cookie": buildClearSessionCookie() } });
}
