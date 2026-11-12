import { NextRequest, NextResponse } from "next/server";

import { config } from "@/lib/config";
import { requireUser, unauthorized } from "@/lib/session";

/**
 * GET /api/history
 *
 * Proxies the Python processor's /history endpoint and returns a paginated
 * list of past crawl jobs for the authenticated user.
 *
 * Query parameters:
 *  - limit  (1–200, default 50)
 *  - offset (default 0)
 */
export async function GET(req: NextRequest) {
  const user = requireUser(req);
  if (!user) return unauthorized();

  const { searchParams } = new URL(req.url);
  const limit = Math.min(200, Math.max(1, Number(searchParams.get("limit") ?? 50)));
  const offset = Math.max(0, Number(searchParams.get("offset") ?? 0));

  try {
    const upstream = await fetch(
      `${config.processorUrl}/history?limit=${limit}&offset=${offset}`,
      { signal: AbortSignal.timeout(10_000) },
    );

    if (!upstream.ok) {
      return NextResponse.json(
        { error: `processor returned ${upstream.status}` },
        { status: 502 },
      );
    }

    const data = await upstream.json();
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: `history unavailable: ${(err as Error).message}` },
      { status: 503 },
    );
  }
}
