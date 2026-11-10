import { connection } from "next/server";

import { forbidden, requireAdmin, requireUser, unauthorized } from "@/lib/session";
import { listUsers } from "@/lib/users";

/** List every account with usage rolled up (admin only). */
export async function GET(request: Request) {
  await connection();

  const user = requireAdmin(request);
  if (!user) {
    // Distinguish "not signed in" from "not an admin".
    return requireUser(request) ? forbidden() : unauthorized();
  }

  const users = listUsers();

  return Response.json(
    {
      users: users.map((row) => ({
        id: row.id,
        email: row.email,
        name: row.name,
        tier: row.tier,
        role: row.role,
        monthly_credits: row.monthly_credits,
        rate_limit_per_minute: row.rate_limit_per_minute,
        concurrent_limit: row.concurrent_limit,
        api_key_count: row.api_key_count,
        active_key_count: row.active_key_count,
        requests: row.requests,
        last_login_at: row.last_login_at,
        created_at: row.created_at,
      })),
      totals: {
        accounts: users.length,
        admins: users.filter((row) => row.role === "admin").length,
        api_keys: users.reduce((sum, row) => sum + row.api_key_count, 0),
        requests: users.reduce((sum, row) => sum + row.requests, 0),
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
