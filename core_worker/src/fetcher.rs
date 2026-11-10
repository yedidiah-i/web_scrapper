use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use futures_util::StreamExt;
use rand::Rng;
use tokio::{
    sync::{mpsc, Mutex, RwLock},
    time::sleep,
};
use url::Url;

use crate::{
    config::Config,
    ipc::IpcSink,
    models::{JobState, RawPacket, Target},
    stats::{now_ms, Stats},
};

/// One unit of queued work.
#[derive(Debug, Clone)]
struct Task {
    job_id: String,
    url: String,
    target: Target,
    selectors: Vec<String>,
}

/// Outcome of a single fetch attempt chain.
struct FetchOutcome {
    status_code: Option<u16>,
    body: String,
    error: Option<String>,
    attempts: u32,
    elapsed_ms: u64,
    bytes: usize,
}

/// Registry of in-flight jobs, used by `GET /jobs/{job_id}`.
pub struct JobRegistry {
    jobs: RwLock<HashMap<String, JobState>>,
    /// Serializes final packet emission + counter updates per registry to guarantee
    /// `job_complete` is strictly ordered after the last `html` packet.
    emit_lock: Mutex<()>,
}

impl JobRegistry {
    pub fn new() -> Self {
        JobRegistry {
            jobs: RwLock::new(HashMap::new()),
            emit_lock: Mutex::new(()),
        }
    }

    async fn create(&self, job_id: &str, target: &Target, total_urls: usize) {
        let now = now_ms();
        let mut jobs = self.jobs.write().await;
        jobs.insert(
            job_id.to_string(),
            JobState {
                job_id: job_id.to_string(),
                target: target.as_str().to_string(),
                total_urls,
                succeeded: 0,
                failed: 0,
                created_at_ms: now,
                updated_at_ms: now,
            },
        );
    }

    /// Atomically sends the data packet, updates job progress, and emits
    /// `job_complete` if this was the final URL in the job.
    async fn record_and_emit(
        &self,
        ipc: &IpcSink,
        packet: RawPacket,
        target: &Target,
    ) {
        let _guard = self.emit_lock.lock().await;
        let job_id = packet.job_id.clone();
        let ok = packet.ok;

        ipc.send(packet).await;

        let (finished, total) = {
            let mut jobs = self.jobs.write().await;
            if let Some(job) = jobs.get_mut(&job_id) {
                if ok {
                    job.succeeded += 1;
                } else {
                    job.failed += 1;
                }
                job.updated_at_ms = now_ms();
                (job.succeeded + job.failed, job.total_urls)
            } else {
                (0, 0)
            }
        };

        if total > 0 && finished >= total {
            ipc.send(make_job_complete_packet(&job_id, target)).await;
        }
    }

    pub async fn get(&self, job_id: &str) -> Option<JobState> {
        self.jobs.read().await.get(job_id).cloned()
    }
}

/// The high-concurrency engine: a bounded mpsc queue feeding a fixed pool of
/// async workers, with resilience handling.
#[derive(Clone)]
pub struct Engine {
    tx: mpsc::Sender<Task>,
    jobs: Arc<JobRegistry>,
    config: Arc<Config>,
    stats: Arc<Stats>,
    ipc: Arc<IpcSink>,
}

