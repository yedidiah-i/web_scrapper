import { NextRequest, NextResponse } from "next/server";

import { config } from "@/lib/config";
import { requireUser, unauthorized } from "@/lib/session";

/**
 * GET /api/history/[job_id]
 *
 * Returns the compact history entry for a single crawl job, including the
 * top-5 results summary stored at completion time.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ job_id: string }> },
) {
  const user = requireUser(req);
  if (!user) return unauthorized();

  const { job_id } = await params;

  try {
    const upstream = await fetch(
      `${config.processorUrl}/history/${job_id}`,
      { signal: AbortSignal.timeout(10_000) },
    );

    if (upstream.status === 404) {
      return NextResponse.json({ error: "history entry not found" }, { status: 404 });
    }
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
