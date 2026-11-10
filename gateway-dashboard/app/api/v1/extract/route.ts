import { NextRequest } from "next/server";

import { config } from "@/lib/config";
import { findUserByApiKey, touchApiKey } from "@/lib/auth";
import { EngineError } from "@/lib/engine";
import { performExtraction } from "@/lib/extract";
import {
  acquireSlot,
  creditsRemaining,
  releaseSlot,
  requestsInLastMinute,
  recordUsage,
} from "@/lib/ratelimit";

const ALLOWED_TARGETS = new Set([
  "auto",
  "text",
  "tables",
  "images",
  "links",
  "metadata",
  "prices",
]);

type ExtractRequestBody = {
  urls?: unknown;
  url?: unknown;
  target?: unknown;
  selectors?: unknown;
};

function jsonError(status: number, code: string, message: string, extra?: Record<string, unknown>) {
  return Response.json(
    { error: { status, code, message, ...(extra ?? {}) } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * Public extraction endpoint (Step 4.1).
 *
 * Flow: validate the bearer key -> check credits, rate limit and concurrency
 * -> forward the job to the Rust core queue -> wait for the transformed
 * payload from the Python processor -> meter the usage.
 */
export async function POST(request: NextRequest) {
  const startedAt = Date.now();

  // --- API key validation (Step 4.2) ------------------------------------- //
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());

  if (!match) {
    return jsonError(
      401,
      "missing_api_key",
      "Provide an API key as 'Authorization: Bearer <KEY>'.",
    );
  }

  const authenticated = findUserByApiKey(match[1].trim());
  if (!authenticated) {
    return jsonError(401, "invalid_api_key", "The supplied API key is not valid.");
  }

  const { user, apiKey } = authenticated;
  touchApiKey(apiKey.id);

  // --- Credit, rate and concurrency checks (Step 4.3) -------------------- //
  const remaining = creditsRemaining(user);
  if (remaining <= 0) {
    return jsonError(
      429,
      "credits_exhausted",
      "Your monthly credit allowance is exhausted.",
      { monthly_credits: user.monthly_credits },
    );
  }

  const usedThisMinute = requestsInLastMinute(user.id);
  if (usedThisMinute >= user.rate_limit_per_minute) {
    return jsonError(
      429,
      "rate_limit_exceeded",
      `Rate limit of ${user.rate_limit_per_minute} requests/minute exceeded.`,
      { limit: user.rate_limit_per_minute, retry_after_seconds: 60 },
    );
  }

  if (!acquireSlot(user.id, user.concurrent_limit)) {
    return jsonError(
      429,
      "concurrency_limit_exceeded",
      `Your tier allows ${user.concurrent_limit} concurrent extraction requests.`,
      { concurrent_limit: user.concurrent_limit },
    );
  }

  try {
    // --- Payload validation ------------------------------------------------ //
    let body: ExtractRequestBody;
    try {
      body = (await request.json()) as ExtractRequestBody;
    } catch {
      return jsonError(400, "invalid_json", "Request body must be valid JSON.");
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
      return jsonError(400, "missing_urls", "Provide at least one URL to extract.");
    }

    if (urls.length > config.maxUrlsPerRequest) {
      return jsonError(
        400,
        "too_many_urls",
        `A maximum of ${config.maxUrlsPerRequest} URLs is allowed per request.`,
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

    // --- Forward to the Rust core queue and collect the payload ----------- //
    const outcome = await performExtraction(user, { urls, target, selectors }, apiKey.id);

    return Response.json(
      {
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
        credits_remaining: Math.max(0, remaining - outcome.creditsCharged),
        results: outcome.results,
      },
      {
        status: outcome.succeeded > 0 ? 200 : 502,
        headers: {
          "Cache-Control": "no-store",
          "X-RateLimit-Limit": String(user.rate_limit_per_minute),
          "X-RateLimit-Remaining": String(
            Math.max(0, user.rate_limit_per_minute - usedThisMinute - 1),
          ),
          "X-Credits-Remaining": String(Math.max(0, remaining - outcome.creditsCharged)),
        },
      },
    );
  } catch (error) {
    const status = error instanceof EngineError ? error.status : 500;
    const message =
      error instanceof Error ? error.message : "Unexpected error while processing the job.";

    recordUsage({
      userId: user.id,
      apiKeyId: apiKey.id,
      jobId: null,
      urlsCount: 0,
      creditsCharged: 0,
      bytesOut: 0,
      status: "error",
      error: message,
      latencyMs: Date.now() - startedAt,
    });

    return jsonError(status, "extraction_failed", message);
  } finally {
    releaseSlot(user.id);
  }
}

/** CORS preflight for browser based callers. */
export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });
}
