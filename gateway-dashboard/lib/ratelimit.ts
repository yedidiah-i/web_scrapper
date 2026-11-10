import { db, type UsageRow, type UserRow } from "./db";

/** Start of the current UTC month in epoch milliseconds. */
export function startOfMonth(now: number = Date.now()): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

/** Credits already spent in the current billing month. */
export function creditsUsedThisMonth(userId: number, now: number = Date.now()): number {
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(credits_charged), 0) AS used FROM usage_ledger WHERE user_id = ? AND created_at >= ?",
    )
    .get(userId, startOfMonth(now)) as { used: number };
  return row.used ?? 0;
}

/** Credits left in the current billing month. */
export function creditsRemaining(user: UserRow, now: number = Date.now()): number {
  return Math.max(0, user.monthly_credits - creditsUsedThisMonth(user.id, now));
}

/** Number of requests accepted in the last 60 seconds. */
export function requestsInLastMinute(userId: number, now: number = Date.now()): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS count FROM usage_ledger WHERE user_id = ? AND created_at >= ?",
    )
    .get(userId, now - 60_000) as { count: number };
  return row.count ?? 0;
}

/** Aggregate usage for a user, used by the dashboard charts. */
export function usageSummary(userId: number, hours = 24, now: number = Date.now()) {
  const since = now - hours * 60 * 60 * 1000;

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS requests,
              COALESCE(SUM(credits_charged), 0) AS credits,
              COALESCE(SUM(urls_count), 0) AS urls,
              COALESCE(SUM(bytes_out), 0) AS bytes,
              COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS succeeded,
              COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS failed,
              COALESCE(AVG(latency_ms), 0) AS avg_latency_ms
         FROM usage_ledger
        WHERE user_id = ? AND created_at >= ?`,
    )
    .get(userId, since) as {
    requests: number;
    credits: number;
    urls: number;
    bytes: number;
    succeeded: number;
    failed: number;
    avg_latency_ms: number;
  };

  const rows = db
    .prepare(
      `SELECT created_at, status FROM usage_ledger
        WHERE user_id = ? AND created_at >= ? ORDER BY created_at ASC`,
    )
    .all(userId, since) as Pick<UsageRow, "created_at" | "status">[];

  // Bucket the ledger into hourly buckets for the chart.
  const buckets = new Map<number, { success: number; failed: number }>();
  for (const row of rows) {
    const bucket = Math.floor(row.created_at / 3_600_000) * 3_600_000;
    const entry = buckets.get(bucket) ?? { success: 0, failed: 0 };
    if (row.status === "success") entry.success += 1;
    else entry.failed += 1;
    buckets.set(bucket, entry);
  }

  const series = [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([ts, value]) => ({ ts, ...value }));

  return {
    window_hours: hours,
    requests: totals.requests ?? 0,
    credits_used: totals.credits ?? 0,
    urls_processed: totals.urls ?? 0,
    bytes_out: totals.bytes ?? 0,
    succeeded: totals.succeeded ?? 0,
    failed: totals.failed ?? 0,
    avg_latency_ms: Math.round(totals.avg_latency_ms ?? 0),
    series,
  };
}

/* -------------------------------------------------------------------------- */
/* Concurrency guard                                                           */
/* -------------------------------------------------------------------------- */

const globalForInflight = globalThis as unknown as {
  __inflight?: Map<number, number>;
};

const inflight: Map<number, number> =
  globalForInflight.__inflight ?? (globalForInflight.__inflight = new Map());

/** Current number of in-flight requests for a user. */
export function activeRequests(userId: number): number {
  return inflight.get(userId) ?? 0;
}

/**
 * Reserve a concurrency slot. Returns false when the tier limit is reached.
 */
export function acquireSlot(userId: number, limit: number): boolean {
  const current = activeRequests(userId);
  if (current >= limit) return false;
  inflight.set(userId, current + 1);
  return true;
}

/** Release a previously acquired concurrency slot. */
export function releaseSlot(userId: number): void {
  const current = activeRequests(userId);
  if (current <= 1) {
    inflight.delete(userId);
  } else {
    inflight.set(userId, current - 1);
  }
}

/** Record a request in the usage ledger. */
export function recordUsage(entry: {
  userId: number;
  apiKeyId?: number | null;
  jobId?: string | null;
  urlsCount: number;
  creditsCharged: number;
  bytesOut: number;
  status: "success" | "error";
  error?: string | null;
  latencyMs: number;
}): void {
  db.prepare(
    `INSERT INTO usage_ledger
       (user_id, api_key_id, job_id, urls_count, credits_charged, bytes_out,
        status, error, latency_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.userId,
    entry.apiKeyId ?? null,
    entry.jobId ?? null,
    entry.urlsCount,
    entry.creditsCharged,
    entry.bytesOut,
    entry.status,
    entry.error ?? null,
    entry.latencyMs,
    Date.now(),
  );
}
