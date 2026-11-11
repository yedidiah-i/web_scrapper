import { type NextRequest, NextResponse } from "next/server";

import { SESSION_COOKIE } from "@/lib/config";
import { updateSession } from "@/lib/supabase/proxy";

export async function proxy(request: NextRequest) {
  const response = await updateSession(request);
  const url = request.nextUrl.clone();

  if (!request.cookies.get(SESSION_COOKIE)?.value) {
    url.pathname = "/login";
    url.searchParams.set("next", `${request.nextUrl.pathname}${request.nextUrl.search}`);
    const redirect = NextResponse.redirect(url);
    for (const cookie of response.cookies.getAll()) {
      const { name, value, ...options } = cookie;
      redirect.cookies.set(name, value, options);
    }
    return redirect;
  }

  return response;
}

export const config = {
  matcher: ["/dashboard/:path*", "/account/:path*", "/admin/:path*"],
};
