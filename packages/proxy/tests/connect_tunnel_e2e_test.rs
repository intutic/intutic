//! `CONNECT` end to end, over real sockets: the proxy on loopback, a client
//! that sends `CONNECT`, completes TLS through the tunnel and gets an HTTP
//! response back.
//!
//! - **Intercepted host** (`api.anthropic.com`): the proxy terminates TLS with
//!   a leaf it mints, which the client accepts trusting only the proxy's CA,
//!   and the decrypted request reaches the proxy's own HTTP handling. It asks
//!   for `/health`, which the proxy answers itself: a governed LLM request
//!   would be forwarded to the real provider host the `Host` header names.
//! - **Any other host**: a blind tunnel to a local TLS server, whose own
//!   certificate the client trusts.
//!
//! ONE `#[tokio::test]`: `HOME` (where the CA lives) and `PORT` (where the
//! MITM path sends decrypted traffic) are process-global.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

fn provider() -> Arc<rustls::crypto::CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

fn pem_cert(pem: &str) -> CertificateDer<'static> {
    let mut reader = std::io::Cursor::new(pem.as_bytes());
    let cert = rustls_pemfile::certs(&mut reader)
        .next()
        .expect("a certificate")
        .expect("parses");
    cert
}

/// Open a `CONNECT` tunnel to `target` and return the stream once the proxy
/// answered `200`, or the status line it answered instead.
async fn connect_through(proxy: SocketAddr, target: &str) -> Result<TcpStream, String> {
    let mut stream = TcpStream::connect(proxy).await.expect("reach the proxy");
    stream
        .write_all(format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n").as_bytes())
        .await
        .unwrap();
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        let n = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut byte))
            .await
            .map_err(|_| "no answer to CONNECT".to_string())?
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Err(format!(
                "proxy closed the connection after {:?}",
                String::from_utf8_lossy(&head)
            ));
        }
        head.push(byte[0]);
    }
    let head = String::from_utf8_lossy(&head).to_string();
    if head.starts_with("HTTP/1.1 200") {
        Ok(stream)
    } else {
        Err(head)
    }
}

/// TLS over `stream` for `host`, trusting only `root`.
async fn tls(
    stream: TcpStream,
    host: &str,
    root: CertificateDer<'static>,
) -> tokio_rustls::client::TlsStream<TcpStream> {
    let mut roots = rustls::RootCertStore::empty();
    roots.add(root).unwrap();
    let config = rustls::ClientConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth();
    tokio_rustls::TlsConnector::from(Arc::new(config))
        .connect(ServerName::try_from(host.to_string()).unwrap(), stream)
        .await
        .expect("TLS through the tunnel, trusting only the expected root")
}

/// Send `request` and read until the peer closes. A peer that closes without
/// `close_notify` ends the read like EOF: the response is already complete.
async fn exchange<S: AsyncRead + AsyncWrite + Unpin>(stream: &mut S, request: &[u8]) -> String {
    stream.write_all(request).await.unwrap();
    stream.flush().await.unwrap();
    let mut out = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        match tokio::time::timeout(Duration::from_secs(10), stream.read(&mut buf)).await {
            Ok(Ok(0)) | Ok(Err(_)) => break,
            Ok(Ok(n)) => out.extend_from_slice(&buf[..n]),
            Err(_) => panic!(
                "timed out; read so far: {:?}",
                String::from_utf8_lossy(&out)
            ),
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

/// A one-connection TLS server for `localhost` that answers any request.
async fn tls_upstream() -> (u16, CertificateDer<'static>) {
    let cert = rcgen::generate_simple_self_signed(vec!["localhost".to_string()]).unwrap();
    let der = cert.cert.der().clone();
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(cert.key_pair.serialize_der()));
    let config = rustls::ServerConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![der.clone()], key)
        .unwrap();
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut tls = acceptor.accept(tcp).await.unwrap();
        let mut head = Vec::new();
        let mut buf = [0u8; 1024];
        while !head.windows(4).any(|w| w == b"\r\n\r\n") {
            let n = tls.read(&mut buf).await.unwrap();
            if n == 0 {
                return;
            }
            head.extend_from_slice(&buf[..n]);
        }
        let body = "hello from the tunnelled upstream";
        tls.write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .as_bytes(),
        )
        .await
        .unwrap();
        tls.shutdown().await.ok();
    });
    (port, der)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn connect_tunnels_intercepted_and_blind() {
    let home = std::env::temp_dir().join(format!(
        "intutic-connect-e2e-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&home).unwrap();
    std::env::set_var("HOME", &home);
    std::env::remove_var("INTUTIC_SOPS_DIR");

    let config: intutic_proxy::config::ProxyConfig =
        serde_yaml::from_str("model_list: []\n").expect("config parses");
    let state = intutic_proxy::proxy::AppState {
        config,
        wasm_registry: intutic_proxy::wasm::registry::PluginRegistry::new(None)
            .await
            .expect("empty registry"),
        http_client: Arc::new(reqwest::Client::new()),
        reward_engine: Arc::new(intutic_proxy::routing::reward::RewardEngine::new()),
        store: Arc::new(intutic_proxy::store::MemoryStore::new()),
        control_plane: Arc::new(intutic_proxy::store::NullControlPlaneCache),
        context_snapshot_rate: 0.0,
    };
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy = listener.local_addr().unwrap();
    // The MITM path hands decrypted traffic to this process on PORT.
    std::env::set_var("PORT", proxy.port().to_string());
    let app = intutic_proxy::router::build_router(state);
    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .ok();
    });

    let ca = intutic_proxy::ca_manager::ensure_ca_exists()
        .await
        .expect("the proxy's CA");

    // ── Intercepted: TLS terminates at the proxy with a leaf that chains to
    // its CA, and the decrypted request is served by the proxy itself.
    let tunnel = connect_through(proxy, "api.anthropic.com:443")
        .await
        .expect("CONNECT to an intercepted host is answered 200");
    let mut tls_stream = tls(tunnel, "api.anthropic.com", pem_cert(&ca.cert_pem)).await;
    let response = exchange(
        &mut tls_stream,
        b"GET /health HTTP/1.1\r\nHost: api.anthropic.com\r\nConnection: close\r\n\r\n",
    )
    .await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    assert!(
        response.contains("\"service\":\"intutic-proxy\""),
        "{response}"
    );

    // ── Blind: a host the proxy does not intercept is tunnelled as is, and
    // the client sees the upstream's own certificate.
    let (port, upstream_cert) = tls_upstream().await;
    let tunnel = connect_through(proxy, &format!("localhost:{port}"))
        .await
        .expect("CONNECT to another host is answered 200");
    let mut tls_stream = tls(tunnel, "localhost", upstream_cert).await;
    let response = exchange(
        &mut tls_stream,
        b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
    )
    .await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    assert!(
        response.contains("hello from the tunnelled upstream"),
        "{response}"
    );
}
