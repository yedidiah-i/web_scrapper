use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use futures_util::StreamExt;
use parking_lot::Mutex as StdMutex;
use rand::Rng;
use reqwest::cookie::Jar;
use tokio::{
    sync::{mpsc, Mutex, RwLock},
    time::sleep,
};
use url::Url;

use crate::{
    config::Config,
    fingerprint,
    ipc::IpcSink,
    models::{JobState, RawPacket, Target},
    proxy,
    stats::{now_ms, Stats},
    throttle::Throttle,
};

// --------------------------------------------------------------------------- //
// Task definition
// --------------------------------------------------------------------------- //

/// One unit of queued work.
#[derive(Debug, Clone)]
pub struct Task {
    pub job_id: String,
    pub url: String,
    pub target: Target,
    pub selectors: Vec<String>,
    /// Remaining crawl hops from this URL (0 = leaf, do not follow links).
    pub crawl_depth_remaining: usize,
    /// Crawl depth this URL was found at (0 = seed).
    pub depth: usize,
    /// Page that linked here (None for seeds).
    pub source_url: Option<String>,
    /// Session cookie jar shared by every page of the job.
    pub cookies: Arc<Jar>,
    /// Set of URLs already queued or fetched for this job (dedup guard).
    pub visited: Arc<StdMutex<HashSet<String>>>,
}

/// Outcome of a single fetch attempt chain.
struct FetchOutcome {
    status_code: Option<u16>,
    body: String,
    error: Option<String>,
    attempts: u32,
    elapsed_ms: u64,
    bytes: usize,
    browser_rendered: bool,
    proxy_used: String,
    /// Anti-bot challenge detected on the page, if any.
    challenge: Option<String>,
}