impl Engine {
    pub fn spawn(
        config: Arc<Config>,
        stats: Arc<Stats>,
        jobs: Arc<JobRegistry>,
        ipc: Arc<IpcSink>,
    ) -> Engine {
        let client = reqwest::Client::builder()
            .timeout(config.request_timeout)
            .connect_timeout(config.connect_timeout)
            .pool_idle_timeout(Duration::from_secs(90))
            .pool_max_idle_per_host(config.worker_count)
            .user_agent(config.user_agent.clone())
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()
            .expect("failed to build http client");

        let (tx, rx) = mpsc::channel::<Task>(config.queue_capacity);
        let rx = Arc::new(Mutex::new(rx));
        // Shared across all workers so sequence numbers never collide.
        let sequence = Arc::new(AtomicU64::new(0));

        for worker_id in 0..config.worker_count {
            let rx = rx.clone();
            let client = client.clone();
            let config = config.clone();
            let stats = stats.clone();
            let jobs = jobs.clone();
            let ipc = ipc.clone();
            let sequence = sequence.clone();

            tokio::spawn(async move {
                tracing::info!(worker_id, "worker started");

                loop {
                    let task = {
                        let mut guard = rx.lock().await;
                        guard.recv().await
                    };

                    let Some(task) = task else { break };

                    let seq = sequence.fetch_add(1, Ordering::Relaxed);
                    let outcome = fetch_with_retry(&client, &config, &task, &stats).await;

                    let ok = outcome.error.is_none()
                        && outcome.status_code.is_some_and(|c| (200..400).contains(&c));

                    let packet = RawPacket {
                        version: 1,
                        kind: "html".to_string(),
                        job_id: task.job_id.clone(),
                        sequence_number: seq,
                        url: task.url.clone(),
                        status_code: outcome.status_code,
                        ok,
                        error: outcome.error,
                        attempts: outcome.attempts,
                        elapsed_ms: outcome.elapsed_ms,
                        timestamp_ns: now_ns(),
                        html_content: outcome.body,
                        target: task.target.as_str().to_string(),
                        selectors: task.selectors,
                    };

                    stats.record_outcome(ok, outcome.elapsed_ms, outcome.bytes);
                    jobs.record_and_emit(&ipc, packet, &task.target).await;
                }

                tracing::info!(worker_id, "worker stopped");
            });
        }

        Engine {
            tx,
            jobs,
            config,
            stats,
            ipc,
        }
    }

    /// Accept a job into the queue. Returns the number of accepted and rejected
    /// URLs; rejected URLs are non-http(s) or over the per-job cap.
    pub async fn submit(
        &self,
        job_id: &str,
        urls: Vec<String>,
        target: Target,
        selectors: Vec<String>,
    ) -> (usize, usize) {
        let mut accepted = Vec::new();
        let mut rejected = 0usize;

        for raw in urls {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                rejected += 1;
                continue;
            }
            if !is_fetchable_url(trimmed) {
                tracing::warn!(url = trimmed, "rejecting unsupported url");
                rejected += 1;
                continue;
            }
            if accepted.len() >= self.config.max_urls_per_job {
                rejected += 1;
                continue;
            }
            accepted.push(trimmed.to_string());
        }

        let total = accepted.len();
        self.stats.record_job();
        self.stats.record_urls(total);
        self.jobs.create(job_id, &target, total).await;

        // If 0 URLs were accepted, complete the job immediately so callers aren't stranded.
        if total == 0 {
            self.ipc
                .send(make_job_complete_packet(job_id, &target))
                .await;
            return (0, rejected);
        }

        for url in accepted {
            let task = Task {
                job_id: job_id.to_string(),
                url,
                target: target.clone(),
                selectors: selectors.clone(),
            };
            if let Err(err) = self.tx.send(task).await {
                tracing::error!(%err, "job queue closed");
                break;
            }
        }

        (total, rejected)
    }

    /// Number of URLs currently waiting in the queue.
    pub fn queue_depth(&self) -> usize {
        self.tx.max_capacity() - self.tx.capacity()
    }

    /// Access to the in-flight job registry.
    pub fn jobs(&self) -> &Arc<JobRegistry> {
        &self.jobs
    }
}

fn make_job_complete_packet(job_id: &str, target: &Target) -> RawPacket {
    RawPacket {
        version: 1,
        kind: "job_complete".to_string(),
        job_id: job_id.to_string(),
        sequence_number: 0,
        url: String::new(),
        status_code: None,
        ok: true,
        error: None,
        attempts: 0,
        elapsed_ms: 0,
        timestamp_ns: now_ns(),
        html_content: String::new(),
        target: target.as_str().to_string(),
        selectors: Vec::new(),
    }
}

/// Accept only absolute http/https URLs.
fn is_fetchable_url(raw: &str) -> bool {
    match Url::parse(raw) {
        Ok(url) => matches!(url.scheme(), "http" | "https") && url.host_str().is_some(),
        Err(_) => false,
    }
}

