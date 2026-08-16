//! The response-echo corpus gate: a pinned, self-authored measurement of how
//! often the five request-side injection patterns fire on MODEL OUTPUT.
//!
//! `injection::scan_response_body` (non-streaming path) and `injection::scan`
//! (streaming path, run on accumulated content) both scan the model's own
//! text for the same five phrasings `scan_body` looks for on the request
//! side. That is a different population from anything `anomaly_corpus_test.rs`
//! measures: a model legitimately quotes and discusses these phrasings — the
//! textbook answer to "how do I defend against prompt injection?" trips
//! `override-instructions` by construction — and `injection.rs` already pins
//! that exact shape as EXPECTED behavior in
//! `response_scan_fires_on_benign_discussion_of_injection_by_design`.
//!
//! # Why this corpus is different from every other one in `tests/corpus/`
//!
//! BFCL and NotInject, vendored elsewhere in this test suite, are external
//! and public — nobody at Intutic chose them, which is what makes a
//! false-positive count against them mean something. No such corpus exists
//! for this population: NotInject covers benign *prompts* carrying injection
//! vocabulary, not benign *model output* carrying it, and no third-party
//! corpus of the latter exists anywhere. So this one is self-authored. Read
//! `tests/corpus/PROVENANCE.md`, section "Response-echo corpus", before
//! citing any number this file produces — it explains exactly what a
//! self-authored corpus can and cannot prove, and it is not a substitute for
//! an external measurement.
//!
//! # What this file proves and does not
//!
//! Proves: the five patterns fire on discussion-of-injection-topic model
//! output at a specific, measured, PINNED rate on this corpus, and a change
//! to any pattern's regex will show up as a diff against the pinned firing
//! set — widened means new rows start firing, narrowed means pinned rows go
//! quiet. Also proves the streaming (`scan`) and non-streaming
//! (`scan_response_body`) paths agree on every row, across all three
//! provider response shapes.
//!
//! Does not prove: any false-positive rate on real production model-output
//! traffic. See PROVENANCE.md.

use std::collections::{BTreeMap, BTreeSet};

const CORPUS: &str = include_str!("corpus/response_echo/benign_outputs.jsonl");

#[derive(Debug, Clone, serde::Deserialize)]
struct Row {
    id: String,
    text: String,
}

fn load_rows() -> Vec<Row> {
    CORPUS
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str::<Row>(l).expect("corpus row parses as {id, text}"))
        .collect()
}

/// Sorted, deduped pattern names fired by the raw scan (streaming path).
fn fired_raw(text: &str) -> Vec<String> {
    let mut pats = intutic_proxy::injection::scan(text);
    pats.sort();
    pats.dedup();
    pats
}

// ── Provider response wrappers ──────────────────────────────────────────────
//
// The three shapes `scan_response_body` extracts text from. Minimal but
// otherwise realistic — the fields a real provider response carries beyond
// these are irrelevant to extraction and are omitted.

fn wrap_anthropic(text: &str) -> serde_json::Value {
    serde_json::json!({
        "id": "msg_corpus",
        "type": "message",
        "role": "assistant",
        "content": [
            { "type": "text", "text": text }
        ],
        "model": "claude-corpus",
        "stop_reason": "end_turn",
    })
}

fn wrap_openai(text: &str) -> serde_json::Value {
    serde_json::json!({
        "id": "chatcmpl-corpus",
        "object": "chat.completion",
        "choices": [
            { "index": 0, "message": { "role": "assistant", "content": text }, "finish_reason": "stop" }
        ],
    })
}

fn wrap_gemini(text: &str) -> serde_json::Value {
    serde_json::json!({
        "candidates": [
            { "content": { "role": "model", "parts": [ { "text": text } ] }, "finishReason": "STOP" }
        ],
    })
}

fn fired_body(body: &serde_json::Value) -> Vec<String> {
    // `scan_response_body` already returns a deduplicated, sorted list (it
    // collects from a `BTreeSet<String>` internally) — sorting again here
    // costs nothing and makes this helper's contract explicit rather than
    // borrowed from an implementation detail the caller shouldn't need to
    // know.
    let mut pats = intutic_proxy::injection::scan_response_body(body);
    pats.sort();
    pats.dedup();
    pats
}

// ── Test 1: anti-vacuity ────────────────────────────────────────────────────