// --------------------------------------------------------------------------- //
// Job registry
// --------------------------------------------------------------------------- //

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

    pub async fn create(
        &self,
        job_id: &str,
        target: &Target,
        total_urls: usize,
        max_pages: usize,
        crawl_depth: usize,
    ) {
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
                max_pages,
                crawl_depth,
            },
        );
    }

    /// Reserve up to `want` additional page slots for a job.
    ///
    /// Returns the number of slots actually granted.  This keeps the crawl
    /// inside `CORE_CRAWL_MAX_PAGES` even when several workers discover links
    /// on the same page at the same time.
    pub async fn reserve_slots(&self, job_id: &str, want: usize) -> usize {
        let mut jobs = self.jobs.write().await;
        let Some(job) = jobs.get_mut(job_id) else {
            return 0;
        };
        let remaining = job.max_pages.saturating_sub(job.total_urls);
        let granted = want.min(remaining);
        job.total_urls += granted;
        job.updated_at_ms = now_ms();
        granted
    }

    /// Atomically sends the data packet, updates job progress, and emits
    /// `job_complete` if this was the final URL in the job.
    pub async fn record_and_emit(
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

// --------------------------------------------------------------------------- //
// Engine
// --------------------------------------------------------------------------- //

/// The high-concurrency engine: a bounded mpsc queue feeding a fixed pool of
/// async workers, with resilience handling, proxy rotation, stealth headers,
/// adaptive throttling, and optional recursive link-following.
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
        // Initialise the proxy pool from the environment.
        let _ = &*proxy::POOL;

        let throttle = Throttle::new();
        let (tx, rx) = mpsc::channel::<Task>(config.queue_capacity);
        let rx = Arc::new(Mutex::new(rx));
        // Shared across all workers so sequence numbers never collide.
        let sequence = Arc::new(AtomicU64::new(0));

        for worker_id in 0..config.worker_count {
            let rx = rx.clone();
            let config = config.clone();
            let stats = stats.clone();
            let jobs = jobs.clone();
            let ipc = ipc.clone();
            let sequence = sequence.clone();
            let throttle = throttle.clone();
            let engine_tx = tx.clone();

            tokio::spawn(async move {
                tracing::info!(worker_id, "worker started");

                loop {
                    let task = {
                        let mut guard = rx.lock().await;
                        guard.recv().await
                    };

                    let Some(task) = task else { break };

                    // Adaptive per-host throttle wait.
                    let host = host_of(&task.url);
                    throttle.wait(&host).await;

                    let seq = sequence.fetch_add(1, Ordering::Relaxed);
                    let outcome = fetch_with_retry(&config, &task, &stats, &throttle).await;

                    let ok = outcome.error.is_none()
                        && outcome.status_code.is_some_and(|c| (200..400).contains(&c));

                    // ---------------------------------------------------------------- //
                    // Recursive link crawling
                    // ---------------------------------------------------------------- //
                    if ok && task.crawl_depth_remaining > 0 {
                        // Extract links from the fetched body and enqueue them.
                        let discovered = discover_links(
                            &outcome.body,
                            &task.url,
                            config.crawl_any_host,
                            config.crawl_max_links_per_page,
                        );

                        // Drop URLs this job already handled, then ask the
                        // registry for the remaining page budget.
                        let mut fresh: Vec<String> = Vec::new();
                        {
                            let mut visited = task.visited.lock();
                            for url in discovered {
                                if visited.insert(url.clone()) {
                                    fresh.push(url);
                                }
                            }
                        }

                        if !fresh.is_empty() {
                            let granted = jobs.reserve_slots(&task.job_id, fresh.len()).await;
                            if granted < fresh.len() {
                                tracing::info!(
                                    job_id = %task.job_id,
                                    requested = fresh.len(),
                                    granted,
                                    "crawl page budget reached — stopping expansion"
                                );
                                fresh.truncate(granted);
                            }

                            let new_tasks: Vec<Task> = fresh
                                .into_iter()
                                .map(|url| Task {
                                    job_id: task.job_id.clone(),
                                    url,
                                    target: task.target,
                                    selectors: task.selectors.clone(),
                                    crawl_depth_remaining: task.crawl_depth_remaining - 1,
                                    depth: task.depth + 1,
                                    source_url: Some(task.url.clone()),
                                    cookies: task.cookies.clone(),
                                    visited: task.visited.clone(),
                                })
                                .collect();

                            for new_task in new_tasks {
                                if let Err(err) = engine_tx.send(new_task).await {
                                    tracing::warn!(%err, "crawl queue full, dropping discovered url");
                                }
                            }
                        }
                    }

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
                        crawl_depth_remaining: task.crawl_depth_remaining,
                        browser_rendered: outcome.browser_rendered,
                        proxy_used: outcome.proxy_used,
                        depth: task.depth,
                        source_url: task.source_url.clone(),
                        challenge: outcome.challenge,
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
        crawl_depth: usize,
    ) -> (usize, usize) {
        let effective_depth = crawl_depth.min(self.config.crawl_depth);

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

        // One cookie jar and one visited-set per job: the crawl behaves like a
        // single browser session and never fetches the same URL twice.
        let cookies = Arc::new(Jar::default());
        let visited = Arc::new(StdMutex::new(HashSet::new()));
        for url in &accepted {
            visited.lock().insert(url.clone());
        }

        let max_pages = self.config.crawl_max_pages.max(total);
        self.jobs
            .create(job_id, &target, total, max_pages, effective_depth)
            .await;

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
                target,
                selectors: selectors.clone(),
                crawl_depth_remaining: effective_depth,
                depth: 0,
                source_url: None,
                cookies: cookies.clone(),
                visited: visited.clone(),
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

// --------------------------------------------------------------------------- //
// Helpers
// --------------------------------------------------------------------------- //

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
        crawl_depth_remaining: 0,
        browser_rendered: false,
        proxy_used: String::new(),
        depth: 0,
        source_url: None,
        challenge: None,
    }
}

/// Extract the hostname from a URL for throttle keying.
fn host_of(url: &str) -> String {
    Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_else(|| url.to_string())
}

/// Accept only absolute http/https URLs.
fn is_fetchable_url(raw: &str) -> bool {
    match Url::parse(raw) {
        Ok(url) => matches!(url.scheme(), "http" | "https") && url.host_str().is_some(),
        Err(_) => false,
    }
}

/// Extract followable links from an HTML body for recursive crawling.
///
/// Links are resolved against the page URL, so relative hrefs work.  Only
/// http/https URLs survive; anchors, `mailto:`, `javascript:` and `tel:` are
/// dropped.  The result is deduplicated and capped at `max_links`.
///
/// The crawler follows links to *any* host by default - the platform is meant
/// to walk "links in links" across the open web.  Set `CORE_CRAWL_ANY_HOST=false`
/// to restrict discovery to the seed host.
fn discover_links(html: &str, base_url: &str, any_host: bool, max_links: usize) -> Vec<String> {
    let base = match Url::parse(base_url) {
        Ok(u) => u,
        Err(_) => return vec![],
    };
    let base_host = base.host_str().unwrap_or("").to_string();

    // Very lightweight link extraction — avoids pulling in a full HTML parser
    // dependency; correctness over completeness is fine for crawl discovery.
    let mut seen: HashSet<String> = HashSet::new();
    let mut links: Vec<String> = Vec::new();

    // Match href="..." and href='...'
    let pattern = "href=";
    let mut search = html;
    while let Some(pos) = search.find(pattern) {
        if links.len() >= max_links {
            break;
        }
        search = &search[pos + pattern.len()..];
        let (quote, rest) = if search.starts_with('"') {
            ('"', &search[1..])
        } else if search.starts_with('\'') {
            ('\'', &search[1..])
        } else {
            continue;
        };
        let end = match rest.find(quote) {
            Some(e) => e,
            None => break,
        };
        let href = &rest[..end];
        search = &rest[end + 1..];

        if href.starts_with('#')
            || href.starts_with("javascript")
            || href.starts_with("mailto")
            || href.starts_with("tel:")
            || href.starts_with("data:")
        {
            continue;
        }

        let resolved = match base.join(href) {
            Ok(u) => u,
            Err(_) => continue,
        };

        if !matches!(resolved.scheme(), "http" | "https") {
            continue;
        }

        // Optionally keep the crawl inside the seed host.
        if !any_host && resolved.host_str().unwrap_or("") != base_host {
            continue;
        }

        // Normalise by stripping the fragment.
        let mut canonical = resolved.clone();
        canonical.set_fragment(None);
        let url_str = canonical.to_string();

        // Never re-queue the page we are on.
        if url_str == base_url {
            continue;
        }

        if seen.insert(url_str.clone()) {
            links.push(url_str);
        }
    }

    links
}

// --------------------------------------------------------------------------- //
// Fetch pipeline
// --------------------------------------------------------------------------- //

/// Build a fresh reqwest client, optionally routing through a proxy.
///
/// The client shares the job's cookie jar, so session cookies survive across
/// pages, proxies and render escalations.
fn build_client(
    config: &Config,
    proxy_url: Option<&str>,
    cookies: Option<Arc<Jar>>,
) -> reqwest::Result<reqwest::Client> {
    let ua = if config.rotate_user_agent {
        proxy::random_user_agent().to_string()
    } else {
        config.user_agent.clone()
    };

    let mut builder = reqwest::Client::builder()
        .timeout(config.request_timeout)
        .connect_timeout(config.connect_timeout)
        .pool_idle_timeout(Duration::from_secs(90))
        .pool_max_idle_per_host(config.worker_count)
        .user_agent(ua)
        .redirect(reqwest::redirect::Policy::limited(5));

    if let Some(jar) = cookies {
        builder = builder.cookie_provider(jar);
    }

    if let Some(proxy_str) = proxy_url {
        if let Ok(proxy) = reqwest::Proxy::all(proxy_str) {
            builder = builder.proxy(proxy);
        }
    }

    builder.build()
}

/// Fetch one URL with exponential backoff retries, proxy rotation, stealth
/// headers, adaptive throttle recording, and an optional browser fallback.
async fn fetch_with_retry(
    config: &Config,
    task: &Task,
    stats: &Stats,
    throttle: &Throttle,
) -> FetchOutcome {
    let max_attempts = config.max_retries.saturating_add(1);
    let mut attempt = 0u32;
    let total_started = Instant::now();

    loop {
        attempt += 1;

        // Rotate the proxy on each attempt for resilience.
        let proxy_url = proxy::POOL.next().map(str::to_string);
        let proxy_display = proxy_url.as_deref().unwrap_or("direct").to_string();

        let client = match build_client(
            config,
            proxy_url.as_deref(),
            config.persist_cookies.then(|| task.cookies.clone()),
        ) {
            Ok(c) => c,
            Err(err) => {
                return FetchOutcome {
                    status_code: None,
                    body: String::new(),
                    error: Some(format!("client build failed: {err}")),
                    attempts: attempt,
                    elapsed_ms: total_started.elapsed().as_millis() as u64,
                    bytes: 0,
                    browser_rendered: false,
                    proxy_used: proxy_display,
                    challenge: None,
                };
            }
        };

        let result = if config.tls_impersonate && fingerprint::available() {
            // Real browser TLS/HTTP2 fingerprint instead of the plain one.
            let page = fingerprint::fetch(
                &task.job_id,
                &task.url,
                proxy_url.as_deref(),
                config.request_timeout,
                config.max_html_bytes,
            )
            .await;

            match page.error {
                Some(error) => AttemptResult::Failure {
                    status_code: page.status_code,
                    error,
                    retryable: page.retryable,
                    retry_after: page.retry_after,
                },
                None => {
                    tracing::debug!(
                        url = %task.url,
                        profile = %page.profile,
                        "fetched with a browser TLS fingerprint"
                    );
                    AttemptResult::Success {
                        status_code: page.status_code.unwrap_or(200),
                        body: page.body,
                        bytes: page.bytes,
                    }
                }
            }
        } else {
            attempt_fetch(&client, config, &task.url).await
        };
        let elapsed_ms = total_started.elapsed().as_millis() as u64;
        let host = host_of(&task.url);

        match result {
            AttemptResult::Success {
                status_code,
                body,
                bytes,
            } => {
                // Detect an anti-bot challenge page on the cheap path.
                let challenge = detect_challenge(&body);

                // Decide whether the page really needs a browser.
                let too_small = body.trim().len() < config.min_body_bytes_for_static;
                let js_shell = looks_like_js_app(&body);
                let challenged = config.escalate_on_challenge && challenge.is_some();
                let needs_browser =
                    config.browser_fallback && (too_small || js_shell || challenged);

                if needs_browser && attempt == 1 {
                    tracing::info!(
                        url = %task.url,
                        body_len = body.len(),
                        ?challenge,
                        js_shell,
                        "escalating to the headless browser"
                    );

                    if let Some(rendered) =
                        render_via_service(config, &task.url, &task.cookies).await
                    {
                        throttle.record(&host, elapsed_ms, false, true);
                        let bytes = rendered.html.len();
                        return FetchOutcome {
                            status_code: Some(rendered.status_code.unwrap_or(status_code)),
                            body: rendered.html,
                            error: None,
                            attempts: attempt,
                            elapsed_ms,
                            bytes,
                            browser_rendered: true,
                            proxy_used: proxy_display,
                            challenge: rendered.challenge.or(challenge),
                        };
                    }

                    tracing::warn!(
                        url = %task.url,
                        "render service unavailable — keeping the static body"
                    );
                }

                throttle.record(&host, elapsed_ms, false, true);
                return FetchOutcome {
                    status_code: Some(status_code),
                    body,
                    error: None,
                    attempts: attempt,
                    elapsed_ms,
                    bytes,
                    browser_rendered: false,
                    proxy_used: proxy_display,
                    challenge,
                };
            }
            AttemptResult::Failure {
                status_code,
                error,
                retryable,
                retry_after,
            } => {
                let was_rate_limited = status_code == Some(429);
                throttle.record(&host, elapsed_ms, was_rate_limited, false);

                let can_retry = retryable && attempt < max_attempts;
                if !can_retry {
                    return FetchOutcome {
                        status_code,
                        body: String::new(),
                        error: Some(error),
                        attempts: attempt,
                        elapsed_ms,
                        bytes: 0,
                        browser_rendered: false,
                        proxy_used: proxy_display,
                        challenge: None,
                    };
                }
                stats.record_retry();
                // Honour Retry-After if present, otherwise use exponential backoff.
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

/// One HTTP attempt with stealth headers, a hard timeout, and a body size ceiling.
async fn attempt_fetch(client: &reqwest::Client, config: &Config, url: &str) -> AttemptResult {
    let mut req = client.get(url);

    // Inject stealth browser headers on every request.
    for (key, value) in proxy::stealth_headers() {
        req = req.header(&key, &value);
    }

    let response = match req.send().await {
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

// --------------------------------------------------------------------------- //
// Browser escalation (Python render service)
// --------------------------------------------------------------------------- //

/// A page rendered by the headless browser.
struct RenderedPage {
    html: String,
    status_code: Option<u16>,
    challenge: Option<String>,
}

/// Ask the Python render service to render a page with a real browser.
///
/// The Rust worker deliberately keeps only the fast HTTP path; the browser
/// lives in the Python service so one implementation serves both the local
/// Playwright backend and any remote cloud browser.  When the service is not
/// running the caller simply keeps the static body, so a missing browser
/// never fails a crawl.
async fn render_via_service(config: &Config, url: &str, cookies: &Jar) -> Option<RenderedPage> {
    let client = reqwest::Client::builder()
        .timeout(config.render_timeout)
        .connect_timeout(config.connect_timeout)
        .build()
        .ok()?;

    let payload = serde_json::json!({
        "url": url,
        "scroll": true,
        "wait_after_ms": 750,
    });

    let response = client
        .post(&config.render_endpoint)
        .json(&payload)
        .send()
        .await
        .ok()?;

    if !response.status().is_success() {
        tracing::warn!(
            url = %url,
            status = %response.status(),
            "render service returned an error status"
        );
        return None;
    }

    let body: serde_json::Value = response.json().await.ok()?;
    let html = body
        .get("html")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    if html.trim().is_empty() {
        return None;
    }

    // Carry the browser session cookies back into the HTTP client so the
    // whole job behaves like one continuous visit.
    if let Some(list) = body.get("cookies").and_then(|v| v.as_array()) {
        merge_cookies(cookies, list, url);
    }

    Some(RenderedPage {
        html,
        status_code: body
            .get("status_code")
            .and_then(|v| v.as_u64())
            .map(|v| v as u16),
        challenge: body
            .get("challenge")
            .and_then(|v| v.as_str())
            .map(str::to_string),
    })
}

/// Copy cookies returned by the browser into the HTTP cookie jar.
fn merge_cookies(jar: &Jar, cookies: &[serde_json::Value], url: &str) {
    let Ok(parsed) = Url::parse(url) else {
        return;
    };

    for cookie in cookies {
        let name = cookie.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let value = cookie.get("value").and_then(|v| v.as_str()).unwrap_or("");
        if name.is_empty() {
            continue;
        }
        let domain = cookie
            .get("domain")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let path = cookie.get("path").and_then(|v| v.as_str()).unwrap_or("/");

        let mut header = format!("{name}={value}; Path={path}");
        if !domain.is_empty() {
            header.push_str(&format!("; Domain={domain}"));
        }
        jar.add_cookie_str(&header, &parsed);
    }
}

/// Markers of an anti-bot challenge page.
///
/// The crawler never tries to *solve* a challenge.  It detects the challenge,
/// reports it on the packet, and escalates to the browser tier, which can
/// clear a passive challenge on its own.
fn detect_challenge(html: &str) -> Option<String> {
    let lowered = html.to_ascii_lowercase();
    let head: String = lowered.chars().take(200_000).collect();

    const MARKERS: &[(&str, &str)] = &[
        ("cf-browser-verification", "cloudflare"),
        ("/cdn-cgi/challenge-platform", "cloudflare"),
        ("cf_chl_opt", "cloudflare"),
        ("g-recaptcha", "recaptcha"),
        ("hcaptcha.com", "hcaptcha"),
        ("h-captcha", "hcaptcha"),
        ("turnstile", "turnstile"),
        ("verify you are human", "bot_wall"),
        ("unusual traffic", "bot_wall"),
        ("pardon our interruption", "bot_wall"),
        ("checking your browser", "bot_wall"),
    ];

    MARKERS
        .iter()
        .find(|(marker, _)| head.contains(marker))
        .map(|(_, name)| (*name).to_string())
}

/// Cheap heuristic: does this markup look like a shell that JavaScript fills?
fn looks_like_js_app(html: &str) -> bool {
    const MARKERS: &[&str] = &[
        "id=\"root\"",
        "id='root'",
        "id=\"app\"",
        "id='app'",
        "__next_data__",
        "__nuxt__",
        "ng-version",
        "data-reactroot",
        "window.__initial_state__",
    ];

    let lowered = html.to_ascii_lowercase();
    MARKERS.iter().any(|marker| lowered.contains(marker))
}

// --------------------------------------------------------------------------- //
// Delay helpers
// --------------------------------------------------------------------------- //

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

// --------------------------------------------------------------------------- //
// Tests
// --------------------------------------------------------------------------- //

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = r##"
        <html><body>
          <a href="/alpha">Alpha</a>
          <a href="https://other.example/beta">Beta</a>
          <a href='gamma.html'>Gamma</a>
          <a href="#section">Section</a>
          <a href="mailto:hi@example.com">Mail</a>
          <a href="javascript:void(0)">JS</a>
          <a href="/alpha">Alpha again</a>
        </body></html>
    "##;

    #[test]
    fn discovers_links_across_hosts() {
        let links = discover_links(PAGE, "https://example.com/dir/page", true, 25);
        assert!(links.contains(&"https://example.com/alpha".to_string()));
        assert!(links.contains(&"https://other.example/beta".to_string()));
        assert!(links.contains(&"https://example.com/dir/gamma.html".to_string()));
    }

    #[test]
    fn same_host_mode_filters_other_hosts() {
        let links = discover_links(PAGE, "https://example.com/dir/page", false, 25);
        assert!(links.contains(&"https://example.com/alpha".to_string()));
        assert!(!links.contains(&"https://other.example/beta".to_string()));
    }

    #[test]
    fn drops_anchors_mail_and_javascript() {
        let links = discover_links(PAGE, "https://example.com/", true, 25);
        assert!(!links.iter().any(|link| link.contains("mailto")));
        assert!(!links.iter().any(|link| link.contains("javascript")));
        assert!(!links.iter().any(|link| link.ends_with("#section")));
    }

    #[test]
    fn deduplicates_and_caps() {
        let links = discover_links(PAGE, "https://example.com/", true, 25);
        let unique: std::collections::HashSet<&String> = links.iter().collect();
        assert_eq!(unique.len(), links.len());

        let capped = discover_links(PAGE, "https://example.com/", true, 2);
        assert_eq!(capped.len(), 2);
    }

    #[test]
    fn strips_fragments_from_links() {
        let html = r#"<a href="/page#frag">x</a>"#;
        let links = discover_links(html, "https://example.com/", true, 25);
        assert_eq!(links, vec!["https://example.com/page".to_string()]);
    }

    #[test]
    fn detects_challenge_pages() {
        assert_eq!(
            detect_challenge("<html>cf-browser-verification</html>").as_deref(),
            Some("cloudflare")
        );
        assert_eq!(
            detect_challenge("<div class='g-recaptcha'></div>").as_deref(),
            Some("recaptcha")
        );
        assert!(detect_challenge("<html><body>hello</body></html>").is_none());
    }

    #[test]
    fn recognises_js_shells() {
        assert!(looks_like_js_app("<div id=\"root\"></div>"));
        assert!(!looks_like_js_app("<html><body><p>text</p></body></html>"));
    }
}
