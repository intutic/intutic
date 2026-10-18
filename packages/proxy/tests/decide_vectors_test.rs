//! The proxy's decide rules against the shared vectors.
//!
//! `packages/shared-types/fixtures/decide-vectors.json` is run by the
//! TypeScript module, the Python gate and this crate; each must reach the same
//! answers, reason text included. The front-matter group goes through
//! `loaded_sops()`, the path a proxy takes at startup, with `INTUTIC_SOPS_DIR`
//! pointed at a directory of the group's SOP files.

use std::collections::BTreeMap;
use std::path::PathBuf;

use intutic_proxy::decide::{
    self, Answer, Band, Candidate, Combiner, DecideDecl, Escalate, On, Outcome, Rollout,
    RuleResult, Tri,
};
use intutic_proxy::sops::loaded_sops;
use serde_json::Value;

fn vectors() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("shared-types")
        .join("fixtures")
        .join("decide-vectors.json");
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "{} is missing ({e}) — this test would assert nothing",
            path.display()
        )
    });
    serde_json::from_str(&raw).expect("decide-vectors.json is JSON")
}

fn s(v: &Value) -> &str {
    v.as_str().expect("a string")
}

fn tri(v: &Value) -> Tri {
    match s(v) {
        "T" => Tri::T,
        "F" => Tri::F,
        "U" => Tri::U,
        other => panic!("not a three-valued answer: {other}"),
    }
}

fn tri_str(t: Tri) -> &'static str {
    match t {
        Tri::T => "T",
        Tri::F => "F",
        Tri::U => "U",
    }
}

fn band(v: &Value) -> Band {
    Band {
        yes_at: v["yes_at"].as_f64().expect("yes_at"),
        no_below: v["no_below"].as_f64().expect("no_below"),
    }
}

fn per_order(v: &Value) -> Vec<decide::PerOrder> {
    v.as_array()
        .expect("perOrder is a list")
        .iter()
        .map(|m| {
            m.as_object()
                .expect("an option map")
                .iter()
                .map(|(k, p)| (k.clone(), p.as_f64().expect("a probability")))
                .collect()
        })
        .collect()
}

fn outcome_str(o: Outcome) -> &'static str {
    match o {
        Outcome::Allow => "allow",
        Outcome::Refuse => "refuse",
        Outcome::Escalate => "escalate",
        Outcome::Unavailable => "unavailable",
    }
}

fn opt_str<T: AsRef<str>>(v: Option<T>) -> Value {
    v.map_or(Value::Null, |s| Value::from(s.as_ref()))
}

fn validated(rule: &Value) -> decide::DecideRule {
    decide::validate(rule).unwrap_or_else(|e| panic!("vector rule does not validate: {e}"))
}

#[test]
fn every_group_this_layer_claims_has_cases() {
    let v = vectors();
    for (group, layers) in v["layers"].as_object().expect("layers") {
        if !layers.as_array().unwrap().iter().any(|l| l == "rust") {
            continue;
        }
        let n = match &v[group.as_str()] {
            Value::Array(a) => a.len(),
            Value::Object(o) => o.values().map(|c| c.as_array().map_or(0, Vec::len)).sum(),
            _ => 0,
        };
        assert!(n > 0, "{group} has no cases");
    }
    assert!(v["validate"].as_array().unwrap().len() >= 100);
}

#[test]
fn validate() {
    let v = vectors();
    for case in v["validate"].as_array().unwrap() {
        let name = s(&case["name"]);
        let raw = match case.get("raw") {
            Some(r) => s(r).to_string(),
            None => serde_json::to_string(&case["rule"]).unwrap(),
        };
        let got = match decide::parse_line(&raw) {
            DecideDecl::Rule(r) => {
                serde_json::json!({ "ok": true, "when": decide::canonical_when(&r.expr) })
            }
            DecideDecl::Unreadable { id, error } => {
                serde_json::json!({ "ok": false, "id": id, "error": error })
            }
        };
        assert_eq!(got, case["expect"], "{name}");
    }
}

