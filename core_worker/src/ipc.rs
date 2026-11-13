use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use tokio::{
    io::AsyncWriteExt,
    net::TcpStream,
    sync::mpsc,
    time::{sleep, Instant},
};

use serde::Serialize;

use crate::{config::Config, models::{JobStart, RawPacket}};

/// Everything the worker streams to the Python ingestion socket.
///
/// Both variants serialise to a flat JSON object with a `kind` discriminator,
/// so the Python side can tell a job announcement from a fetched page.
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum Outbound {
    /// Announcement of a job that was just accepted.
    JobStart(JobStart),
    /// A fetched page.
    Page(RawPacket),
}

/// Outbound sink that streams raw HTML packets to the Python ingestion socket.
///
/// The writer task owns the TCP connection. If the Python service restarts the
/// socket is transparently re-established, and the packet that failed to write
/// is retried instead of being dropped.
pub struct IpcSink {
    tx: mpsc::Sender<Outbound>,
    connected: Arc<AtomicBool>,
}

impl IpcSink {
    pub fn spawn(cfg: &Config) -> std::sync::Arc<Self> {
        let (tx, mut rx) = mpsc::channel::<Outbound>(4096);
        let addr = cfg.python_ingest;
        let connected = Arc::new(AtomicBool::new(false));
        let connected_flag = connected.clone();

        tokio::spawn(async move {
            let mut stream: Option<TcpStream> = None;
            let mut reconnect_after = Instant::now();

            while let Some(packet) = rx.recv().await {
                let mut attempts = 0u32;
                let mut payload = serde_json::to_vec(&packet).unwrap_or_default();
                payload.push(b'\n');

                loop {
                    if stream.is_none() {
                        if Instant::now() < reconnect_after {
                            sleep(reconnect_after - Instant::now()).await;
                        }
                        match TcpStream::connect(addr).await {
                            Ok(s) => {
                                tracing::info!(%addr, "connected to python ingestion socket");
                                connected_flag.store(true, Ordering::Relaxed);
                                stream = Some(s);
                            }
                            Err(err) => {
                                attempts += 1;
                                reconnect_after = Instant::now() + Duration::from_secs(2);
                                if attempts >= 30 {
                                    tracing::error!(
                                        %addr,
                                        %err,
                                        attempts,
                                        "giving up on python ingestion socket, packet dropped"
                                    );
                                    break;
                                }
                                tracing::warn!(%addr, %err, attempts, "ingestion connect failed, retrying");
                                continue;
                            }
                        }
                    }

                    let write_result = async {
                        let s = stream.as_mut().expect("stream present");
                        s.write_all(&payload).await?;
                        s.flush().await
                    }
                    .await;

                    if write_result.is_ok() {
                        break;
                    }

                    let err = write_result.err();
                    tracing::warn!(%addr, ?err, "ingestion write failed, reconnecting");
                    connected_flag.store(false, Ordering::Relaxed);
                    stream = None;
                    reconnect_after = Instant::now() + Duration::from_secs(1);
                    attempts += 1;
                    if attempts >= 30 {
                        tracing::error!(%addr, attempts, "ingestion write failed too often, packet dropped");
                        break;
                    }
                }
            }

            tracing::info!("ingestion writer stopped");
        });

        std::sync::Arc::new(IpcSink { tx, connected })
    }

    /// Whether the ingestion socket is currently established.
    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::Relaxed)
    }

    /// Queue a packet for delivery. Never blocks the worker on a slow socket
    /// beyond the bounded channel capacity.
    pub async fn send(&self, packet: RawPacket) {
        self.push(Outbound::Page(packet)).await;
    }

    /// Announce a freshly accepted job so the Python layer can register the
    /// crawl in its history with the right label and crawl depth.
    pub async fn send_job_start(&self, start: JobStart) {
        self.push(Outbound::JobStart(start)).await;
    }

    async fn push(&self, outbound: Outbound) {
        if let Err(err) = self.tx.send(outbound).await {
            tracing::error!(%err, "ingestion channel closed, packet lost");
        }
    }
}
