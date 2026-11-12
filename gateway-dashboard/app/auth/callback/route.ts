import { createLocalSession as issueLocalSession, ensureLocalAccount } from "@/lib/supabase/local-account";
import { createClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const requestedNext = url.searchParams.get("next");
  const next = requestedNext?.startsWith("/") && !requestedNext.startsWith("//")
    ? requestedNext
    : "/dashboard";

  if (!code) return NextResponse.redirect(new URL("/login?error=confirmation", request.url));

  const supabase = await createClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.user) {
    return NextResponse.redirect(new URL("/login?error=confirmation", request.url));
  }

  try {
    const localUser = ensureLocalAccount(data.user);
    const session = issueLocalSession(localUser);
    const response = NextResponse.redirect(new URL(next, request.url));
    response.headers.append("Set-Cookie", session.cookie);
    return response;
  } catch {
    return NextResponse.redirect(new URL("/auth/error", request.url));
  }
}
