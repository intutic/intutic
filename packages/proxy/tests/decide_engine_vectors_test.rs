//! The decide engine client and its host guard, held to
//! `packages/shared-types/fixtures/decide-engine-vectors.json`, which the
//! TypeScript and Python clients run too. Engine cases go through a wiremock
//! server that replays the vectors' recorded responses; no model runs.

use intutic_proxy::decide::engine::{
    build_response_state, build_tool_call_state, question_prompts, resolve_config, DecideAdapter,
    DecideEngine, DecideEngineConfig, ErrorOutcome, QuestionCall, QuestionType, ToolCallStateInput,
    DECIDE_MAX_RESPONSE_STATE_BYTES, DECIDE_UNAVAILABLE_REFUSAL,
};
use intutic_proxy::decide::guard::check_self_hosted_decision_host;
use serde_json::{json, Value};
use std::time::Duration;
use tokio::time::Instant;
use wiremock::matchers::{body_string_contains, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn vectors() -> Value {
    let p = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../shared-types/fixtures/decide-engine-vectors.json"
    );
    serde_json::from_str(&std::fs::read_to_string(p).expect("vectors")).expect("vectors json")
}

/// Expands `{repeat, times}` anywhere in a vector value.
fn expand(v: &Value) -> Value {
    match v {
        Value::Object(m) if m.len() == 2 && m.contains_key("repeat") && m.contains_key("times") => {
            Value::String(
                m["repeat"]
                    .as_str()
                    .unwrap()
                    .repeat(m["times"].as_u64().unwrap() as usize),
            )
        }
        Value::Object(m) => Value::Object(m.iter().map(|(k, x)| (k.clone(), expand(x))).collect()),
        Value::Array(a) => Value::Array(a.iter().map(expand).collect()),
        other => other.clone(),
    }
}

fn joined(v: &Value) -> String {
    match expand(v) {
        Value::Array(parts) => parts.iter().map(|p| p.as_str().unwrap()).collect(),
        Value::String(s) => s,
        other => panic!("not a string: {other}"),
    }
}

fn question(q: &Value) -> QuestionCall {
    QuestionCall {
        name: q["name"].as_str().unwrap().to_string(),
        qtype: if q["type"] == "choice" {
            QuestionType::Choice
        } else {
            QuestionType::YesNo
        },
        ask: q["ask"].as_str().unwrap().to_string(),
        options: q
            .get("options")
            .and_then(Value::as_array)
            .map(|o| o.iter().map(|x| x.as_str().unwrap().to_string()).collect())
            .unwrap_or_default(),
    }
}

fn config(url: &str, c: &Value, parallel: usize) -> DecideEngineConfig {
    DecideEngineConfig {
        url: url.to_string(),
        adapter: DecideAdapter::parse(c["adapter"].as_str().unwrap()).unwrap(),
        model: c["model"].as_str().unwrap().to_string(),
        api_key: None,
        timeout_ms: c.get("timeoutMs").and_then(Value::as_u64).unwrap_or(5000),
        parallel,
        structured: c
            .get("structured")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        ollama: c.get("ollama").and_then(Value::as_bool).unwrap_or(false),
        model_digest: c
            .get("modelDigest")
            .and_then(Value::as_str)
            .map(str::to_string),
        self_hosted_hosts: None,
        max_response_state_bytes: c
            .get("maxResponseStateBytes")
            .and_then(Value::as_u64)
            .map(|n| n as usize),
    }
}

async fn replay(entries: &[Value]) -> MockServer {
    let server = MockServer::start().await;
    for e in entries {
        let body = match e.get("bodyRaw") {
            Some(raw) => raw.as_str().unwrap().to_string(),
            None => serde_json::to_string(e.get("body").unwrap_or(&json!({}))).unwrap(),
        };
        let mut response = ResponseTemplate::new(e["status"].as_u64().unwrap() as u16)
            .set_body_raw(body, "application/json");
        if let Some(ms) = e.get("delayMs").and_then(Value::as_u64) {
            response = response.set_delay(Duration::from_millis(ms));
        }
        let mock = Mock::given(method(e["method"].as_str().unwrap()))
            .and(path(e["path"].as_str().unwrap()));
        let mock = match e.get("match").and_then(Value::as_str) {
            Some(m) => mock.and(body_string_contains(m)),
            None => mock,
        };
        mock.respond_with(response)
            .up_to_n_times(e.get("times").and_then(Value::as_u64).unwrap_or(1))
            .mount(&server)
            .await;
    }
    server
}