/// The corpus must not degrade into a zero-iteration loop.
///
/// A truncated or corrupted corpus file must fail loudly here, not silently
/// report a perfect firing rate three tests later. Checks the exact id
/// sequence, not just a count — a corpus with the right row count but
/// shuffled, duplicated, or renumbered ids would still pass a bare
/// `len() == 150` check.
#[test]
fn corpus_is_not_empty_and_matches_its_pinned_size() {
    let rows = load_rows();
    assert_eq!(rows.len(), 150, "response_echo corpus row count changed");

    let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
    let expected_ids: Vec<String> = (1..=150).map(|n| format!("resp_echo_{n:04}")).collect();
    assert_eq!(
        ids, expected_ids,
        "corpus ids are not exactly resp_echo_0001..resp_echo_0150 in order — \
         truncated, duplicated, or reordered corpus file",
    );

    let unique: BTreeSet<&str> = ids.iter().copied().collect();
    assert_eq!(unique.len(), rows.len(), "duplicate id in response_echo corpus");

    for row in &rows {
        assert!(!row.text.trim().is_empty(), "{}: empty text", row.id);
    }
}

// ── Test 2: byte-stable baseline ────────────────────────────────────────────

/// Generate the baseline report and require the committed file to match.
///
/// Regenerate deliberately with `INTUTIC_WRITE_BASELINE=1 cargo test --test
/// response_echo_corpus_test`. Same mechanism as `anomaly_corpus_test.rs`'s
/// `the_baseline_is_current_and_byte_stable` — same env var, same
/// write-instead-of-compare gate, same reasoning: a test that only compared
/// counts would pass while the detector behind a number changed.
#[test]
fn the_response_echo_baseline_is_current_and_byte_stable() {
    let report = build_report();

    if std::env::var("INTUTIC_WRITE_BASELINE").is_ok() {
        std::fs::write(
            concat!(env!("CARGO_MANIFEST_DIR"), "/tests/corpus/response_echo/BASELINE.txt"),
            &report,
        )
        .expect("write baseline");
        return;
    }

    let committed = include_str!("corpus/response_echo/BASELINE.txt");
    assert_eq!(
        report, committed,
        "response_echo/BASELINE.txt is stale. Re-run with INTUTIC_WRITE_BASELINE=1 \
         and READ the diff — a changed firing set is a decision, not a chore.",
    );
}

fn build_report() -> String {
    let rows = load_rows();

    let mut per_pattern: BTreeMap<String, usize> = BTreeMap::new();
    let mut firing_rows: BTreeMap<String, Vec<String>> = BTreeMap::new();

    for row in &rows {
        let pats = fired_raw(&row.text);
        for p in &pats {
            *per_pattern.entry(p.clone()).or_default() += 1;
        }
        if !pats.is_empty() {
            firing_rows.insert(row.id.clone(), pats);
        }
    }

    let total = rows.len();
    let fired_total = firing_rows.len();
    let rate = 100.0 * fired_total as f64 / total as f64;

    let mut out = String::new();
    out.push_str(BASELINE_HEADER);
    out.push_str(&format!("Corpus: {total} self-authored rows (resp_echo_0001..resp_echo_{total:04}).\n\n"));
    out.push_str(
        "Both scan entry points agree on every row (see \
         `both_scan_entry_points_agree_on_every_row`); the counts below come \
         from `injection::scan` run directly on each row's `text`.\n\n",
    );
    out.push_str("  pattern_name                  | rows_fired\n");
    out.push_str("  -------------------------------|-----------\n");
    for (pattern, count) in &per_pattern {
        out.push_str(&format!("  {pattern:<30} | {count:>10}\n"));
    }
    out.push_str(&format!(
        "\nRows with at least one firing: {fired_total} of {total} ({rate:.1}%).\n\n",
    ));

    out.push_str("Firing rows, by id:\n");
    if firing_rows.is_empty() {
        out.push_str("  (none)\n");
    } else {
        for (id, pats) in &firing_rows {
            out.push_str(&format!("  {id}  ->  {}\n", pats.join(", ")));
        }
    }
    out
}

const BASELINE_HEADER: &str = "\
Intutic response-echo corpus baseline — self-authored, regression-only
========================================================================

Produced by:
    cd packages/proxy && INTUTIC_WRITE_BASELINE=1 cargo test --test response_echo_corpus_test

