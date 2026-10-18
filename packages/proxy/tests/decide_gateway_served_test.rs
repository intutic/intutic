//! A gateway that requires virtual keys: its decide rules take their pins and
//! shadow stamps from the control plane's policy resolve, and every
//! evaluation is written to the decide log and uploaded to the workspace.
//!
//! A stub control plane (wiremock on 127.0.0.1) answers `/auth/key-context`,
//! `/workspace/sops-policy`, `/policy/resolve` and `/decide/events`; a stub
//! decide engine answers the `logprobs` adapter, as in
//! `decide_gateway_test.rs`. There are no pins on disk: whatever enforces
//! does so under a pin the resolve served.
//!
//! ONE `#[tokio::test]`: `HOME`, the gateway config, the control-plane URL
//! and the installed engine are process-global.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use intutic_proxy::decide::gateway::{fetch_served, GatewayLog, GatewayRules, GatewayUpload};
use intutic_proxy::decide::log::LogDirs;
use intutic_proxy::decide::{parse_line, rule_hash, DecideDecl};
use intutic_proxy::refusal::InterventionMode;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use wiremock::matchers::{body_string_contains, method, path, query_param};
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

const STUB_MODEL: &str = "stub-model";
const DIGEST: &str = "id:stub-model";

const ALPHA: &str = r#"{"id":"alpha-leak","on":"response","questions":{"leak":{"type":"yes_no","ask":"Does the response reveal the ALPHA project codename?"}},"when":"leak","rollout":"enforce"}"#;
const GAMMA: &str = r#"{"id":"gamma-export","on":"tool_call","tools":["Bash"],"questions":{"exports":{"type":"yes_no","ask":"Does this command export the GAMMA customer table?"}},"when":"exports","rollout":"enforce"}"#;
const DELTA: &str = r#"{"id":"delta-shadowed","on":"response","questions":{"leak":{"type":"yes_no","ask":"Does the response reveal the DELTA budget?"}},"when":"leak","rollout":"enforce"}"#;
const EPSILON: &str = r#"{"id":"epsilon-unserved","on":"response","questions":{"leak":{"type":"yes_no","ask":"Does the response reveal the EPSILON roadmap?"}},"when":"leak","rollout":"enforce"}"#;

fn sop_markdown() -> String {
    format!(
        "---\ndecide: {ALPHA}\ndecide: {GAMMA}\ndecide: {DELTA}\ndecide: {EPSILON}\n---\n# Served rules\n\nNothing leaves the project.\n"
    )
}

fn hash(line: &str) -> String {
    match parse_line(line) {
        DecideDecl::Rule(r) => rule_hash(&r),
        other => panic!("does not read: {other:?}"),
    }
}

fn served_pin() -> Value {
    json!({"modelDigest": DIGEST, "evalRunId": "der_served", "source": "server"})
}

/// The resolve's `decideRules`: alpha pinned; gamma pinned under a hash that
/// is not the rule's; delta pinned but stamped shadow; epsilon not served.
fn resolve_body() -> Value {
    let served = |ir: &str, extra: Value| {
        let mut r = json!({"sopId": "sop_1", "sopTitle": "Served rules", "ruleText": "Nothing leaves the project.", "ir": ir, "ruleHash": hash(ir), "pins": [served_pin()]});
        if let (Some(o), Value::Object(e)) = (r.as_object_mut(), extra) {
            o.extend(e);
        }
        r
    };
    json!({
        "workspaceId": "ws_served",
        "decideRules": [
            served(ALPHA, json!({})),
            served(GAMMA, json!({"ruleHash": "0".repeat(64)})),
            served(DELTA, json!({"rollout": "shadow"})),
        ]
    })
}

struct StubEngine;

fn logprobs(tokens: &[(&str, f64)]) -> ResponseTemplate {
    let top: Vec<Value> = tokens
        .iter()
        .map(|(t, p)| json!({ "token": t, "logprob": p.ln() }))
        .collect();
    ResponseTemplate::new(200).set_body_json(json!({
        "choices": [{ "logprobs": { "content": [{ "top_logprobs": top }] } }]
    }))
}