fn closed_port() -> u16 {
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    l.local_addr().unwrap().port()
}

fn approx(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-9
}

#[test]
fn host_guard_vectors() {
    let v = vectors();
    let cases = v["host"].as_array().unwrap();
    assert!(cases.len() > 40);
    for c in cases {
        let got = check_self_hosted_decision_host(
            c["url"].as_str().unwrap(),
            c.get("listed").and_then(Value::as_str),
        );
        assert_eq!(
            (got.ok, got.reason),
            (c["ok"].as_bool().unwrap(), c["reason"].as_str().unwrap()),
            "{}",
            c["name"]
        );
    }
}

#[test]
fn config_vectors() {
    let v = vectors();
    for c in v["config"].as_array().unwrap() {
        let env = c["env"].as_object().unwrap().clone();
        let lookup = move |name: &str| env.get(name).and_then(Value::as_str).map(str::to_string);
        let got = resolve_config(Some(&c["file"]), &lookup)
            .and_then(|cfg| DecideEngine::new(cfg.clone()).map(|_| cfg));
        match c.get("error") {
            Some(code) => assert_eq!(
                got.unwrap_err().code(),
                code.as_str().unwrap(),
                "{}",
                c["name"]
            ),
            None => {
                let cfg = got.unwrap_or_else(|e| panic!("{}: {e}", c["name"]));
                let mut seen = json!({
                    "url": cfg.url, "adapter": cfg.adapter.as_str(), "model": cfg.model, "timeoutMs": cfg.timeout_ms,
                    "parallel": cfg.parallel, "structured": cfg.structured, "ollama": cfg.ollama,
                });
                for (k, v) in [
                    ("apiKey", &cfg.api_key),
                    ("modelDigest", &cfg.model_digest),
                    ("selfHostedHosts", &cfg.self_hosted_hosts),
                ] {
                    if let Some(v) = v {
                        seen[k] = json!(v);
                    }
                }
                if let Some(n) = cfg.max_response_state_bytes {
                    seen["maxResponseStateBytes"] = json!(n);
                }
                assert_eq!(seen, c["expect"], "{}", c["name"]);
            }
        }
    }
}

#[test]
fn state_vectors() {
    let v = vectors();
    for c in v["state"].as_array().unwrap() {
        let i = expand(&c["input"]);
        let s = |k: &str| i[k].as_str().unwrap_or_default().to_string();
        let got = if i["kind"] == "response" {
            build_response_state(
                &s("ruleText"),
                &s("content"),
                i.get("maxBytes")
                    .and_then(Value::as_u64)
                    .map_or(DECIDE_MAX_RESPONSE_STATE_BYTES, |n| n as usize),
            )
        } else {
            build_tool_call_state(&ToolCallStateInput {
                rule_id: &s("ruleId"),
                sop_title: &s("sopTitle"),
                rule_text: &s("ruleText"),
                tool: &s("tool"),
                cwd: &s("cwd"),
                tool_input: &i["toolInput"],
                last_user_turn: i.get("lastUserTurn").and_then(Value::as_str),
            })
        };
        match c.get("error") {
            Some(code) => assert_eq!(
                got.unwrap_err().code(),
                code.as_str().unwrap(),
                "{}",
                c["name"]
            ),
            None => assert_eq!(got.unwrap(), joined(&c["expect"]), "{}", c["name"]),
        }
    }
}

#[test]
fn prompt_vectors() {
    let v = vectors();
    for c in v["prompts"].as_array().unwrap() {
        let want: Vec<String> = c["expect"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            question_prompts(&question(&c["question"])),
            want,
            "{}",
            c["name"]
        );
    }
}

