//! False-positive measurement for the PII detectors.
//!
//! Every detector runs over every vendored corpus with all detectors enabled,
//! whatever their configured default, so the numbers describe detection and
//! not configuration. Two kinds of corpus, read differently:
//!
//! - **External** — BFCL tool-call arguments, NotInject prompts, BFCL tool
//!   and parameter descriptions. Nobody at Intutic chose them. A firing there
//!   is not automatically a false positive (BFCL arguments carry made-up
//!   emails and phone numbers on purpose); the baseline lists every firing
//!   row so a reader can judge.
//! - **Self-authored coding-agent traffic** — `corpus/pii/coding_agent.jsonl`:
//!   manifests, lockfiles, git output, test fixtures and output, hashes,
//!   UUIDs, versions, timestamps, big integers. None of it contains PII, so
//!   any firing is a false positive. The gate: no detector other than email
//!   fires on it, and the full default scanner (secrets plus default-on PII)
//!   finds nothing. Email fires on git authors and manifest contacts by
//!   design — real addresses, just not ones worth redacting from a coding
//!   agent — which is why it ships off. See PROVENANCE.md before citing any
//!   number from this corpus: its authors also wrote the detectors.
//!
//! The report is pinned byte for byte in `corpus/pii/BASELINE.txt`. Regenerate
//! deliberately with `INTUTIC_WRITE_BASELINE=1 cargo test --test
//! pii_corpus_test` and read the diff.
//!
//! Real coding-agent traffic is measured too, when it is there: point
//! `INTUTIC_CODING_CORPUS` at the OpenHands extract (`corpus/openhands/
//! extract.py`). Not vendored, so not in the pinned baseline; the measured
//! numbers are in PROVENANCE.md.

#[allow(dead_code)]
mod corpus_support;

use intutic_proxy::dlp::{self, pii};
use std::collections::BTreeMap;

const CODING: &str = include_str!("corpus/pii/coding_agent.jsonl");
const RESPONSE_ECHO: &str = include_str!("corpus/response_echo/benign_outputs.jsonl");

/// Rows of the coding corpus where email fires. Git authors, manifest
/// contacts, an SSH remote and a bot's noreply address — every one a real
/// address shape, none worth redacting from a coding agent.
const EXPECTED_CODING_EMAIL_ROWS: &[&str] = &[
    "coding_0001",
    "coding_0002",
    "coding_0003",
    "coding_0004",
    "coding_0014",
    "coding_0016",
    "coding_0020",
];

struct Corpus {
    name: &'static str,
    rows: Vec<(String, String)>,
}

/// The coding corpus writes `{at}` for the `@` of an address, so the file
/// carries no address-shaped literal; it is put back here.
fn coding_rows() -> Vec<(String, String)> {
    CODING
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| {
            let v: serde_json::Value = serde_json::from_str(l).expect("coding row is JSON");
            (
                v["id"].as_str().unwrap().to_string(),
                v["text"].as_str().unwrap().replace("{at}", "@"),
            )
        })
        .collect()
}

fn jsonl_field(body: &str, field: &str, id_prefix: &str) -> Vec<(String, String)> {
    body.lines()
        .filter(|l| !l.trim().is_empty())
        .enumerate()
        .map(|(i, l)| {
            let v: serde_json::Value = serde_json::from_str(l).expect("corpus row is JSON");
            let id = v["id"]
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| format!("{id_prefix}_{:05}", i + 1));
            (id, v[field].as_str().unwrap_or("").to_string())
        })
        .collect()
}

fn corpora() -> Vec<Corpus> {
    let bfcl = corpus_support::load_seeds()
        .into_iter()
        .flat_map(|seed| {
            seed.calls
                .into_iter()
                .enumerate()
                .map(move |(i, c)| (format!("{}#{}", seed.id, i + 1), c.input.to_string()))
        })
        .collect();
    vec![
        Corpus {
            name: "bfcl-call-arguments",
            rows: bfcl,
        },
        Corpus {
            name: "notinject-prompts",
            rows: jsonl_field(corpus_support::NOTINJECT, "prompt", "notinject"),
        },
        Corpus {
            name: "bfcl-tool-descriptions",
            rows: jsonl_field(corpus_support::TOOL_DESCRIPTIONS, "text", "tooldesc"),
        },
        Corpus {
            name: "response-echo-outputs",
            rows: jsonl_field(RESPONSE_ECHO, "text", "resp_echo"),
        },
        Corpus {
            name: "coding-agent (self)",
            rows: coding_rows(),
        },
    ]
}

/// Detector id → ids of the rows it fired on.
fn firings(rows: &[(String, String)]) -> BTreeMap<&'static str, Vec<String>> {
    let mut out: BTreeMap<&'static str, Vec<String>> = BTreeMap::new();
    for (id, text) in rows {
        let mut fired: Vec<&'static str> = pii::detect_all(text).into_iter().map(|f| f.0).collect();
        fired.dedup();
        for det in fired {
            out.entry(det).or_default().push(id.clone());
        }
    }
    out
}

#[test]
fn the_coding_corpus_fires_nothing_but_email() {
    let rows = coding_rows();
    assert!(rows.len() >= 60, "the coding corpus lost its rows");
    let fired = firings(&rows);
    for (det, ids) in &fired {
        if *det == "pii.email" {
            assert_eq!(ids, EXPECTED_CODING_EMAIL_ROWS, "email firing set changed");
        } else {
            panic!("{det} fired on coding-agent traffic: {ids:?}");
        }
    }
    for (id, text) in &rows {
        let findings = dlp::scan(text);
        assert!(
            findings.is_empty(),
            "{id}: the default scanner found {:?}",
            findings.iter().map(|f| &f.pattern_name).collect::<Vec<_>>()
        );
    }
}

