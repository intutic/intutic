//! The PII detectors against the conformance vectors both scanners run.
//!
//! `packages/shared-types/fixtures/pii-detector-vectors.json` is read here and
//! by `packages/mcp-proxy/src/__tests__/dlpPii.test.ts`. The two
//! implementations share the definition (`dlp/pii_detectors.json`) but not
//! the validators or the boundary rule, so these vectors are what holds them
//! to the same answers. Compared as matched text, not offsets: Rust counts
//! bytes and JavaScript UTF-16 units, and one vector is non-ASCII on purpose.

use intutic_proxy::dlp::pii;

fn vectors() -> serde_json::Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../shared-types/fixtures/pii-detector-vectors.json");
    let body = std::fs::read_to_string(&path).expect("pii-detector-vectors.json is readable");
    serde_json::from_str(&body).expect("pii-detector-vectors.json parses")
}

fn parts(case: &serde_json::Value) -> Vec<String> {
    case["parts"]
        .as_array()
        .expect("parts")
        .iter()
        .map(|p| p.as_str().expect("part is a string").to_string())
        .collect()
}

#[test]
fn every_vector_matches_exactly() {
    let v = vectors();
    let cases = v["cases"].as_array().expect("cases");
    assert!(cases.len() >= 50, "the vector file lost its cases");
    let mut failures = Vec::new();
    for case in cases {
        let parts = parts(case);
        let input = parts.concat();
        let want: Vec<(String, String)> = case["expect"]
            .as_array()
            .expect("expect")
            .iter()
            .map(|e| {
                let from = e["parts"][0].as_u64().unwrap() as usize;
                let to = e["parts"][1].as_u64().unwrap() as usize;
                (
                    e["id"].as_str().unwrap().to_string(),
                    parts[from..=to].concat(),
                )
            })
            .collect();
        let got: Vec<(String, String)> = pii::detect_all(&input)
            .into_iter()
            .map(|(id, s, e)| (id.to_string(), input[s..e].to_string()))
            .collect();
        if got != want {
            failures.push(format!(
                "{}: want {want:?}, got {got:?}",
                case["name"].as_str().unwrap_or("?")
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// A detector with no positive vector could match nothing and pass; one with
/// no negative vector could match everything shaped like it and pass.
#[test]
fn every_detector_has_positive_and_negative_vectors() {
    let v = vectors();
    for det in pii::detectors() {
        let prefix = det.id.trim_start_matches("pii.");
        let mut positive = false;
        let mut negative = false;
        for case in v["cases"].as_array().unwrap() {
            let expects = case["expect"].as_array().unwrap();
            if expects.iter().any(|e| e["id"] == det.id.as_str()) {
                positive = true;
            }
            let input = parts(case).concat();
            let shaped = det.regex.is_match(&input);
            if expects.is_empty() && shaped {
                negative = true;
            }
        }
        assert!(positive, "{prefix}: no vector expects a match");
        assert!(negative, "{prefix}: no vector rejects a regex match");
    }
}
