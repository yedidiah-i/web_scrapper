//! Core worker: high-concurrency asynchronous fetching engine.
//!
//! Pipeline position: the TypeScript gateway posts extraction jobs to this
//! binary, workers pull URLs from a bounded mpsc queue, fetch them with
//! timeout + retry protection, and stream the raw HTML to the Python
//! transformation service over a newline delimited JSON socket.

mod config;
mod fetcher;
mod ipc;
mod models;
mod server;
mod stats;

use std::sync::Arc;

use anyhow::Result;
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

use crate::{
    config::Config, fetcher::{Engine, JobRegistry}, ipc::IpcSink, server::AppState, stats::Stats,
};

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_target(false)
        .init();

    let config = Arc::new(Config::from_env()?);
    tracing::info!(
        bind = %config.bind_addr,
        workers = config.worker_count,
        timeout_secs = config.request_timeout.as_secs(),
        max_retries = config.max_retries,
        "starting core worker"
    );

    let stats = Arc::new(Stats::new(config.stats_window_secs));
    let jobs = Arc::new(JobRegistry::new());
    let ipc = IpcSink::spawn(&config);
    let engine = Engine::spawn(config.clone(), stats.clone(), jobs.clone(), ipc.clone());

    let listener = TcpListener::bind(config.bind_addr).await?;
    tracing::info!("core worker listening on {}", config.bind_addr);

    let app = server::router(AppState {
        engine,
        stats,
        config: config.clone(),
        ipc,
    });

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    tracing::info!("core worker stopped");
    Ok(())
}

/// Stop accepting work on SIGINT / SIGTERM so in-flight jobs drain.
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut sig) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            sig.recv().await;
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }

    tracing::info!("shutdown signal received");
}