#[test]
fn the_pii_baseline_is_current_and_byte_stable() {
    let report = build_report();
    if std::env::var("INTUTIC_WRITE_BASELINE").is_ok() {
        std::fs::write(
            concat!(env!("CARGO_MANIFEST_DIR"), "/tests/corpus/pii/BASELINE.txt"),
            &report,
        )
        .expect("write baseline");
        return;
    }
    assert_eq!(
        report,
        include_str!("corpus/pii/BASELINE.txt"),
        "pii/BASELINE.txt is stale. Re-run with INTUTIC_WRITE_BASELINE=1 \
         and READ the diff — a changed firing set is a decision, not a chore.",
    );
}

fn build_report() -> String {
    let ids: Vec<&str> = pii::detectors().iter().map(|d| d.id.as_str()).collect();
    let corpora = corpora();
    let mut table = String::new();
    let mut listing = String::new();
    table.push_str(&format!("  {:<24} | {:>6}", "corpus", "rows"));
    for id in &ids {
        table.push_str(&format!(" | {id:>9}"));
    }
    table.push('\n');
    table.push_str(&format!("  {:-<24}-|-{:->6}", "", ""));
    for _ in &ids {
        table.push_str(&format!("-|-{:->9}", ""));
    }
    table.push('\n');
    for c in &corpora {
        let fired = firings(&c.rows);
        table.push_str(&format!("  {:<24} | {:>6}", c.name, c.rows.len()));
        for id in &ids {
            table.push_str(&format!(" | {:>9}", fired.get(id).map_or(0, Vec::len)));
        }
        table.push('\n');
        for (det, rows) in &fired {
            listing.push_str(&format!("  {} / {det}: {}\n", c.name, rows.join(", ")));
        }
    }
    if listing.is_empty() {
        listing.push_str("  (none)\n");
    }
    format!(
        "Intutic PII detectors — false-positive baseline\n\
         ===============================================\n\
         \n\
         Produced by:\n    \
         cd packages/proxy && INTUTIC_WRITE_BASELINE=1 cargo test --test pii_corpus_test\n\
         \n\
         Every detector runs on every row with all detectors enabled, whatever its\n\
         default (card, IBAN and SSN ship on; email and phone ship off). A cell is\n\
         the number of rows with at least one validated match.\n\
         \n\
         The first four corpora are external (see PROVENANCE.md). Their rows carry\n\
         no real PII, but BFCL's API tasks do pass made-up emails and phone numbers\n\
         as arguments, so a firing there can be a correct detection of a fake value;\n\
         every firing row is listed below so it can be read. The last corpus is\n\
         self-authored coding-agent traffic with no PII in it at all: a firing there\n\
         is a false positive. Its authors also wrote the detectors.\n\
         \n\
         {table}\n\
         Firing rows:\n\
         {listing}"
    )
}

/// Real coding-agent tool calls: the OpenHands extract, when present.
#[test]
fn openhands_coding_traffic_when_present() {
    let Ok(path) = std::env::var("INTUTIC_CODING_CORPUS") else {
        eprintln!(
            "SKIPPED: INTUTIC_CODING_CORPUS is not set, so nothing was measured. \
             Run tests/corpus/openhands/extract.py and point the variable at its output."
        );
        return;
    };
    let body = std::fs::read_to_string(&path).expect("INTUTIC_CODING_CORPUS is readable");
    let ids: Vec<&str> = pii::detectors().iter().map(|d| d.id.as_str()).collect();
    let (mut trajectories, mut calls, mut bytes) = (0usize, 0usize, 0usize);
    let mut calls_fired: BTreeMap<&str, usize> = BTreeMap::new();
    let mut traj_fired: BTreeMap<&str, usize> = BTreeMap::new();
    let mut samples: BTreeMap<&str, Vec<String>> = BTreeMap::new();
    for line in body.lines().filter(|l| !l.trim().is_empty()) {
        let v: serde_json::Value = serde_json::from_str(line).expect("corpus line is JSON");
        trajectories += 1;
        let mut in_traj: Vec<&str> = Vec::new();
        for call in v["calls"].as_array().into_iter().flatten() {
            calls += 1;
            // The request body a proxy would scan: arguments as JSON.
            let text = call["input"].to_string();
            bytes += text.len();
            let mut fired: Vec<(&str, usize, usize)> = pii::detect_all(&text);
            fired.dedup_by_key(|f| f.0);
            for (id, s, e) in fired {
                *calls_fired.entry(id).or_default() += 1;
                if !in_traj.contains(&id) {
                    in_traj.push(id);
                }
                let sample = samples.entry(id).or_default();
                if sample.len() < 15 {
                    let lo = s.saturating_sub(30);
                    let hi = (e + 30).min(text.len());
                    let (lo, hi) = (floor_boundary(&text, lo), floor_boundary(&text, hi));
                    sample.push(text[lo..hi].replace('\n', " "));
                }
            }
        }
        for id in in_traj {
            *traj_fired.entry(id).or_default() += 1;
        }
    }
    eprintln!("OpenHands extract: {trajectories} trajectories, {calls} tool calls, {bytes} bytes of arguments");
    for id in &ids {
        eprintln!(
            "  {id:<10} calls fired {:>5}  trajectories fired {:>4}",
            calls_fired.get(id).copied().unwrap_or(0),
            traj_fired.get(id).copied().unwrap_or(0)
        );
        for s in samples.get(id).into_iter().flatten() {
            eprintln!("      … {s}");
        }
    }
}

fn floor_boundary(s: &str, mut i: usize) -> usize {
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}
