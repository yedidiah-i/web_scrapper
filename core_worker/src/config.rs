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
    /// Outgoing User-Agent header (overridden per-request by stealth rotation).
    pub user_agent: String,
    /// Address of the Python ingestion socket (Rust pushes raw HTML here).
    pub python_ingest: SocketAddr,
    /// Address of the Python results HTTP server (gateway reads results here).
    pub python_results: SocketAddr,
    /// Size of the rolling event window used for the per-minute success/failure series.
    pub stats_window_secs: u64,

    // ------------------------------------------------------------------ //
    // Stealth & proxy settings
    // ------------------------------------------------------------------ //

    /// Rotate User-Agent on every request using a real-browser pool.
    /// Set `CORE_ROTATE_UA=false` to disable.
    pub rotate_user_agent: bool,

    // ------------------------------------------------------------------ //
    // Hybrid fetch (browser fallback)
    // ------------------------------------------------------------------ //

    /// Whether to fall back to a headless browser when the static fetch
    /// returns an empty or JS-redirect body.  Requires Playwright installed.
    /// Set `CORE_BROWSER_FALLBACK=true` to enable.
    pub browser_fallback: bool,

    /// Minimum non-whitespace bytes in a static response before we consider it
    /// substantial enough *not* to need the browser fallback.
    pub min_body_bytes_for_static: usize,

    // ------------------------------------------------------------------ //
    // Recursive crawler settings
    // ------------------------------------------------------------------ //

    /// Maximum recursion depth for link-following (0 = no recursion).
    pub crawl_depth: usize,

    /// Hard cap on total pages crawled per job tree (seed + discovered links).
    pub crawl_max_pages: usize,

    /// Maximum number of links followed from a single page.
    ///
    /// Without this a link-heavy page can fan out into thousands of requests
    /// before the global page cap is noticed.
    pub crawl_max_links_per_page: usize,

    /// Follow links that point at a different host.
    ///
    /// The user asked for "crawl links in links" across the open web, so this
    /// defaults to `true`.  Set `CORE_CRAWL_ANY_HOST=false` to keep the crawl
    /// inside the seed host.
    pub crawl_any_host: bool,

    // ------------------------------------------------------------------ //
    // Browser escalation
    // ------------------------------------------------------------------ //

    /// URL of the Python render service that drives the headless browser.
    ///
    /// The Rust worker keeps the fast HTTP path and delegates the slow
    /// JavaScript path to this service, so browser orchestration lives in one
    /// place instead of being duplicated in Rust and Python.
    pub render_endpoint: String,

    /// Timeout for a single render request.
    pub render_timeout: Duration,

    /// Escalate to the browser when the static response looks like an
    /// anti-bot challenge page (Cloudflare, reCAPTCHA, hCaptcha, Turnstile).
    ///
    /// The challenge is detected and reported, never solved programmatically.
    pub escalate_on_challenge: bool,

    /// Persist session cookies across the pages of a job so the crawler looks
    /// like one continuous browser session.
    pub persist_cookies: bool,

    /// Use a real browser TLS/HTTP2 fingerprint for every request.
    ///
    /// Requires a binary built with the `tls-impersonate` cargo feature; the
    /// worker logs a warning and keeps the plain HTTP path when the feature is
    /// missing.
    pub tls_impersonate: bool,
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
                "ScrapingEngine/0.3 (+https://example.com/bot)",
            ),
            python_ingest: env_parse("PY_INGEST_ADDR", "127.0.0.1:59081")?,
            python_results: env_parse("PY_RESULTS_ADDR", "127.0.0.1:59082")?,
            stats_window_secs: env_parse("CORE_STATS_WINDOW_SECS", "3600")?,

            // Stealth
            rotate_user_agent: env_bool("CORE_ROTATE_UA", true),

            // Browser fallback
            browser_fallback: env_bool("CORE_BROWSER_FALLBACK", false),
            min_body_bytes_for_static: env_parse("CORE_MIN_BODY_BYTES", "512")?,

            // Recursive crawler
            crawl_depth: env_parse("CORE_CRAWL_DEPTH", "2")?,
            crawl_max_pages: env_parse("CORE_CRAWL_MAX_PAGES", "50")?,
            crawl_max_links_per_page: env_parse("CORE_CRAWL_MAX_LINKS_PER_PAGE", "25")?,
            crawl_any_host: env_bool("CORE_CRAWL_ANY_HOST", true),

            // Browser escalation
            render_endpoint: env_str(
                "PY_RENDER_URL",
                "http://127.0.0.1:59082/render",
            ),
            render_timeout: Duration::from_secs(env_parse("CORE_RENDER_TIMEOUT_SECS", "45")?),
            escalate_on_challenge: env_bool("CORE_ESCALATE_ON_CHALLENGE", true),
            persist_cookies: env_bool("CORE_PERSIST_COOKIES", true),
            tls_impersonate: env_bool("CORE_TLS_IMPERSONATE", false),
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

fn env_bool(key: &str, default: bool) -> bool {
    match env::var(key).as_deref() {
        Ok("true" | "1" | "yes") => true,
        Ok("false" | "0" | "no") => false,
        _ => default,
    }
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