#[tokio::test]
async fn engine_vectors() {
    let v = vectors();
    for c in v["engine"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let replay_entries = c["replay"].as_array().unwrap();
        let server = replay(replay_entries).await;
        let url = if c.get("down").is_some() {
            format!("http://127.0.0.1:{}", closed_port())
        } else {
            server.uri()
        };
        let engine = DecideEngine::new(config(&url, c, 1)).unwrap();
        let qs: Vec<QuestionCall> = c["questions"]
            .as_array()
            .unwrap()
            .iter()
            .map(question)
            .collect();
        let deadline = Instant::now()
            + Duration::from_millis(c.get("budgetMs").and_then(Value::as_u64).unwrap_or(5000));
        let got = engine.ask(&joined(&c["state"]), &qs, deadline).await;
        let expect = &c["expect"];
        let received = server.received_requests().await.unwrap_or_default();
        if let Some(code) = expect.get("error") {
            let err = got.expect_err(name);
            assert_eq!(err.code(), code.as_str().unwrap(), "{name}");
            assert_eq!(
                err.status().map(u64::from),
                expect.get("status").and_then(Value::as_u64),
                "{name}"
            );
        } else {
            let r = got.unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(
                r.identity.model,
                expect["model"].as_str().unwrap(),
                "{name}"
            );
            assert_eq!(
                r.identity.model_digest,
                expect["modelDigest"].as_str().unwrap(),
                "{name}"
            );
            assert_eq!(
                r.identity.digest_strength.as_str(),
                expect["digestStrength"].as_str().unwrap(),
                "{name}"
            );
            assert_eq!(r.adapter.as_str(), c["adapter"].as_str().unwrap(), "{name}");
            for (q, want) in expect["answers"].as_object().unwrap() {
                let a = &r.answers[q];
                assert_eq!(a.qtype.as_str(), want["type"].as_str().unwrap(), "{name}");
                if let Some(p) = want.get("p").and_then(Value::as_f64) {
                    assert!(approx(a.p.unwrap(), p), "{name}: {q} p {:?} != {p}", a.p);
                }
                if let Some(orders) = want.get("perOrder").and_then(Value::as_array) {
                    assert_eq!(a.per_order.len(), orders.len(), "{name}");
                    for (g, w) in a.per_order.iter().zip(orders) {
                        let w = w.as_object().unwrap();
                        assert_eq!(g.len(), w.len(), "{name}");
                        for (opt, p) in w {
                            assert!(approx(g[opt], p.as_f64().unwrap()), "{name}: {q}.{opt}");
                        }
                    }
                }
            }
            // Every recorded response was used, and nothing else was asked.
            assert_eq!(received.len(), replay_entries.len(), "{name}");
        }
        if let Some(want) = c.get("requests").and_then(Value::as_array) {
            let sent: Vec<Value> = received
                .iter()
                .map(|r| {
                    let mut o = json!({ "method": r.method.as_str(), "path": r.url.path() });
                    if !r.body.is_empty() {
                        o["body"] = serde_json::from_slice(&r.body).unwrap();
                    }
                    o
                })
                .collect();
            assert_eq!(sent.len(), want.len(), "{name}");
            for w in want {
                assert!(sent.contains(w), "{name}: missing request {w}");
            }
        }
    }
}

#[test]
fn error_outcome_vectors() {
    use intutic_proxy::decide::engine::DecideEngineError as E;
    let v = vectors();
    let all = [
        E::NotConfigured,
        E::HostRefused(String::new()),
        E::Timeout,
        E::Upstream(0),
        E::NoLogprobs,
        E::BadResponse(String::new()),
        E::TooLarge,
        E::CanaryFailed,
    ];
    let cases = v["outcome"].as_array().unwrap();
    assert_eq!(cases.len(), all.len());
    for c in cases {
        let err = all
            .iter()
            .find(|e| e.code() == c["code"].as_str().unwrap())
            .expect("a code per case");
        let (outcome, refusal) = match err.outcome() {
            ErrorOutcome::Unavailable => ("unavailable", json!(DECIDE_UNAVAILABLE_REFUSAL)),
            ErrorOutcome::Unknown => ("unknown", Value::Null),
        };
        assert_eq!(outcome, c["outcome"].as_str().unwrap(), "{}", c["code"]);
        assert_eq!(refusal, c["refusal"], "{}", c["code"]);
    }
}

fn yes_reply(top: &[(&str, f64)]) -> Value {
    let top: Vec<Value> = top
        .iter()
        .map(|(t, l)| json!({ "token": t, "logprob": l }))
        .collect();
    json!({ "choices": [{ "logprobs": { "content": [{ "top_logprobs": top }] } }] })
}

