//! An Intutic virtual key never leaves the proxy.
//!
//! A `vk_` authenticates the caller to Intutic. When the proxy resolved no
//! upstream credential for it (no provisioned workspace key, no operator env
//! key, BYO-key enforcement off), it used to fall through to the raw-key
//! passthrough and copy the caller's `Authorization`/`x-api-key` — the `vk_`
//! itself — to the provider. No provider accepts it, so the call failed
//! anyway, but the key had been handed to a third party. It is refused now,
//! for every provider, before anything is sent.
//!
//! With a provisioned key, the upstream receives that key and no header
//! carrying the `vk_`.
//!
//! ONE `#[tokio::test]`: upstream URLs and the `*_API_KEY` fallbacks are
//! process-global env.

use std::sync::Arc;

use serde_json::json;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const WS_BARE: &str = "ws_vk_unprovisioned";
const WS_KEYED: &str = "ws_vk_provisioned";

// Runtime-assembled per the repo's fixture rule.
fn vk(ws: &str) -> String {
    ["vk_", "0123456789abcdef0123456789abcdef", "_", ws].concat()
}
fn upstream_key(provider: &str) -> String {
    [provider, "-provisioned-", "test"].concat()
}

#[tokio::test]
async fn a_virtual_key_is_refused_rather_than_forwarded_and_never_reaches_an_upstream() {
    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "chatcmpl-vk", "object": "chat.completion", "model": "m",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"},
                         "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}
        })))
        .mount(&upstream)
        .await;
    for p in ["/v1/messages", "/anthropic/v1/messages"] {
        Mock::given(method("POST"))
            .and(path(p))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "msg_vk", "type": "message", "role": "assistant", "model": "m",
                "content": [{"type": "text", "text": "ok"}],
                "stop_reason": "end_turn",
                "usage": {"input_tokens": 1, "output_tokens": 1}
            })))
            .mount(&upstream)
            .await;
    }

    for var in [
        "OPENAI_UPSTREAM_URL",
        "ANTHROPIC_UPSTREAM_URL",
        "DEEPSEEK_UPSTREAM_URL",
        "MISTRAL_UPSTREAM_URL",
    ] {
        std::env::set_var(var, upstream.uri());
    }
    for var in [
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "DEEPSEEK_API_KEY",
        "MISTRAL_API_KEY",
        "CONTROL_PLANE_URL",
        "INTUTIC_SOPS_DIR",
    ] {
        std::env::remove_var(var);
    }

    let store = Arc::new(intutic_proxy::store::MemoryStore::new());
    {
        use intutic_proxy::store::LocalStore as _;
        store
            .set_workspace_credential(WS_KEYED, "openai_api_key", &upstream_key("openai"))
            .await;
        store
            .set_workspace_credential(WS_KEYED, "anthropic_api_key", &upstream_key("anthropic"))
            .await;
        for p in ["deepseek", "mistral"] {
            store
                .set_workspace_credential(
                    WS_KEYED,
                    &format!("{p}_config"),
                    &json!({ "apiKey": upstream_key(p) }).to_string(),
                )
                .await;
        }
    }

    let config: intutic_proxy::config::ProxyConfig =
        serde_yaml::from_str("model_list: []\nintutic_settings:\n  routing:\n    enabled: false\n")
            .expect("config parses");
    let state = intutic_proxy::proxy::AppState {
        config,
        wasm_registry: intutic_proxy::wasm::registry::PluginRegistry::new(None)
            .await
            .expect("empty registry"),
        http_client: Arc::new(reqwest::Client::new()),
        reward_engine: Arc::new(intutic_proxy::routing::reward::RewardEngine::new()),
        store: Arc::clone(&store) as Arc<dyn intutic_proxy::store::LocalStore>,
        control_plane: Arc::new(intutic_proxy::store::NullControlPlaneCache),
        context_snapshot_rate: 0.0,
    };
    let app = intutic_proxy::router::build_router(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        axum::serve(listener, app).await.ok();
    });

    // (label, route, model, auth header, provider key name)
    let cases = [
        (
            "openai",
            "/v1/chat/completions",
            "gpt-4o",
            "authorization",
            "openai",
        ),
        (
            "anthropic",
            "/v1/messages",
            "claude-3-5-haiku-20241022",
            "x-api-key",
            "anthropic",
        ),
        (
            "deepseek-anth",
            "/v1/messages",
            "deepseek-flash",
            "x-api-key",
            "deepseek",
        ),
        (
            "deepseek-chat",
            "/v1/chat/completions",
            "deepseek-chat",
            "authorization",
            "deepseek",
        ),
        (
            "mistral",
            "/v1/chat/completions",
            "mistral-large-latest",
            "authorization",
            "mistral",
        ),
    ];

    let send = |ws: &'static str, label: &str, route: &str, model: &str, auth: &str| {
        let token = vk(ws);
        let value = if auth == "authorization" {
            format!("Bearer {token}")
        } else {
            token
        };
        let body = if route == "/v1/messages" {
            json!({"model": model, "max_tokens": 16,
                   "messages": [{"role": "user", "content": format!("{ws} {label}: hi")}]})
        } else {
            json!({"model": model, "messages": [{"role": "user", "content": format!("{ws} {label}: hi")}]})
        };
        reqwest::Client::new()
            .post(format!("http://{addr}{route}"))
            .header(auth, value)
            .header(
                "x-session-id",
                format!(
                    "ses-{}-{label}",
                    if ws == WS_KEYED { "keyed" } else { "bare" }
                ),
            )
            .json(&body)
            .send()
    };

    let mut failures = Vec::new();

    // Unprovisioned: refused, nothing sent.
    for (label, route, model, auth, _) in cases {
        let res = send(WS_BARE, label, route, model, auth)
            .await
            .expect("proxy reachable");
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        if status.as_u16() != 402 || !text.contains("no_upstream_credential") {
            failures.push(format!(
                "unprovisioned {label}: expected 402 no_upstream_credential, got {status}: {text}"
            ));
        }
    }
    let leaked: Vec<String> = upstream
        .received_requests()
        .await
        .unwrap_or_default()
        .iter()
        .map(|r| String::from_utf8_lossy(&r.body).into_owned())
        .collect();
    if !leaked.is_empty() {
        failures.push(format!(
            "an unprovisioned virtual-key request reached the upstream: {leaked:?}"
        ));
    }

    // Provisioned: served with the provider key; the vk_ is in no header.
    for (label, route, model, auth, provider) in cases {
        let res = send(WS_KEYED, label, route, model, auth)
            .await
            .expect("proxy reachable");
        let status = res.status();
        if !status.is_success() {
            let text = res.text().await.unwrap_or_default();
            failures.push(format!("provisioned {label}: {status}: {text}"));
            continue;
        }
        let marker = format!("{WS_KEYED} {label}: hi");
        let reqs = upstream.received_requests().await.unwrap_or_default();
        let Some(r) = reqs
            .iter()
            .find(|r| String::from_utf8_lossy(&r.body).contains(&marker))
        else {
            failures.push(format!("provisioned {label}: never reached the upstream"));
            continue;
        };
        let values: Vec<String> = r
            .headers
            .iter()
            .map(|(_, v)| v.to_str().unwrap_or_default().to_string())
            .collect();
        if values.iter().any(|v| v.contains("vk_")) {
            failures.push(format!(
                "provisioned {label}: the virtual key reached the upstream in {:?}",
                r.headers
            ));
        }
        if !values.iter().any(|v| v.contains(&upstream_key(provider))) {
            failures.push(format!(
                "provisioned {label}: the {provider} key was not sent: {:?}",
                r.headers
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "{} failure(s):\n\n{}",
        failures.len(),
        failures.join("\n\n")
    );
}
