use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

/// A single completed fetch, kept in a rolling window for time-series charts.
#[derive(Debug, Clone, Copy)]
struct Event {
    at_ms: u64,
    ok: bool,
    latency_ms: u64,
}

/// Shared engine counters.
///
/// Cheap atomics for the hot path plus a bounded rolling window of events used
/// by the dashboard to chart successful runs against failed network requests.
pub struct Stats {
    jobs_total: AtomicU64,
    urls_total: AtomicU64,
    success: AtomicU64,
    failed: AtomicU64,
    retries: AtomicU64,
    bytes: AtomicU64,
    total_latency_ms: AtomicU64,
    started_at_ms: u64,
    window_secs: u64,
    events: Mutex<VecDeque<Event>>,
}

impl Stats {
    pub fn new(window_secs: u64) -> Self {
        Stats {
            jobs_total: AtomicU64::new(0),
            urls_total: AtomicU64::new(0),
            success: AtomicU64::new(0),
            failed: AtomicU64::new(0),
            retries: AtomicU64::new(0),
            bytes: AtomicU64::new(0),
            total_latency_ms: AtomicU64::new(0),
            started_at_ms: now_ms(),
            window_secs,
            events: Mutex::new(VecDeque::new()),
        }
    }

    pub fn record_job(&self) {
        self.jobs_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_urls(&self, count: usize) {
        self.urls_total.fetch_add(count as u64, Ordering::Relaxed);
    }

    pub fn record_retry(&self) {
        self.retries.fetch_add(1, Ordering::Relaxed);
    }

    /// Record the outcome of one URL attempt.
    pub fn record_outcome(&self, ok: bool, latency_ms: u64, bytes: usize) {
        if ok {
            self.success.fetch_add(1, Ordering::Relaxed);
        } else {
            self.failed.fetch_add(1, Ordering::Relaxed);
        }
        self.bytes.fetch_add(bytes as u64, Ordering::Relaxed);
        self.total_latency_ms.fetch_add(latency_ms, Ordering::Relaxed);

        let mut events = match self.events.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        events.push_back(Event {
            at_ms: now_ms(),
            ok,
            latency_ms,
        });
        let cutoff = now_ms().saturating_sub(self.window_secs * 1000);
        while let Some(front) = events.front() {
            if front.at_ms < cutoff {
                events.pop_front();
            } else {
                break;
            }
        }
    }

    /// Snapshot of counters plus a per-minute success/failure series.
    pub fn snapshot(&self) -> StatsSnapshot {
        let success = self.success.load(Ordering::Relaxed);
        let failed = self.failed.load(Ordering::Relaxed);
        let total_latency_ms = self.total_latency_ms.load(Ordering::Relaxed);
        let completed = success + failed;

        let events = match self.events.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };

        // Bucket the rolling window into whole minutes, oldest first.
        let mut buckets: Vec<(u64, u64, u64)> = Vec::new();
        for event in events.iter() {
            let minute = event.at_ms / 60_000 * 60_000;
            match buckets.last_mut() {
                Some(last) if last.0 == minute => {
                    if event.ok {
                        last.1 += 1;
                    } else {
                        last.2 += 1;
                    }
                }
                _ => buckets.push((minute, u64::from(event.ok), u64::from(!event.ok))),
            }
        }

        let series = buckets
            .into_iter()
            .map(|(ts, ok, err)| SeriesPoint {
                ts,
                success: ok,
                failed: err,
            })
            .collect();

        StatsSnapshot {
            jobs_total: self.jobs_total.load(Ordering::Relaxed),
            urls_total: self.urls_total.load(Ordering::Relaxed),
            success,
            failed,
            retries: self.retries.load(Ordering::Relaxed),
            bytes: self.bytes.load(Ordering::Relaxed),
            avg_latency_ms: if completed > 0 {
                total_latency_ms / completed
            } else {
                0
            },
            started_at_ms: self.started_at_ms,
            uptime_secs: now_ms().saturating_sub(self.started_at_ms) / 1000,
            series,
        }
    }
}

/// Point-in-time engine counters.
#[derive(Debug, Clone, serde::Serialize)]
pub struct StatsSnapshot {
    pub jobs_total: u64,
    pub urls_total: u64,
    pub success: u64,
    pub failed: u64,
    pub retries: u64,
    pub bytes: u64,
    pub avg_latency_ms: u64,
    pub started_at_ms: u64,
    pub uptime_secs: u64,
    pub series: Vec<SeriesPoint>,
}

/// One minute bucket of the success/failure chart.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SeriesPoint {
    /// Start of the minute bucket, epoch milliseconds.
    pub ts: u64,
    pub success: u64,
    pub failed: u64,
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
