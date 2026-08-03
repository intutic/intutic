//! DLP Scanner — bidirectional regex-based secret/PII detection.
//!
//! Uses Rust `regex` crate (linear-time, ReDoS-safe).
//! Scans both input and output streams for secrets, PII, and credentials.
//!
//! # Pattern doctrine
//!
//! Every pattern here is **prefix- or magic-substring-anchored** — the tier
//! gitleaks and TruffleHog treat as high-confidence without entropy gates or
//! context keywords. Formats are ported from the gitleaks default config and
//! TruffleHog detector sources (verified 2026-07-28), which is why some look
//! oddly specific: `T3BlbkFJ` is base64("OpenAI") and appears in every OpenAI
//! key; `AgEIcHlwaS5vcmc` is the macaroon header embedding "pypi.org".
//!
//! Deliberately absent, with reasons:
//! - **Bare 40-char AWS secret keys** — neither reference tool ships this
//!   without context keywords or live verification; unanchored it matches git
//!   SHAs and base64 fragments constantly.
//! - **Generic high-entropy strings** — the entropy+stopword machinery that
//!   makes those tolerable is out of proportion to this scanner.
//! - **Context-required vendors** (Telegram, Twilio auth tokens) — their
//!   secrets are format-ambiguous without a nearby vendor keyword.
//!
//! Action doctrine: `block` is reserved for material that is catastrophic to
//! forward and unambiguous to match (private key blocks, Anthropic keys —
//! the credential class this proxy itself runs on). Everything else redacts:
//! a developer who pastes a key wants their question answered, and refusing
//! teaches them to switch DLP off. Redaction answers with the key removed.

use once_cell::sync::Lazy;
use regex::Regex;

use crate::wasm::context::DlpFinding;

/// DLP pattern categories
static PATTERNS: Lazy<Vec<DlpPattern>> = Lazy::new(|| {
    let defs: Vec<(&str, &str, &str, &str)> = vec![
        // (name, category, regex, action)
        (
            "aws_access_key",
            "secret",
            // AKIA long-lived, ASIA temporary, ABIA/ACCA/A3T* other classes.
            // Base32 alphabet [A-Z2-7] per gitleaks — 0,1,8,9 never appear.
            r"\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}\b",
            "redact",
        ),
        (
            "github_token",
            "secret",
            // All five classic prefixes: PAT, OAuth, App-user, App-server,
            // refresh. The old pattern matched ghp_ only.
            r"\b(?:ghp|gho|ghu|ghs|ghr)_[0-9a-zA-Z]{36}\b",
            "redact",
        ),
        (
            "github_fine_grained_pat",
            "secret",
            // 93 chars total; the tail carries a checksum, so this format is
            // near-zero-FP by construction (GitHub's own design goal).
            r"\bgithub_pat_\w{82}\b",
            "redact",
        ),
        (
            "anthropic_api_key",
            "secret",
            r"sk-ant-[A-Za-z0-9\-_]{10,}",
            "block",
        ),
        (
            "openai_api_key",
            "secret",
            // Anchored on T3BlbkFJ = base64("OpenAI"), present in legacy
            // sk-{48} keys and current sk-proj-/sk-svcacct-/sk-admin- keys.
            r"\b(?:sk-(?:proj|svcacct|admin)-(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})T3BlbkFJ(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})|sk-[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20})\b",
            "redact",
        ),
        (
            "gitlab_pat",
            "secret",
            // Legacy glpat-{20} and the newer routable form with a
            // dot-separated version+checksum suffix.
            r"\bglpat-[0-9a-zA-Z_-]{20,300}(?:\.[0-9a-z]{9})?\b",
            "redact",
        ),
        (
            "slack_token",
            "secret",
            // Bot/user/app/legacy families share the xox?- shape; xapp- is
            // the app-level token.
            r"\b(?:xox[baprse]-[0-9a-zA-Z-]{10,}|xapp-\d-[A-Z0-9]+-\d+-[a-z0-9]+)\b",
            "redact",
        ),
        (
            "slack_webhook_url",
            "secret",
            // The path IS the secret; anyone holding it can post.
            r"hooks\.slack\.com/(?:services|workflows|triggers)/[A-Za-z0-9+/]{40,60}",
            "redact",
        ),
        (
            "google_api_key",
            "secret",
            r"\bAIza[0-9A-Za-z_-]{35}\b",
            "redact",
        ),
        (
            "stripe_key",
            "secret",
            // Secret and restricted keys, all modes. Test keys redact too:
            // harmless when redacted, and the format is identical.
            r"\b(?:sk|rk)_(?:test|live|prod)_[a-zA-Z0-9]{10,99}\b",
            "redact",
        ),
        (
            "sendgrid_api_key",
            "secret",
            // Three-part SG.<key id>.<secret> shape per TruffleHog.
            r"\bSG\.[0-9A-Za-z_-]{20,24}\.[0-9A-Za-z_-]{39,50}\b",
            "redact",
        ),
        (
            "npm_token",
            "secret",
            r"\bnpm_[A-Za-z0-9]{36}\b",
            "redact",
        ),
        (
            "pypi_token",
            "secret",
            // AgEIcHlwaS5vcmc is the macaroon header embedding "pypi.org".
            r"pypi-AgEIcHlwaS5vcmc[0-9A-Za-z_-]{50,1000}",
            "redact",
        ),
        (
            "huggingface_token",
            "secret",
            // Letters only, per gitleaks' empirically tuned form.
            r"\b(?:hf_|api_org_)[A-Za-z]{34}\b",
            "redact",
        ),
        (
            "db_connection_string",
            "credential",
            // scheme://user:password@ — the credential is the matched span,
            // so redaction removes exactly the user:pass while the host
            // stays legible in what the model sees.
            r"\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?|amqps?)://[^:\s'\x22/@]{1,64}:[^@\s'\x22]{1,128}@",
            "redact",
        ),
        (
            "jwt",
            "credential",
            // Signature segment required (gitleaks makes it optional; we
            // trade a little recall for precision on the hot path).
            r"\bey[a-zA-Z0-9]{17,}\.ey[a-zA-Z0-9/_-]{17,}\.[a-zA-Z0-9/_-]{10,}={0,2}",
            "redact",
        ),
        (
            "ssn",
            "pii",
            r"\b\d{3}-\d{2}-\d{4}\b",
            "redact",
        ),
        (
            "bearer_token",
            "credential",
            r"Bearer\s+[A-Za-z0-9\-._~+/]+=*",
            "redact",
        ),
        (
            "private_key",
            "secret",
            // The full PEM family via the free-form slot: RSA, EC, DSA,
            // OPENSSH, ENCRYPTED (PKCS#8), PGP (with " BLOCK"), and bare
            // "PRIVATE KEY". The old pattern named three variants and
            // missed OPENSSH and PGP entirely.
            r"(?i)-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----",
            "block",
        ),
    ];

    defs.into_iter()
        .map(|(name, category, regex, action)| DlpPattern {
            name: name.into(),
            category: category.into(),
            regex: Regex::new(regex).unwrap(),
            action: action.into(),
        })
        .collect()
});