#[tokio::test]
async fn parallel_caps_requests_in_flight() {
    let qs: Vec<QuestionCall> = (0..6)
        .map(|i| QuestionCall {
            name: format!("q{i}"),
            qtype: QuestionType::YesNo,
            ask: format!("Question number {i}?"),
            options: vec![],
        })
        .collect();
    let entries: Vec<Value> = qs
        .iter()
        .map(|q| {
            json!({ "method": "POST", "path": "/v1/chat/completions", "match": q.ask, "status": 200,
                         "body": yes_reply(&[("yes", -0.1), ("no", -2.4)]), "delayMs": 150 })
        })
        .collect();
    let server = replay(&entries).await;
    let mut cfg = config(
        &server.uri(),
        &json!({ "adapter": "logprobs", "model": "m" }),
        2,
    );
    cfg.parallel = 2;
    let started = Instant::now();
    let r = DecideEngine::new(cfg)
        .unwrap()
        .ask("STATE", &qs, Instant::now() + Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(r.answers.len(), 6);
    // Six calls of 150 ms, two at a time: three rounds.
    let took = started.elapsed();
    assert!(
        took >= Duration::from_millis(420) && took < Duration::from_millis(1500),
        "{took:?}"
    );
}

#[tokio::test]
async fn prefix_bytes_are_identical_across_questions() {
    let state = build_tool_call_state(&ToolCallStateInput {
        rule_id: "prod-data-export",
        sop_title: "Production data handling",
        rule_text: "Never copy customer data out of production.",
        tool: "Bash",
        cwd: "/repo",
        tool_input: &json!({ "command": "pg_dump -h prod > /tmp/x.sql" }),
        last_user_turn: None,
    })
    .unwrap();
    let mut qs: Vec<QuestionCall> = (0..6)
        .map(|i| QuestionCall {
            name: format!("q{i}"),
            qtype: QuestionType::YesNo,
            ask: format!("Yes or no question {i}?"),
            options: vec![],
        })
        .collect();
    let opts = |o: &[&str]| o.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    qs.push(QuestionCall {
        name: "dest".into(),
        qtype: QuestionType::Choice,
        ask: "Where does the data go?".into(),
        options: opts(&[
            "local_file",
            "cloud_bucket",
            "external_host",
            "none_of_these",
        ]),
    });
    qs.push(QuestionCall {
        name: "kind".into(),
        qtype: QuestionType::Choice,
        ask: "What kind of data?".into(),
        options: opts(&["customer", "internal", "none_of_these"]),
    });
    let entries: Vec<Value> = qs
        .iter()
        .flat_map(|q| {
            let top = if q.qtype == QuestionType::YesNo { yes_reply(&[("yes", -0.1), ("no", -2.4)]) } else { yes_reply(&[("A", -0.1), ("B", -2.4)]) };
            question_prompts(q).into_iter().map(move |_| {
                json!({ "method": "POST", "path": "/v1/chat/completions", "match": q.ask, "status": 200, "body": top })
            })
        })
        .collect();
    let server = replay(&entries).await;
    let mut cfg = config(
        &server.uri(),
        &json!({ "adapter": "logprobs", "model": "m" }),
        4,
    );
    cfg.parallel = 4;
    DecideEngine::new(cfg)
        .unwrap()
        .ask(&state, &qs, Instant::now() + Duration::from_secs(5))
        .await
        .unwrap();
    let mut contents: Vec<String> = server
        .received_requests()
        .await
        .unwrap()
        .iter()
        .map(|r| {
            serde_json::from_slice::<Value>(&r.body).unwrap()["messages"][0]["content"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect();
    let mut expected: Vec<String> = qs
        .iter()
        .flat_map(|q| {
            question_prompts(q)
                .into_iter()
                .map(|p| format!("{state}{p}"))
        })
        .collect();
    contents.sort();
    expected.sort();
    assert_eq!(contents.len(), 11);
    assert_eq!(contents, expected);
    assert!(contents
        .iter()
        .all(|c| c.as_bytes().starts_with(state.as_bytes())));
}

#[tokio::test]
async fn the_key_goes_as_a_bearer_token_and_never_into_a_refusal() {
    let key = ["test", "decide", "key"].join("-");
    let server = replay(&[
        json!({ "method": "POST", "path": "/v1/systemone", "status": 200,
        "body": { "model": "k", "answers": { "a": { "type": "noul", "noul": 0.2 } } } }),
    ])
    .await;
    let mut cfg = config(
        &server.uri(),
        &json!({ "adapter": "systemone", "model": "k" }),
        1,
    );
    cfg.api_key = Some(key.clone());
    let q = QuestionCall {
        name: "a".into(),
        qtype: QuestionType::YesNo,
        ask: "Is it?".into(),
        options: vec![],
    };
    DecideEngine::new(cfg.clone())
        .unwrap()
        .ask("S", &[q], Instant::now() + Duration::from_secs(5))
        .await
        .unwrap();
    let received = server.received_requests().await.unwrap();
    assert_eq!(
        received[0]
            .headers
            .get("authorization")
            .unwrap()
            .to_str()
            .unwrap(),
        format!("Bearer {key}")
    );

    cfg.url = "https://api.fireworks.ai/inference".into();
    let err = DecideEngine::new(cfg.clone()).err().unwrap();
    assert_eq!(err.code(), "host_refused");
    assert!(!err.to_string().contains(&key));
    assert!(!format!("{cfg:?}").contains(&key));
}

fn canary_entries(p_v: &[(&str, f64)], p_c: &[(&str, f64)]) -> Vec<Value> {
    vec![
        json!({ "method": "POST", "path": "/v1/chat/completions", "match": "--no-preserve-root\\\"}\\n\\nQUESTION: Does", "status": 200, "body": yes_reply(p_v) }),
        json!({ "method": "POST", "path": "/v1/chat/completions", "match": "ls -la", "status": 200, "body": yes_reply(p_c) }),
        json!({ "method": "POST", "path": "/v1/chat/completions", "match": "A) delete_files", "status": 200, "body": yes_reply(&[("A", -0.02), ("C", -4.0)]) }),
        json!({ "method": "POST", "path": "/v1/chat/completions", "match": "A) none_of_these", "status": 200, "body": yes_reply(&[("C", -0.02), ("A", -4.0)]) }),
    ]
}

#[tokio::test]
async fn canary_passes_a_model_that_knows_the_answers() {
    let server = replay(&canary_entries(
        &[("yes", -0.01), ("no", -5.0)],
        &[("no", -0.01), ("yes", -5.0)],
    ))
    .await;
    let engine = DecideEngine::new(config(
        &server.uri(),
        &json!({ "adapter": "logprobs", "model": "m" }),
        1,
    ))
    .unwrap();
    let r = engine
        .canary(Instant::now() + Duration::from_secs(5))
        .await
        .unwrap();
    assert!(r.ok, "{r:?}");
    assert_eq!(r.choice_top, "delete_files");
}

#[tokio::test]
async fn canary_fails_an_always_allow_model() {
    let server = replay(&canary_entries(
        &[("no", -0.01), ("yes", -5.0)],
        &[("no", -0.01), ("yes", -5.0)],
    ))
    .await;
    let engine = DecideEngine::new(config(
        &server.uri(),
        &json!({ "adapter": "logprobs", "model": "m" }),
        1,
    ))
    .unwrap();
    let r = engine
        .canary(Instant::now() + Duration::from_secs(5))
        .await
        .unwrap();
    assert!(!r.ok);
    assert!(r.p_violation < 0.15);
}

// ─── The engine protections around one call (decide/evaluate.rs) ───────
//
// The `rollout` and `evaluate` groups, and an always-allow fault injected
// into this client.

use async_trait::async_trait;
use intutic_proxy::decide::engine::{
    run_canary, DecideAsk, DecideEngineError, EngineResult, ModelIdentity,
};
use intutic_proxy::decide::evaluate::{
    canary_fresh, effective_rollout, evaluate_call, CanaryEntry, CanaryFileStore, CanaryState,
    Deterministic, EvaluateInput, Pin, RuleEntry, DECIDE_CANARY_TTL_MS,
};
use intutic_proxy::decide::{rule_hash, validate, Outcome, Rollout};

fn rollout_of(v: &Value) -> Rollout {
    if v.as_str() == Some("enforce") {
        Rollout::Enforce
    } else {
        Rollout::Shadow
    }
}

fn pins_of(v: &Value) -> Vec<Pin> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|p| Pin::from_value(p).expect("pin"))
        .collect()
}

fn temp_canary(name: &str) -> CanaryFileStore {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static N: AtomicUsize = AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!(
        "intutic-decide-canary-{}-{}-{name}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    CanaryFileStore::new(dir.join("decide").join("canary.json"))
}

fn canary_entry(url: &str, ok: bool, at_ms: f64) -> CanaryEntry {
    CanaryEntry {
        url: url.to_string(),
        model_digest: format!("sha256:{}", "a".repeat(64)),
        ok,
        at_ms,
        p_violation: 0.97,
        p_clean: 0.02,
        choice_top: "delete_files".into(),
    }
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as f64
}

#[test]
fn effective_rollout_vectors() {
    let v = vectors();
    let cases = v["rollout"].as_array().unwrap();
    assert!(cases.len() >= 10);
    for c in cases {
        let e = &c["entry"];
        let got = effective_rollout(
            rollout_of(&e["irRollout"]),
            rollout_of(&e["rollout"]),
            e["stampedBy"].as_str().unwrap(),
            &pins_of(&e["pins"]),
            c["modelDigest"].as_str(),
        );
        let want = &c["expect"];
        assert_eq!(
            (
                got.effective,
                got.why.as_deref(),
                got.pin.as_ref().map(|p| p.eval_run_id.as_str())
            ),
            (
                rollout_of(&want["effective"]),
                want["why"].as_str(),
                want["evalRunId"].as_str()
            ),
            "{}",
            c["name"]
        );
    }
}

fn entry(r: &Value) -> RuleEntry {
    let rule = validate(&r["rule"]).expect("vector rule");
    RuleEntry {
        rule_ref: r["ref"].as_str().unwrap().to_string(),
        rule_hash: r
            .get("ruleHash")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| rule_hash(&rule)),
        rollout: rollout_of(&r["rollout"]),
        stamped_by: r["stampedBy"].as_str().unwrap().to_string(),
        rule,
        sop_title: r["sopTitle"].as_str().unwrap().to_string(),
        rule_text: r["ruleText"].as_str().unwrap().to_string(),
        pins: pins_of(&r["pins"]),
    }
}

fn outcome_str(o: Outcome) -> &'static str {
    match o {
        Outcome::Allow => "allow",
        Outcome::Refuse => "refuse",
        Outcome::Escalate => "escalate",
        Outcome::Unavailable => "unavailable",
    }
}

fn rollout_str(r: Rollout) -> &'static str {
    match r {
        Rollout::Enforce => "enforce",
        Rollout::Shadow => "shadow",
    }
}

