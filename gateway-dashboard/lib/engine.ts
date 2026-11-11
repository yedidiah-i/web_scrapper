import { config } from "./config";

/** Result of a single URL extracted from a page. */
export type ExtractedRow = Record<string, unknown>;

export type ProcessorResult = {
  url: string;
  ok: boolean;
  status_code: number | null;
  created_at: number;
  result: {
    job_id: string;
    url: string;
    status: string;
    target: string;
    extracted_at: string;
    row_count: number;
    fields: string[];
    data: ExtractedRow[];
    meta: Record<string, unknown>;
  };
};

export type ProcessorJob = {
  job_id: string;
  status: "pending" | "completed";
  target: string | null;
  received: number;
  succeeded: number;
  failed: number;
  completed: boolean;
  created_at: number;
  updated_at: number;
  results: ProcessorResult[];
};

export type EngineJob = {
  job_id: string;
  status: string;
  target: string;
  total_urls: number;
  succeeded: number;
  failed: number;
};

export type JobSubmission = {
  urls: string[];
  target: string;
  selectors: string[];
  /** How many link-following hops to perform from the seed URLs (default 0). */
  crawl_depth?: number;
  /** Maximum total pages (seed + discovered) to crawl (default 50). */
  crawl_max_pages?: number;
  /** Optional label for history grouping. */
  label?: string;
};

export class EngineError extends Error {
  status: number;
  details?: unknown;

  constructor(message: string, status = 502, details?: unknown) {
    super(message);
    this.name = "EngineError";
    this.status = status;
    this.details = details;
  }
}

/** Push a job into the Rust core worker queue. */
export async function submitJob(
  urls: string[],
  target: string,
  selectors: string[],
  options?: { crawl_depth?: number; crawl_max_pages?: number; label?: string },
): Promise<{ jobId: string; accepted: number; rejected: number; target: string; crawl_depth: number; label?: string }> {
  let response: Response;
  try {
    response = await fetch(`${config.engineUrl}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        urls,
        target,
        selectors,
        crawl_depth: options?.crawl_depth ?? 0,
        crawl_max_pages: options?.crawl_max_pages ?? 50,
        label: options?.label,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new EngineError(
      `core engine unreachable at ${config.engineUrl}: ${(error as Error).message}`,
      503,
    );
  }

  if (!response.ok) {
    const text = await response.text();
    throw new EngineError(`core engine rejected the job (${response.status})`, 502, text);
  }

  const body = (await response.json()) as {
    job_id: string;
    accepted_urls: number;
    rejected_urls: number;
    target: string;
    crawl_depth: number;
    label?: string;
  };

  return {
    jobId: body.job_id,
    accepted: body.accepted_urls,
    rejected: body.rejected_urls,
    target: body.target,
    crawl_depth: body.crawl_depth ?? 0,
    label: body.label,
  };
}

/** Read the live status of a job from the Rust core worker. */
export async function fetchEngineJob(jobId: string): Promise<EngineJob | null> {
  try {
    const response = await fetch(`${config.engineUrl}/jobs/${jobId}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    return (await response.json()) as EngineJob;
  } catch {
    return null;
  }
}

/** Read the transformed results of a job from the Python processor. */
export async function fetchProcessorJob(jobId: string): Promise<ProcessorJob | null> {
  try {
    const response = await fetch(`${config.processorUrl}/results/${jobId}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) return null;
    if (!response.ok) return null;
    return (await response.json()) as ProcessorJob;
  } catch {
    return null;
  }
}

/**
 * Wait until the processor has the final payload for a job.
 *
 * The processor marks a job complete when the Rust engine sends the terminal
 * `job_complete` marker, so the poll loop simply waits for that flag.
 */
export async function waitForJob(
  jobId: string,
  timeoutMs: number = config.jobTimeoutMs,
): Promise<ProcessorJob> {
  const deadline = Date.now() + timeoutMs;
  let last: ProcessorJob | null = null;

  while (Date.now() < deadline) {
    const job = await fetchProcessorJob(jobId);
    if (job) {
      last = job;
      if (job.completed) return job;
    }

    // If the engine already finished every URL but the processor never saw a
    // completion marker, surface that as a failure instead of hanging.
    const engineJob = await fetchEngineJob(jobId);
    if (engineJob && engineJob.status === "completed" && job && job.received > 0) {
      // Give the processor a moment to flush the marker, then accept the data.
      await sleep(config.pollIntervalMs);
      const refreshed = await fetchProcessorJob(jobId);
      if (refreshed) return refreshed;
    }

    await sleep(config.pollIntervalMs);
  }

  throw new EngineError(
    `job ${jobId} did not complete within ${Math.round(timeoutMs / 1000)}s`,
    504,
    last,
  );
}

/** Health snapshot of the core engine. */
export async function engineHealth(): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(`${config.engineUrl}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Health snapshot of the data processor. */
export async function processorHealth(): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(`${config.processorUrl}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