#[test]
fn hash() {
    let v = vectors();
    let cases = v["hash"].as_array().unwrap();
    let by_name: BTreeMap<&str, &Value> = cases.iter().map(|c| (s(&c["name"]), c)).collect();
    for case in cases {
        let name = s(&case["name"]);
        let rule = validated(&case["rule"]);
        assert_eq!(decide::hash_input(&rule), s(&case["input"]), "{name}");
        assert_eq!(decide::rule_hash(&rule), s(&case["ruleHash"]), "{name}");
        if let Some(other) = case.get("sameAs") {
            assert_eq!(case["ruleHash"], by_name[s(other)]["ruleHash"], "{name}");
        }
        if let Some(other) = case.get("differsFrom") {
            assert_ne!(case["ruleHash"], by_name[s(other)]["ruleHash"], "{name}");
        }
    }
    assert_eq!(
        s(&by_name["the LLD example"]["ruleHash"]),
        "be5cbda58b93cf90e90d1b994c32331b05459aefba564ab9e2d190396a1b3291"
    );
}

#[test]
fn kleene_bands_and_orders() {
    let v = vectors();
    let kleene = v["compose"]["kleene"].as_array().unwrap();
    assert_eq!(kleene.len(), 9);
    for r in kleene {
        let (a, b) = (tri(&r["a"]), tri(&r["b"]));
        assert_eq!(decide::k_and(a, b), tri(&r["and"]), "{a:?} AND {b:?}");
        assert_eq!(decide::k_or(a, b), tri(&r["or"]), "{a:?} OR {b:?}");
        assert_eq!(decide::k_not(a), tri(&r["notA"]), "NOT {a:?}");
    }
    for r in v["compose"]["band"].as_array().unwrap() {
        let p = r["p"].as_f64().unwrap();
        assert_eq!(
            decide::band_value(p, band(&r["band"])),
            tri(&r["value"]),
            "{p}"
        );
    }
    for r in v["compose"]["orders"].as_array().unwrap() {
        let n = r["n"].as_u64().unwrap() as usize;
        let want: Vec<Vec<usize>> = serde_json::from_value(r["orders"].clone()).unwrap();
        assert_eq!(decide::choice_orders(n), want, "{n}");
    }
}

#[test]
fn choice() {
    let v = vectors();
    for case in v["compose"]["choice"].as_array().unwrap() {
        let name = s(&case["name"]);
        let options: Vec<String> = serde_json::from_value(case["options"].clone()).unwrap();
        let got =
            decide::choice_atoms(&options, &per_order(&case["perOrder"]), band(&case["band"]));
        let want = case["atoms"].as_object().unwrap();
        assert_eq!(got.len(), want.len(), "{name}");
        for (o, w) in want {
            let a = got[o.as_str()];
            assert_eq!(a.p, w["p"].as_f64().unwrap(), "{name}: {o} p");
            assert_eq!(
                a.spread,
                w["spread"].as_f64().unwrap(),
                "{name}: {o} spread"
            );
            assert_eq!(a.value, tri(&w["value"]), "{name}: {o} value");
        }
    }
}

#[test]
fn rule() {
    let v = vectors();
    for case in v["compose"]["rule"].as_array().unwrap() {
        let name = s(&case["name"]);
        let rule = validated(&case["rule"]);
        let answers: BTreeMap<String, Answer> = case["answers"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(q, a)| {
                (
                    q.clone(),
                    Answer {
                        p: a.get("p").and_then(Value::as_f64),
                        per_order: a.get("perOrder").map(per_order),
                    },
                )
            })
            .collect();
        let combiner = case.get("combiner").map(|c| Combiner {
            bias: c["bias"].as_f64().unwrap(),
            weights: c["weights"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(k, w)| (k.clone(), w.as_f64().unwrap()))
                .collect(),
            band: band(&c["band"]),
        });
        let got = decide::rule_outcome(&rule, &answers, combiner.as_ref());
        let want = &case["expect"];
        assert_eq!(tri_str(got.value), s(&want["value"]), "{name}: value");
        assert_eq!(
            outcome_str(got.outcome),
            s(&want["outcome"]),
            "{name}: outcome"
        );
        assert_eq!(opt_str(got.code), want["code"], "{name}: code");
        assert_eq!(
            opt_str(got.via.map(Escalate::as_str)),
            want["via"],
            "{name}: via"
        );
        match want.get("score").and_then(Value::as_f64) {
            Some(score) => assert!(
                (got.score.unwrap() - score).abs() < 1e-9,
                "{name}: score {:?}",
                got.score
            ),
            None => assert_eq!(got.score, None, "{name}: score"),
        }
    }
}