async fn evaluate_case<E: DecideAsk + ?Sized>(
    c: &Value,
    engine: &E,
    url: &str,
    store: &CanaryFileStore,
) -> intutic_proxy::decide::evaluate::Evaluation {
    let rules: Vec<RuleEntry> = c["rules"].as_array().unwrap().iter().map(entry).collect();
    let input = EvaluateInput {
        deterministic: if c["deterministic"] == "allow" {
            Deterministic::Allow
        } else {
            Deterministic::Refuse
        },
        tool: c["tool"].as_str().unwrap(),
        tool_input: &c["toolInput"],
        cwd: c["cwd"].as_str().unwrap(),
        last_user_turn: c.get("lastUserTurn").and_then(Value::as_str),
        rules: &rules,
        deadline: Instant::now() + Duration::from_secs(5),
    };
    evaluate_call(&input, Ok(engine), url, store).await
}

#[tokio::test]
async fn evaluate_vectors() {
    let v = vectors();
    let cases = v["evaluate"].as_array().unwrap();
    assert!(cases.len() >= 10);
    for (i, c) in cases.iter().enumerate() {
        let name = c["name"].as_str().unwrap();
        let down = c.get("down").and_then(Value::as_bool).unwrap_or(false);
        let server = if down {
            None
        } else {
            Some(replay(c["replay"].as_array().unwrap()).await)
        };
        let url = match &server {
            Some(s) => s.uri(),
            None => format!("http://127.0.0.1:{}", closed_port()),
        };
        let store = temp_canary(&format!("vector{i}"));
        if let Some(k) = c.get("canaryCache") {
            store
                .write(&CanaryEntry {
                    url: url.clone(),
                    model_digest: k["modelDigest"].as_str().unwrap().to_string(),
                    ok: k["ok"].as_bool().unwrap(),
                    at_ms: now_ms() - k["ageMs"].as_f64().unwrap(),
                    p_violation: 0.99,
                    p_clean: 0.01,
                    choice_top: "delete_files".into(),
                })
                .unwrap();
        }
        let engine = DecideEngine::new(config(&url, &c["engine"], 1)).unwrap();
        let got = evaluate_case(c, &engine, &url, &store).await;
        let want = &c["expect"];
        assert_eq!(
            (
                outcome_str(got.call.outcome),
                got.call.code.as_deref(),
                got.call.rule_ref.as_deref()
            ),
            (
                want["outcome"].as_str().unwrap(),
                want["code"].as_str(),
                want["ruleRef"].as_str()
            ),
            "{name}"
        );
        let rules: Vec<Value> = got
            .rules
            .iter()
            .map(|r| {
                json!({ "ref": r.rule_ref, "effective": rollout_str(r.effective), "why": r.why,
                        "outcome": outcome_str(r.outcome), "error": r.error })
            })
            .collect();
        assert_eq!(Value::Array(rules), want["rules"], "{name}");
        assert_eq!(
            got.canary.map(CanaryState::as_str),
            want["canary"].as_str(),
            "{name}"
        );
        let received = match &server {
            Some(s) => s.received_requests().await.unwrap().len() as u64,
            None => 0,
        };
        assert_eq!(received, want["requests"].as_u64().unwrap(), "{name}");
        let stored = got
            .engine
            .as_ref()
            .and_then(|id| store.read(&url, &id.model_digest))
            .map(|e| e.ok);
        assert_eq!(stored, want["canaryStored"].as_bool(), "{name}");
        if let (Some(sent), Some(s)) = (want.get("sent"), &server) {
            let systems: Vec<String> = s
                .received_requests()
                .await
                .unwrap()
                .iter()
                .filter(|r| r.url.path() == "/v1/chat/completions")
                .map(|r| {
                    let body: Value = serde_json::from_slice(&r.body).unwrap();
                    body["messages"][0]["content"].as_str().unwrap().to_string()
                })
                .collect();
            assert!(!systems.is_empty(), "{name}");
            for text in &systems {
                for w in sent["contains"].as_array().unwrap() {
                    assert!(text.contains(w.as_str().unwrap()), "{name}: {text}");
                }
                for n in sent["excludes"].as_array().unwrap() {
                    assert!(!text.contains(n.as_str().unwrap()), "{name}: {text}");
                }
            }
        }
    }
}

