import { connection } from "next/server";

import { readSessionCookie, userFromSessionToken } from "@/lib/auth";
import { creditsRemaining, creditsUsedThisMonth } from "@/lib/ratelimit";
import { isTier, TIERS } from "@/lib/pricing";

/** Return the signed-in user, or 401 when there is no valid session. */
export async function GET(request: Request) {
  // Opt into request-time rendering; the session read is never cacheable.
  await connection();

  const user = userFromSessionToken(readSessionCookie(request.headers.get("cookie")));
  if (!user) {
    return Response.json(
      { error: { status: 401, code: "not_authenticated", message: "No active session." } },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const tier = isTier(user.tier) ? TIERS[user.tier] : null;

  return Response.json(
    {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        tier: user.tier,
        tier_label: tier?.label ?? user.tier,
        role: user.role,
        monthly_credits: user.monthly_credits,
        credits_used: creditsUsedThisMonth(user.id),
        credits_remaining: creditsRemaining(user),
        rate_limit_per_minute: user.rate_limit_per_minute,
        concurrent_limit: user.concurrent_limit,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
