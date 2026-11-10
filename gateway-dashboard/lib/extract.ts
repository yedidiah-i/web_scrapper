import { config } from "./config";
import type { UserRow } from "./db";
import { EngineError, submitJob, waitForJob } from "./engine";
import { recordUsage } from "./ratelimit";

export type ExtractionRequest = {
  urls: string[];
  target: string;
  selectors: string[];
};

export type ExtractionOutcome = {
  jobId: string;
  target: string;
  accepted: number;
  rejected: number;
  results: Array<Record<string, unknown>>;
  succeeded: number;
  failed: number;
  missing: number;
  creditsCharged: number;
  bytesOut: number;
  latencyMs: number;
};

/**
 * Run one extraction through the Rust core queue and the Python processor.
 *
 * Shared by the public `POST /api/v1/extract` endpoint and the dashboard
 * playground so both paths behave identically.
 */
export async function performExtraction(
  user: UserRow,
  request: ExtractionRequest,
  apiKeyId: number | null = null,
): Promise<ExtractionOutcome> {
  const startedAt = Date.now();

  const submitted = await submitJob(request.urls, request.target, request.selectors);

  if (submitted.accepted === 0) {
    throw new EngineError(
      "None of the supplied URLs could be queued. Only absolute http/https URLs are supported.",
      400,
    );
  }

  const job = await waitForJob(submitted.jobId);
  const results = job.results.map((entry) => entry.result as unknown as Record<string, unknown>);

  const succeeded = results.filter((item) => item.status === "ok").length;
  const failed = results.length - succeeded;

  // Accepted URLs that never produced a result. The processor records one
  // payload per URL, so a shortfall means a packet was dropped upstream.
  // Reporting it keeps the summary honest instead of silently undercounting.
  const missing = Math.max(0, submitted.accepted - results.length);

  const creditsCharged = succeeded * config.creditsPerUrl;
  const bytesOut = Buffer.byteLength(JSON.stringify(results), "utf8");
  const latencyMs = Date.now() - startedAt;

  recordUsage({
    userId: user.id,
    apiKeyId,
    jobId: submitted.jobId,
    urlsCount: submitted.accepted,
    creditsCharged,
    bytesOut,
    status: succeeded > 0 ? "success" : "error",
    error: succeeded > 0 ? null : "all urls failed",
    latencyMs,
  });

  return {
    jobId: submitted.jobId,
    target: submitted.target,
    accepted: submitted.accepted,
    rejected: submitted.rejected,
    results,
    succeeded,
    failed,
    missing,
    creditsCharged,
    bytesOut,
    latencyMs,
  };
}