#[tokio::test]
async fn an_engine_that_could_not_be_created_is_unavailable() {
    let v = vectors();
    let c = v["evaluate"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| {
            c["name"]
                .as_str()
                .unwrap()
                .starts_with("an enforcing rule refuses")
        })
        .unwrap();
    let rules: Vec<RuleEntry> = c["rules"].as_array().unwrap().iter().map(entry).collect();
    let input = EvaluateInput {
        deterministic: Deterministic::Allow,
        tool: "Bash",
        tool_input: &json!({}),
        cwd: "/",
        last_user_turn: None,
        rules: &rules,
        deadline: Instant::now() + Duration::from_secs(5),
    };
    let got = evaluate_call::<DecideEngine>(
        &input,
        Err(DecideEngineError::NotConfigured),
        "",
        &temp_canary("not-configured"),
    )
    .await;
    assert_eq!(got.call.code.as_deref(), Some("GOVERNANCE_UNAVAILABLE"));
    assert_eq!(got.rules[0].error, Some("not_configured"));
}

/// The client with a fault injected: it reads the other answer token, so a
/// model's yes comes back as a no and each choice's mass lands on the next
/// option. Every rule would allow; the canary asks through the same path.
struct ReadsTheWrongToken(DecideEngine);

#[async_trait]
impl DecideAsk for ReadsTheWrongToken {
    async fn ask(
        &self,
        state: &str,
        questions: &[QuestionCall],
        deadline: Instant,
    ) -> Result<EngineResult, DecideEngineError> {
        let mut r = self.0.ask(state, questions, deadline).await?;
        for a in r.answers.values_mut() {
            if let Some(p) = a.p {
                a.p = Some(1.0 - p);
            }
            for order in a.per_order.iter_mut() {
                let keys: Vec<String> = order.keys().cloned().collect();
                let values: Vec<f64> = order.values().copied().collect();
                for (i, k) in keys.iter().enumerate() {
                    order.insert(k.clone(), values[(i + 1) % values.len()]);
                }
            }
        }
        Ok(r)
    }
    async fn describe(&self, deadline: Instant) -> Result<ModelIdentity, DecideEngineError> {
        self.0.describe(deadline).await
    }
}

