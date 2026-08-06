//! The streaming trace must carry the shadow reports, not an empty vector.
//!
//! ## What this guards
//!
//! `wasm_shadow_reports` is computed once in `handle_proxy`, off the request
//! context, **before** the streaming/non-streaming split. Both response paths
//! therefore have it in scope. The streaming trace passed `Vec::new()` anyway,
//! under a comment saying reports were "captured on the non-streaming trace
//! only for now."
//!
//! That was not a deferral, it was a hole. Agent harnesses stream by default,
//! so `rule_candidates.shadow_evaluations` — the denominator `promotionReadiness`
//! divides by, and the whole point of the shadow period — only ever counted the
//! minority traffic shape. A shadowed rule would take far longer to reach its
//! 200-evaluation bar than the operator was told, or never reach it, and the
//! promotion gate would go on answering `ready: false` with nothing to say why.
//!
//! ## What this is NOT
//!
//! **This is a source-text assertion, and that is second best.** It cannot
//! observe a trace, only the shape of the code that builds one. It would not
//! catch the reports being computed wrongly, dropped later, or lost between the
//! proxy and the control plane.
//!
//! The real guard is an end-to-end streaming request against a stub upstream
//! with the emitted trace captured — the shape `mirror_test.rs` already uses
//! `wiremock` for. That needs an `AppState` fixture, which no test in this crate
//! builds today. Until one exists this holds the specific line, and says so
//! rather than implying more.
//!
//! The three remaining `Vec::new()` sites are deliberate and are asserted to
//! stay that way: blocked-before-evaluation, served-from-cache, and
//! error-short-circuit each ran no rule, so an empty report list is the true
//! answer and counting them would inflate the denominator with requests no rule
//! ever saw.

const PROXY_RS: &str = include_str!("../src/proxy.rs");

/// The trace-construction sites, by the comment that identifies each.
fn field_after(marker: &str) -> String {
    let at = PROXY_RS
        .find(marker)
        .unwrap_or_else(|| panic!("marker vanished from proxy.rs: {marker}"));
    let rest = &PROXY_RS[at..];
    let field = rest
        .find("wasm_shadow_reports:")
        .unwrap_or_else(|| panic!("no wasm_shadow_reports after: {marker}"));
    let line_start = at + field;
    let line_end = PROXY_RS[line_start..]
        .find('\n')
        .map(|n| line_start + n)
        .unwrap_or(PROXY_RS.len());
    PROXY_RS[line_start..line_end].trim().to_string()
}

#[test]
fn the_streaming_trace_carries_the_reports_it_already_has() {
    let line = field_after("The same reports the non-streaming trace carries");
    assert!(
        line.contains("wasm_shadow_reports.clone()"),
        "the streaming trace must carry the computed reports, not an empty vector. \
         Agent harnesses stream by default, so an empty vector here starves \
         rule_candidates.shadow_evaluations of the dominant traffic shape and no \
         generated rule can accumulate the evidence promotion is gated on. Found: {line}"
    );
}

#[test]
fn the_non_streaming_trace_still_carries_them() {
    let line = field_after("The one path that actually evaluated rules");
    assert!(
        line.contains("wasm_shadow_reports.clone()"),
        "the non-streaming trace must carry the reports. Found: {line}"
    );
}

#[test]
fn the_three_paths_that_evaluated_nothing_still_report_nothing() {
    // Each of these ran no rule, so an empty list is the true answer. Counting
    // them would inflate the denominator with requests no rule ever saw, which
    // would make a rule's observed act-rate look better the more traffic it was
    // never evaluated against — the failure direction that reads as success.
    for marker in [
        "Blocked before WASM evaluation ran.",
        "Served from cache; no rule was evaluated.",
        "Error or short-circuit before rule evaluation.",
    ] {
        let line = field_after(marker);
        assert!(
            line.contains("Vec::new()"),
            "'{marker}' evaluated no rule, so its trace must report none. Found: {line}"
        );
    }
}
