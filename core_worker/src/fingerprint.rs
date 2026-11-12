//! TLS and HTTP/2 fingerprint impersonation.
//!
//! A plain HTTP client has a recognisable TLS handshake: the cipher list,
//! the extension order and the HTTP/2 settings frame are the same for every
//! request, which makes it easy for a bot-detection service to separate
//! "real browsers" from "scripts".  This module fetches pages through a
//! stack that reproduces a real browser's fingerprint end to end.
//!
//! The implementation is behind the `tls-impersonate` cargo feature because
//! it vendors BoringSSL and therefore needs cmake, NASM, perl and go on the
//! build machine.  Without the feature the module still compiles and the
//! engine simply keeps the plain HTTP path.
//!
//! The clients are cached per job so a crawl keeps one consistent fingerprint
//! and one cookie jar, which is what a real browser session looks like.

use std::time::Duration;

#[cfg(feature = "tls-impersonate")]
mod imp {
    use std::{
        collections::HashMap,
        sync::atomic::{AtomicUsize, Ordering},
        time::Duration,
    };

    use once_cell::sync::Lazy;
    use parking_lot::Mutex;
    use wreq::Client;
    use wreq_util::Emulation;

    /// One client per (job, proxy) pair.
    static CLIENTS: Lazy<Mutex<HashMap<String, Client>>> = Lazy::new(|| Mutex::new(HashMap::new()));

    /// Counter used to hand every job its own browser profile.
    static PROFILE_SEQ: Lazy<AtomicUsize> = Lazy::new(|| AtomicUsize::new(0));

    /// The browser profiles the crawler rotates between.
    ///
    /// Each entry reproduces the TLS handshake, the ALPN negotiation, the HTTP/2
    /// settings and the default headers of that browser.
    fn profile_for(index: usize) -> (Emulation, &'static str) {
        match index % 4 {
            0 => (Emulation::Chrome136, "chrome_136"),
            1 => (Emulation::Firefox136, "firefox_136"),
            2 => (Emulation::Safari18, "safari_18"),
            _ => (Emulation::Edge134, "edge_134"),
        }
    }

    /// Build (or reuse) the client for a job and proxy.
    pub(super) fn client_for(
        job_id: &str,
        proxy_url: Option<&str>,
        timeout: Duration,
    ) -> Result<(Client, String), String> {
        let key = format!("{job_id}|{}", proxy_url.unwrap_or("direct"));

        let mut clients = CLIENTS.lock();
        if let Some(client) = clients.get(&key) {
            return Ok((client.clone(), String::from("cached")));
        }

        let index = PROFILE_SEQ.fetch_add(1, Ordering::Relaxed);
        let (emulation, name) = profile_for(index);

        let mut builder = Client::builder()
            .emulation(emulation)
            .cookie_store(true)
            .gzip(true)
            .brotli(true)
            .deflate(true)
            .zstd(true)
            .timeout(timeout);

        if let Some(proxy) = proxy_url {
            let proxy = wreq::Proxy::all(proxy).map_err(|err| format!("invalid proxy: {err}"))?;
            builder = builder.proxy(proxy);
        }

        let client = builder
            .build()
            .map_err(|err| format!("client build failed: {err}"))?;
        clients.insert(key, client.clone());
        Ok((client, name.to_string()))
    }
}

#[cfg(feature = "tls-impersonate")]
pub async fn fetch(
    job_id: &str,
    url: &str,
    proxy_url: Option<&str>,
    timeout: Duration,
    max_bytes: usize,
) -> ImpersonatedPage {
    let (client, profile) = match imp::client_for(job_id, proxy_url, timeout) {
        Ok(value) => value,
        Err(err) => {
            return ImpersonatedPage {
                status_code: None,
                body: String::new(),
                bytes: 0,
                error: Some(err),
                retryable: false,
                retry_after: None,
                profile: String::new(),
            };
        }
    };

    match client.get(url).send().await {
        Ok(response) => {
            let status = response.status();
            let status_code = status.as_u16();
            let retry_after = response
                .headers()
                .get("retry-after")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.trim().parse::<u64>().ok())
                .map(|seconds| Duration::from_secs(seconds.min(60)));

            if status.is_server_error() || status_code == 429 {
                return ImpersonatedPage {
                    status_code: Some(status_code),
                    body: String::new(),
                    bytes: 0,
                    error: Some(format!("transient http status {status_code}")),
                    retryable: true,
                    retry_after,
                    profile,
                };
            }
            if status.is_client_error() {
                return ImpersonatedPage {
                    status_code: Some(status_code),
                    body: String::new(),
                    bytes: 0,
                    error: Some(format!("permanent http status {status_code}")),
                    retryable: false,
                    retry_after: None,
                    profile,
                };
            }

            match response.bytes().await {
                Ok(bytes) => {
                    let truncated = bytes.len().min(max_bytes);
                    let body = String::from_utf8_lossy(&bytes[..truncated]).to_string();
                    ImpersonatedPage {
                        status_code: Some(status_code),
                        bytes: truncated,
                        body,
                        error: None,
                        retryable: false,
                        retry_after: None,
                        profile,
                    }
                }
                Err(err) => ImpersonatedPage {
                    status_code: Some(status_code),
                    body: String::new(),
                    bytes: 0,
                    error: Some(format!("body read failed: {err}")),
                    retryable: true,
                    retry_after: None,
                    profile,
                },
            }
        }
        Err(err) => ImpersonatedPage {
            status_code: None,
            body: String::new(),
            bytes: 0,
            error: Some(format!("{err}")),
            retryable: true,
            retry_after: None,
            profile,
        },
    }
}

/// Result of one impersonated fetch.
pub struct ImpersonatedPage {
    pub status_code: Option<u16>,
    pub body: String,
    pub bytes: usize,
    pub error: Option<String>,
    pub retryable: bool,
    pub retry_after: Option<Duration>,
    /// Human readable name of the browser profile that was used.
    pub profile: String,
}

// --------------------------------------------------------------------------- //
// Feature gated implementation
// --------------------------------------------------------------------------- //
#[cfg(not(feature = "tls-impersonate"))]
pub async fn fetch(
    _job_id: &str,
    _url: &str,
    _proxy_url: Option<&str>,
    _timeout: Duration,
    _max_bytes: usize,
) -> ImpersonatedPage {
    ImpersonatedPage {
        status_code: None,
        body: String::new(),
        bytes: 0,
        error: Some("tls impersonation is not compiled into this binary".to_string()),
        retryable: false,
        retry_after: None,
        profile: String::new(),
    }
}

/// Whether the binary was built with real browser fingerprints.
pub const fn available() -> bool {
    cfg!(feature = "tls-impersonate")
}