fn healthy_case() -> Value {
    vectors()["evaluate"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| {
            c["name"]
                .as_str()
                .unwrap()
                .starts_with("with no cached canary")
        })
        .unwrap()
        .clone()
}

#[tokio::test]
async fn without_the_fault_the_rule_refuses() {
    let c = healthy_case();
    let server = replay(c["replay"].as_array().unwrap()).await;
    let engine = DecideEngine::new(config(&server.uri(), &c["engine"], 1)).unwrap();
    let got = evaluate_case(&c, &engine, &server.uri(), &temp_canary("healthy")).await;
    assert_eq!(got.call.outcome, Outcome::Refuse);
    assert_eq!(got.call.code.as_deref(), Some("DECIDE_REFUSED"));
}

#[tokio::test]
async fn the_canary_catches_an_always_allow_fault_in_this_client() {
    let c = healthy_case();
    let server = replay(c["replay"].as_array().unwrap()).await;
    let faulty =
        ReadsTheWrongToken(DecideEngine::new(config(&server.uri(), &c["engine"], 1)).unwrap());
    let canary = run_canary(&faulty, Instant::now() + Duration::from_secs(5))
        .await
        .unwrap();
    assert!(!canary.ok, "{canary:?}");

    let server = replay(c["replay"].as_array().unwrap()).await;
    let faulty =
        ReadsTheWrongToken(DecideEngine::new(config(&server.uri(), &c["engine"], 1)).unwrap());
    let got = evaluate_case(&c, &faulty, &server.uri(), &temp_canary("fault")).await;
    assert_eq!(got.canary, Some(CanaryState::Failed));
    assert_eq!(got.call.outcome, Outcome::Refuse);
    assert_eq!(got.call.code.as_deref(), Some("GOVERNANCE_UNAVAILABLE"));
    assert_eq!(got.rules[0].outcome, Outcome::Unavailable);
    assert_eq!(got.rules[0].error, Some("canary_failed"));
    assert!(got.rules[0].answers.is_none());
}