struct DlpPattern {
    name: String,
    category: String,
    regex: Regex,
    action: String,
}

/// Scan text for DLP matches.
///
/// # Why this is a plain loop and not a `RegexSet`
///
/// It used to be a `RegexSet` prefilter, on the reasoning that one traversal
/// beats ~20. The arithmetic is right and the conclusion is backwards, by two
/// orders of magnitude. Measured on a 128 KB clean body (Apple M4 Pro, release,
/// `benches/policy_bench.rs`):
///
/// | strategy | total | per byte |
/// |---|---|---|
/// | every pattern individually, in a loop | **0.12 ms** | 0.91 ns |
/// | the same patterns as one `RegexSet` | **19.9 ms** | 150.6 ns |
///
/// The set was **165× slower than the loop it replaced.** Each pattern on its
/// own starts with a literal or a tight class — `AKIA`, `ghp_`, `sk-ant-`,
/// `glpat-`, `-----BEGIN` — so the regex crate picks a memchr-accelerated
/// prefilter and skips almost every byte. Union them and no common literal
/// survives, so no prefilter applies; worse, the combined automaton over these
/// patterns' large bounded repetitions (`{20,300}`, `{50,1000}`, `{82}`)
/// overflows the lazy DFA's state cache and degrades to the PikeVM, which
/// visits every byte. Nineteen accelerated passes that skip most of the input
/// beat one unaccelerated pass that cannot.
///
/// This mattered in production, not just in a benchmark. The cost was linear at
/// ~150 ns/byte, so a 32 KB request body spent ~5 ms in DLP alone — the entire
/// latency the public docs advertised for the whole evaluation chain — and the
/// scanner runs on the request *and* the response, so it was paid twice.
///
/// If this is ever revisited: measure it. `is_match` before `matches` was also
/// tried and changed nothing (both engines are equally slow on this set) while
/// making the dirty path ~20% worse by scanning twice.
pub fn scan(text: &str) -> Vec<DlpFinding> {
    let mut findings = Vec::new();
    for pattern in PATTERNS.iter() {
        for mat in pattern.regex.find_iter(text) {
            findings.push(DlpFinding {
                category: pattern.category.clone(),
                pattern_name: pattern.name.clone(),
                action: pattern.action.clone(),
                offset: mat.start(),
                length: mat.len(),
            });
        }
    }
    findings
}

