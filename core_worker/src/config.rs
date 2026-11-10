use anyhow::{Context, Result};
use std::{env, net::SocketAddr, time::Duration};

/// Runtime configuration for the core worker.
///
/// Every value can be overridden with an environment variable so the same
/// binary works locally, in Docker, and on a fixed-IP Linux host.
#[derive(Clone, Debug)]
pub struct Config {
    /// Public bind address of the job intake API (Step 4 talks to this).
    pub bind_addr: SocketAddr,
    /// Number of concurrent async workers draining the URL queue (Substep 2.2).
    pub worker_count: usize,
    /// Capacity of the bounded mpsc queue (Substep 2.2).
    pub queue_capacity: usize,
    /// Hard per-request ceiling, prevents hung sockets stalling the queue (Substep 2.3).
    pub request_timeout: Duration,
    /// TCP/TLS connect ceiling, a subset of the total request budget.
    pub connect_timeout: Duration,
    /// Retry attempts for transient failures (5xx, 429, network errors) (Substep 2.3).
    pub max_retries: u32,
    /// Exponential backoff base delay (Substep 2.3).
    pub backoff_base: Duration,
    /// Exponential backoff ceiling (Substep 2.3).
    pub backoff_max: Duration,
    /// Maximum HTML payload accepted per response, in bytes.
    pub max_html_bytes: usize,
    /// Maximum number of URLs accepted in a single job.
    pub max_urls_per_job: usize,
    /// Outgoing User-Agent header.
    pub user_agent: String,
    /// Address of the Python ingestion socket (Rust pushes raw HTML here).
    pub python_ingest: SocketAddr,
    /// Address of the Python results HTTP server (gateway reads results here).
    pub python_results: SocketAddr,
    /// Size of the rolling event window used for the per-minute success/failure series.
    pub stats_window_secs: u64,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let cfg = Config {
            bind_addr: env_parse("CORE_BIND_ADDR", "0.0.0.0:59080")?,
            worker_count: env_parse("CORE_WORKERS", "64")?,
            queue_capacity: env_parse("CORE_QUEUE_CAPACITY", "2048")?,
            request_timeout: Duration::from_secs(env_parse("CORE_REQUEST_TIMEOUT_SECS", "10")?),
            connect_timeout: Duration::from_secs(env_parse("CORE_CONNECT_TIMEOUT_SECS", "5")?),
            max_retries: env_parse("CORE_MAX_RETRIES", "3")?,
            backoff_base: Duration::from_millis(env_parse("CORE_BACKOFF_BASE_MS", "250")?),
            backoff_max: Duration::from_millis(env_parse("CORE_BACKOFF_MAX_MS", "8000")?),
            max_html_bytes: env_parse("CORE_MAX_HTML_BYTES", "5242880")?,
            max_urls_per_job: env_parse("CORE_MAX_URLS_PER_JOB", "500")?,
            user_agent: env_str(
                "CORE_USER_AGENT",
                "ScrapingEngine/0.2 (+https://example.com/bot)",
            ),
            python_ingest: env_parse("PY_INGEST_ADDR", "127.0.0.1:59081")?,
            python_results: env_parse("PY_RESULTS_ADDR", "127.0.0.1:59082")?,
            stats_window_secs: env_parse("CORE_STATS_WINDOW_SECS", "3600")?,
        };

        anyhow::ensure!(cfg.worker_count > 0, "CORE_WORKERS must be greater than 0");
        anyhow::ensure!(
            cfg.queue_capacity > 0,
            "CORE_QUEUE_CAPACITY must be greater than 0"
        );
        Ok(cfg)
    }
}

fn env_str(key: &str, default: &str) -> String {
    env::var(key)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| default.to_string())
}

fn env_parse<T>(key: &str, default: &str) -> Result<T>
where
    T: std::str::FromStr,
    <T as std::str::FromStr>::Err: std::error::Error + Send + Sync + 'static,
{
    match env::var(key) {
        Ok(raw) if !raw.trim().is_empty() => raw
            .trim()
            .parse::<T>()
            .with_context(|| format!("invalid value for {key}")),
        _ => default
            .parse::<T>()
            .with_context(|| format!("invalid default value for {key}")),
    }
}
