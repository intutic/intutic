//! Who may use the proxy from where, through the real router: `CONNECT`
//! tunnels and sandbox attestation.
//!
//! The peer address is set on each request the way
//! `into_make_service_with_connect_info` sets it in `main.rs`, so a peer on
//! another machine can be simulated. This binary never opens the listener
//! (`listen::set_listener_open`), which is the default: loopback only.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Method, Request, StatusCode};
use serde_json::json;
use tower::Service;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn virtual_key(workspace: &str) -> String {
    ["vk_", "0123456789abcdef0123456789abcdef", "_", workspace].concat()
}

async fn app(control_plane_url: &str) -> axum::Router {
    let config: intutic_proxy::config::ProxyConfig = serde_yaml::from_str(&format!(
        "model_list: []\nintutic_settings:\n  policy:\n    control_plane_url: {control_plane_url}\n"
    ))
    .expect("config parses");
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
    intutic_proxy::router::build_router(state)
}

/// One request through the router. `Router` is always ready, so `call` needs
/// no `poll_ready` first.
async fn send(app: &axum::Router, req: Request<Body>) -> axum::response::Response {
    app.clone().call(req).await.unwrap()
}

fn from(peer: &str, mut req: Request<Body>) -> Request<Body> {
    let addr: SocketAddr = format!("{peer}:50000").parse().unwrap();
    req.extensions_mut().insert(ConnectInfo(addr));
    req
}

fn attest(bearer: Option<&str>) -> Request<Body> {
    let mut b = Request::builder()
        .method(Method::POST)
        .uri("/intutic/attest-sandbox")
        .header("content-type", "application/json");
    if let Some(bearer) = bearer {
        b = b.header("authorization", format!("Bearer {bearer}"));
    }
    b.body(Body::from(json!({"sessionId": "ses_peer"}).to_string()))
        .unwrap()
}

fn connect(proxy_authorization: Option<&str>) -> Request<Body> {
    let mut b = Request::builder()
        .method(Method::CONNECT)
        .uri("example.com:443");
    if let Some(auth) = proxy_authorization {
        b = b.header("proxy-authorization", auth);
    }
    b.body(Body::empty()).unwrap()
}

async fn patches(cp: &MockServer) -> usize {
    cp.received_requests()
        .await
        .unwrap_or_default()
        .iter()
        .filter(|r| r.method.as_str() == "PATCH")
        .count()
}

#[tokio::test]
async fn connect_from_another_machine_is_refused_on_a_loopback_listener() {
    let app = app("http://127.0.0.1:9").await;
    let bearer = format!("Bearer {}", virtual_key("ws_a"));
    let res = send(&app, from("192.168.1.42", connect(Some(&bearer)))).await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);

    // A CONNECT with no peer address at all is refused too.
    let res = send(&app, connect(None)).await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn connect_from_this_machine_is_admitted() {
    let app = app("http://127.0.0.1:9").await;
    let res = send(&app, from("127.0.0.1", connect(None))).await;
    assert_eq!(res.status(), StatusCode::OK);
}

#[tokio::test]
async fn an_unauthenticated_attestation_is_refused() {
    let cp = MockServer::start().await;
    let app = app(&cp.uri()).await;
    let res = send(&app, from("127.0.0.1", attest(None))).await;
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(patches(&cp).await, 0);
}

#[tokio::test]
async fn an_attestation_from_another_machine_is_refused() {
    let cp = MockServer::start().await;
    let app = app(&cp.uri()).await;
    let key = virtual_key("ws_a");
    let res = send(&app, from("192.168.1.42", attest(Some(&key)))).await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    assert!(cp.received_requests().await.unwrap_or_default().is_empty());
}

/// A key of the right shape that the control plane does not recognise never
/// reaches the attestation endpoint.
#[tokio::test]
async fn a_key_the_control_plane_rejects_cannot_attest() {
    let cp = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/auth/key-context"))
        .respond_with(ResponseTemplate::new(401))
        .mount(&cp)
        .await;
    let app = app(&cp.uri()).await;
    let key = virtual_key("ws_forged");
    let res = send(&app, from("127.0.0.1", attest(Some(&key)))).await;
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(patches(&cp).await, 0);
}

/// Another workspace's valid key is authenticated and forwarded, and the
/// control plane refuses it because the session is not that workspace's: the
/// refusal reaches the caller and nothing is attested.
#[tokio::test]
async fn another_workspaces_key_cannot_attest_the_session() {
    let cp = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/auth/key-context"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"workspaceId": "ws_b"})))
        .mount(&cp)
        .await;
    Mock::given(method("PATCH"))
        .and(path("/api/v1/sessions/ses_peer/attest-sandbox"))
        .respond_with(
            ResponseTemplate::new(404).set_body_json(json!({"error": "session_not_found"})),
        )
        .mount(&cp)
        .await;
    let app = app(&cp.uri()).await;
    let key = virtual_key("ws_b");
    let res = send(&app, from("127.0.0.1", attest(Some(&key)))).await;
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    let body = axum::body::to_bytes(res.into_body(), 4096).await.unwrap();
    let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(body["attested"], false);
}

/// The sandbox's own flow: a loopback peer (Docker Desktop delivers the
/// container's `host.docker.internal` connection from loopback) with the
/// workspace key attests.
#[tokio::test]
async fn the_sandbox_attests_with_its_workspace_key() {
    let cp = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/auth/key-context"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"workspaceId": "ws_a"})))
        .mount(&cp)
        .await;
    Mock::given(method("PATCH"))
        .and(path("/api/v1/sessions/ses_peer/attest-sandbox"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"data": {"attested": true}})))
        .mount(&cp)
        .await;
    let app = app(&cp.uri()).await;
    let key = virtual_key("ws_a");
    let res = send(&app, from("127.0.0.1", attest(Some(&key)))).await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(patches(&cp).await, 1);
}
