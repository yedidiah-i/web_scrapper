import { buildClearSessionCookie, deleteSession, readSessionCookie } from "@/lib/auth";

/** End the current session. */
export async function POST(request: Request) {
  deleteSession(readSessionCookie(request.headers.get("cookie")));

  return Response.json({ ok: true }, { headers: { "Set-Cookie": buildClearSessionCookie() } });
}