#[test]
fn call() {
    let v = vectors();
    let rollout = |v: &Value| {
        if s(v) == "enforce" {
            Rollout::Enforce
        } else {
            Rollout::Shadow
        }
    };
    for case in v["compose"]["call"].as_array().unwrap() {
        let name = s(&case["name"]);
        let candidates: Vec<Candidate> = case["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| Candidate {
                rule_ref: s(&c["ref"]).to_string(),
                on: if s(&c["on"]) == "tool_call" {
                    On::ToolCall
                } else {
                    On::Response
                },
                tools: c
                    .get("tools")
                    .map_or_else(Vec::new, |t| serde_json::from_value(t.clone()).unwrap()),
                effective: rollout(&c["effective"]),
            })
            .collect();
        let results: Vec<RuleResult> = case["results"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| RuleResult {
                rule_ref: s(&r["ref"]).to_string(),
                effective: rollout(&r["effective"]),
                outcome: match s(&r["outcome"]) {
                    "allow" => Outcome::Allow,
                    "refuse" => Outcome::Refuse,
                    "escalate" => Outcome::Escalate,
                    _ => Outcome::Unavailable,
                },
                code: r.get("code").and_then(Value::as_str).map(str::to_string),
                via: match r.get("via").and_then(Value::as_str) {
                    Some("ask") => Some(Escalate::Ask),
                    Some("review") => Some(Escalate::Review),
                    _ => None,
                },
            })
            .collect();
        let sel = decide::select_rules(&candidates, s(&case["tool"]));
        let out = decide::call_outcome(&sel, &results);
        let refs = |xs: &[&Candidate]| xs.iter().map(|c| c.rule_ref.clone()).collect::<Vec<_>>();
        let got = serde_json::json!({
            "evaluate": refs(&sel.evaluate),
            "skipped": refs(&sel.skipped),
            "outcome": outcome_str(out.outcome),
            "code": out.code,
            "ruleRef": out.rule_ref,
            "via": out.via.map(Escalate::as_str),
            "reason": out.reason,
        });
        assert_eq!(got, case["expect"], "{name}");
    }
}

#[test]
fn front_matter_through_the_sop_loader() {
    let v = vectors();
    let cases = v["frontMatter"].as_array().unwrap();
    let dir = std::env::temp_dir().join(format!(
        "intutic-decide-vectors-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    for (i, case) in cases.iter().enumerate() {
        let doc = format!(
            "---\n{}\n---\n# Case {i}\n\nA decide vector.\n",
            s(&case["front"])
        );
        std::fs::write(dir.join(format!("case{i}.md")), doc).unwrap();
    }
    std::env::set_var("INTUTIC_SOPS_DIR", &dir);
    let sops = loaded_sops();
    assert_eq!(sops.len(), cases.len(), "every case file loads");
    for (i, case) in cases.iter().enumerate() {
        let name = s(&case["name"]);
        let sop = sops
            .iter()
            .find(|s| s.title == format!("case{i}"))
            .unwrap_or_else(|| panic!("{name}: not loaded"));
        let got: Vec<Value> = sop
            .decide_rules
            .iter()
            .map(|d| match d {
                DecideDecl::Rule(r) => {
                    serde_json::json!({ "rule": r.id, "ruleHash": decide::rule_hash(r) })
                }
                DecideDecl::Unreadable { id, error } => {
                    serde_json::json!({ "unreadable": { "id": id, "error": error } })
                }
            })
            .collect();
        assert_eq!(Value::from(got), case["expect"], "{name}");
    }
    let _ = std::fs::remove_dir_all(&dir);
}
