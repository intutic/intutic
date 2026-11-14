//! A provider connection that breaks part-way through a streamed answer.
//!
//! Until this fix the proxy reset the client's connection on this path and logged
//! nothing, so a harness saw only "incomplete chunked read" (six Harvey LAB tasks,
//! 2026-11-14). Now the client gets the text produced so far, then the error event
//! a provider sends when its own stream fails, and a cleanly ended body.
//!
//! Standalone (`INTUTIC_STANDALONE=1`, the operator key from the environment), so it
//! runs in the open-core build. One test per file: it sets process-global env.

use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// An upstream that answers 200 with two SSE chunks, then closes the socket
/// without the terminating chunk.
async fn dying_upstream() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        let mut buf = vec![0u8; 64 * 1024];
        let _ = sock.read(&mut buf).await;
        let chunk = |text: &str| {
            let line = format!(
                "data: {}\n\n",
                serde_json::json!({
                    "id": "c1", "object": "chat.completion.chunk",
                    "choices": [{"index": 0, "delta": {"content": text}, "finish_reason": null}]
                })
            );
            format!("{:x}\r\n{}\r\n", line.len(), line)
        };
        let _ = sock
            .write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n")
            .await;
        let _ = sock.write_all(chunk("Partial answer, ").as_bytes()).await;
        let _ = sock
            .write_all(chunk("then the line drops").as_bytes())
            .await;
        let _ = sock.flush().await;
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        drop(sock); // no terminating 0-chunk: the body is cut
    });
    format!("http://{addr}")
}

#[tokio::test]
async fn a_broken_upstream_stream_ends_with_an_error_event_not_a_reset() {
    let upstream = dying_upstream().await;
    std::env::set_var("OPENAI_UPSTREAM_URL", &upstream);
    std::env::set_var("OPENAI_API_KEY", ["test", "-operator-", "key"].concat());
    std::env::remove_var("CONTROL_PLANE_URL");
    std::env::set_var("INTUTIC_STANDALONE", "1");
    std::env::set_var("INTUTIC_LOCAL_BUDGET_ENFORCE", "0");

    let config: intutic_proxy::config::ProxyConfig =
        serde_yaml::from_str("model_list: []\nintutic_settings: {}\n")
            .expect("minimal config parses");
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
    let app = intutic_proxy::router::build_router(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        axum::serve(listener, app).await.ok();
    });

    let res = reqwest::Client::new()
        .post(format!("http://{addr}/v1/chat/completions"))
        .header(
            "Authorization",
            concat!(
                "Bearer vk_",
                "0123456789abcdef0123456789abcdef",
                "_ws_mid_stream_test"
            ),
        )
        .header("x-workspace-id", "ws_mid_stream_test")
        .header("x-session-id", "ses_mid_stream_test")
        .json(&serde_json::json!({
            "model": "qwen-test-model",
            "stream": true,
            "messages": [{"role": "user", "content": "Write something long."}]
        }))
        .send()
        .await
        .expect("proxy reachable");
    let status = res.status();
    if !status.is_success() {
        panic!("status {status}: {}", res.text().await.unwrap_or_default());
    }
    // The body must END cleanly: before the fix this was a transport error.
    let body = res
        .text()
        .await
        .expect("the stream ends cleanly instead of being reset");

    assert!(
        body.contains("Partial answer, "),
        "text before the break is kept:\n{body}"
    );
    let err_line = body
        .lines()
        .find(|l| l.starts_with("data: ") && l.contains("\"error\""))
        .unwrap_or_else(|| panic!("no error event in the stream:\n{body}"));
    let v: serde_json::Value =
        serde_json::from_str(&err_line["data: ".len()..]).expect("error event is JSON");
    let msg = v["error"]["message"].as_str().unwrap_or_default();
    assert!(
        msg.starts_with("Upstream connection failed mid-response"),
        "{msg}"
    );
    assert_eq!(v["error"]["type"], "server_error");
}
