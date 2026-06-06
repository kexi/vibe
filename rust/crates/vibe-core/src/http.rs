//! Minimal HTTP client for the upgrade check.
//!
//! Ported from the `fetch` call in `packages/core/src/commands/upgrade.ts`. The
//! trait keeps the network out of the upgrade logic so it can be tested with a
//! [`FakeHttpClient`]. [`UreqClient`] is the production impl over ureq 3.x with
//! the security posture the review demanded: redirects DISABLED, non-2xx is an
//! error, certificate verification always on (rustls + aws-lc-rs), explicit
//! timeouts, and a hard 1 MB body cap applied via `Read::take`.

use crate::error::{Result, VibeError};
use std::time::Duration;

/// Body size cap for upgrade responses (1 MB). The JSR meta.json is tiny; this
/// defends against a malicious/oversized response regardless of Content-Length.
pub const MAX_RESPONSE_SIZE: u64 = 1_048_576;

/// A fetched HTTP response (only the fields upgrade needs).
#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: u16,
    /// Lowercased `Content-Type` header value, if present.
    pub content_type: Option<String>,
    /// Body bytes, already capped at [`MAX_RESPONSE_SIZE`].
    pub body: String,
}

/// Abstraction over an HTTPS GET, injected so upgrade is testable offline.
pub trait HttpClient {
    /// GET `url` with the given total timeout.
    ///
    /// Mapping a non-2xx status to `Err` is NOT a trait guarantee — it is the
    /// behavior of the production [`UreqClient`] impl (via
    /// `http_status_as_error(true)`). Test doubles such as [`FakeHttpClient`] may
    /// return `Ok` carrying any [`HttpResponse::status`], including non-2xx.
    /// Callers MUST therefore inspect `HttpResponse::status` even on `Ok` rather
    /// than assume `Ok` means 2xx (the defensive check in `fetch_latest_version`
    /// does exactly this).
    fn get(&self, url: &str, timeout: Duration) -> Result<HttpResponse>;
}

/// Production [`HttpClient`] over ureq 3.x.
pub struct UreqClient;

impl UreqClient {
    pub fn new() -> Self {
        UreqClient
    }
}

impl Default for UreqClient {
    fn default() -> Self {
        UreqClient::new()
    }
}

/// Install the aws-lc-rs rustls crypto provider as the process default, once.
///
/// Why this is needed: we depend on `rustls` with only the `aws-lc-rs` feature
/// (to keep `ring` out of the tree), so there is exactly one provider available
/// but it is not auto-installed as the process default. `install_default` is
/// idempotent-guarded by `OnceLock` so repeated upgrade calls are safe.
fn ensure_crypto_provider() {
    use std::sync::OnceLock;
    static INSTALLED: OnceLock<()> = OnceLock::new();
    INSTALLED.get_or_init(|| {
        // Ignore an Err: it only means a provider was already installed, which
        // is fine — we just need *a* provider present before the TLS handshake.
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    });
}

impl HttpClient for UreqClient {
    fn get(&self, url: &str, timeout: Duration) -> Result<HttpResponse> {
        use std::io::Read;

        ensure_crypto_provider();

        let agent: ureq::Agent = ureq::Agent::config_builder()
            // Non-2xx → Err (the upgrade logic treats any non-2xx as failure).
            .http_status_as_error(true)
            // SECURITY: never follow redirects. A redirect to an attacker host
            // could exfiltrate or feed a spoofed version. 0 = reject redirects.
            .max_redirects(0)
            .timeout_global(Some(timeout))
            .timeout_connect(Some(Duration::from_secs(5)))
            // SECURITY: explicit read timeout so a slow-loris body can't hang us.
            .timeout_recv_body(Some(Duration::from_secs(5)))
            .build()
            .into();

        let mut response = agent
            .get(url)
            .call()
            .map_err(|e| VibeError::Network(format!("{e}")))?;

        let status = response.status().as_u16();
        let content_type = response
            .headers()
            .get(ureq::http::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_ascii_lowercase());

        // SECURITY: cap the body via `take` regardless of Content-Length so a
        // lying/oversized response cannot exhaust memory.
        let mut buf = Vec::new();
        response
            .body_mut()
            .as_reader()
            .take(MAX_RESPONSE_SIZE)
            .read_to_end(&mut buf)
            .map_err(|e| VibeError::Network(format!("Failed to read response body: {e}")))?;
        let body = String::from_utf8_lossy(&buf).into_owned();

        Ok(HttpResponse {
            status,
            content_type,
            body,
        })
    }
}

#[cfg(any(test, feature = "test-util"))]
pub use fake::FakeHttpClient;

#[cfg(any(test, feature = "test-util"))]
mod fake {
    use super::{HttpClient, HttpResponse};
    use crate::error::{Result, VibeError};
    use std::time::Duration;

    /// A canned-response [`HttpClient`] for tests.
    pub struct FakeHttpClient {
        result: std::result::Result<HttpResponse, String>,
    }

    impl FakeHttpClient {
        /// Respond with a 2xx JSON body.
        pub fn json(body: &str) -> Self {
            FakeHttpClient {
                result: Ok(HttpResponse {
                    status: 200,
                    content_type: Some("application/json".to_string()),
                    body: body.to_string(),
                }),
            }
        }

        /// Respond with an explicit status / content-type / body.
        pub fn with(status: u16, content_type: Option<&str>, body: &str) -> Self {
            FakeHttpClient {
                result: Ok(HttpResponse {
                    status,
                    content_type: content_type.map(|s| s.to_string()),
                    body: body.to_string(),
                }),
            }
        }

        /// Respond with a transport-level error (e.g. redirect rejected).
        pub fn error(message: &str) -> Self {
            FakeHttpClient {
                result: Err(message.to_string()),
            }
        }
    }

    impl HttpClient for FakeHttpClient {
        fn get(&self, _url: &str, _timeout: Duration) -> Result<HttpResponse> {
            self.result.clone().map_err(VibeError::Network)
        }
    }
}
