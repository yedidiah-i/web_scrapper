import { connection } from "next/server";

import { db } from "@/lib/db";
import { engineHealth, processorHealth } from "@/lib/engine";

/**
 * Service health.
 *
 * Reports the ledger and the two backing services. Returns 200 as long as the
 * ledger is reachable; the engine and processor are reported but do not fail
 * the check, since the dashboard stays useful while they are down.
 */
export async function GET() {
  await connection();

  let ledger = "ok";
  try {
    db.prepare("SELECT COUNT(*) AS count FROM users").get();
  } catch {
    ledger = "unreachable";
  }

  const [engine, processor] = await Promise.all([engineHealth(), processorHealth()]);

  return Response.json(
    {
      status: ledger === "ok" ? "ok" : "degraded",
      ledger,
      engine: engine ? { status: engine.status ?? "unknown" } : { status: "unreachable" },
      processor: processor
        ? { status: processor.status ?? "unknown" }
        : { status: "unreachable" },
      timestamp: new Date().toISOString(),
    },
    {
      status: ledger === "ok" ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