#[test]
fn canary_file_round_trips_in_a_private_file() {
    let store = temp_canary("round-trip");
    let digest = format!("sha256:{}", "a".repeat(64));
    assert!(store.read("http://127.0.0.1:11434", &digest).is_none());
    store
        .write(&canary_entry("http://127.0.0.1:11434", false, now_ms()))
        .unwrap();
    store
        .write(&canary_entry("http://127.0.0.1:11434", true, now_ms()))
        .unwrap();
    assert!(store.read("http://127.0.0.1:11434", &digest).unwrap().ok);
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(&store.path).unwrap()).unwrap();
    assert_eq!(doc["entries"].as_array().unwrap().len(), 1);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&store.path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}

#[test]
fn canary_file_keeps_the_newest_sixteen() {
    let store = temp_canary("sixteen");
    for i in 0..20 {
        store
            .write(&canary_entry(
                &format!("http://10.0.0.{i}:8000"),
                true,
                now_ms(),
            ))
            .unwrap();
    }
    let digest = format!("sha256:{}", "a".repeat(64));
    assert!(store.read("http://10.0.0.3:8000", &digest).is_none());
    assert!(store.read("http://10.0.0.4:8000", &digest).is_some());
}

#[test]
fn canary_file_reads_a_damaged_file_as_empty() {
    let store = temp_canary("damaged");
    std::fs::create_dir_all(store.path.parent().unwrap()).unwrap();
    std::fs::write(&store.path, r#"{"v":1,"entries":[{"url":1}]"#).unwrap();
    assert!(store.read("x", "y").is_none());
}

#[test]
fn canary_freshness() {
    let now = 1_800_000_000_000.0;
    assert!(canary_fresh(
        Some(&canary_entry("u", true, now - 1000.0)),
        now
    ));
    assert!(!canary_fresh(
        Some(&canary_entry("u", true, now - DECIDE_CANARY_TTL_MS)),
        now
    ));
    assert!(!canary_fresh(
        Some(&canary_entry("u", false, now - 1000.0)),
        now
    ));
    assert!(!canary_fresh(
        Some(&canary_entry("u", true, now + 60_000.0)),
        now
    ));
    assert!(!canary_fresh(None, now));
}
