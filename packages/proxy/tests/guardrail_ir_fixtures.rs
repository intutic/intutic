//! Every Guardrail IR front-matter fixture parses in the proxy to the fields
//! the IR meant (LLD #71).
//!
//! The `.md` files under `packages/shared-types/fixtures/guardrail-ir/` are
//! rendered by `packages/shared-types/scripts/generate-guardrail-fixtures.ts`
//! from IR values; the `.expected.json` beside each one is authored from the
//! IR's meaning — not from this parser and not from the TypeScript mirror of
//! it — so both parsers answer to the same expectation and neither can drift
//! without a red row here. The files are loaded through `loaded_sops()`, the
//! same path a proxy takes at startup, with `INTUTIC_SOPS_DIR` pointed at the
//! fixture directory; there is no private parser call to bypass.
//!
//! Also pinned: the informational `source:` and `cite:` lines a generated
//! guardrail carries are ignored (they reach no enforcing field and raise no
//! parse error), `mode: shadow` is read as shadow, and no fixture ever
//! produces an allowlist (`allow_harnesses`, `plan_steps`, `scope_paths`) —
//! the IR deliberately does not offer those keys.

use std::collections::BTreeSet;
use std::path::PathBuf;

use intutic_proxy::sops::{loaded_sops, SopMode};
use serde::Deserialize;

#[derive(Deserialize)]
struct Ordering {
    first: String,
    then: String,
    adjacent: bool,
}

#[derive(Deserialize)]
struct Bound {
    token: String,
    limit: usize,
}

#[derive(Deserialize)]
struct Taint {
    taint: String,
    token: String,
}

#[derive(Deserialize)]
struct Expected {
    deny_tools: Vec<String>,
    review_before: Vec<String>,
    requires_before: Vec<Ordering>,
    forbid_after: Vec<Ordering>,
    max_calls: Vec<Bound>,
    forbid_with: Vec<Taint>,
    roles: Vec<String>,
    mode: String,
}

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("shared-types")
        .join("fixtures")
        .join("guardrail-ir")
}

fn sorted(v: &[String]) -> Vec<String> {
    let mut out = v.to_vec();
    out.sort();
    out
}

fn read_expectations(dir: &PathBuf) -> Vec<(String, Expected)> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).expect("the guardrail-ir fixture directory exists") {
        let path = entry.expect("readable directory entry").path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if let Some(stem) = name.strip_suffix(".expected.json") {
            let raw = std::fs::read_to_string(&path).expect("readable expectation");
            let parsed: Expected =
                serde_json::from_str(&raw).unwrap_or_else(|e| panic!("{name}: malformed expectation — {e}"));
            out.push((stem.to_string(), parsed));
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

#[test]
fn every_guardrail_ir_fixture_parses_to_the_fields_the_ir_meant() {
    let dir = fixture_dir();
    let expectations = read_expectations(&dir);
    assert!(
        expectations.len() >= 5,
        "found only {} expectation file(s) in {} — regenerate the fixtures",
        expectations.len(),
        dir.display()
    );

    std::env::set_var("INTUTIC_SOPS_DIR", &dir);
    let sops = loaded_sops();
    assert_eq!(
        sops.len(),
        expectations.len(),
        "the proxy loaded {} SOP(s) from {} fixture file(s); a fixture the proxy refuses to load is a rule that would never fire",
        sops.len(),
        expectations.len()
    );

    for (stem, want) in expectations {
        let sop = sops
            .iter()
            .find(|s| s.title == stem)
            .unwrap_or_else(|| panic!("{stem}: not loaded (titles are file stems)"));

        assert_eq!(sorted(&sop.deny_tools), want.deny_tools, "{stem}: deny_tools");
        assert_eq!(sorted(&sop.review_before), want.review_before, "{stem}: review_before");
        assert_eq!(sorted(&sop.roles), want.roles, "{stem}: roles");

        let got: BTreeSet<(String, String, bool)> = sop.requires_before.iter().cloned().collect();
        let want_rb: BTreeSet<(String, String, bool)> = want
            .requires_before
            .iter()
            .map(|o| (o.first.clone(), o.then.clone(), o.adjacent))
            .collect();
        assert_eq!(got, want_rb, "{stem}: requires_before");

        let got: BTreeSet<(String, String, bool)> = sop.forbid_after.iter().cloned().collect();
        let want_fa: BTreeSet<(String, String, bool)> = want
            .forbid_after
            .iter()
            .map(|o| (o.first.clone(), o.then.clone(), o.adjacent))
            .collect();
        assert_eq!(got, want_fa, "{stem}: forbid_after");

        let got: BTreeSet<(String, usize)> = sop.max_calls.iter().cloned().collect();
        let want_mc: BTreeSet<(String, usize)> =
            want.max_calls.iter().map(|b| (b.token.clone(), b.limit)).collect();
        assert_eq!(got, want_mc, "{stem}: max_calls");

        let got: BTreeSet<(String, String)> = sop.forbid_with.iter().cloned().collect();
        let want_fw: BTreeSet<(String, String)> =
            want.forbid_with.iter().map(|t| (t.taint.clone(), t.token.clone())).collect();
        assert_eq!(got, want_fw, "{stem}: forbid_with");

        let shadow = matches!(sop.mode, SopMode::Shadow);
        assert_eq!(shadow, want.mode == "shadow", "{stem}: mode (want {})", want.mode);

        assert!(
            sop.allow_harnesses.is_empty() && sop.plan_steps.is_empty() && sop.scope_paths.is_empty(),
            "{stem}: a generated guardrail produced an allowlist, which the IR does not offer"
        );
    }
}

#[test]
fn informational_source_and_cite_lines_reach_no_enforcing_field() {
    let dir = fixture_dir();
    std::env::set_var("INTUTIC_SOPS_DIR", &dir);
    let sops = loaded_sops();
    let sop = sops
        .iter()
        .find(|s| s.title == "04-informational-keys")
        .expect("the informational-keys fixture is loaded");

    // The one enforcing line, and nothing else.
    assert_eq!(sop.deny_tools, vec!["kubectl".to_string()]);
    assert!(sop.review_before.is_empty());
    assert!(sop.requires_before.is_empty());
    assert!(sop.forbid_after.is_empty());
    assert!(sop.max_calls.is_empty());
    assert!(sop.forbid_with.is_empty());
    assert!(sop.roles.is_empty());
    assert!(matches!(sop.mode, SopMode::Shadow));

    // Nothing from the two annotation lines leaked into a field the detectors read.
    let raw = std::fs::read_to_string(dir.join("04-informational-keys.md")).expect("fixture file");
    assert!(raw.contains("\nsource: https://"), "the fixture no longer carries a source: line");
    assert!(raw.contains("\ncite: "), "the fixture no longer carries a cite: line");
    for field in [&sop.deny_tools, &sop.review_before, &sop.roles, &sop.plan_steps, &sop.scope_paths, &sop.allow_harnesses] {
        for v in field {
            assert!(
                !v.contains("https://") && !v.starts_with("source") && !v.starts_with("cite"),
                "an informational line leaked into an enforcing field as {v:?}"
            );
        }
    }
}
