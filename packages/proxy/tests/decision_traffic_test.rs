//! Customer calls to decision models, governed end to end.
//!
//! Both formats (System One on `/v1/systemone`, OpenAI Decisions on
//! `/v1/decisions`) are read from the recorded shapes in
//! `tests/fixtures/decision-traffic/`, parsed to the normalised shape, and
//! sent through the real router to a local stub upstream that answers with
//! the recorded responses. No hosted API is called: every upstream here is
//! the stub on 127.0.0.1.
//!
//! The end-to-end case is ONE `#[tokio::test]`: `HOME` (where the logs go),
//! `UPSTREAM_URL` and the egress policy are process-global.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use intutic_proxy::protocol::DecisionFormat;
use serde_json::{json, Value};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const SYSTEMONE: &str = include_str!("fixtures/decision-traffic/systemone.json");
const DECISIONS: &str = include_str!("fixtures/decision-traffic/decisions.json");

fn fixture(text: &str) -> Value {
    serde_json::from_str(text).expect("fixture parses")
}

fn check_normalised(format: DecisionFormat, fx: &Value) {
    let want = &fx["normalised"];
    let req = format
        .parse_request(&fx["request"])
        .expect("request parses");
    assert_eq!(req.model, want["model"], "{format:?} model");
    assert_eq!(
        serde_json::to_value(&req.questions).unwrap(),
        want["questions"],
        "{format:?} questions"
    );
    let state = &fx["request"][format.state_field()];
    let expected_state = match state {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    assert_eq!(
        req.state, expected_state,
        "{format:?} state is the bytes sent"
    );

    let resp = format.parse_response(&fx["response"]);
    assert_eq!(
        resp.model_version.as_deref(),
        want["modelVersion"].as_str(),
        "{format:?} model version"
    );
    assert_eq!(
        serde_json::to_value(&resp.answers).unwrap(),
        want["answers"],
        "{format:?} answers"
    );
    assert_eq!(
        u64::from(resp.input_tokens),
        want["inputTokens"].as_u64().unwrap()
    );
    assert_eq!(
        u64::from(resp.output_tokens),
        want["outputTokens"].as_u64().unwrap()
    );
}

#[test]
fn both_recorded_formats_parse_to_the_normalised_shape() {
    check_normalised(DecisionFormat::SystemOne, &fixture(SYSTEMONE));
    check_normalised(DecisionFormat::Decisions, &fixture(DECISIONS));
}

#[test]
fn a_request_the_proxy_cannot_read_is_an_error_not_a_guess() {
    let mut fx = fixture(SYSTEMONE)["request"].clone();
    fx["questions"]["approve"]["type"] = json!("ranking");
    assert!(DecisionFormat::SystemOne.parse_request(&fx).is_err());
    assert!(DecisionFormat::SystemOne
        .parse_request(&json!({"model": "jev-1.14.0", "state": "s"}))
        .is_err());
    assert!(DecisionFormat::Decisions
        .parse_request(&json!({"input": "s", "questions": [{"name": "a", "type": "predicate"}]}))
        .is_err());
    // A box question parses, and has no probability to read.
    let boxed = json!({
        "model": "jev-1.14.0", "state": {"image": "data:image/png;base64,AAAA"},
        "questions": {"region": {"type": "box", "instructions": "Where is the damage?"}}
    });
    let req = DecisionFormat::SystemOne
        .parse_request(&boxed)
        .expect("box parses");
    assert_eq!(req.state, r#"{"image":"data:image/png;base64,AAAA"}"#);
    let resp = DecisionFormat::SystemOne.parse_response(&json!({
        "answers": {"region": {"type": "box", "box": [0.1, 0.2, 0.5, 0.6]}}
    }));
    assert_eq!(resp.answers["region"].top_probability(), None);
}

// Runtime-assembled per the repo's fixture rule: no contiguous credential-
// shaped literal in source.
fn aws_key() -> String {
    ["AKIA", "IOSFODNN7EXAMPLE"].concat()
}
fn pem_header() -> String {
    ["-----BEGIN ", "RSA PRIVATE KEY", "-----"].concat()
}
fn caller_key() -> String {
    ["sk-", "caller-own-", "test"].concat()
}
fn vk() -> String {
    ["vk_", "0123456789abcdef0123456789abcdef", "_ws_decisions"].concat()
}

fn read_lines(dir: &Path, prefix: &str) -> Vec<Value> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with(prefix) && name.ends_with(".jsonl") {
            let text = std::fs::read_to_string(e.path()).unwrap_or_default();
            out.extend(text.lines().filter_map(|l| serde_json::from_str(l).ok()));
        }
    }
    out
}