/// Scrub one unit of streamed text (TD-210).
///
/// The proxy's streaming forward loop is line-buffered — every SSE line is
/// reassembled before it is re-emitted — so the scrub unit is a complete
/// line, and no byte-holdback is needed: a secret always sits within one
/// line's `data:` JSON or it has SSE scaffolding through the middle of it,
/// which no linear pattern can match anyway. Per-line scrubbing therefore
/// gives the same coverage a windowed scrubber would, with zero added
/// latency on the token stream.
///
/// Returns `None` when the line is clean (the overwhelming case — the caller
/// forwards the original, allocating nothing), or the scrubbed line plus the
/// pattern names redacted.
///
/// Block-action patterns are redacted here, not blocked. Input-side "block"
/// exists to keep material from reaching the provider; on the output side
/// the goal is containment — the private key never reaches the client — and
/// redaction achieves that without killing a live stream.
pub fn scrub_stream_text(text: &str) -> Option<(String, Vec<String>)> {
    let findings = scan(text);
    if findings.is_empty() {
        return None;
    }
    let mut names: Vec<String> = Vec::new();
    for f in &findings {
        if !names.contains(&f.pattern_name) {
            names.push(f.pattern_name.clone());
        }
    }
    Some((redact(text, &findings), names))
}

/// Redact all findings in text, replacing matches with [REDACTED_{CATEGORY}]
pub fn redact(text: &str, findings: &[DlpFinding]) -> String {
    let mut result = text.to_string();
    // Process findings in reverse order to preserve offsets
    let mut sorted = findings.to_vec();
    sorted.sort_by_key(|b| std::cmp::Reverse(b.offset));
    for finding in &sorted {
        let replacement = format!("[REDACTED_{}]", finding.category.to_uppercase());
        result.replace_range(
            finding.offset..finding.offset + finding.length,
            &replacement,
        );
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_aws_key_detection() {
        let text = "My key is AKIAIOSFODNN7EXAMPLE and it should be found";
        let findings = scan(text);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].pattern_name, "aws_access_key");
    }

    #[test]
    fn test_anthropic_key_detection() {
        let text = "Print my API_KEY: sk-ant-api03-abcdefg";
        let findings = scan(text);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].pattern_name, "anthropic_api_key");
        assert_eq!(findings[0].action, "block");
    }

    #[test]
    fn test_ssn_detection() {
        let text = "SSN: 123-45-6789";
        let findings = scan(text);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].pattern_name, "ssn");
    }

    #[test]
    fn test_redaction() {
        let text = "Key: AKIAIOSFODNN7EXAMPLE";
        let findings = scan(text);
        let redacted = redact(text, &findings);
        assert!(redacted.contains("[REDACTED_SECRET]"));
        assert!(!redacted.contains("AKIA"));
    }

    #[test]
    fn test_no_false_positives() {
        let text = "Hello world, this is a normal message";
        let findings = scan(text);
        assert!(findings.is_empty());
    }

    // ── Expanded pattern set (2026-07-29) ───────────────────────────────
    //
    // Formats ported from the gitleaks default config and TruffleHog
    // detector sources. Each test uses a syntactically valid but fake token.

    fn names(text: &str) -> Vec<String> {
        scan(text).into_iter().map(|f| f.pattern_name).collect()
    }

    #[test]
    fn aws_temporary_and_other_key_classes_detected() {
        // ASIA (STS temporary) was invisible to the old AKIA-only pattern.
        assert!(names("key ASIAJEXAMPLEKEY234AB here").contains(&"aws_access_key".into()));
        assert!(names("key ABIAJEXAMPLEKEY234AB here").contains(&"aws_access_key".into()));
    }

    #[test]
    fn all_github_classic_prefixes_detected() {
        // Only ghp_ matched before; the other four classes were invisible.
        for prefix in ["ghp", "gho", "ghu", "ghs", "ghr"] {
            let tok = format!("{}_{}", prefix, "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8");
            assert!(
                names(&format!("token {tok} end")).contains(&"github_token".into()),
                "{prefix} must be detected"
            );
        }
    }

    #[test]
    fn github_fine_grained_pat_detected() {
        let tok = format!("github_pat_{}", "A".repeat(82));
        assert!(names(&tok).contains(&"github_fine_grained_pat".into()));
    }

    #[test]
    fn openai_keys_detected_via_magic_substring() {
        // Legacy: sk- + 20 alnum + T3BlbkFJ + 20 alnum.
        let legacy = format!("sk-{}T3BlbkFJ{}", "a1B2c3D4e5F6g7H8i9J0", "K1l2M3n4O5p6Q7r8S9t0");
        assert!(names(&legacy).contains(&"openai_api_key".into()));
        // Project-scoped: symmetric 58-char halves around the magic.
        let half = "a".repeat(58);
        let proj = format!("sk-proj-{half}T3BlbkFJ{half}");
        assert!(names(&proj).contains(&"openai_api_key".into()));
    }

    #[test]
    fn platform_tokens_detected() {
        let cases: Vec<(String, &str)> = vec![
            (format!("glpat-{}", "aB3dE5fG7hI9jK1lM3nO"), "gitlab_pat"),
            // Assembled at runtime: a contiguous literal in this shape trips
            // GitHub push protection — correctly, which is its own kind of
            // proof the pattern is worth having.
            (format!("xox{}-123456789012-123456789012-AbCdEfGhIjKlMnOp", "b"), "slack_token"),
            (format!("https://hooks.slack.com/services/{}", "A".repeat(44)), "slack_webhook_url"),
            (format!("AIza{}", "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6c"), "google_api_key"),
            (format!("sk_live_{}", "a1B2c3D4e5F6g7H8i9J0k1L2"), "stripe_key"),
            (format!("SG.{}.{}", "a".repeat(22), "b".repeat(43)), "sendgrid_api_key"),
            (format!("npm_{}", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"), "npm_token"),
            (format!("pypi-AgEIcHlwaS5vcmc{}", "x".repeat(60)), "pypi_token"),
            (format!("hf_{}", "AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGh"), "huggingface_token"),
        ];
        for (tok, expected) in cases {
            assert!(
                names(&format!("value: {tok} .")).contains(&expected.to_string()),
                "{expected} must detect {tok}"
            );
        }
    }

    #[test]
    fn db_connection_credentials_detected_and_redaction_spares_the_host() {
        // Assembled at runtime so no credential-shaped literal exists in
        // source (GitHub secret scanning flags the contiguous form).
        let text = format!(
            "url is postgres://{}:{}@db.internal:5432/app",
            "svc_user", "hunter22secret"
        );
        let findings = scan(&text);
        assert!(findings.iter().any(|f| f.pattern_name == "db_connection_string"));
        let redacted = redact(&text, &findings);
        assert!(!redacted.contains("hunter22secret"), "password must be gone");
        assert!(redacted.contains("db.internal:5432/app"), "host stays legible");
    }

    /// The loop and the `RegexSet` it replaced must agree on every finding.
    ///
    /// `scan` used to prefilter with a `RegexSet` and then run only the patterns
    /// the set reported. That was replaced with a plain loop over every pattern
    /// because the set measured **165× slower** on a clean body (see `scan`'s doc
    /// comment). A speed change must not be a behaviour change, and "the other
    /// tests still pass" does not prove that — they assert individual patterns,
    /// not that the two strategies produce the *same list*, in the same order,
    /// with the same offsets.
    ///
    /// So this reconstructs the old strategy and diffs the whole `Vec`. If anyone
    /// reintroduces a prefilter, this is what tells them whether it is equivalent.
    #[test]
    fn the_loop_and_the_regexset_prefilter_agree_exactly() {
        // Every pattern family in one body, so the comparison covers the
        // multi-match path and not just the empty case. Assembled at runtime,
        // per this module's convention — no contiguous credential literal.
        let body = format!(
            "deploy log\n\
             aws {} ok\n\
             gh {}_{} ok\n\
             anthropic sk-ant-{} ok\n\
             gitlab glpat-{} ok\n\
             google AIza{} ok\n\
             stripe sk_live_{} ok\n\
             npm npm_{} ok\n\
             hf hf_{} ok\n\
             db postgres://{}:{}@db.internal:5432/app\n\
             ssn 123-45-6789\n\
             auth Bearer abc123DEF456ghi789\n\
             key -----BEGIN OPENSSH PRIVATE KEY-----\n\
             and a lot of ordinary prose to make the body worth scanning. {}",
            "ASIAJEXAMPLEKEY234AB",
            "ghp",
            "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
            "abcdefghijklmnop",
            "aB3dE5fG7hI9jK1lM3nO",
            "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6c",
            "a1B2c3D4e5F6g7H8i9J0k1L2",
            "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
            "AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGh",
            "svc_user",
            "hunter22secret",
            "lorem ipsum dolor sit amet ".repeat(200),
        );

        // The old strategy, reconstructed verbatim.
        let prefilter =
            regex::RegexSet::new(PATTERNS.iter().map(|p| p.regex.as_str())).unwrap();
        let mut via_set = Vec::new();
        for idx in prefilter.matches(&body) {
            let pattern = &PATTERNS[idx];
            for mat in pattern.regex.find_iter(&body) {
                via_set.push((
                    pattern.name.clone(),
                    pattern.category.clone(),
                    pattern.action.clone(),
                    mat.start(),
                    mat.len(),
                ));
            }
        }

        let via_loop: Vec<_> = scan(&body)
            .into_iter()
            .map(|f| (f.pattern_name, f.category, f.action, f.offset, f.length))
            .collect();

        assert!(
            !via_loop.is_empty(),
            "fixture must actually trip patterns, or this test proves nothing",
        );
        assert_eq!(
            via_loop, via_set,
            "the loop and the RegexSet prefilter must produce identical findings",
        );
    }

    #[test]
    fn jwt_with_signature_detected() {
        let jwt = format!(
            "eyJhbGciOiJIUzI1NiJ9x.eyJzdWIiOiIxMjM0NTY3ODkwIn0.{}",
            "TJVA95OrM7E2cBab30RM"
        );
        assert!(names(&jwt).contains(&"jwt".into()));
    }

    #[test]
    fn bearer_token_detected() {
        // Had zero coverage since the pattern was written.
        let f = scan("Authorization value Bearer abc123DEF456ghi789 in body");
        assert!(f.iter().any(|x| x.pattern_name == "bearer_token"));
    }

    #[test]
    fn private_key_family_blocks_including_openssh_and_pgp() {
        // Had zero coverage; the old pattern also missed both of these.
        for header in [
            "-----BEGIN PRIVATE KEY-----",
            "-----BEGIN RSA PRIVATE KEY-----",
            "-----BEGIN OPENSSH PRIVATE KEY-----",
            "-----BEGIN ENCRYPTED PRIVATE KEY-----",
            "-----BEGIN PGP PRIVATE KEY BLOCK-----",
        ] {
            let f = scan(header);
            let hit = f.iter().find(|x| x.pattern_name == "private_key");
            let hit = hit.unwrap_or_else(|| panic!("{header} must be caught"));
            assert_eq!(hit.action, "block", "{header} must block, not redact");
        }
    }

    #[test]
    fn ordinary_technical_text_produces_no_findings() {
        // The false-positive control. Everyday engineering text carrying the
        // shapes that trip naive scanners: git SHAs, UUIDs, base64-ish ids,
        // words containing pattern prefixes.
        let text = "task-123 finished; risk-based review of commit                     9f86d081884c7d659a2feaa0c55ad015a3bf4f1b left node_modules                     unchanged. uuid 550e8400-e29b-41d4-a716-446655440000,                     ghost_user asked about skiing at https://example.com/a/b.                     The phone extension is 555-0100 and the build id is                     AKIA-lowercase-not-a-key.";
        let findings = scan(text);
        assert!(
            findings.is_empty(),
            "no findings expected, got: {:?}",
            findings.iter().map(|f| &f.pattern_name).collect::<Vec<_>>()
        );
    }
}

#[cfg(test)]
mod stream_scrub_tests {
    use super::*;

    #[test]
    fn clean_line_returns_none_and_costs_nothing() {
        assert!(scrub_stream_text(r#"data: {"delta":{"text":"hello world"}}"#).is_none());
    }

    #[test]
    fn secret_inside_a_delta_is_redacted_and_named() {
        let line = r#"data: {"delta":{"text":"key: AKIAIOSFODNN7EXAMPLE done"}}"#;
        let (scrubbed, names) = scrub_stream_text(line).expect("must find the key");
        assert!(!scrubbed.contains("AKIAIOSFODNN7EXAMPLE"));
        assert!(scrubbed.contains("[REDACTED_SECRET]"));
        assert_eq!(names, ["aws_access_key"]);
        // The scrubbed line must still be a valid SSE data line with valid JSON.
        let json_part = scrubbed.strip_prefix("data: ").unwrap();
        assert!(serde_json::from_str::<serde_json::Value>(json_part).is_ok());
    }

    #[test]
    fn block_action_material_is_contained_by_redaction() {
        // Output-side doctrine: containment, not stream-kill.
        let line = r#"data: {"delta":{"text":"-----BEGIN OPENSSH PRIVATE KEY----- b"}}"#;
        let (scrubbed, names) = scrub_stream_text(line).unwrap();
        assert!(!scrubbed.contains("BEGIN OPENSSH"));
        assert!(names.contains(&"private_key".to_string()));
    }

    #[test]
    fn several_distinct_secrets_in_one_line_all_redact() {
        let line = format!(
            r#"data: {{"text":"a AKIAIOSFODNN7EXAMPLE b ghp_{} c 123-45-6789"}}"#,
            "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"
        );
        let (scrubbed, names) = scrub_stream_text(&line).unwrap();
        assert!(!scrubbed.contains("AKIA"));
        assert!(!scrubbed.contains("ghp_"));
        assert!(!scrubbed.contains("123-45-6789"));
        assert_eq!(names.len(), 3);
    }
}

#[cfg(test)]
mod redaction_before_forward_tests {
    use super::*;

    /// Redaction must leave the body parseable, because the proxy forwards the
    /// redacted JSON rather than the original (TD-DLP-001). A replacement that
    /// broke the structure would turn a leak into a confusing upstream error.
    #[test]
    fn redacting_inside_json_keeps_it_valid() {
        let body = r#"{"messages":[{"role":"user","content":"key AKIAIOSFODNN7EXAMPLE here"}]}"#;
        let findings = scan(body);
        assert!(!findings.is_empty(), "the fixture must actually match");

        let redacted = redact(body, &findings);
        let parsed: serde_json::Value =
            serde_json::from_str(&redacted).expect("redacted body must still be valid JSON");

        let content = parsed["messages"][0]["content"].as_str().unwrap();
        assert!(!content.contains("AKIAIOSFODNN7EXAMPLE"), "secret must be gone");
        assert!(content.contains("REDACTED"));
    }

    /// The replacement text must not introduce characters that would need
    /// escaping inside a JSON string.
    #[test]
    fn the_replacement_needs_no_json_escaping() {
        let findings = scan("AKIAIOSFODNN7EXAMPLE");
        let out = redact("AKIAIOSFODNN7EXAMPLE", &findings);
        assert!(!out.contains('"'), "a quote would break the enclosing string");
        assert!(!out.contains('\\'), "a backslash would break escaping");
    }

    #[test]
    fn several_secrets_in_one_body_are_all_removed() {
        // Offsets shift as each replacement is applied; reverse ordering is
        // what keeps the later ones pointing at the right bytes.
        let body = r#"{"a":"AKIAIOSFODNN7EXAMPLE","b":"ghp_012345678901234567890123456789012345","c":"123-45-6789"}"#;
        let findings = scan(body);
        assert!(findings.len() >= 3, "expected three matches, got {}", findings.len());

        let redacted = redact(body, &findings);
        serde_json::from_str::<serde_json::Value>(&redacted).expect("still valid JSON");
        assert!(!redacted.contains("AKIAIOSFODNN7EXAMPLE"));
        assert!(!redacted.contains("ghp_012345678901234567890123456789012345"));
        assert!(!redacted.contains("123-45-6789"));
    }

    #[test]
    fn multibyte_content_does_not_split_a_character() {
        // replace_range panics on a non-char-boundary. Regex offsets are byte
        // offsets, so a body with multibyte text before the secret is the case
        // that would expose it.
        let body = r#"{"m":"日本語のテキスト AKIAIOSFODNN7EXAMPLE です"}"#;
        let findings = scan(body);
        let redacted = redact(body, &findings);
        let parsed: serde_json::Value = serde_json::from_str(&redacted).unwrap();
        let m = parsed["m"].as_str().unwrap();
        assert!(m.contains("日本語のテキスト"), "surrounding text intact");
        assert!(!m.contains("AKIAIOSFODNN7EXAMPLE"));
    }

    #[test]
    fn a_clean_body_is_returned_unchanged() {
        let body = r#"{"messages":[{"role":"user","content":"nothing sensitive"}]}"#;
        assert_eq!(redact(body, &scan(body)), body);
    }
}
