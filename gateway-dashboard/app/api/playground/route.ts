import { config } from "@/lib/config";
import { EngineError } from "@/lib/engine";
import { performExtraction } from "@/lib/extract";
import { requireUser, unauthorized } from "@/lib/session";

const ALLOWED_TARGETS = new Set([
  "auto",
  "text",
  "tables",
  "images",
  "links",
  "metadata",
  "prices",
]);

/** Playground endpoint used by the dashboard sandbox (Step 5.2). */
export async function POST(request: Request) {
  const user = requireUser(request);
  if (!user) return unauthorized();

  let body: { urls?: unknown; url?: unknown; target?: unknown; selectors?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json(
      { error: { status: 400, code: "invalid_json", message: "Body must be valid JSON." } },
      { status: 400 },
    );
  }

  const rawUrls = Array.isArray(body.urls)
    ? body.urls
    : typeof body.url === "string"
      ? [body.url]
      : [];

  const urls = rawUrls
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);

  if (urls.length === 0) {
    return Response.json(
      { error: { status: 400, code: "missing_urls", message: "Enter at least one URL." } },
      { status: 400 },
    );
  }

  if (urls.length > config.maxUrlsPerRequest) {
    return Response.json(
      {
        error: {
          status: 400,
          code: "too_many_urls",
          message: `A maximum of ${config.maxUrlsPerRequest} URLs is allowed per request.`,
        },
      },
      { status: 400 },
    );
  }

  const target =
    typeof body.target === "string" && ALLOWED_TARGETS.has(body.target.toLowerCase())
      ? body.target.toLowerCase()
      : "auto";

  const selectors = Array.isArray(body.selectors)
    ? body.selectors
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
        .slice(0, 10)
    : [];

  try {
    const outcome = await performExtraction(user, { urls, target, selectors });

    return Response.json({
      job_id: outcome.jobId,
      status: outcome.succeeded > 0 ? "success" : "error",
      target: outcome.target,
      summary: {
        requested: urls.length,
        accepted: outcome.accepted,
        rejected: outcome.rejected,
        succeeded: outcome.succeeded,
        failed: outcome.failed,
        missing: outcome.missing,
      },
      credits_charged: outcome.creditsCharged,
      latency_ms: outcome.latencyMs,
      results: outcome.results,
    });
  } catch (error) {
    const status = error instanceof EngineError ? error.status : 500;
    return Response.json(
      {
        error: {
          status,
          code: "extraction_failed",
          message: error instanceof Error ? error.message : "Extraction failed.",
        },
      },
      { status },
    );
  }
}