impl Respond for StubEngine {
    fn respond(&self, req: &Request) -> ResponseTemplate {
        let body: Value = serde_json::from_slice(&req.body).unwrap_or(Value::Null);
        let prompt = body["messages"][0]["content"].as_str().unwrap_or("");
        let (state, question) = prompt.rsplit_once("\n\nQUESTION: ").unwrap_or((prompt, ""));
        if question.contains("\nOPTIONS:\n") {
            let letter = question
                .lines()
                .find_map(|l| l.strip_suffix(") delete_files"))
                .unwrap_or("A");
            let others: Vec<&str> = ["A", "B", "C"]
                .into_iter()
                .filter(|l| *l != letter)
                .collect();
            return logprobs(&[(letter, 0.98), (others[0], 0.01), (others[1], 0.01)]);
        }
        let p = if state.contains("rm -rf / --no-preserve-root") {
            0.99
        } else {
            match ["ALPHA", "GAMMA", "DELTA", "EPSILON"]
                .iter()
                .find(|k| question.contains(*k))
            {
                Some(k) if state.contains(&format!("{k}-YES")) => 0.99,
                _ => 0.01,
            }
        };
        logprobs(&[("yes", p), ("no", 1.0 - p)])
    }
}

fn text_body(content: &str) -> Value {
    json!({
        "id": "chatcmpl-served", "object": "chat.completion", "model": "qwen-test-model",
        "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}
    })
}

fn tool_call_body(command: &str) -> Value {
    json!({
        "id": "chatcmpl-served", "object": "chat.completion", "model": "qwen-test-model",
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": null, "tool_calls": [{
                "id": "call_served", "type": "function",
                "function": { "name": "Bash", "arguments": json!({ "command": command }).to_string() }
            }]},
            "finish_reason": "tool_calls"
        }],
        "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30}
    })
}

/// Every decide log line under `logs`.
fn log_lines(logs: &Path) -> Vec<Value> {
    let Ok(entries) = std::fs::read_dir(logs) else {
        return Vec::new();
    };
    let mut names: Vec<_> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("decide-") && n.ends_with(".jsonl"))
        })
        .collect();
    names.sort();
    names
        .iter()
        .flat_map(|p| {
            std::fs::read_to_string(p)
                .unwrap()
                .lines()
                .map(|l| serde_json::from_str::<Value>(l).expect("each line is JSON"))
                .collect::<Vec<_>>()
        })
        .collect()
}

/// The upload requests the stub control plane received so far.
async fn uploads(cp: &MockServer) -> Vec<(String, Value)> {
    cp.received_requests()
        .await
        .unwrap()
        .into_iter()
        .filter(|r| r.url.path() == "/api/v1/decide/events")
        .map(|r| {
            let auth = r
                .headers
                .get("authorization")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string();
            (auth, serde_json::from_slice(&r.body).unwrap())
        })
        .collect()
}