/// Fetch one URL with exponential backoff retries.
async fn fetch_with_retry(
    client: &reqwest::Client,
    config: &Config,
    task: &Task,
    stats: &Stats,
) -> FetchOutcome {
    let max_attempts = config.max_retries.saturating_add(1);
    let mut attempt = 0u32;
    let total_started = Instant::now();

    loop {
        attempt += 1;
        let result = attempt_fetch(client, config, &task.url).await;
        let elapsed_ms = total_started.elapsed().as_millis() as u64;

        match result {
            AttemptResult::Success {
                status_code,
                body,
                bytes,
            } => {
                return FetchOutcome {
                    status_code: Some(status_code),
                    body,
                    error: None,
                    attempts: attempt,
                    elapsed_ms,
                    bytes,
                };
            }
            AttemptResult::Failure {
                status_code,
                error,
                retryable,
                retry_after,
            } => {
                let can_retry = retryable && attempt < max_attempts;
                if !can_retry {
                    return FetchOutcome {
                        status_code,
                        body: String::new(),
                        error: Some(error),
                        attempts: attempt,
                        elapsed_ms,
                        bytes: 0,
                    };
                }
                stats.record_retry();
                let delay = retry_after
                    .map(add_jitter)
                    .unwrap_or_else(|| backoff_delay(config, attempt));
                tracing::warn!(
                    url = %task.url,
                    attempt,
                    ?delay,
                    "transient failure, retrying"
                );
                sleep(delay).await;
            }
        }
    }
}

enum AttemptResult {
    Success {
        status_code: u16,
        body: String,
        bytes: usize,
    },
    Failure {
        status_code: Option<u16>,
        error: String,
        retryable: bool,
        retry_after: Option<Duration>,
    },
}

/// One HTTP attempt with a hard timeout and a body size ceiling.
async fn attempt_fetch(client: &reqwest::Client, config: &Config, url: &str) -> AttemptResult {
    let response = match client.get(url).send().await {
        Ok(resp) => resp,
        Err(err) => {
            let retryable =
                err.is_timeout() || err.is_connect() || err.is_request() || err.is_body();
            return AttemptResult::Failure {
                status_code: None,
                error: format!("{err}"),
                retryable,
                retry_after: None,
            };
        }
    };
    let status = response.status();
    let status_code = status.as_u16();
    let retry_after = parse_retry_after(response.headers().get("retry-after"));

    // 5xx and 429 are transient, other 4xx are permanent client errors.
    if status.is_server_error() || status_code == 429 {
        return AttemptResult::Failure {
            status_code: Some(status_code),
            error: format!("transient http status {status_code}"),
            retryable: true,
            retry_after,
        };
    }
    if status.is_client_error() {
        return AttemptResult::Failure {
            status_code: Some(status_code),
            error: format!("permanent http status {status_code}"),
            retryable: false,
            retry_after: None,
        };
    }

    // Read the body with a hard byte ceiling so a huge page cannot exhaust memory.
    let mut buf: Vec<u8> = Vec::new();
    let mut stream = response.bytes_stream();
    let mut truncated = false;

    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(err) => {
                return AttemptResult::Failure {
                    status_code: Some(status_code),
                    error: format!("body read failed: {err}"),
                    retryable: true,
                    retry_after: None,
                };
            }
        };
        if buf.len() + chunk.len() > config.max_html_bytes {
            let room = config.max_html_bytes.saturating_sub(buf.len());
            buf.extend_from_slice(&chunk[..room]);
            truncated = true;
            break;
        }
        buf.extend_from_slice(&chunk);
    }

    if truncated {
        tracing::warn!(
            url = %url,
            limit = config.max_html_bytes,
            "response truncated at byte ceiling"
        );
    }

    let bytes = buf.len();
    let body = String::from_utf8_lossy(&buf).to_string();

    AttemptResult::Success {
        status_code,
        body,
        bytes,
    }
}

/// Exponential backoff with jitter, capped by the configured ceiling.
fn backoff_delay(config: &Config, attempt: u32) -> Duration {
    let exponent = attempt.saturating_sub(1).min(20);
    let factor = 1u64 << exponent;
    let millis = config
        .backoff_base
        .as_millis()
        .saturating_mul(factor as u128)
        .min(config.backoff_max.as_millis()) as u64;
    add_jitter(Duration::from_millis(millis))
}

/// Adds up to 25% positive jitter to prevent synchronized retry spikes.
fn add_jitter(base: Duration) -> Duration {
    let millis = base.as_millis() as u64;
    let jitter = rand::rng().random_range(0..=(millis / 4).max(1));
    Duration::from_millis(millis + jitter)
}

/// Parse a numeric Retry-After header (seconds).
fn parse_retry_after(header: Option<&reqwest::header::HeaderValue>) -> Option<Duration> {
    let value = header?.to_str().ok()?.trim();
    let seconds: u64 = value.parse().ok()?;
    Some(Duration::from_secs(seconds.min(60)))
}

fn now_ns() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}