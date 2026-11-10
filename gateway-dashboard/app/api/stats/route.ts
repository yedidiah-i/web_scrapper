import { connection } from "next/server";

import { engineHealth, processorHealth } from "@/lib/engine";
import { creditsRemaining, creditsUsedThisMonth, usageSummary } from "@/lib/ratelimit";
import { requireUser, unauthorized } from "@/lib/session";
import { isTier, TIERS } from "@/lib/pricing";

/** Usage, credits and service health for the dashboard charts (Step 5.3). */
export async function GET(request: Request) {
  await connection();

  const user = requireUser(request);
  if (!user) return unauthorized();

  const url = new URL(request.url);
  const hoursParam = Number(url.searchParams.get("hours") ?? 24);
  const hours = Number.isFinite(hoursParam)
    ? Math.min(720, Math.max(1, hoursParam))
    : 24;

  const [usage, engine, processor] = await Promise.all([
    Promise.resolve(usageSummary(user.id, hours)),
    engineHealth(),
    processorHealth(),
  ]);

  const tier = isTier(user.tier) ? TIERS[user.tier] : null;

  return Response.json(
    {
      usage,
      credits: {
        monthly_credits: user.monthly_credits,
        used: creditsUsedThisMonth(user.id),
        remaining: creditsRemaining(user),
        price_monthly_usd: tier?.priceMonthlyUsd ?? null,
      },
      tier: tier
        ? {
            id: tier.id,
            label: tier.label,
            rate_limit_per_minute: user.rate_limit_per_minute,
            concurrent_limit: user.concurrent_limit,
          }
        : null,
      services: {
        engine: engine
          ? {
              status: engine.status ?? "unknown",
              workers: engine.workers ?? null,
              queue_depth: engine.queue_depth ?? null,
              python_ingest_connected: engine.python_ingest_connected ?? null,
            }
          : { status: "unreachable" },
        processor: processor
          ? { status: processor.status ?? "unknown" }
          : { status: "unreachable" },
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
