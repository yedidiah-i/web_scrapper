import path from "node:path";

const developmentSessionSecret = "local-dev-secret-change-me-in-production";
const integrationSecret = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sessionSecret =
  process.env.SESSION_SECRET ??
  (integrationSecret ? `scrappy-session:${integrationSecret}` : developmentSessionSecret);

if (
  process.env.NODE_ENV === "production" &&
  (sessionSecret === developmentSessionSecret || sessionSecret.length < 32)
) {
  throw new Error("Set SESSION_SECRET to a high-entropy secret before production deployment.");
}

/**
 * Runtime configuration for the gateway.
 *
 * Every value can be overridden with an environment variable so the same
 * build runs locally and on the production host.
 */
export const config = {
  /** Rust core worker job API. */
  engineUrl: process.env.ENGINE_URL ?? "http://127.0.0.1:59080",
  /** Python data processor results API. */
  processorUrl: process.env.PROCESSOR_URL ?? "http://127.0.0.1:59082",
  /** SQLite ledger used for keys, credits and usage. */
  dbPath:
    process.env.GATEWAY_DB_PATH ??
    path.join(process.cwd(), "data", "gateway.db"),
  /** Secret used to sign session cookies. */
  sessionSecret,
  /** Session lifetime in milliseconds (7 days). */
  sessionTtlMs: Number(process.env.SESSION_TTL_MS ?? 7 * 24 * 60 * 60 * 1000),
  /** Maximum number of URLs accepted in one extraction request. */
  maxUrlsPerRequest: Number(process.env.MAX_URLS_PER_REQUEST ?? 100),
  /** How long the gateway waits for the engine + processor to finish a job. */
  jobTimeoutMs: Number(process.env.JOB_TIMEOUT_MS ?? 60_000),
  /** Poll interval while waiting for job results. */
  pollIntervalMs: Number(process.env.JOB_POLL_INTERVAL_MS ?? 350),
  /** Credits charged per successfully processed URL. */
  creditsPerUrl: Number(process.env.CREDITS_PER_URL ?? 1),
} as const;

export const SESSION_COOKIE = "scrapeworks_session";
