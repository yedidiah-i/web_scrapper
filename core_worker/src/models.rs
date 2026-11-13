use serde::{Deserialize, Serialize};

/// Extraction targets understood by the Python transformation layer (Step 3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Target {
    /// Visible text of the page body, split into blocks.
    Text,
    /// Table rows flattened into header/value records.
    Tables,
    /// Image sources, alt text and dimensions hints.
    Images,
    /// Anchor href + anchor text pairs.
    Links,
    /// `<meta>` tags and other document level metadata.
    Metadata,
    /// Price-like elements with the amount and currency split out.
    Prices,
    /// Let the Python layer decide the best target from page structure.
    Auto,
}

impl Target {
    pub fn as_str(&self) -> &'static str {
        match self {
            Target::Text => "text",
            Target::Tables => "tables",
            Target::Images => "images",
            Target::Links => "links",
            Target::Metadata => "metadata",
            Target::Prices => "prices",
            Target::Auto => "auto",
        }
    }
}

/// Job intake payload accepted by `POST /jobs` on the core engine.
#[derive(Debug, Clone, Deserialize)]
pub struct JobRequest {
    /// Target URLs to fetch. Must be http/https.
    pub urls: Vec<String>,
    /// Extraction target forwarded to the Python transformer.
    #[serde(default = "default_target")]
    pub target: Target,
    /// Optional CSS selector overrides applied by the Python transformer.
    #[serde(default)]
    pub selectors: Vec<String>,
    /// How many link-following hops to perform from the seed URLs.
    /// 0 = no recursion (default), 1 = follow links found on seed pages, etc.
    #[serde(default)]
    pub crawl_depth: usize,
    /// Maximum total pages (seed + discovered) to crawl in this job tree.
    #[serde(default = "default_max_pages")]
    pub crawl_max_pages: usize,
    /// Label the caller can attach to group related crawls in history.
    #[serde(default)]
    pub label: Option<String>,
}

fn default_target() -> Target {
    Target::Auto
}

fn default_max_pages() -> usize {
    50
}

/// Response returned once a job is accepted into the worker queue.
#[derive(Debug, Clone, Serialize)]
pub struct JobAccepted {
    pub job_id: String,
    pub status: &'static str,
    pub accepted_urls: usize,
    pub rejected_urls: usize,
    pub target: String,
    pub queued_at_ms: u64,
    pub crawl_depth: usize,
    pub crawl_max_pages: usize,
    pub label: Option<String>,
}

/// Announcement of a newly accepted job, streamed to the Python ingestion
/// socket before the first page packet of that job.
///
/// Without it the processor only learns about a crawl when the first page
/// arrives, and has to guess the label and the crawl depth of the job.
#[derive(Debug, Clone, Serialize)]
pub struct JobStart {
    /// Packet discriminator.
    pub kind: &'static str,
    /// Wire protocol version.
    pub version: u32,
    /// Job this announcement belongs to.
    pub job_id: String,
    /// Caller supplied label, used to group crawls in the history.
    pub label: Option<String>,
    /// Extraction target requested for the job.
    pub target: String,
    /// How many link-following hops the job is allowed to perform.
    pub crawl_depth: usize,
    /// Hard ceiling on the number of pages in this job tree.
    pub crawl_max_pages: usize,
    /// The seed URLs the job started from.
    pub seed_urls: Vec<String>,
}

impl JobStart {
    pub fn new(
        job_id: &str,
        label: Option<String>,
        target: &Target,
        crawl_depth: usize,
        crawl_max_pages: usize,
        seed_urls: Vec<String>,
    ) -> Self {
        Self {
            kind: "job_start",
            version: 1,
            job_id: job_id.to_string(),
            label,
            target: target.as_str().to_string(),
            crawl_depth,
            crawl_max_pages,
            seed_urls,
        }
    }
}

/// Raw HTML packet streamed to the Python ingestion socket.
///
/// One JSON object per line (NDJSON) so the socket stays streaming friendly.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawPacket {
    /// Wire protocol version.
    pub version: u32,
    /// Packet discriminator: `html` for a fetched page, `job_complete` for the
    /// terminal marker that tells the Python layer the job has no more URLs.
    pub kind: String,
    /// Job this packet belongs to.
    pub job_id: String,
    /// Monotonic packet counter for the job.
    pub sequence_number: u64,
    /// Source URL.
    pub url: String,
    /// HTTP status code, absent when the request never completed.
    pub status_code: Option<u16>,
    /// Whether the fetch produced a usable body.
    pub ok: bool,
    /// Failure reason when `ok` is false.
    pub error: Option<String>,
    /// Number of attempts spent (1 means first try succeeded).
    pub attempts: u32,
    /// Wall time spent on the final attempt, in milliseconds.
    pub elapsed_ms: u64,
    /// Nanosecond timestamp of the completed attempt.
    pub timestamp_ns: u128,
    /// Raw HTML body (empty on failure).
    pub html_content: String,
    /// Extraction target requested for this URL.
    pub target: String,
    /// CSS selector overrides requested for this URL.
    pub selectors: Vec<String>,
    /// How many more hops the crawler is allowed from this page (0 = leaf).
    pub crawl_depth_remaining: usize,
    /// Whether this response required a headless-browser render.
    pub browser_rendered: bool,
    /// Proxy used for this fetch, or empty when connecting directly.
    pub proxy_used: String,
    /// Crawl depth at which this page was found (0 = seed URL).
    pub depth: usize,
    /// URL of the page that linked to this one (empty for seeds).
    pub source_url: Option<String>,
    /// Name of the anti-bot challenge detected on this page, if any.
    ///
    /// The challenge is reported, never solved: the worker only escalates to
    /// the browser tier, which may clear a passive challenge on its own.
    pub challenge: Option<String>,
}

/// Live status of a submitted job.
#[derive(Debug, Clone, Serialize)]
pub struct JobStatus {
    pub job_id: String,
    pub status: &'static str,
    pub target: String,
    pub total_urls: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    /// Crawl depth the job was accepted with.
    pub crawl_depth: usize,
    /// Page ceiling for this job tree.
    pub max_pages: usize,
}

/// Internal per-job counters tracked by the engine.
#[derive(Debug, Clone)]
pub struct JobState {
    pub job_id: String,
    pub target: String,
    pub total_urls: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    /// Hard ceiling on pages (seed + discovered) for this job tree.
    pub max_pages: usize,
    /// Crawl depth the job was accepted with.
    pub crawl_depth: usize,
}
