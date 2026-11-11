import { config } from "./config";
import type { UserRow } from "./db";
import { EngineError, submitJob, waitForJob } from "./engine";
import { recordUsage } from "./ratelimit";

export type ExtractionRequest = {
  urls: string[];
  target: string;
  selectors: string[];
  /** How many link-following hops to perform from the seed URLs (0 = no crawl). */
  crawl_depth?: number;
  /** Maximum total pages to crawl per job (seed + discovered). */
  crawl_max_pages?: number;
  /** Optional human-readable label stored in crawl history. */
  label?: string;
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
  crawl_depth: number;
  /** URLs for downloading results in alternative formats. */
  exportUrls: {
    json: string;
    ndjson: string;
    csv: string;
    markdown: string;
    parquet: string;
    excel: string;
    bundle: string;
    zip: string;
  };
};

/** Formats the processor can serve. */
export const RESULT_FORMATS = [
  "json",
  "ndjson",
  "csv",
  "parquet",
  "markdown",
  "bundle",
  "excel",
] as const;

export type ResultFormat = (typeof RESULT_FORMATS)[number];

/** Media type produced by each format. */
const FORMAT_MIME: Record<ResultFormat, string> = {
  json: "application/json; charset=utf-8",
  ndjson: "application/x-ndjson; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  parquet: "application/vnd.apache.parquet",
  markdown: "text/markdown; charset=utf-8",
  bundle: "application/zip",
  excel: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/**
 * Work out which result format the caller wants.
 *
 * An explicit `?format=` wins, then the `Accept` header.  `null` means the
 * caller wants the default JSON envelope.
 */
export function negotiateResultFormat(
  accept: string | null,
  requested?: string | null,
): ResultFormat | null {
  if (requested) {
    const key = requested.trim().toLowerCase();
    if (key === "zip") return "bundle";
    if ((RESULT_FORMATS as readonly string[]).includes(key)) return key as ResultFormat;
    return null;
  }

  if (!accept) return null;

  const byMediaType: Record<string, ResultFormat> = {
    "text/csv": "csv",
    "application/x-ndjson": "ndjson",
    "application/vnd.apache.parquet": "parquet",
    "text/markdown": "markdown",
    "text/x-markdown": "markdown",
    "application/zip": "bundle",
  };

  for (const part of accept.split(",")) {
    const media = (part.split(";")[0] ?? "").trim().toLowerCase();
    if (media in byMediaType) return byMediaType[media];
  }

  return null;
}

/**
 * Fetch a finished job in one of the negotiated formats.
 *
 * The processor owns the rendering, so the gateway simply forwards the
 * request and hands the bytes back with the right content type.
 */
export async function fetchResultFormat(
  jobId: string,
  format: ResultFormat,
): Promise<{ body: ArrayBuffer; contentType: string }> {
  const response = await fetch(
    `${config.processorUrl}/results/${jobId}?format=${format}&download=1`,
    { signal: AbortSignal.timeout(30_000) },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new EngineError(
      `processor could not render job ${jobId} as ${format} (${response.status})`,
      502,
      text,
    );
  }

  return {
    body: await response.arrayBuffer(),
    contentType: FORMAT_MIME[format] ?? "application/octet-stream",
  };
}

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

  const submitted = await submitJob(request.urls, request.target, request.selectors, {
    crawl_depth: request.crawl_depth ?? 0,
    crawl_max_pages: request.crawl_max_pages ?? 50,
    label: request.label,
  });

  // Pre-register with crawl history
  fetch(`${config.processorUrl}/history`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jobId: submitted.jobId,
      urls: request.urls,
      target: submitted.target,
      crawl_depth: submitted.crawl_depth,
      label: request.label,
      userId: user.id,
    }),
    signal: AbortSignal.timeout(3_000),
  }).catch(() => {
    // Non-blocking: processor auto-creates history entry on job completion
  });

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

  const jobId = submitted.jobId;
  const exportBase = `${config.processorUrl}/results/${jobId}`;

  return {
    jobId,
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
    crawl_depth: submitted.crawl_depth,
    exportUrls: {
      json: `${exportBase}?format=json`,
      ndjson: `${exportBase}?format=ndjson`,
      csv: `${exportBase}/csv`,
      markdown: `${exportBase}/markdown`,
      parquet: `${exportBase}/parquet`,
      excel: `${exportBase}/excel`,
      bundle: `${exportBase}/zip`,
      zip: `${exportBase}/zip`,
    },
  };
}