Source: self-authored by the Intutic team (see tests/corpus/PROVENANCE.md,
section \"Response-echo corpus\"). This is NOT an external or independent
measurement, unlike the BFCL and NotInject corpora in BASELINE.txt one
directory up — no third-party corpus of \"benign model output discussing
prompt injection\" exists anywhere. Read PROVENANCE.md before citing any
number in this file in documentation.

";

// ── Test 3: pinned firing set ───────────────────────────────────────────────

/// Row id -> sorted pattern names, for every row with at least one firing.
///
/// Determined by actually running `injection::scan` over the corpus (see the
/// generation commands in this file's module docs / PROVENANCE.md) — not
/// guessed. A non-empty list here is expected and correct: it mirrors
/// `injection.rs`'s own `response_scan_fires_on_benign_discussion_of_injection_by_design`,
/// which pins the identical shape as intentional, not a bug to chase to zero.
const EXPECTED_ECHO_FIRINGS: &[(&str, &[&str])] = &[
    ("resp_echo_0001", &["override-instructions", "reveal-system-prompt"]),
    ("resp_echo_0002", &["override-instructions"]),
    ("resp_echo_0003", &["override-instructions"]),
    ("resp_echo_0004", &["reveal-system-prompt"]),
    ("resp_echo_0005", &["role-reassignment"]),
    ("resp_echo_0006", &["guardrail-bypass"]),
    ("resp_echo_0007", &["override-instructions", "role-reassignment"]),
    ("resp_echo_0008", &["guardrail-bypass", "override-instructions", "reveal-system-prompt"]),
    ("resp_echo_0009", &["guardrail-bypass", "override-instructions", "role-reassignment"]),
    ("resp_echo_0012", &["override-instructions", "role-reassignment"]),
    ("resp_echo_0015", &["role-reassignment"]),
    ("resp_echo_0017", &["override-instructions"]),
    ("resp_echo_0018", &["override-instructions"]),
    ("resp_echo_0020", &["override-instructions"]),
    ("resp_echo_0021", &["override-instructions"]),
    ("resp_echo_0022", &["guardrail-bypass", "role-reassignment"]),
    ("resp_echo_0023", &["guardrail-bypass"]),
    ("resp_echo_0024", &["reveal-system-prompt"]),
    ("resp_echo_0026", &["override-instructions"]),
    ("resp_echo_0027", &["override-instructions", "role-reassignment"]),
    ("resp_echo_0028", &["reveal-system-prompt"]),
    ("resp_echo_0029", &["override-instructions"]),
    ("resp_echo_0030", &["override-instructions"]),
    ("resp_echo_0031", &["override-instructions"]),
    ("resp_echo_0032", &["override-instructions"]),
    ("resp_echo_0033", &["override-instructions", "reveal-system-prompt"]),
    ("resp_echo_0034", &["role-reassignment"]),
    ("resp_echo_0035", &["override-instructions"]),
    ("resp_echo_0036", &["reveal-system-prompt"]),
    ("resp_echo_0037", &["role-reassignment"]),
    ("resp_echo_0038", &["guardrail-bypass"]),
    ("resp_echo_0040", &["override-instructions"]),
    ("resp_echo_0041", &["guardrail-bypass", "role-reassignment"]),
    ("resp_echo_0043", &["override-instructions"]),
    ("resp_echo_0044", &["reveal-system-prompt"]),
    (
        "resp_echo_0046",
        &["guardrail-bypass", "override-instructions", "reveal-system-prompt", "role-reassignment"],
    ),
    ("resp_echo_0047", &["reveal-system-prompt"]),
    ("resp_echo_0048", &["role-reassignment"]),
    ("resp_echo_0049", &["override-instructions"]),
    ("resp_echo_0050", &["override-instructions"]),
    ("resp_echo_0054", &["override-instructions"]),
    ("resp_echo_0058", &["reveal-system-prompt"]),
    ("resp_echo_0062", &["role-reassignment"]),
    ("resp_echo_0065", &["role-reassignment"]),
    ("resp_echo_0067", &["guardrail-bypass"]),
    ("resp_echo_0070", &["guardrail-bypass"]),
    ("resp_echo_0072", &["instruction-boundary-forgery"]),
    ("resp_echo_0073", &["instruction-boundary-forgery"]),
    ("resp_echo_0074", &["instruction-boundary-forgery"]),
];

/// This is a RATE-based / pinned-set assertion, NOT a zero-tolerance gate.
///
/// A non-empty `EXPECTED_ECHO_FIRINGS` is expected and correct — see the
/// constant's own doc comment. What this test guards is the *set* changing
/// underneath the corpus without anyone noticing.
#[test]
fn benign_echo_firings_are_pinned_by_id() {
    let rows = load_rows();
    let mut actual: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for row in &rows {
        let pats = fired_raw(&row.text);
        if !pats.is_empty() {
            actual.insert(row.id.clone(), pats);
        }
    }

    let expected: BTreeMap<String, Vec<String>> = EXPECTED_ECHO_FIRINGS
        .iter()
        .map(|(id, pats)| ((*id).to_string(), pats.iter().map(|p| p.to_string()).collect()))
        .collect();

    assert_eq!(
        actual, expected,
        "the set of response_echo rows that fire a pattern changed. \
         A widened match set means a pattern loosened; a narrowed one means a \
         pattern tightened. Either is a deliberate regex change, not a corpus \
         bug — update EXPECTED_ECHO_FIRINGS only after confirming the pattern \
         change was intentional.",
    );
}

// ── Test 4: streaming and non-streaming paths agree ────────────────────────

/// Every corpus row, wrapped in all three provider response shapes, must
/// produce the same firing set from `scan_response_body` as `scan` produces
/// on the raw text. This is what proves the corpus exercises BOTH the
/// streaming path (`scan`, run on accumulated content) and the non-streaming
/// path (`scan_response_body`) with one shared corpus, rather than each path
/// having its own untested extraction logic.
#[test]
fn both_scan_entry_points_agree_on_every_row() {
    let rows = load_rows();
    assert!(!rows.is_empty(), "an empty corpus would assert nothing");

    for row in &rows {
        let expected = fired_raw(&row.text);

        let anthropic = fired_body(&wrap_anthropic(&row.text));
        assert_eq!(
            anthropic, expected,
            "{}: scan_response_body (Anthropic shape) disagrees with scan",
            row.id,
        );

        let openai = fired_body(&wrap_openai(&row.text));
        assert_eq!(
            openai, expected,
            "{}: scan_response_body (OpenAI shape) disagrees with scan",
            row.id,
        );

        let gemini = fired_body(&wrap_gemini(&row.text));
        assert_eq!(
            gemini, expected,
            "{}: scan_response_body (Gemini shape) disagrees with scan",
            row.id,
        );
    }

    // A non-text content block alongside the text block must not change the
    // result — `scan_response_body` filters Anthropic content by
    // `type == "text"`, and a `tool_use` block sitting next to it has no
    // `text` field to extract from in the first place. Uses a row known to
    // fire, so a regression that accidentally scanned the tool_use block's
    // JSON (and found nothing there) couldn't hide behind an
    // already-empty expected result.
    let firing_row = rows.iter().find(|r| !fired_raw(&r.text).is_empty()).expect("a firing row exists");
    let with_tool_use = serde_json::json!({
        "content": [
            { "type": "text", "text": firing_row.text },
            { "type": "tool_use", "id": "toolu_corpus", "name": "get_weather", "input": { "city": "Boston" } },
        ],
    });
    assert_eq!(
        fired_body(&with_tool_use),
        fired_raw(&firing_row.text),
        "a non-text content block changed the firing set — non-text blocks must be ignored",
    );

    // Multi-block / multi-choice: extraction must cover every block or
    // choice, not just the first. Picks two rows whose pattern sets are
    // different so a regression that only read `content[0]` /
    // `choices[0]` would visibly lose one row's patterns rather than
    // coincidentally still passing.
    let a = rows.iter().find(|r| r.id == "resp_echo_0002").expect("resp_echo_0002 exists"); // override-instructions
    let b = rows.iter().find(|r| r.id == "resp_echo_0005").expect("resp_echo_0005 exists"); // role-reassignment
    let combined_expected: Vec<String> = {
        let mut set: BTreeSet<String> = BTreeSet::new();
        set.extend(fired_raw(&a.text));
        set.extend(fired_raw(&b.text));
        set.into_iter().collect()
    };
    assert_eq!(
        combined_expected,
        vec!["override-instructions".to_string(), "role-reassignment".to_string()],
        "test fixture assumption broke -- pick two rows with different, known pattern sets",
    );

    let multi_anthropic = serde_json::json!({
        "content": [
            { "type": "text", "text": a.text },
            { "type": "text", "text": b.text },
        ],
    });
    assert_eq!(
        fired_body(&multi_anthropic),
        combined_expected,
        "multi-block Anthropic response did not cover every text block",
    );

    let multi_openai = serde_json::json!({
        "choices": [
            { "index": 0, "message": { "role": "assistant", "content": a.text }, "finish_reason": "stop" },
            { "index": 1, "message": { "role": "assistant", "content": b.text }, "finish_reason": "stop" },
        ],
    });
    assert_eq!(
        fired_body(&multi_openai),
        combined_expected,
        "multi-choice OpenAI response did not cover every choice",
    );
}
