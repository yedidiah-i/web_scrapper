//! Adaptive per-host rate throttle.
//!
//! Each host gets its own [`HostThrottle`] entry that tracks:
//!
//! * An exponential moving average (EMA) of recent response latencies.
//! * A consecutive-429 counter that temporarily raises the inter-request delay.
//!
//! Workers call [`Throttle::wait`] *before* issuing each request and
//! [`Throttle::record`] *after* the response arrives.  The throttle
//! automatically backs off when the server is slow or rate-limiting and
//! gradually returns to normal speed once responses improve.

use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};

use parking_lot::Mutex;
use tokio::time::sleep;

/// EMA smoothing factor (α): higher → reacts faster, lower → more stable.
const EMA_ALPHA: f64 = 0.2;

/// Base inter-request delay at steady state (no congestion signal).
const BASE_DELAY_MS: u64 = 50;

/// Each additional consecutive 429 adds this many milliseconds of back-off.
const BACKOFF_PER_429_MS: u64 = 2_000;

/// Maximum delay imposed by the adaptive throttle (caps the 429 ramp).
const MAX_ADAPTIVE_DELAY_MS: u64 = 30_000;

/// Latency threshold above which the throttle starts slowing down.
const SLOW_LATENCY_MS: f64 = 3_000.0;

struct HostThrottle {
    /// EMA latency in milliseconds.
    ema_latency_ms: f64,
    /// How many consecutive 429s have been seen without a success in between.
    consecutive_429s: u64,
    /// Timestamp of the last request to this host.
    last_request: Option<Instant>,
}

impl Default for HostThrottle {
    fn default() -> Self {
        HostThrottle {
            ema_latency_ms: 500.0,
            consecutive_429s: 0,
            last_request: None,
        }
    }
}

impl HostThrottle {
    /// Compute the adaptive delay to impose before the next request.
    fn desired_delay_ms(&self) -> u64 {
        // 429-driven back-off.
        let rate_limit_delay = self.consecutive_429s * BACKOFF_PER_429_MS;

        // Latency-driven back-off: scale the base delay proportionally when
        // the server is running slow (EMA exceeds the threshold).
        let latency_factor = if self.ema_latency_ms > SLOW_LATENCY_MS {
            (self.ema_latency_ms / SLOW_LATENCY_MS).min(4.0)
        } else {
            1.0
        };
        let latency_delay = (BASE_DELAY_MS as f64 * latency_factor) as u64;

        (rate_limit_delay + latency_delay).min(MAX_ADAPTIVE_DELAY_MS)
    }
}

/// Global adaptive throttle shared across all workers.
#[derive(Clone)]
pub struct Throttle {
    hosts: Arc<Mutex<HashMap<String, HostThrottle>>>,
}

impl Throttle {
    pub fn new() -> Self {
        Throttle {
            hosts: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Block until it is polite to issue a request to `host`.
    ///
    /// The wait is calculated from the host's adaptive state; fresh hosts get
    /// the base delay only.
    pub async fn wait(&self, host: &str) {
        let delay = {
            let mut map = self.hosts.lock();
            let entry = map.entry(host.to_string()).or_default();
            let delay_ms = entry.desired_delay_ms();

            // Track when the last request was so we can subtract elapsed time.
            let already_waited = entry
                .last_request
                .map(|t| t.elapsed().as_millis() as u64)
                .unwrap_or(delay_ms);

            entry.last_request = Some(Instant::now());

            if delay_ms > already_waited {
                Duration::from_millis(delay_ms - already_waited)
            } else {
                Duration::ZERO
            }
        };

        if !delay.is_zero() {
            sleep(delay).await;
        }
    }

    /// Record the outcome of a completed request.
    ///
    /// * `elapsed_ms` — wall time for the successful or failed attempt.
    /// * `was_rate_limited` — true when the server returned HTTP 429.
    /// * `was_success` — true when the response was 2xx/3xx.
    pub fn record(&self, host: &str, elapsed_ms: u64, was_rate_limited: bool, was_success: bool) {
        let mut map = self.hosts.lock();
        let entry = map.entry(host.to_string()).or_default();

        // Update EMA latency.
        let alpha = EMA_ALPHA;
        entry.ema_latency_ms =
            alpha * elapsed_ms as f64 + (1.0 - alpha) * entry.ema_latency_ms;

        // Track consecutive 429s to ramp back-off.
        if was_rate_limited {
            entry.consecutive_429s += 1;
            tracing::debug!(
                host,
                consecutive = entry.consecutive_429s,
                "rate limited — throttle raised"
            );
        } else if was_success {
            if entry.consecutive_429s > 0 {
                tracing::debug!(host, "throttle relaxed after success");
            }
            entry.consecutive_429s = 0;
        }
    }
}