async fn wait_for_uploads(cp: &MockServer, n: usize) -> Vec<(String, Value)> {
    for _ in 0..100 {
        let got = uploads(cp).await;
        if got.len() >= n {
            return got;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    uploads(cp).await
}

fn vk() -> String {
    // Runtime-assembled virtual key, per the repo's fixture rule.
    ["vk_", "0123456789abcdef0123456789abcdef", "_ws_served"].concat()
}

#[tokio::test]
async fn a_gateway_that_requires_keys_takes_pins_from_resolve_and_writes_and_uploads_the_decide_log(
) {
    let engine_stub = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(StubEngine)
        .mount(&engine_stub)
        .await;

    let cp = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/auth/key-context"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "workspaceId": "ws_served",
            "memberId": "mbr_served",
            "role": "DEVELOPER",
            "budget": { "dailyUsd": 50, "monthlyUsd": 1000 },
            "ssoGroups": { "policy": null, "memberGroups": null },
            "decideLogUploadEnabled": true,
            "decideLogUploadArgs": false
        })))
        .mount(&cp)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/v1/workspace/sops-policy"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "workspaceId": "ws_served",
            "sops": [{"title": "Served rules", "markdownContent": sop_markdown(), "scope": "workspace"}]
        })))
        .mount(&cp)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/v1/policy/resolve"))
        .and(query_param("workspaceId", "ws_served"))
        .respond_with(ResponseTemplate::new(200).set_body_json(resolve_body()))
        .mount(&cp)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/v1/decide/events"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"accepted": 1})))
        .mount(&cp)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/v1/policy/check"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "action": "allow" })))
        .mount(&cp)
        .await;

    let root = std::env::temp_dir().join(format!("intutic-decide-served-{}", std::process::id()));
    let home = root.join("home");
    std::fs::create_dir_all(home.join(".intutic/decide")).unwrap();
    std::fs::write(
        home.join(".intutic/decide/engine.json"),
        json!({"url": engine_stub.uri(), "adapter": "logprobs", "model": STUB_MODEL}).to_string(),
    )
    .unwrap();
    std::env::set_var("HOME", &home);
    std::env::remove_var("INTUTIC_DECIDE_MODEL_DIGEST");
    std::env::remove_var("INTUTIC_DECIDE_MAX_RESPONSE_STATE_BYTES");
    intutic_proxy::decide::gateway::install_from_env();
    assert!(intutic_proxy::decide::gateway::current().engine().is_ok());

    // ── The served stamps, read directly ──
    let client = reqwest::Client::new();
    let credential = intutic_proxy::credential::RequestCredential::classify(&vk());
    let key = credential.virtual_key().expect("a virtual key").clone();
    let served = fetch_served(&client, &cp.uri(), "ws_served", &key, None).await;
    let sop = intutic_proxy::sops::Sop {
        title: "Served rules".into(),
        body: "# Served rules\n\nNothing leaves the project.".into(),
        decide_rules: intutic_proxy::decide::parse_lines([ALPHA, GAMMA, DELTA, EPSILON]),
        ..Default::default()
    };
    // A local pin for every rule: a gateway that requires keys ignores them.
    let local = root.join("local-decide");
    for line in [ALPHA, GAMMA, DELTA, EPSILON] {
        let dir = local.join("evals").join(hash(line));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("pin.json"),
            json!({"modelDigest": DIGEST, "evalRunId": "run-local", "source": "local"}).to_string(),
        )
        .unwrap();
    }
    let stamps = |rules: &GatewayRules| -> Vec<(String, String, usize)> {
        rules
            .entries()
            .iter()
            .map(|e| (e.rule.id.clone(), e.stamped_by.clone(), e.pins.len()))
            .collect()
    };
    let gateway = GatewayRules::from_sops_in(
        std::slice::from_ref(&sop),
        "",
        InterventionMode::Transparent,
        false,
        &local,
        Some(&served),
    );
    assert_eq!(
        stamps(&gateway),
        [
            ("alpha-leak".to_string(), "rule".to_string(), 1),
            ("gamma-export".to_string(), "no-pins".to_string(), 0),
            ("delta-shadowed".to_string(), "server-shadow".to_string(), 1),
            ("epsilon-unserved".to_string(), "no-pins".to_string(), 0),
        ]
    );
    assert_eq!(gateway.entries()[0].pins[0].eval_run_id, "der_served");
    // The same SOPs read from the SOP directory take the local pins.
    let local_rules = GatewayRules::from_sops_in(
        std::slice::from_ref(&sop),
        "",
        InterventionMode::Transparent,
        true,
        &local,
        None,
    );
    assert!(stamps(&local_rules)
        .iter()
        .all(|(_, by, n)| by == "rule" && *n == 1));
    // Cached: a second read asks nothing.
    let resolves = || async {
        cp.received_requests()
            .await
            .unwrap()
            .iter()
            .filter(|r| r.url.path() == "/api/v1/policy/resolve")
            .count()
    };
    assert_eq!(resolves().await, 1);
    let again = fetch_served(&client, &cp.uri(), "ws_served", &key, None).await;
    assert_eq!(again, served);
    assert_eq!(resolves().await, 1);
    // A resolve that does not answer serves nothing: every rule is shadow.
    let none = fetch_served(&client, "http://127.0.0.1:1", "ws_other", &key, None).await;
    let unserved = GatewayRules::from_sops_in(
        std::slice::from_ref(&sop),
        "",
        InterventionMode::Transparent,
        false,
        &local,
        Some(&none),
    );
    assert!(stamps(&unserved)
        .iter()
        .all(|(_, by, n)| by == "no-pins" && *n == 0));

    // ── The log and the upload, at the stage ──
    let dirs = |name: &str| LogDirs {
        logs: root.join(name).join("logs"),
        stats: root.join(name).join("stats"),
        decide: root.join(name).join("decide"),
    };
    let with_log = |rules: GatewayRules, name: &str, url: &str, with_args: bool| {
        rules.with_log(GatewayLog {
            harness: "claude-code".into(),
            workspace_id: "ws_served".into(),
            session_id: "ses_stage".into(),
            dirs: dirs(name),
            upload: Some(GatewayUpload {
                client: Arc::new(reqwest::Client::new()),
                control_plane_url: url.to_string(),
                virtual_key: key.clone(),
                with_args,
            }),
        })
    };
    let stage = with_log(gateway.clone(), "stage", &cp.uri(), false);
    let content = "The ALPHA-YES codename is Bluebird; ask dev.one@example.com.";
    let verdict = stage.check_response(content).await.expect("refused");
    assert_eq!(verdict.code, "DECIDE_REFUSED");
    let lines = log_lines(&dirs("stage").logs);
    let decision = lines
        .iter()
        .find(|l| l["event"] == "decide.decision")
        .expect("a decision line");
    let state = format!(
        "ACTIVE SOP CONSTRAINTS:\n# Served rules\n\nNothing leaves the project.\n\nASSISTANT RESPONSE:\n{content}"
    );
    let state_hash = format!("sha256:{}", hex::encode(Sha256::digest(state.as_bytes())));
    assert_eq!(decision["v"], 1);
    assert_eq!(decision["harness"], "claude-code");
    assert_eq!(decision["workspaceId"], "ws_served");
    assert_eq!(decision["sessionId"], "ses_stage");
    assert_eq!(decision["tool"], "");
    assert_eq!(decision["outcome"], "refuse");
    assert_eq!(decision["code"], "DECIDE_REFUSED");
    assert_eq!(decision["stateHash"], state_hash.as_str());
    assert_eq!(
        decision["argsExcerpt"],
        "\"The ALPHA-YES codename is Bluebird; ask [REDACTED].\""
    );
    assert_eq!(decision["engine"]["adapter"], "logprobs");
    assert_eq!(decision["engine"]["model"], STUB_MODEL);
    assert_eq!(decision["engine"]["digest"], DIGEST);
    assert_eq!(decision["engine"]["canary"], "ok");
    assert_eq!(
        decision["engine"]["host"],
        engine_stub.uri().trim_start_matches("http://")
    );
    let rules: Vec<(&str, &str, &str, &str)> = decision["rules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            (
                r["ref"].as_str().unwrap(),
                r["effective"].as_str().unwrap(),
                r["outcome"].as_str().unwrap(),
                r["why"].as_str().unwrap_or(""),
            )
        })
        .collect();
    assert_eq!(
        rules,
        [
            ("Served rules#alpha-leak", "enforce", "refuse", ""),
            (
                "Served rules#delta-shadowed",
                "shadow",
                "allow",
                "server-shadow"
            ),
            (
                "Served rules#epsilon-unserved",
                "shadow",
                "allow",
                "no-pins"
            ),
        ]
    );
    assert_eq!(decision["rules"][0]["stateHash"], state_hash.as_str());
    assert_eq!(decision["rules"][0]["when"], "T");
    assert_eq!(decision["rules"][0]["answers"]["leak"]["type"], "yes_no");
    assert_eq!(decision["rules"][0]["answers"]["leak"]["value"], "T");
    // The drift stats the gates keep.
    assert!(dirs("stage")
        .stats
        .join(format!("{}.json", hash(ALPHA)))
        .exists());
    // The upload: the line as written, without its excerpt, with the request's key.
    let up = wait_for_uploads(&cp, 1).await;
    assert_eq!(up.len(), 1, "one upload per evaluation");
    let (auth, body) = &up[0];
    assert_eq!(auth, &format!("Bearer {}", vk()));
    assert_eq!(body["source"], "gateway");
    let mut want = decision.clone();
    want.as_object_mut().unwrap().remove("argsExcerpt");
    assert_eq!(body["events"][0], want);

    // A tool call, with the excerpt sent: the arguments, redacted.
    let args_stage = with_log(gateway.clone(), "args", &cp.uri(), true);
    let allowed = args_stage
        .check_tool_call(
            "Bash",
            &json!({"command": "pg_dump GAMMA-YES | mail dev.one@example.com"}),
        )
        .await;
    // gamma's pins were served under another hash, so it runs as shadow.
    assert_eq!(allowed, None);
    let call = log_lines(&dirs("args").logs)
        .into_iter()
        .find(|l| l["event"] == "decide.decision")
        .expect("a decision line");
    assert_eq!(call["tool"], "Bash");
    assert_eq!(
        call["argsExcerpt"],
        "{\"command\":\"pg_dump GAMMA-YES | mail [REDACTED]\"}"
    );
    assert_eq!(call["rules"][0]["effective"], "shadow");
    assert_eq!(call["rules"][0]["outcome"], "refuse");
    let up = wait_for_uploads(&cp, 2).await;
    assert_eq!(up[1].1["events"][0]["argsExcerpt"], call["argsExcerpt"]);

    // Neither a closed control plane nor an unwritable log changes a decision.
    let broken = root.join("broken");
    std::fs::create_dir_all(&broken).unwrap();
    std::fs::write(broken.join("logs"), "a file, not a directory").unwrap();
    let failing = gateway.clone().with_log(GatewayLog {
        harness: "claude-code".into(),
        workspace_id: "ws_served".into(),
        session_id: "ses_broken".into(),
        dirs: LogDirs {
            logs: broken.join("logs"),
            stats: broken.join("logs").join("stats"),
            decide: broken.join("decide"),
        },
        upload: Some(GatewayUpload {
            client: Arc::new(reqwest::Client::new()),
            control_plane_url: "http://127.0.0.1:1".into(),
            virtual_key: key.clone(),
            with_args: false,
        }),
    });
    let v = failing
        .check_response(content)
        .await
        .expect("still refused");
    assert_eq!(v.code, "DECIDE_REFUSED");
    assert!(failing.check_response("All quiet.").await.is_none());

    // ── End to end, through the router ──
    intutic_proxy::gateway::init_gateway_config(intutic_proxy::gateway::GatewayConfig {
        require_vk: true,
        ..Default::default()
    });
    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(body_string_contains("case-refuse:"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(text_body("The ALPHA-YES codename is Bluebird.")),
        )
        .mount(&upstream)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(body_string_contains("case-tool:"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(tool_call_body("pg_dump GAMMA-YES > /tmp/x")),
        )
        .mount(&upstream)
        .await;
    std::env::set_var("OPENAI_UPSTREAM_URL", upstream.uri());
    std::env::set_var("OPENAI_API_KEY", ["test", "-operator-", "key"].concat());
    std::env::set_var("CONTROL_PLANE_URL", cp.uri());
    std::env::remove_var("INTUTIC_SOPS_DIR");

    let config: intutic_proxy::config::ProxyConfig =
        serde_yaml::from_str("model_list: []\nintutic_settings: {}\n").expect("config parses");
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
    let send = |marker: &'static str| {
        let url = format!("http://{addr}/v1/chat/completions");
        async move {
            let res = reqwest::Client::new()
                .post(url)
                .header("Authorization", format!("Bearer {}", vk()))
                .header("x-session-id", format!("ses_{marker}"))
                .json(&json!({
                    "model": "qwen-test-model",
                    "messages": [{"role": "user", "content": format!("{marker}: go")}]
                }))
                .send()
                .await
                .expect("proxy reachable");
            let status = res.status();
            let body = res.text().await.expect("body");
            assert!(status.is_success(), "{marker}: {status}: {body}");
            body
        }
    };
    let before = uploads(&cp).await.len();
    let body = send("case-refuse").await;
    assert!(
        body.contains("Intutic Decide (gateway): VIOLATION"),
        "the served pin enforces alpha:\n{body}"
    );
    let body = send("case-tool").await;
    assert!(
        body.contains("call_served"),
        "gamma's mismatched pins leave it shadow:\n{body}"
    );
    // One upload per evaluation, sent beside the call: the response's, the
    // tool call's, and the tool-call response's (empty) text.
    let mut sent: Vec<Value> = Vec::new();
    for _ in 0..100 {
        sent = uploads(&cp).await[before..]
            .iter()
            .flat_map(|(_, b)| b["events"].as_array().cloned().unwrap_or_default())
            .collect();
        if sent.iter().any(|e| e["tool"] == "Bash") && sent.iter().any(|e| e["outcome"] == "refuse")
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let refused = sent
        .iter()
        .find(|e| e["sessionId"] == "ses_case-refuse")
        .unwrap_or_else(|| panic!("no upload for the refused response: {sent:?}"));
    assert_eq!(refused["workspaceId"], "ws_served");
    assert!(refused["harness"].is_string());
    assert_eq!(refused["tool"], "");
    assert_eq!(refused["outcome"], "refuse");
    assert!(refused.get("argsExcerpt").is_none());
    let call = sent
        .iter()
        .find(|e| e["tool"] == "Bash")
        .unwrap_or_else(|| panic!("no upload for the tool call: {sent:?}"));
    assert_eq!(call["sessionId"], "ses_case-tool");
    assert_eq!(call["rules"][0]["why"], "no-pins");
    assert_eq!(call["rules"][0]["outcome"], "refuse");
    // And the gateway's own log, under its home, with the excerpts.
    let mine: Vec<Value> = log_lines(&home.join(".intutic/logs"))
        .into_iter()
        .filter(|l| l["event"] == "decide.decision")
        .collect();
    assert!(mine.len() >= 2, "{mine:?}");
    assert!(mine.iter().all(|l| l.get("argsExcerpt").is_some()));
    assert!(mine.iter().any(|l| l["tool"] == "Bash"));

    let _ = std::fs::remove_dir_all(&root);
}
