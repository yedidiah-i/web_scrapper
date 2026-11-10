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
}

fn default_target() -> Target {
    Target::Auto
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
}