async fn serve(config_yaml: &str) -> std::net::SocketAddr {
    let config: intutic_proxy::config::ProxyConfig =
        serde_yaml::from_str(config_yaml).expect("config parses");
    config
        .intutic_settings
        .decision_traffic
        .validate()
        .expect("valid decision_traffic");
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
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .ok();
    });
    addr
}

struct Sent {
    status: u16,
    headers: reqwest::header::HeaderMap,
    body: Value,
}

async fn send(
    addr: std::net::SocketAddr,
    route: &str,
    body: &Value,
    bearer: &str,
    extra: &[(&str, &str)],
) -> Sent {
    let mut req = reqwest::Client::new()
        .post(format!("http://{addr}{route}"))
        .header("authorization", format!("Bearer {bearer}"))
        .header("x-intutic-harness", "refund-service");
    for (k, v) in extra {
        req = req.header(*k, *v);
    }
    let res = req.json(body).send().await.expect("proxy reachable");
    let status = res.status().as_u16();
    let headers = res.headers().clone();
    let body = res.json().await.unwrap_or(Value::Null);
    Sent {
        status,
        headers,
        body,
    }
}

#[tokio::test]
async fn recorded_decision_calls_are_governed_end_to_end() {
    let home: PathBuf = std::env::temp_dir().join(format!("dt-e2e-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&home).unwrap();
    std::env::set_var("HOME", &home);
    for var in [
        "UPSTREAM_URL",
        "CONTROL_PLANE_URL",
        "INTUTIC_GATEWAY_ID",
        "INTUTIC_GATEWAY_REQUIRE_VK",
        "TYPESAFE_API_KEY",
        "OPENAI_API_KEY",
        "INTUTIC_SOPS_DIR",
    ] {
        std::env::remove_var(var);
    }
    let logs = home.join(".intutic").join("logs");

    let so = fixture(SYSTEMONE);
    let de = fixture(DECISIONS);
    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/systemone"))
        .respond_with(ResponseTemplate::new(200).set_body_json(so["response"].clone()))
        .mount(&upstream)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/decisions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(de["response"].clone()))
        .mount(&upstream)
        .await;

    let base = format!(
        "model_list: []\nintutic_settings:\n  routing:\n    enabled: false\n  decision_traffic:\n    \
         systemone_upstream: {u}\n    decisions_upstream: {u}\n    floors:\n      approve: 0.8\n      \
         \"*\": 0.5\n    consequential_models: [gpt-6-luna]\n",
        u = upstream.uri()
    );
    let addr = serve(&base).await;
    let key = caller_key();
    let mut forwarded = 0usize;

    // ── System One: floors, no consequential mark ──────────────────────
    let r = send(addr, "/v1/systemone", &so["request"], &key, &[]).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body, so["response"], "the body is never rewritten");
    // approve leans yes at 0.62 (< 0.8), urgency's top level is 0.45 (< 0.5);
    // route's 0.71 clears "*".
    assert_eq!(r.headers["x-intutic-decision-abstain"], "approve,urgency");
    assert!(r.headers.get("x-intutic-decision-requires-human").is_none());
    forwarded += 1;

    // The same call, marked consequential by the app.
    let r = send(
        addr,
        "/v1/systemone",
        &so["request"],
        &key,
        &[("x-intutic-decision-consequential", "1")],
    )
    .await;
    assert_eq!(r.status, 200);
    assert_eq!(r.headers["x-intutic-decision-requires-human"], "1");
    forwarded += 1;

    // ── OpenAI Decisions: a consequential model, a refused question ──────
    let r = send(addr, "/v1/decisions", &de["request"], &key, &[]).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body, de["response"]);
    assert_eq!(r.headers["x-intutic-decision-abstain"], "refund_due");
    assert_eq!(r.headers["x-intutic-decision-requires-human"], "1");
    forwarded += 1;

    // ── DLP redacts the state before it leaves ───────────────────────────
    let mut leaky = so["request"].clone();
    leaky["state"] = json!(format!("refund for account key {}", aws_key()));
    let r = send(addr, "/v1/systemone", &leaky, &key, &[]).await;
    assert_eq!(r.status, 200);
    forwarded += 1;

    // ── A virtual key never reaches a self-hosted upstream ──────────────
    let r = send(addr, "/v1/decisions", &de["request"], &vk(), &[]).await;
    assert_eq!(r.status, 200);
    forwarded += 1;

    let before_refusals = upstream.received_requests().await.unwrap().len();

    // ── DLP refuses a blocked pattern ───────────────────────────────────
    let mut blocked = de["request"].clone();
    blocked["input"][0]["content"][0]["text"] = json!(format!("{}\nMIIEow...", pem_header()));
    let r = send(addr, "/v1/decisions", &blocked, &key, &[]).await;
    assert_eq!(r.status, 400);
    assert_eq!(r.body["error"]["type"], "dlp_policy_violation");

    // ── The version pin refuses a moving alias and an unversioned model ──
    for model in ["jev-latest", "jev-preview"] {
        let mut unpinned = so["request"].clone();
        unpinned["model"] = json!(model);
        let r = send(addr, "/v1/systemone", &unpinned, &key, &[]).await;
        assert_eq!(r.status, 403, "{model}");
        assert_eq!(r.body["error"]["type"], "policy_denied", "{model}");
        assert!(
            r.body["error"]["message"]
                .as_str()
                .unwrap()
                .contains("allow_unpinned"),
            "{model}"
        );
    }

    // ── Egress enforcement refuses an upstream not on the allow policy ───
    intutic_proxy::egress_policy::swap_global_policy(
        intutic_proxy::egress_policy::EgressPolicy::from_entries(
            intutic_proxy::egress_policy::EgressMode::Enforce,
            ["decide.corp.example".to_string()],
        ),
    );
    let r = send(addr, "/v1/decisions", &de["request"], &key, &[]).await;
    assert_eq!(r.status, 403);
    assert_eq!(r.body["error"]["type"], "policy_denied");
    intutic_proxy::egress_policy::swap_global_policy(
        intutic_proxy::egress_policy::EgressPolicy::default(),
    );

    // ── The machine's daily cap refuses a call it cannot cover ──────────
    // No control plane, so the standalone cap ($10 a day by default) holds.
    // About 650k tokens at the unknown-model rate is over it.
    let mut huge = so["request"].clone();
    huge["state"] = json!("x".repeat(2_600_000));
    let r = send(addr, "/v1/systemone", &huge, &key, &[]).await;
    assert_eq!(r.status, 429);
    assert_eq!(r.body["error"]["type"], "OVERAGE_HARD_CAP_EXCEEDED");

    // ── A body that is not a decision request is not forwarded ──────────
    let r = send(
        addr,
        "/v1/systemone",
        &json!({"model": "jev-1.14.0"}),
        &key,
        &[],
    )
    .await;
    assert_eq!(r.status, 400);
    assert_eq!(r.body["error"]["type"], "invalid_body");

    let received = upstream.received_requests().await.unwrap();
    assert_eq!(
        received.len(),
        before_refusals,
        "no refused call reached the upstream"
    );
    assert_eq!(received.len(), forwarded);

    // What the upstream saw: the caller's own key, never a virtual key, no
    // Intutic header, and the redacted state.
    for (i, req) in received.iter().enumerate() {
        assert!(
            req.headers
                .keys()
                .all(|k| !k.as_str().starts_with("x-intutic-")),
            "call {i} leaked an x-intutic header"
        );
        let auth = req
            .headers
            .get("authorization")
            .map(|v| v.to_str().unwrap().to_string());
        if i == 4 {
            assert_eq!(auth, None, "a virtual key is never forwarded");
        } else {
            assert_eq!(auth, Some(format!("Bearer {key}")), "call {i}");
        }
    }
    let sent: Value = serde_json::from_slice(&received[3].body).unwrap();
    let sent_state = sent["state"].as_str().unwrap();
    assert!(!sent_state.contains(&aws_key()), "the key left the machine");
    assert!(sent_state.contains("[REDACTED_SECRET]"), "{sent_state}");

    // ── Shadow mode logs what enforce would refuse, and forwards ─────────
    let shadow = serve(&format!("{base}    mode: shadow\n")).await;
    let mut unpinned = so["request"].clone();
    unpinned["model"] = json!("jev-latest");
    let r = send(shadow, "/v1/systemone", &unpinned, &key, &[]).await;
    assert_eq!(r.status, 200);
    forwarded += 1;
    // allow_unpinned admits it with no shadow note.
    let allow = serve(&format!("{base}    allow_unpinned: true\n")).await;
    let r = send(allow, "/v1/systemone", &unpinned, &key, &[]).await;
    assert_eq!(r.status, 200);
    forwarded += 1;

    // ── The decision-traffic log: one record per call ───────────────────
    // Trace publication is detached; give the writers a moment.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let records = read_lines(&logs, "decision-traffic-");
    let actions: Vec<&str> = records
        .iter()
        .map(|r| r["action"].as_str().unwrap())
        .collect();
    assert_eq!(
        actions,
        [
            "forwarded",
            "forwarded",
            "forwarded",
            "forwarded",
            "forwarded",
            "refused_dlp",
            "refused_unpinned",
            "refused_unpinned",
            "refused_egress",
            "refused_budget",
            "forwarded",
            "forwarded",
        ]
    );
    let keys = |r: &Value| -> Vec<String> {
        let mut k: Vec<String> = r.as_object().unwrap().keys().cloned().collect();
        k.sort();
        k
    };
    let mut schema = vec![
        "v",
        "at",
        "traceId",
        "workspaceId",
        "virtualKeyId",
        "format",
        "provider",
        "upstreamHost",
        "model",
        "modelVersion",
        "pinned",
        "stateHash",
        "stateBytes",
        "dlp",
        "questions",
        "probabilities",
        "floors",
        "belowFloor",
        "consequential",
        "action",
        "status",
        "latencyMs",
    ];
    schema.sort();
    assert_eq!(keys(&records[0]), schema, "the forwarded record's schema");

    let first = &records[0];
    assert_eq!(first["v"], 1);
    assert_eq!(first["format"], "systemone");
    assert_eq!(first["provider"], "other");
    assert_eq!(first["upstreamHost"], "127.0.0.1");
    assert_eq!(first["model"], "jev-1.14.0");
    assert_eq!(first["modelVersion"], "1.14.0");
    assert_eq!(first["pinned"], true);
    let state = so["request"]["state"].as_str().unwrap();
    assert_eq!(first["stateBytes"], state.len());
    assert!(first["stateHash"].as_str().unwrap().starts_with("sha256:"));
    assert!(
        !first.to_string().contains("order: 88412"),
        "the raw state is never logged"
    );
    assert_eq!(first["dlp"], json!({"action": "none", "detectors": []}));
    assert_eq!(first["questions"], so["normalised"]["questions"]);
    assert_eq!(first["probabilities"], so["normalised"]["answers"]);
    assert_eq!(
        first["floors"],
        json!({"approve": 0.8, "route": 0.5, "urgency": 0.5})
    );
    assert_eq!(first["belowFloor"], json!(["approve", "urgency"]));
    assert_eq!(first["consequential"], false);
    assert_eq!(first["status"], 200);
    assert_eq!(records[1]["consequential"], true);
    assert_eq!(records[2]["format"], "decisions");
    assert_eq!(records[2]["probabilities"]["refund_due"], Value::Null);
    assert_eq!(records[3]["dlp"]["action"], "redact");
    assert_eq!(records[3]["dlp"]["detectors"], json!(["aws_access_key"]));
    assert_eq!(records[5]["dlp"]["action"], "refuse");
    assert_eq!(records[5]["status"], 400);
    assert_eq!(records[6]["pinned"], false);
    assert_eq!(records[6]["status"], 403);
    assert_eq!(records[8]["status"], 403);
    assert_eq!(records[9]["status"], 429);
    assert_eq!(records[9]["stateBytes"], 2_600_000);
    assert_eq!(records[10]["shadow"], json!(["would_refuse_unpinned"]));
    assert!(records[11].get("shadow").is_none());

    // ── Metering: one trace per forwarded call, one Governed Request each ─
    let traces: Vec<Value> = read_lines(&logs, "traces-")
        .into_iter()
        .filter(|t| t.get("decision_traffic").is_some())
        .collect();
    assert_eq!(traces.len(), forwarded, "one trace per forwarded call");
    for t in &traces {
        let rec = &t["decision_traffic"];
        assert_eq!(t["trace_id"], rec["traceId"]);
        assert_eq!(t["model"], rec["model"]);
        assert_eq!(t["harness_type"], "refund-service");
        assert!(t["actual_cost_usd"].as_f64().unwrap() > 0.0);
    }
    let forwarded_ids: Vec<&Value> = records
        .iter()
        .filter(|r| r["action"] == "forwarded")
        .map(|r| &r["traceId"])
        .collect();
    let mut trace_ids: Vec<&Value> = traces.iter().map(|t| &t["trace_id"]).collect();
    let mut ids = forwarded_ids.clone();
    ids.sort_by_key(|v| v.to_string());
    trace_ids.sort_by_key(|v| v.to_string());
    assert_eq!(ids, trace_ids);

    let _ = std::fs::remove_dir_all(&home);
}
