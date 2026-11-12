use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::json;
use tower_http::cors::{Any, CorsLayer};

use crate::{
    config::Config,
    fetcher::Engine,
    ipc::IpcSink,
    models::{JobAccepted, JobRequest, JobStatus},
    stats::Stats,
};

/// Shared state handed to every route handler.
#[derive(Clone)]
pub struct AppState {
    pub engine: Engine,
    pub stats: Arc<Stats>,
    pub config: Arc<Config>,
    pub ipc: Arc<IpcSink>,
}

/// Public HTTP surface of the core engine.
///
/// The TypeScript gateway posts jobs here (Step 4.2) and polls the Python
/// result store for the transformed payload.
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/stats", get(stats))
        .route("/jobs", post(submit_job))
        .route("/jobs/{job_id}", get(job_status))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .with_state(state)
}

async fn health(State(state): State<AppState>) -> Json<serde_json::Value> {
    let snap = state.stats.snapshot();
    Json(json!({
        "status": "ok",
        "service": "core_worker",
        "version": env!("CARGO_PKG_VERSION"),
        "uptime_secs": snap.uptime_secs,
        "workers": state.config.worker_count,
        "queue_capacity": state.config.queue_capacity,
        "queue_depth": state.engine.queue_depth(),
        "request_timeout_secs": state.config.request_timeout.as_secs(),
        "max_retries": state.config.max_retries,
        "python_ingest": state.config.python_ingest.to_string(),
        "python_results": state.config.python_results.to_string(),
        "python_ingest_connected": state.ipc.is_connected(),
    }))
}

async fn stats(State(state): State<AppState>) -> Json<serde_json::Value> {
    let mut snap = state.stats.snapshot();
    snap.series.retain(|_| true);
    Json(json!({
        "engine": snap,
        "queue_depth": state.engine.queue_depth(),
    }))
}

async fn submit_job(
    State(state): State<AppState>,
    Json(payload): Json<JobRequest>,
) -> Response {
    if payload.urls.is_empty() {
        return api_error(StatusCode::BAD_REQUEST, "urls must not be empty");
    }
    if payload.urls.len() > state.config.max_urls_per_job {
        return api_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            &format!(
                "too many urls: {} exceeds limit {}",
                payload.urls.len(),
                state.config.max_urls_per_job
            ),
        );
    }

    let job_id = uuid::Uuid::new_v4().to_string();
    let target = payload.target;
    let crawl_depth = payload.crawl_depth.min(state.config.crawl_depth);
    let crawl_max_pages = payload.crawl_max_pages.min(state.config.crawl_max_pages);
    let label = payload.label.clone();

    let (accepted, rejected) = state
        .engine
        .submit(
            &job_id,
            payload.urls,
            target,
            payload.selectors,
            crawl_depth,
        )
        .await;

    let body = JobAccepted {
        job_id,
        status: "queued",
        accepted_urls: accepted,
        rejected_urls: rejected,
        target: target.as_str().to_string(),
        queued_at_ms: crate::stats::now_ms(),
        crawl_depth,
        crawl_max_pages,
        label,
    };

    (StatusCode::ACCEPTED, Json(body)).into_response()
}

async fn job_status(
    State(state): State<AppState>,
    Path(job_id): Path<String>,
) -> Response {
    match state.engine.jobs().get(&job_id).await {
        Some(job) => {
            let status = if job.succeeded + job.failed >= job.total_urls {
                "completed"
            } else {
                "running"
            };
            let body = JobStatus {
                job_id: job.job_id,
                status,
                target: job.target,
                total_urls: job.total_urls,
                succeeded: job.succeeded,
                failed: job.failed,
                created_at_ms: job.created_at_ms,
                updated_at_ms: job.updated_at_ms,
                crawl_depth: job.crawl_depth,
                max_pages: job.max_pages,
            };
            Json(body).into_response()
        }
        None => api_error(StatusCode::NOT_FOUND, "unknown job id"),
    }
}

/// Uniform error envelope so the gateway can parse failures uniformly.
fn api_error(status: StatusCode, message: &str) -> Response {
    (
        status,
        Json(json!({ "error": { "status": status.as_u16(), "message": message } })),
    )
        .into_response()
}
