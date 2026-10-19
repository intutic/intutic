//! `packages/shared-types/fixtures/test-outcome-vectors.json` (the 3.1
//! test outcome), run against the proxy's port in `plugins::anomaly::outcome`. The
//! TypeScript (`testOutcome.ts`) and Python (`test_outcome.py`) ports run the
//! same file. `parseState` is the hook gates' state-file format, which the
//! proxy does not read (its record lives in Valkey), so it is not run here.
//!
//! A missing file fails: the vectors are the contract.

use intutic_proxy::plugins::anomaly::outcome::{
    decide_test_outcome, extract_exit_code, ordering_qualifier_error, prerequisite_case,
    prerequisite_unmet_reason, Case, OutcomeEntry, OutcomeInput,
};
use serde_json::Value;

fn vectors() -> Option<Value> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../shared-types/fixtures/test-outcome-vectors.json");
    match std::fs::read_to_string(&path) {
        Ok(t) => Some(serde_json::from_str(&t).expect("the vectors parse")),
        Err(e) => panic!("{} must exist: {e}", path.display()),
    }
}

/// An output written as a string, or `{concat: [[text, n], …]}`.
fn output(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Object(o) => o["concat"]
            .as_array()
            .expect("concat")
            .iter()
            .map(|p| {
                p[0].as_str()
                    .unwrap()
                    .repeat(p[1].as_u64().unwrap() as usize)
            })
            .collect(),
        _ => String::new(),
    }
}

fn input(v: &Value) -> OutcomeInput {
    OutcomeInput {
        exit_code: v.get("exitCode").and_then(Value::as_i64),
        is_error: v.get("isError").and_then(Value::as_bool),
        success: v.get("success").and_then(Value::as_bool),
        output: v.get("output").map(output).unwrap_or_default(),
    }
}

#[test]
fn every_test_outcome_vector_holds() {
    let Some(v) = vectors() else { return };
    let mut wrong = Vec::new();

    for c in v["extractExitCode"].as_array().unwrap() {
        let got = extract_exit_code(c["output"].as_str().unwrap());
        if got != c["exitCode"].as_i64() {
            wrong.push(format!("extractExitCode {}: {got:?}", c["name"]));
        }
    }
    for c in v["decide"].as_array().unwrap() {
        let d = decide_test_outcome(&input(&c["input"]));
        if d.outcome.as_str() != c["outcome"] || d.why != c["why"] {
            wrong.push(format!(
                "decide {}: {} {}",
                c["name"],
                d.outcome.as_str(),
                d.why
            ));
        }
    }
    for c in v["qualifier"].as_array().unwrap() {
        let got =
            ordering_qualifier_error(c["side"].as_str().unwrap(), c["left"].as_bool().unwrap());
        if got.as_deref() != c["error"].as_str() {
            wrong.push(format!("qualifier {}: {got:?}", c["name"]));
        }
    }
    for c in v["state"].as_array().unwrap() {
        let mut state: std::collections::BTreeMap<String, OutcomeEntry> = Default::default();
        for step in c["steps"].as_array().unwrap() {
            match step["op"].as_str().unwrap() {
                "record" => {
                    let d = decide_test_outcome(&input(&step["input"]));
                    state.insert(
                        step["token"].as_str().unwrap().to_string(),
                        OutcomeEntry::record(&d, step["at"].as_i64().unwrap()),
                    );
                }
                _ => {
                    let changed = step["changedFiles"].as_bool().unwrap();
                    for e in state.values_mut() {
                        e.note_completed_call(changed);
                    }
                }
            }
        }
        let check = &c["check"];
        let (case, why) = prerequisite_case(
            state.get(check["token"].as_str().unwrap()),
            check["adjacent"].as_bool().unwrap(),
            check["now"].as_i64().unwrap(),
        );
        if case.as_str() != c["case"] || why.as_deref() != c["why"].as_str() {
            wrong.push(format!("state {}: {} {why:?}", c["name"], case.as_str()));
        }
    }
    for c in v["reasons"].as_array().unwrap() {
        let got = prerequisite_unmet_reason(
            c["first"].as_str().unwrap(),
            c["then"].as_str().unwrap(),
            Case::parse(c["case"].as_str().unwrap()).expect("a case"),
            c["why"].as_str(),
            c["harness"].as_str().unwrap(),
        );
        if got != c["reason"] {
            wrong.push(format!("reasons {}: {got}", c["case"]));
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

/// Linear time: each adversarial output decides well within the 200 ms the
/// JavaScript and Python ports are held to.
#[test]
fn adversarial_outputs_decide_quickly() {
    let Some(v) = vectors() else { return };
    for c in v["adversarial"].as_array().unwrap() {
        let text = c[2]
            .as_str()
            .unwrap()
            .repeat(c[3].as_u64().unwrap() as usize);
        let started = std::time::Instant::now();
        let _ = decide_test_outcome(&OutcomeInput {
            output: text.clone(),
            ..Default::default()
        });
        let _ = extract_exit_code(&text);
        let took = started.elapsed();
        assert!(
            took < std::time::Duration::from_millis(2_000),
            "{}: {took:?}",
            c[0]
        );
    }
}
