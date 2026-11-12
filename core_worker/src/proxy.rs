//! Proxy pool, header rotation, and TLS stealth helpers.
//!
//! # Proxy rotation
//!
//! Proxies are loaded once from the `PROXY_LIST` environment variable
//! (comma-separated `http://user:pass@host:port` or `socks5://...` URIs).
//! Workers call [`ProxyPool::next`] to get a round-robin proxy URL they can
//! use when constructing a per-request `reqwest::Client`.
//!
//! # Header stealth
//!
//! [`random_user_agent`] returns a real browser User-Agent from a curated
//! pool so that the outgoing fingerprint looks like normal user traffic.
//! Additional headers (`Accept`, `Accept-Language`, `Accept-Encoding`,
//! `Sec-Fetch-*`) are injected via [`stealth_headers`].

use std::sync::atomic::{AtomicUsize, Ordering};

use once_cell::sync::Lazy;
use rand::seq::IndexedRandom;

// --------------------------------------------------------------------------- //
// User-Agent pool
// --------------------------------------------------------------------------- //

static USER_AGENTS: &[&str] = &[
    // Chrome 124 / Windows
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    // Chrome 123 / macOS
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    // Firefox 125 / Windows
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
    // Firefox 124 / Linux
    "Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0",
    // Edge 124 / Windows
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0",
    // Safari 17 / macOS
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15",
    // Chrome 122 / Android
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36",
    // Safari iOS 17
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
];

/// Returns a random real-browser User-Agent string.
pub fn random_user_agent() -> &'static str {
    let mut rng = rand::rng();
    USER_AGENTS.choose(&mut rng).copied().unwrap_or(USER_AGENTS[0])
}

/// Returns a set of stealth request headers that mimic a real browser session.
///
/// These are injected on every outgoing request to blend in with normal user
/// traffic and reduce the chance of triggering bot-detection rules.
pub fn stealth_headers() -> Vec<(String, String)> {
    vec![
        ("Accept".to_string(), "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8".to_string()),
        ("Accept-Language".to_string(), "en-US,en;q=0.9".to_string()),
        ("Accept-Encoding".to_string(), "gzip, deflate, br".to_string()),
        ("Upgrade-Insecure-Requests".to_string(), "1".to_string()),
        ("Sec-Fetch-Dest".to_string(), "document".to_string()),
        ("Sec-Fetch-Mode".to_string(), "navigate".to_string()),
        ("Sec-Fetch-Site".to_string(), "none".to_string()),
        ("Sec-Fetch-User".to_string(), "?1".to_string()),
        ("Cache-Control".to_string(), "max-age=0".to_string()),
        ("Connection".to_string(), "keep-alive".to_string()),
    ]
}

// --------------------------------------------------------------------------- //
// Proxy pool
// --------------------------------------------------------------------------- //

/// A thread-safe round-robin pool of proxy URLs.
pub struct ProxyPool {
    proxies: Vec<String>,
    counter: AtomicUsize,
}

impl ProxyPool {
    /// Build a pool from a comma-separated list of proxy URIs.  Returns an
    /// empty pool (direct connections) when the list is empty or absent.
    pub fn from_env() -> Self {
        let list: Vec<String> = std::env::var("PROXY_LIST")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect();

        if list.is_empty() {
            tracing::info!("PROXY_LIST not set — using direct connections");
        } else {
            tracing::info!(count = list.len(), "proxy pool initialised");
        }

        ProxyPool {
            proxies: list,
            counter: AtomicUsize::new(0),
        }
    }

    /// Return the next proxy URL in round-robin order, or `None` for direct.
    pub fn next(&self) -> Option<&str> {
        if self.proxies.is_empty() {
            return None;
        }
        let idx = self.counter.fetch_add(1, Ordering::Relaxed) % self.proxies.len();
        Some(&self.proxies[idx])
    }
}

/// Global proxy pool, initialised once from the environment.
pub static POOL: Lazy<ProxyPool> = Lazy::new(ProxyPool::from_env);
