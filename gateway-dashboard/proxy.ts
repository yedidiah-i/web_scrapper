import { NextResponse, type NextRequest } from "next/server";

import { SESSION_COOKIE } from "@/lib/config";

/**
 * Route protection.
 *
 * The dashboard, account and admin pages need a session. This performs an
 * optimistic check on the cookie: if the session cookie is missing the
 * visitor is redirected to the login page before any page renders. The
 * authoritative check still happens on the server in every route handler.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  const hasSessionCookie = Boolean(request.cookies.get(SESSION_COOKIE)?.value);

  if (!hasSessionCookie) {
    const login = new URL("/login", request.url);
    // Preserve where the visitor was heading so login can send them back.
    if (pathname !== "/") login.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(login);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*", "/account/:path*", "/admin/:path*"],
};
