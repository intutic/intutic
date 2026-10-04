//! TD-248: `CYCLE_COVERAGE_FLOOR` against real coding-agent trajectories.
//!
//! The BFCL sweep in `anomaly_corpus_test.rs` could only speak for 2 of 1,000
//! trajectories, because API-orchestration runs are too short to reach the
//! coverage gate. Coding agents are the opposite: long runs over a vocabulary
//! of three to five tool names. This measures the floor there.
//!
//! **Fetched, not vendored, and skipped without it.** The corpus is a derived
//! extract of `nebius/SWE-rebench-openhands-trajectories` (CC-BY-4.0); see
//! `corpus/openhands/extract.py` and the TD-248 section of
//! `corpus/PROVENANCE.md`. Vendoring it is a decision about carrying 35 MB of
//! third-party data in a mirrored tree, not one to make inside a test. Without
//! `INTUTIC_CODING_CORPUS` this test prints that it did not run and returns —
//! read the output, a green result here proves nothing on its own.
//!
//! What the measurement found (seed-248 sample, 1,000 trajectories): every
//! trajectory reaches the gate, every gated window clears the floor, and the
//! final-window coverage is never below 0.875. With a handful of tool names every
//! name recurs in any 24-call window, so the floor admits everything and the
//! detector's false-positive behaviour is decided by `CYCLE_MATCH_RATIO` alone.
//! The assertion pins that finding, so a change that makes the floor start
//! discriminating on this traffic fails here and sends someone back to TD-248.

// Shared with anomaly_corpus_test.rs, which uses the rest of it (the BFCL
// seeds and mutators); only the context builder is needed here.
#[allow(dead_code)]
mod corpus_support;

use corpus_support::{build_ctx, fired};
use intutic_proxy::manifest::{InvocationSource, ToolInvocation};
use intutic_proxy::plugins::anomaly::detectors::{landmark_cycle_coverage, CYCLE_COVERAGE_FLOOR};
use std::collections::BTreeMap;

/// The label a trajectory's own outcome gives it. None of these is a human
/// judgment of "was looping": `stuck_in_loop` is OpenHands' own StuckDetector,
/// `budget_exhausted` is the 100-iteration cap, and the two `submitted` labels
/// say the agent finished — a firing there is the closest thing this corpus has
/// to a false positive.
fn label(v: &serde_json::Value) -> &'static str {
    let exit = v["exit_status"].as_str().unwrap_or("");
    if exit.contains("StuckInLoop") {
        "stuck_in_loop"
    } else if exit.contains("maximum iteration") {
        "budget_exhausted"
    } else if v["resolved"].as_i64() == Some(1) {
        "submitted_resolved"
    } else {
        "submitted_unresolved"
    }
}

#[derive(Default, Debug)]
struct Row {
    trajectories: usize,
    reached_gate: usize,
    cleared_floor: usize,
    fired_any_request: usize,
    fired_final_request: usize,
}

#[tokio::test]
async fn cycle_coverage_floor_does_not_discriminate_on_coding_agent_traffic() {
    let Ok(path) = std::env::var("INTUTIC_CODING_CORPUS") else {
        eprintln!(
            "SKIPPED: INTUTIC_CODING_CORPUS is not set, so nothing was measured. \
             Run tests/corpus/openhands/extract.py and point the variable at its output."
        );
        return;
    };
    let body = std::fs::read_to_string(&path).expect("INTUTIC_CODING_CORPUS is readable");

    let mut by_label: BTreeMap<&'static str, Row> = BTreeMap::new();
    let (mut requests, mut gated, mut gated_below_floor, mut fired_requests) = (0, 0, 0, 0);
    let mut min_final_coverage = f64::MAX;

    for line in body.lines().filter(|l| !l.trim().is_empty()) {
        let v: serde_json::Value = serde_json::from_str(line).expect("corpus line is JSON");
        let calls: Vec<ToolInvocation> = v["calls"]
            .as_array()
            .expect("calls array")
            .iter()
            .filter_map(|c| {
                Some(ToolInvocation {
                    name: c["name"].as_str()?.to_string(),
                    input: c["input"].clone(),
                    source: InvocationSource::Call,
                })
            })
            .collect();
        let row = by_label.entry(label(&v)).or_default();
        row.trajectories += 1;

        // Every prefix, because the proxy evaluates on every request and a
        // harness sends one per tool round-trip. The final window alone would
        // miss a firing mid-run, which is when a steer would land.
        let (mut reached, mut cleared, mut fired_any, mut fired_final) =
            (false, false, false, false);
        for k in 1..=calls.len() {
            let ctx = build_ctx(&calls[..k]).await;
            requests += 1;
            if let Some(sample) = landmark_cycle_coverage(&ctx.tool_sequence) {
                gated += 1;
                reached = true;
                if sample.coverage >= CYCLE_COVERAGE_FLOOR {
                    cleared = true;
                } else {
                    gated_below_floor += 1;
                }
                if k == calls.len() {
                    min_final_coverage = min_final_coverage.min(sample.coverage);
                }
            }
            if fired(&ctx).iter().any(|d| d == "landmark_cycle") {
                fired_requests += 1;
                fired_any = true;
                fired_final |= k == calls.len();
            }
        }
        row.reached_gate += reached as usize;
        row.cleared_floor += cleared as usize;
        row.fired_any_request += fired_any as usize;
        row.fired_final_request += fired_final as usize;
    }

    for (label, row) in &by_label {
        println!("{label}: {row:?}");
    }
    println!(
        "requests {requests}, reached the gate {gated}, below the floor {gated_below_floor}, \
         landmark_cycle fired {fired_requests}; minimum final-window coverage {min_final_coverage:.3}"
    );

    assert!(
        gated > 0,
        "no request reached the coverage gate — the corpus is not what extract.py writes"
    );
    // The finding, pinned: the floor rejects (almost) nothing here. 1% of
    // gated requests is slack for a re-sampled corpus, not a tolerance on the
    // claim — the seed-248 sample measured 0.
    assert!(
        (gated_below_floor as f64) < 0.01 * gated as f64,
        "{gated_below_floor} of {gated} gated requests fell below CYCLE_COVERAGE_FLOOR ({}) — the \
         floor now discriminates on coding-agent traffic, which TD-248 records it does not. \
         Re-read the entry before changing either.",
        CYCLE_COVERAGE_FLOOR,
    );
}
