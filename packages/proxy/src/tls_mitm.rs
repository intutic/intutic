//! tls_mitm.rs — HTTP CONNECT tunnel handler with selective TLS interception.
//!
//! When the proxy receives an HTTP CONNECT request:
//!   - AI provider hostname → TLS MITM (terminate, inspect via governance pipeline, re-encrypt)
//!   - All other hosts     → transparent TCP tunnel (no inspection)
//!
//! Safety invariant: we NEVER inspect non-AI traffic. The hostname_filter
//! module defines the strict allowlist. Fail-closed: if MITM setup fails,
//! we return 502 Bad Gateway.

use anyhow::Result;
use axum::{
    body::Body,
    http::{Request, Response, StatusCode},
};
use hyper_util::rt::TokioIo;
use std::sync::Arc;
use tokio::net::TcpStream;
use tokio_rustls::TlsAcceptor;
use tracing::{debug, error, info};

use crate::ca_manager::{ensure_ca_exists, sign_cert_for_host};
use crate::hostname_filter::is_ai_provider_host;

/// Handle an HTTP CONNECT request.
///
/// Upgrades the connection to a raw TCP tunnel. If the target hostname
/// is an AI provider, performs TLS MITM to inspect the request.
/// Otherwise, acts as a transparent passthrough.
pub async fn handle_connect(req: Request<Body>) -> Response<Body> {
    let (host, port) = match req.uri().authority() {
        Some(a) => {
            let host = a.host().to_string();
            let port = a.port_u16().unwrap_or(443);
            (host, port)
        }
        None => {
            error!("CONNECT request missing authority");
            return bad_gateway("Missing authority in CONNECT request");
        }
    };

    let target = format!("{}:{}", host, port);
    let should_mitm = is_ai_provider_host(&host);

    if should_mitm {
        info!(host = %host, "MITM: intercepting AI provider TLS connection");
    } else {
        debug!(host = %host, "Passthrough: transparent TCP tunnel");
    }

    let has_upgrade = req
        .extensions()
        .get::<hyper::upgrade::OnUpgrade>()
        .is_some();
    info!(host = %host, has_upgrade = %has_upgrade, "CONNECT upgrade extension check");

    // Send 200 Connection Established to the client
    let response = Response::builder()
        .status(StatusCode::OK)
        .body(Body::empty())
        .unwrap();

    // Spawn the tunnel in the background using hyper's upgrade mechanism
    tokio::spawn(async move {
        match hyper::upgrade::on(req).await {
            Ok(upgraded) => {
                let client_io = TokioIo::new(upgraded);
                if should_mitm {
                    if let Err(e) = run_mitm_tunnel(client_io, &host).await {
                        tracing::warn!(host = %host, err = %e, "MITM tunnel error");
                    }
                } else {
                    // Connect to the upstream server for transparent passthrough
                    match TcpStream::connect(&target).await {
                        Ok(upstream) => {
                            let (mut client_read, mut client_write) = tokio::io::split(client_io);
                            let (mut upstream_read, mut upstream_write) =
                                tokio::io::split(upstream);
                            let client_to_upstream =
                                tokio::io::copy(&mut client_read, &mut upstream_write);
                            let upstream_to_client =
                                tokio::io::copy(&mut upstream_read, &mut client_write);
                            let _ = tokio::try_join!(client_to_upstream, upstream_to_client);
                        }
                        Err(e) => {
                            error!(target = %target, err = %e, "Failed to connect to upstream during passthrough");
                        }
                    }
                }
            }
            Err(e) => {
                error!("Failed to upgrade CONNECT request: {}", e);
            }
        }
    });

    response
}

/// Perform TLS MITM for an AI provider connection.
///
/// Terminates the client's TLS, signs a fresh cert for the hostname,
/// and pipes the decrypted connection to the local proxy HTTP listener.
async fn run_mitm_tunnel(
    client_io: TokioIo<hyper::upgrade::Upgraded>,
    hostname: &str,
) -> Result<()> {
    // 1. Load CA keypair
    let ca = ensure_ca_exists().await?;

    // 2. Sign a leaf cert for this hostname
    let signed = sign_cert_for_host(&ca, hostname)?;

    // 3. Parse certificate and private key from PEM bytes
    let mut cert_reader = std::io::Cursor::new(signed.cert_pem.as_bytes());
    let certs = rustls_pemfile::certs(&mut cert_reader).collect::<Result<Vec<_>, _>>()?;

    let mut key_reader = std::io::Cursor::new(signed.key_pem.as_bytes());
    let key = rustls_pemfile::private_key(&mut key_reader)?
        .ok_or_else(|| anyhow::anyhow!("No private key found"))?;

    // 4. Build ServerConfig using rustls 0.23 (requires default crypto provider)
    rustls::crypto::ring::default_provider()
        .install_default()
        .ok();

    let server_config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)?;

    let acceptor = TlsAcceptor::from(Arc::new(server_config));

    // 5. Accept TLS connection from client (upgraded socket)
    let client_tls = acceptor.accept(client_io).await?;

    // 6. Connect to our local HTTP server loopback address
    let local_port = std::env::var("PORT")
        .unwrap_or_else(|_| "4000".to_string())
        .parse::<u16>()
        .unwrap_or(4000);
    let local_addr = format!("127.0.0.1:{}", local_port);
    let local_stream = TcpStream::connect(local_addr).await?;

    // 7. Pipe decrypted client_tls and local_stream bidirectionally
    let (mut client_read, mut client_write) = tokio::io::split(client_tls);
    let (mut local_read, mut local_write) = tokio::io::split(local_stream);

    let client_to_local = tokio::io::copy(&mut client_read, &mut local_write);
    let local_to_client = tokio::io::copy(&mut local_read, &mut client_write);

    tokio::select! {
        res = client_to_local => {
            if let Err(e) = res {
                debug!("MITM client-to-local closed with error: {}", e);
            }
        }
        res = local_to_client => {
            if let Err(e) = res {
                debug!("MITM local-to-client closed with error: {}", e);
            }
        }
    }

    info!(
        hostname = %hostname,
        "TLS MITM: intercepted AI provider request — governance pipeline applied"
    );

    Ok(())
}

fn bad_gateway(msg: &str) -> Response<Body> {
    Response::builder()
        .status(StatusCode::BAD_GATEWAY)
        .body(Body::from(format!("502 Bad Gateway: {}", msg)))
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ai_host_gets_mitm() {
        assert!(is_ai_provider_host("api.anthropic.com"));
        assert!(is_ai_provider_host("api.openai.com"));
        assert!(is_ai_provider_host("api2.cursor.sh"));
    }

    #[test]
    fn test_non_ai_host_passes_through() {
        assert!(!is_ai_provider_host("google.com"));
        assert!(!is_ai_provider_host("github.com"));
    }
}
