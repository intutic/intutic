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

/// Operator-supplied patterns, installed once at boot from config.
///
/// Separate from `PATTERNS` rather than merged into it because `PATTERNS` is a
/// `Lazy` with no input: it cannot see the config, and making it able to would
/// mean either a global mutable or threading config through every call site of
/// `scan()`. A `OnceCell` set before the server binds gives the same read path
/// (no lock, no branch per pattern) with none of that.
///
/// Unset in tests, which is what keeps the built-in false-positive fixtures —
/// notably the phone number at the bottom of this file that must NOT match —
/// meaningful regardless of what an operator configures in production.
static CUSTOM: once_cell::sync::OnceCell<Vec<DlpPattern>> = once_cell::sync::OnceCell::new();

/// Compile and install operator patterns. Call once, from main, before serving.
///
/// Returns an error rather than panicking. The built-in set uses
/// `Regex::new(..).unwrap()`, which is fine for a literal list reviewed at
/// compile time and completely wrong for a value an operator types into a
/// ConfigMap: a typo there would abort the process at the first request that
/// happened to reach the scanner, with a panic naming no pattern.
pub fn install_custom_patterns(
    defs: &[crate::config::CustomDlpPattern],
) -> Result<usize, String> {
    let mut out = Vec::with_capacity(defs.len());
    for d in defs {
        if !matches!(d.action.as_str(), "block" | "redact") {
            return Err(format!(
                "dlp pattern '{}' declares action '{}'; only 'block' and 'redact' exist",
                d.name, d.action
            ));
        }
        if d.name.trim().is_empty() {
            return Err("a dlp pattern has an empty name".to_string());
        }
        if PATTERNS.iter().any(|p| p.name == d.name) {
            return Err(format!(
                "dlp pattern '{}' shadows a built-in of the same name; \
                 findings are counted by distinct pattern_name, so a duplicate \
                 would quietly weaken the escalation threshold",
                d.name
            ));
        }
        let regex = Regex::new(&d.regex)
            .map_err(|e| format!("dlp pattern '{}' is not a valid regex: {e}", d.name))?;
        out.push(DlpPattern {
            name: d.name.clone(),
            category: d.category.clone(),
            regex,
            action: d.action.clone(),
        });
    }
    let n = out.len();
    CUSTOM
        .set(out)
        .map_err(|_| "custom DLP patterns are already installed".to_string())?;
    Ok(n)
}

/// Built-ins first, then operator patterns.
fn all_patterns() -> impl Iterator<Item = &'static DlpPattern> {
    PATTERNS
        .iter()
        .chain(CUSTOM.get().map(Vec::as_slice).unwrap_or(&[]).iter())
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
    for pattern in all_patterns() {
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
/// # What this covers, and what it does not
///
/// This is the **wire-form** scrub: one reassembled SSE line, `data:` envelope
/// and JSON escaping included. It catches a secret that sits inside a single
/// line's `data:` JSON, which is the common case.
///
/// It does **not** catch a secret split across two deltas, and the argument
/// that it did was the bug. That argument ran: a secret either sits within one
/// line's `data:` JSON, or it has SSE scaffolding through the middle of it,
/// which no linear pattern can match anyway. The second clause is true and is
/// precisely the leak. This function sees
///
/// ```text
/// data: {"choices":[{"delta":{"content":"AKIAIOSFODNN7"}}]}
/// data: {"choices":[{"delta":{"content":"EXAMPLE"}}]}
/// ```
///
/// and matches nothing, because the scaffolding really is in the way. The
/// client concatenates the two `content` values and sees
/// `AKIAIOSFODNN7EXAMPLE`. The scrubber reads the wire form; the client reads
/// the decoded form; a pattern invisible in the first is plain in the second.
/// "No linear pattern can match it" described the scanner's blindness, not the
/// stream's safety, and it was written as if it were a safety property — which
/// is why the hole survived review.
///
/// Decoded-form continuity is `StreamScrubber`'s job (below). The two run
/// together: this one first, on the raw line, then the holdback on the decoded
/// delta text. Keeping both is deliberate — this one also covers text the
/// holdback never sees (tool-call arguments, non-text event payloads, any
/// provider shape whose delta field the holdback does not know), and it costs
/// nothing on a clean line.
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
///
/// # Overlapping findings
///
/// Patterns overlap on real input, and the obvious case is on the hot path:
/// `Authorization: Bearer eyJ…` matches `bearer_token` over the whole span and
/// `jwt` over the token inside it. Reverse-offset replacement alone **panicked**
/// on that — the inner span was replaced first, the string shrank, and the
/// outer span's end index then pointed past the end of it. In the streaming
/// forward loop that panic kills the response mid-flight.
///
/// So overlaps are resolved before anything is replaced: earliest start wins,
/// and at equal starts the longest span wins. The survivor is the outermost
/// match, which covers at least the bytes the discarded one did — no secret is
/// exposed by dropping the inner finding, and the caller's finding list is
/// still reported in full elsewhere (`scrub_stream_text` names every pattern
/// it saw, not just the ones whose span survived).
pub fn redact(text: &str, findings: &[DlpFinding]) -> String {
    let mut sorted = findings.to_vec();
    sorted.sort_by(|a, b| a.offset.cmp(&b.offset).then(b.length.cmp(&a.length)));

    let mut disjoint: Vec<&DlpFinding> = Vec::with_capacity(sorted.len());
    let mut covered_to = 0usize;
    for f in &sorted {
        if f.offset >= covered_to {
            covered_to = f.offset + f.length;
            disjoint.push(f);
        }
    }

    let mut result = text.to_string();
    // Back to front, so each replacement leaves the earlier offsets valid.
    for finding in disjoint.iter().rev() {
        let replacement = format!("[REDACTED_{}]", finding.category.to_uppercase());
        result.replace_range(
            finding.offset..finding.offset + finding.length,
            &replacement,
        );
    }
    result
}

// ── Streaming holdback ────────────────────────────────────────────────────
//
// Everything below exists because the scrubber above reads the wire form and
// the client reads the decoded form. See `scrub_stream_text`'s doc comment for
// the leak; this is the fix.

/// Upper bound, in **bytes**, on the text one pattern can match.
///
/// `None` means "no bound": the pattern contains a `*`, `+` or `{n,}`
/// repetition, or syntax this walker does not model. Both cases are treated
/// identically by the caller and both are reported at boot, because a pattern
/// that contributes no bound is a pattern the fixed window does not
/// *guarantee* (it is still usually caught — see `StreamScrubber`'s straddle
/// clamp — just not by the window alone).
///
/// # Why a hand-written walker
///
/// `regex-syntax` computes this exactly (`Properties::maximum_len`) and is
/// already in the lock file as a transitive dependency of `regex` — but only
/// as a transitive one, and promoting it to a direct dependency is a
/// `Cargo.toml`/`Cargo.lock` edit. This walker is ~120 lines, is pinned by a
/// per-pattern test table below (every built-in's bound is asserted, so a
/// walker bug fails the suite rather than silently shrinking the window), and
/// fails **open-to-unbounded** on anything it does not recognise, which is the
/// safe direction: unrecognised ⇒ no bound ⇒ reported, never a small number
/// that would silently shrink the holdback.
///
/// # Bytes, not characters
///
/// The holdback is a byte window over a `String`, so this counts bytes.
/// `\d`, `\w`, `\s` and negated classes are Unicode-aware in the `regex`
/// crate and can match a 4-byte character, so they count 4. Positive
/// all-ASCII classes and ASCII literals count 1. That over-counts (the
/// built-in set is entirely ASCII in practice) in the direction of a larger,
/// safer window.
fn max_match_len(src: &str) -> Option<usize> {
    let mut w = LenWalker {
        b: src.as_bytes(),
        i: 0,
    };
    let n = w.alternation()?;
    // A trailing unconsumed byte means the walker lost its place; refuse to
    // report a bound it cannot stand behind.
    if w.i == w.b.len() {
        Some(n)
    } else {
        None
    }
}

/// Bytes a single Unicode-aware atom can occupy. UTF-8's maximum encoding.
const UNICODE_ATOM_BYTES: usize = 4;

struct LenWalker<'a> {
    b: &'a [u8],
    i: usize,
}

impl LenWalker<'_> {
    fn peek(&self) -> Option<u8> {
        self.b.get(self.i).copied()
    }

    fn next_byte(&mut self) -> Option<u8> {
        let c = self.peek()?;
        self.i += 1;
        Some(c)
    }

    /// `a|b|c` — the longest alternative. One unbounded alternative makes the
    /// whole alternation unbounded, which `?` propagation gives us for free.
    fn alternation(&mut self) -> Option<usize> {
        let mut best = self.concat()?;
        while self.peek() == Some(b'|') {
            self.i += 1;
            best = best.max(self.concat()?);
        }
        Some(best)
    }

    fn concat(&mut self) -> Option<usize> {
        let mut total = 0usize;
        loop {
            match self.peek() {
                None | Some(b'|') | Some(b')') => break,
                _ => {}
            }
            let atom = self.atom();
            let piece = self.quantified(atom)?;
            total = total.checked_add(piece)?;
        }
        Some(total)
    }

    /// One atom, without its quantifier.
    fn atom(&mut self) -> Option<usize> {
        match self.next_byte()? {
            b'(' => {
                if self.peek() == Some(b'?') {
                    self.i += 1;
                    // `(?i)` flag-setter, `(?i:` or `(?:` group. Anything else
                    // after `?` — lookaround, named capture — is unmodelled.
                    loop {
                        match self.next_byte()? {
                            b':' => break,
                            b')' => return Some(0), // flag-setter: zero width
                            c if c.is_ascii_alphabetic() || c == b'-' => {}
                            _ => return None,
                        }
                    }
                }
                let n = self.alternation()?;
                if self.next_byte()? != b')' {
                    return None;
                }
                Some(n)
            }
            b'[' => self.char_class(),
            b'\\' => match self.next_byte()? {
                // Zero-width assertions.
                b'b' | b'B' | b'A' | b'z' | b'Z' => Some(0),
                // Unicode-aware shorthands.
                b'd' | b'D' | b'w' | b'W' | b's' | b'S' => Some(UNICODE_ATOM_BYTES),
                // Unicode property / code-point escapes: unmodelled.
                b'p' | b'P' | b'u' | b'U' => None,
                // `\xHH` and `\x{...}` name one code point, up to 4 bytes.
                b'x' => {
                    if self.peek() == Some(b'{') {
                        while self.next_byte()? != b'}' {}
                    } else {
                        self.i += 2;
                        if self.i > self.b.len() {
                            return None;
                        }
                    }
                    Some(UNICODE_ATOM_BYTES)
                }
                // An escaped ASCII literal: one byte.
                _ => Some(1),
            },
            b'^' | b'$' => Some(0),
            b'.' => Some(UNICODE_ATOM_BYTES),
            // A raw byte. Multi-byte UTF-8 literals in the source arrive here
            // one byte at a time and sum to their true width.
            _ => Some(1),
        }
    }

    /// Consume `[...]`, returning the bytes one member can occupy.
    ///
    /// A negated class can match any code point outside the set, so it costs
    /// the Unicode maximum. A positive all-ASCII class costs one byte.
    fn char_class(&mut self) -> Option<usize> {
        let mut negated = false;
        let mut ascii_only = true;
        if self.peek() == Some(b'^') {
            negated = true;
            self.i += 1;
        }
        // A `]` in first position is a literal, not the terminator.
        if self.peek() == Some(b']') {
            self.i += 1;
        }
        loop {
            match self.next_byte()? {
                b']' => break,
                b'\\' => {
                    // `\w`/`\d`/`\s` inside a class widen it past ASCII.
                    match self.next_byte()? {
                        b'd' | b'D' | b'w' | b'W' | b's' | b'S' | b'p' | b'P' => {
                            ascii_only = false
                        }
                        _ => {}
                    }
                }
                // A nested class (`[[:alpha:]]`, `[a[b]]`) is unmodelled.
                b'[' => return None,
                c if !c.is_ascii() => ascii_only = false,
                _ => {}
            }
        }
        if negated || !ascii_only {
            Some(UNICODE_ATOM_BYTES)
        } else {
            Some(1)
        }
    }

    /// Apply the quantifier that follows an atom, if any.
    fn quantified(&mut self, atom: Option<usize>) -> Option<usize> {
        let reps: Option<usize> = match self.peek() {
            Some(b'*') | Some(b'+') => {
                self.i += 1;
                None
            }
            Some(b'?') => {
                self.i += 1;
                Some(1)
            }
            Some(b'{') => self.repetition_max(),
            _ => Some(1),
        };
        // Lazy (`??`, `*?`, `{1,2}?`) and possessive (`*+`) suffixes change
        // which match is preferred, never how long it can be.
        if matches!(self.peek(), Some(b'?') | Some(b'+')) && self.i > 0 {
            let prev = self.b[self.i - 1];
            if matches!(prev, b'*' | b'+' | b'?' | b'}') {
                self.i += 1;
            }
        }
        match (atom, reps) {
            (Some(a), Some(r)) => a.checked_mul(r),
            _ => None,
        }
    }

    /// `{n}`, `{n,}`, `{n,m}` — the maximum. `None` for `{n,}`.
    ///
    /// Restores the cursor and reports "no quantifier" if this `{` is a
    /// literal brace rather than a repetition.
    fn repetition_max(&mut self) -> Option<usize> {
        let start = self.i;
        self.i += 1; // '{'
        let mut lo = String::new();
        while self.peek().is_some_and(|c| c.is_ascii_digit()) {
            lo.push(self.b[self.i] as char);
            self.i += 1;
        }
        if lo.is_empty() {
            self.i = start;
            return Some(1); // literal '{'
        }
        match self.next_byte() {
            Some(b'}') => lo.parse::<usize>().ok(),
            Some(b',') => {
                let mut hi = String::new();
                while self.peek().is_some_and(|c| c.is_ascii_digit()) {
                    hi.push(self.b[self.i] as char);
                    self.i += 1;
                }
                if self.next_byte() != Some(b'}') {
                    self.i = start;
                    return Some(1);
                }
                if hi.is_empty() {
                    None // {n,} — unbounded
                } else {
                    hi.parse::<usize>().ok()
                }
            }
            _ => {
                self.i = start;
                Some(1)
            }
        }
    }
}

/// The holdback the current pattern set requires, and why.
#[derive(Debug, Clone)]
pub struct HoldbackDerivation {
    /// Bytes of decoded text the forward loop must lag by.
    pub bytes: usize,
    /// The pattern that sets `bytes`. Named so an operator who adds a pattern
    /// with a wide repetition can see what just cost them latency.
    pub set_by: String,
    /// Patterns with no computable maximum length — `*`, `+`, `{n,}`, or
    /// syntax the walker does not model.
    pub unbounded: Vec<String>,
}

/// Derive the holdback from the pattern set actually installed.
///
/// # The derivation
///
/// The scrubber releases every byte except the last `H`, and re-scans the
/// whole held buffer each time. A match that begins at stream offset `p` is
/// therefore still unreleased until the stream has grown past `p + H`. If the
/// match is no longer than `H` it is entirely inside the buffer at the moment
/// the decision to release `p` is taken, so it is found. Hence
///
/// > **H = max over patterns of the longest text that pattern can match.**
///
/// Not `max - 1`: a match of exactly `H` bytes starting at `p` is complete
/// once the buffer holds `p + H` bytes, which is the same instant `p` becomes
/// releasable, and the straddle clamp then holds it.
///
/// Patterns with no maximum cannot raise `H` — nothing finite would cover
/// them. They are listed in `unbounded` so this is visible rather than
/// assumed, and they fall into two groups that behave differently:
///
/// - **Open-ended tail** — `anthropic_api_key` (`sk-ant-…{10,}`),
///   `bearer_token` (`Bearer\s+[…]+`), `slack_token`'s `xox?-` form. The
///   unbounded repetition is the last thing in the pattern, so a *prefix* of
///   the secret already matches. The match is detected at its minimum length,
///   while its first byte is still held, and the straddle clamp then refuses
///   to release that byte for as long as the match keeps growing. Verified:
///   a 3013-byte `sk-ant-` key, streamed 8 bytes at a time through a
///   1020-byte window, is redacted in full.
/// - **Unbounded middle** — `jwt` (`…{17,}\.…{17,}\.…{10,}`) and
///   `slack_token`'s `xapp-` form. Required content sits *after* the
///   unbounded part, so nothing matches until that content arrives, and the
///   head can be released before the pattern is detectable at all. Verified:
///   a JWT under `H` is caught; one totalling 1558 bytes is **not**. This is
///   the one class of secret the holdback does not close, and no finite
///   window would — closing it needs a partial-match automaton
///   (`regex-automata` DFA state stepping) rather than a bigger buffer.
///
/// # What it comes out to
///
/// 1020 bytes for the built-in set, set by `pypi_token`
/// (`pypi-AgEIcHlwaS5vcmc` + `[0-9A-Za-z_-]{50,1000}`). One pattern's
/// `{50,1000}` sets the window for the whole scanner; the runner-up is
/// `db_connection_string` at 784. This is worth knowing before adding a
/// pattern with a wide bounded repetition: it is paid as latency by every
/// streamed response in the deployment.
///
/// Read once, lazily. First read is the first streamed response, which is
/// strictly after `install_custom_patterns` runs at boot, so operator
/// patterns are included.
pub fn derive_holdback() -> &'static HoldbackDerivation {
    static DERIVED: Lazy<HoldbackDerivation> = Lazy::new(|| {
        let mut bytes = 0usize;
        let mut set_by = String::from("none");
        let mut unbounded = Vec::new();
        for p in all_patterns() {
            match max_match_len(p.regex.as_str()) {
                Some(n) => {
                    if n > bytes {
                        bytes = n;
                        set_by = p.name.clone();
                    }
                }
                None => unbounded.push(p.name.clone()),
            }
        }
        HoldbackDerivation {
            bytes,
            set_by,
            unbounded,
        }
    });
    &DERIVED
}

/// The effective holdback for this configuration, logged once.
///
/// `None` in config means "the derived bound" — the only value that carries a
/// guarantee. An explicit value, including `0`, is an operator override and is
/// logged as such: `0` restores the pre-holdback behaviour exactly, leak
/// included.
pub fn resolve_holdback(cfg: &crate::config::DlpConfig) -> usize {
    static ANNOUNCE: std::sync::Once = std::sync::Once::new();
    let derived = derive_holdback();
    let effective = cfg.stream_holdback_bytes.unwrap_or(derived.bytes);
    ANNOUNCE.call_once(|| {
        if effective == 0 {
            tracing::warn!(
                derived_bytes = derived.bytes,
                "Output DLP streaming holdback is OFF (dlp.stream_holdback_bytes = 0). \
                 Per-line scrubbing still runs, but a secret split across two SSE \
                 deltas will reach the client unredacted."
            );
        } else {
            tracing::info!(
                holdback_bytes = effective,
                derived_bytes = derived.bytes,
                set_by = %derived.set_by,
                explicit = cfg.stream_holdback_bytes.is_some(),
                unbounded_patterns = ?derived.unbounded,
                "Output DLP streaming holdback active: streamed text is forwarded \
                 this many bytes behind the model. Time-to-first-token grows by the \
                 time the model needs to produce that many bytes; total response \
                 time is unchanged."
            );
            if effective < derived.bytes {
                tracing::warn!(
                    holdback_bytes = effective,
                    derived_bytes = derived.bytes,
                    set_by = %derived.set_by,
                    "Configured holdback is below the derived bound; a secret longer \
                     than the configured window can still be split across deltas \
                     undetected."
                );
            }
        }
    });
    effective
}

/// Decoded-text continuity across SSE deltas.
///
/// The proxy feeds every delta's **decoded** text through `push`, forwards
/// what comes back, and calls `flush` at end of stream. What comes back lags
/// the input by up to `holdback` bytes, which is exactly what buys the ability
/// to see a pattern whole: bytes already handed to the client cannot be taken
/// back, so forwarding has to trail far enough behind to have seen any match
/// in full before its first byte goes out.
///
/// # The latency this costs, precisely
///
/// - **Delayed:** every byte of streamed text, by `holdback` bytes of
///   generation. At the derived 1020 bytes and a typical 250–400 B/s of output
///   (60–100 tok/s at ~4 bytes/token) that is **2.5–4 s** before the first
///   text reaches the client. Faster models pay proportionally less; a
///   500 tok/s model pays ~0.5 s.
/// - **Not delayed:** the *last* byte, and therefore total response time.
///   `flush` runs in the same task before the terminal event, so the tail
///   arrives with the terminal event it would have arrived with anyway. This
///   moves when text appears, not when the response finishes.
/// - **Not delayed:** anything that is not streamed text — tool-call
///   arguments, usage events, the governance block, the judge's synthesis.
/// - **Not paid at all** when `dlp.scan_output` is off, or when
///   `dlp.stream_holdback_bytes` is `0`.
///
/// CPU cost is one `scan` over the held buffer per delta, plus a JSON parse
/// and re-serialise of the delta line (the released text has to be written
/// back into it). Measured end to end through `holdback_rewrite_line` — Apple
/// M4 Pro, release, 20 000 × 26-byte OpenAI chunks at the derived 1020-byte
/// holdback: **2.23 µs per delta**, against 0.39 µs for the per-line scrub
/// alone. About +1.8 µs per delta, or **+0.9 ms** across a 500-delta response.
/// The byte lag below, not the CPU, is the cost worth arguing about.
///
/// # Memory
///
/// `pending` is bounded by `holdback` plus the length of the longest match
/// currently in progress, and a match cannot outlive the response. The
/// streaming task already holds the entire response in `accumulated_content`,
/// so in the worst case this buffers a bounded slice of something already
/// resident — it does not introduce a new unbounded buffer.
pub struct StreamScrubber {
    holdback: usize,
    pending: String,
    redactions: Vec<String>,
}

impl StreamScrubber {
    pub fn new(holdback: usize) -> Self {
        Self {
            holdback,
            pending: String::new(),
            redactions: Vec::new(),
        }
    }

    /// Distinct pattern names this scrubber has redacted.
    pub fn redactions(&self) -> &[String] {
        &self.redactions
    }

    /// Feed one delta's decoded text; returns the text safe to forward now.
    ///
    /// With `holdback == 0` this is the identity function, byte for byte —
    /// which is what makes `stream_holdback_bytes: 0` an exact restoration of
    /// the pre-holdback behaviour rather than an approximation of it.
    pub fn push(&mut self, text: &str) -> String {
        if self.holdback == 0 {
            return text.to_string();
        }
        self.pending.push_str(text);
        self.release()
    }

    /// Everything still held, scrubbed. Idempotent: a second call returns
    /// `None`, so the several terminal paths that must flush can each call it
    /// without coordinating.
    pub fn flush(&mut self) -> Option<String> {
        if self.pending.is_empty() {
            return None;
        }
        let findings = scan(&self.pending);
        self.note(&findings);
        let held = std::mem::take(&mut self.pending);
        Some(if findings.is_empty() {
            held
        } else {
            redact(&held, &findings)
        })
    }

    fn note(&mut self, findings: &[DlpFinding]) {
        for f in findings {
            if !self.redactions.contains(&f.pattern_name) {
                self.redactions.push(f.pattern_name.clone());
            }
        }
    }

    fn release(&mut self) -> String {
        if self.pending.len() <= self.holdback {
            return String::new();
        }
        let findings = scan(&self.pending);
        let mut cut = self.pending.len() - self.holdback;

        // The straddle clamp. A finding that starts before the cut and ends
        // after it must not have its head released — the tail is still
        // arriving, and once the head is out it cannot be redacted. Pull the
        // cut back to the finding's start and re-check, because findings
        // overlap (a `bearer_token` and the `jwt` inside it) and moving the
        // cut can expose a different straddle. Terminates: `cut` strictly
        // decreases and is bounded below by 0.
        //
        // This is also what covers patterns with no maximum length. Their
        // match keeps growing, the clamp keeps holding its start, and the
        // whole thing is released — redacted — only once it stops growing.
        loop {
            let mut next = cut;
            for f in &findings {
                if f.offset < next && f.offset + f.length > next {
                    next = f.offset;
                }
            }
            if next == cut {
                break;
            }
            cut = next;
        }

        // `len - holdback` can land inside a multi-byte character. Findings
        // always start and end on character boundaries, so walking the cut
        // *down* to a boundary cannot move it past the end of a finding that
        // was clear of it a moment ago.
        while cut > 0 && !self.pending.is_char_boundary(cut) {
            cut -= 1;
        }
        if cut == 0 {
            return String::new();
        }

        let head_findings: Vec<DlpFinding> = findings
            .into_iter()
            .filter(|f| f.offset + f.length <= cut)
            .collect();
        self.note(&head_findings);
        let head: String = self.pending.drain(..cut).collect();
        if head_findings.is_empty() {
            head
        } else {
            redact(&head, &head_findings)
        }
    }
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

    // ── operator-supplied patterns ─────────────────────────────────────────
    //
    // `install_custom_patterns` writes a process-global `OnceCell`, so exactly
    // one test may install. The pattern used here is deliberately absurd
    // (`ZZTESTPHIZZ-1234`) so that installing it cannot change the verdict of
    // any other test in this file — several of which assert that ordinary text
    // produces NO findings, and would start failing if a realistic custom
    // pattern leaked into their fixtures.

    fn def(name: &str, category: &str, regex: &str, action: &str) -> crate::config::CustomDlpPattern {
        crate::config::CustomDlpPattern {
            name: name.into(),
            category: category.into(),
            regex: regex.into(),
            action: action.into(),
        }
    }

    #[test]
    fn custom_patterns_are_scanned_alongside_the_builtins() {
        let installed = install_custom_patterns(&[def(
            "zz_test_phi",
            "phi",
            r"ZZTESTPHIZZ-\d{4}",
            "redact",
        )]);
        // Another test in this binary may have installed first; either outcome
        // is fine, what matters is that the pattern is active afterwards.
        assert!(installed.is_ok() || installed.is_err());

        if CUSTOM.get().is_some() {
            let findings = scan("record ZZTESTPHIZZ-4471 attached");
            assert!(
                findings.iter().any(|f| f.pattern_name == "zz_test_phi" && f.category == "phi"),
                "custom pattern did not fire: {findings:?}"
            );
            // And the built-ins still work with a custom set installed.
            assert!(!scan("AKIAIOSFODNN7EXAMPLE").is_empty());
        }
    }

    #[test]
    fn custom_pattern_with_a_bad_regex_is_rejected_by_name() {
        let err = install_custom_patterns(&[def("broken", "phi", "([unclosed", "redact")])
            .expect_err("a malformed regex must not be accepted");
        assert!(err.contains("broken"), "the error must name the pattern: {err}");
    }

    #[test]
    fn custom_pattern_with_an_unknown_action_is_rejected() {
        // There is no warn tier. Accepting one would silently downgrade to
        // redact and the operator would believe they had configured a warning.
        let err = install_custom_patterns(&[def("warny", "phi", "abc", "warn")])
            .expect_err("only block and redact exist");
        assert!(err.contains("warn"), "{err}");
    }

    #[test]
    fn custom_pattern_may_not_shadow_a_builtin_name() {
        // DlpEscalationDetector counts DISTINCT pattern_name values, so a
        // duplicate name would quietly make two findings count as one.
        let err = install_custom_patterns(&[def("ssn", "phi", "abc", "redact")])
            .expect_err("shadowing a built-in must be refused");
        assert!(err.contains("ssn"), "{err}");
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

    /// `Bearer eyJ…` matches `bearer_token` across the whole span and `jwt`
    /// across the token inside it. Reverse-offset replacement panicked on that
    /// — inside the streaming task, which means the client's response died
    /// mid-sentence. The trigger is a model echoing an Authorization header,
    /// which is neither rare nor adversarial.
    #[test]
    fn a_token_nested_inside_another_finding_does_not_panic() {
        let line = format!(
            r#"data: {{"delta":{{"text":"Authorization: Bearer {}.{}.{}"}}}}"#,
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
            "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvZSJ9",
            "S1gnATur3S1gnATur3"
        );
        let (scrubbed, names) = scrub_stream_text(&line).expect("must find the token");
        assert!(!scrubbed.contains("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"));
        assert!(!scrubbed.contains("S1gnATur3"));
        // Both patterns are still reported even though only the outer span is
        // the one that got replaced.
        assert!(names.contains(&"bearer_token".to_string()));
        assert!(names.contains(&"jwt".to_string()));
        let json_part = scrubbed.strip_prefix("data: ").unwrap();
        assert!(serde_json::from_str::<serde_json::Value>(json_part).is_ok());
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


#[cfg(test)]
mod holdback_tests {
    use super::*;

    /// A 20-byte AWS key, and the two halves a model would stream it as.
    const AWS_KEY: &str = "AKIAIOSFODNN7EXAMPLE";
    const AWS_HEAD: &str = "AKIAIOSFODNN7";
    const AWS_TAIL: &str = "EXAMPLE";

    /// Drive a scrubber the way the forward loop does and return everything
    /// the client would have received.
    fn stream(holdback: usize, deltas: &[&str]) -> (String, StreamScrubber) {
        let mut sc = StreamScrubber::new(holdback);
        let mut out = String::new();
        for d in deltas {
            out.push_str(&sc.push(d));
        }
        if let Some(tail) = sc.flush() {
            out.push_str(&tail);
        }
        (out, sc)
    }

    // ── the defect ────────────────────────────────────────────────────────

    /// The leak this whole mechanism exists to close, pinned as a test.
    ///
    /// A zero holdback is byte-for-byte the behaviour that shipped: per-line
    /// scrubbing only. The unsplit key is caught by `scrub_stream_text`; the
    /// split key is not caught by anything, and the client reassembles it.
    /// If this test ever starts failing because the split key IS redacted at
    /// holdback 0, the claim in `DlpConfig::stream_holdback_bytes` that `0`
    /// restores the old behaviour exactly has stopped being true.
    #[test]
    fn holdback_zero_is_the_leak_it_documents() {
        let wire_head = format!(r#"data: {{"delta":{{"text":"{AWS_HEAD}"}}}}"#);
        let wire_tail = format!(r#"data: {{"delta":{{"text":"{AWS_TAIL}"}}}}"#);
        // The wire form of each half: the per-line scrub sees nothing.
        assert!(scrub_stream_text(&wire_head).is_none());
        assert!(scrub_stream_text(&wire_tail).is_none());
        // Unsplit, on one line, it is caught — which is what made the hole
        // look closed.
        let whole = format!(r#"data: {{"delta":{{"text":"{AWS_KEY}"}}}}"#);
        assert!(scrub_stream_text(&whole).is_some());

        let (client_sees, _) = stream(0, &[AWS_HEAD, AWS_TAIL]);
        assert_eq!(
            client_sees, AWS_KEY,
            "a zero holdback must be a byte-exact passthrough, leak included"
        );
    }

    #[test]
    fn split_pattern_is_redacted_and_the_unsplit_control_still_is() {
        let h = derive_holdback().bytes;

        let (split, sc_split) = stream(h, &[AWS_HEAD, AWS_TAIL]);
        assert!(
            !split.contains(AWS_KEY),
            "split key reached the client verbatim: {split}"
        );
        assert!(split.contains("[REDACTED_SECRET]"), "got: {split}");
        assert_eq!(sc_split.redactions(), ["aws_access_key"]);

        let (unsplit, _) = stream(h, &[AWS_KEY]);
        assert!(!unsplit.contains(AWS_KEY));
        assert!(unsplit.contains("[REDACTED_SECRET]"));
    }

    /// Split into as many deltas as it has characters — the shape a
    /// character-by-character stream actually takes.
    #[test]
    fn a_key_split_one_character_per_delta_is_still_caught() {
        let deltas: Vec<String> = AWS_KEY.chars().map(|c| c.to_string()).collect();
        let refs: Vec<&str> = deltas.iter().map(String::as_str).collect();
        let (out, _) = stream(derive_holdback().bytes, &refs);
        assert!(!out.contains(AWS_KEY), "got: {out}");
        assert!(out.contains("[REDACTED_SECRET]"));
    }

    // ── no truncation, no duplication ─────────────────────────────────────

    /// The failure mode that would be worse than the leak.
    #[test]
    fn every_byte_of_a_clean_response_arrives_exactly_once() {
        let deltas = ["The quick ", "brown fox ", "jumps over ", "the lazy dog."];
        let (out, _) = stream(derive_holdback().bytes, &deltas);
        assert_eq!(out, deltas.concat());
    }

    #[test]
    fn released_text_and_the_flush_partition_the_response() {
        // Small holdback so text is released mid-stream rather than all at
        // flush, which is the case where double-emission would show up.
        let mut sc = StreamScrubber::new(16);
        let body: String = std::iter::repeat_n("alpha beta gamma ", 40).collect();
        let mut released = String::new();
        for chunk in body.as_bytes().chunks(7) {
            released.push_str(&sc.push(std::str::from_utf8(chunk).unwrap()));
        }
        assert!(
            !released.is_empty() && released.len() < body.len(),
            "expected a partial release, got {} of {}",
            released.len(),
            body.len()
        );
        released.push_str(&sc.flush().unwrap());
        assert_eq!(released, body);
    }

    #[test]
    fn flush_is_idempotent() {
        let mut sc = StreamScrubber::new(64);
        sc.push("hello");
        assert_eq!(sc.flush().as_deref(), Some("hello"));
        assert_eq!(sc.flush(), None, "a second flush must not re-emit the tail");
        assert_eq!(sc.flush(), None);
    }

    #[test]
    fn flushing_an_untouched_scrubber_emits_nothing() {
        assert_eq!(StreamScrubber::new(64).flush(), None);
    }

    // ── the window and the clamp ──────────────────────────────────────────

    /// The holdback lags; it does not buffer the whole response. This is the
    /// difference between "first token late" and "no streaming at all".
    #[test]
    fn text_is_released_progressively_not_at_the_end() {
        let mut sc = StreamScrubber::new(32);
        let mut released = 0usize;
        for _ in 0..20 {
            released += sc.push("0123456789").len();
        }
        // 200 bytes in, all but the last 32 must already be out.
        assert_eq!(released, 200 - 32);
    }

    /// A pattern with no maximum length (`sk-ant-[A-Za-z0-9\-_]{10,}`) is
    /// caught by the straddle clamp, not by the window: the match is detected
    /// at its minimum length while its first byte is still held, and the clamp
    /// then refuses to release that byte while the match keeps growing.
    #[test]
    fn an_unbounded_pattern_longer_than_the_window_is_still_held() {
        let key = format!("sk-ant-api03-{}", "a".repeat(80));
        // A window far shorter than the key: the clamp is the only thing that
        // can be doing the work here.
        let mut sc = StreamScrubber::new(24);
        let mut released = String::new();
        released.push_str(&sc.push("here is the key: "));
        for c in key.chars() {
            released.push_str(&sc.push(&c.to_string()));
        }
        released.push_str(&sc.push(" and that is all"));
        released.push_str(&sc.flush().unwrap());

        assert!(!released.contains("sk-ant-"), "got: {released}");
        assert!(!released.contains(&"a".repeat(80)), "got: {released}");
        assert!(released.starts_with("here is the key: [REDACTED_SECRET]"));
        assert!(released.ends_with(" and that is all"));
    }

    /// The one class of secret this does not close, pinned so it stays known.
    ///
    /// `jwt` puts required content — the `.` separators and the signature —
    /// *after* its unbounded segments, so nothing matches until the signature
    /// arrives. A JWT that fits in the window is caught; one that does not has
    /// its head released before the pattern is detectable at all. No larger
    /// window fixes this; a partial-match automaton would. If this test starts
    /// failing because the long form is now caught, the `derive_holdback`
    /// doctrine describing this gap needs deleting.
    #[test]
    fn a_jwt_longer_than_the_window_is_a_known_and_documented_gap() {
        let h = derive_holdback().bytes;
        let jwt_of = |payload: usize| {
            format!(
                "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.ey{}.S1gnATur3S1gnATur3",
                "J".repeat(payload)
            )
        };
        let run = |jwt: &str| {
            let deltas: Vec<String> = jwt
                .as_bytes()
                .chunks(8)
                .map(|c| String::from_utf8(c.to_vec()).unwrap())
                .collect();
            let refs: Vec<&str> = deltas.iter().map(String::as_str).collect();
            stream(h, &refs).0
        };
        let short = jwt_of(500);
        assert!(
            !run(&short).contains(&short),
            "a JWT inside the window must be caught"
        );
        let long = jwt_of(1500);
        assert!(long.len() > h);
        assert!(
            run(&long).contains(&long),
            "the documented gap has closed — update derive_holdback's doctrine"
        );
    }

    /// Overlapping findings: `bearer_token` covers the `jwt` inside it, so
    /// pulling the cut back to one finding's start can expose the other. The
    /// clamp iterates for exactly this reason.
    #[test]
    fn overlapping_findings_do_not_leak_through_the_clamp() {
        let jwt = format!(
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvZSJ9.{}",
            "S1gnATur3S1gnATur3"
        );
        let payload = format!("Authorization: Bearer {jwt}");
        let mut sc = StreamScrubber::new(20);
        let mut released = String::new();
        for chunk in payload.as_bytes().chunks(3) {
            released.push_str(&sc.push(std::str::from_utf8(chunk).unwrap()));
        }
        released.push_str(&sc.flush().unwrap_or_default());
        assert!(!released.contains("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"), "got: {released}");
        assert!(!released.contains("S1gnATur3S1gnATur3"), "got: {released}");
    }

    /// `len - holdback` lands wherever it lands, including inside a
    /// three-byte character. `String::drain` panics on a non-boundary.
    #[test]
    fn a_cut_inside_a_multibyte_character_does_not_panic_or_corrupt() {
        let body = "日本語のテキストです、これはとても長い文章になります。";
        for holdback in 1..40 {
            let mut sc = StreamScrubber::new(holdback);
            let mut out = String::new();
            for chunk in body.chars() {
                out.push_str(&sc.push(&chunk.to_string()));
            }
            out.push_str(&sc.flush().unwrap_or_default());
            assert_eq!(out, body, "corrupted at holdback {holdback}");
        }
    }

    /// A single delta far larger than the window must not be swallowed.
    #[test]
    fn a_delta_larger_than_the_window_releases_its_head_immediately() {
        let mut sc = StreamScrubber::new(10);
        let out = sc.push("0123456789abcdefghij");
        assert_eq!(out, "0123456789");
        assert_eq!(sc.flush().as_deref(), Some("abcdefghij"));
    }

    // ── the derivation ────────────────────────────────────────────────────

    /// Pins every built-in's computed bound.
    ///
    /// `max_match_len` is a hand-written walker standing in for
    /// `regex-syntax`, so its output is asserted rather than trusted: a walker
    /// bug that shrank the window would otherwise be a silent loss of
    /// coverage. Unicode-aware atoms (`\w`, `\d`, negated classes) count 4
    /// bytes each, which is why some numbers are larger than the ASCII forms
    /// these patterns match in practice — an over-estimate here costs latency,
    /// an under-estimate costs coverage.
    #[test]
    fn every_built_in_patterns_bound_is_what_we_think_it_is() {
        let expected: &[(&str, Option<usize>)] = &[
            ("aws_access_key", Some(20)),
            ("github_token", Some(40)),
            // `\w{82}`: \w is Unicode-aware, so 82 × 4.
            ("github_fine_grained_pat", Some(339)),
            ("anthropic_api_key", None), // {10,}
            ("openai_api_key", Some(167)),
            ("gitlab_pat", Some(316)),
            ("slack_token", None), // {10,} and +
            ("slack_webhook_url", Some(86)),
            ("google_api_key", Some(39)),
            ("stripe_key", Some(107)),
            ("sendgrid_api_key", Some(78)),
            ("npm_token", Some(40)),
            // The pattern that sets the holdback for the whole scanner.
            ("pypi_token", Some(1020)),
            ("huggingface_token", Some(42)),
            // Two negated classes, 64 and 128 wide, at 4 bytes each.
            ("db_connection_string", Some(784)),
            ("jwt", None), // {17,}
            ("ssn", Some(38)),
            ("bearer_token", None), // \s+ and +
            ("private_key", Some(132)),
        ];
        let by_name: Vec<(String, Option<usize>)> = PATTERNS
            .iter()
            .map(|p| (p.name.clone(), max_match_len(p.regex.as_str())))
            .collect();
        assert_eq!(
            by_name.len(),
            expected.len(),
            "a pattern was added or removed; the holdback derivation changed with it"
        );
        for (got, want) in by_name.iter().zip(expected) {
            assert_eq!(got.0, want.0, "pattern order changed");
            assert_eq!(got.1, want.1, "bound for {} changed", want.0);
        }
    }

    #[test]
    fn the_derived_holdback_is_the_widest_bounded_pattern() {
        let d = derive_holdback();
        assert_eq!(d.bytes, 1020);
        assert_eq!(d.set_by, "pypi_token");
        assert_eq!(
            d.unbounded,
            ["anthropic_api_key", "slack_token", "jwt", "bearer_token"],
            "the patterns the window cannot bound — these rely on the clamp"
        );
        let widest = PATTERNS
            .iter()
            .filter_map(|p| max_match_len(p.regex.as_str()))
            .max()
            .unwrap();
        assert_eq!(d.bytes, widest);
    }

    /// The window must cover the longest match its own bound claims to cover.
    #[test]
    fn a_pattern_at_the_derived_bound_is_caught_when_split_at_its_middle() {
        // A pypi token at close to the maximum the pattern allows: the
        // longest single match anything in the set can produce.
        let token = format!("pypi-AgEIcHlwaS5vcmc{}", "a".repeat(990));
        let mid = token.len() / 2;
        let (out, _) = stream(
            derive_holdback().bytes,
            &[&token[..mid], &token[mid..], " trailing prose"],
        );
        assert!(!out.contains("AgEIcHlwaS5vcmc"), "got a {}-byte leak", out.len());
        assert!(out.contains("[REDACTED_SECRET]"));
        assert!(out.ends_with(" trailing prose"));
    }

    /// Unparseable or unmodelled syntax must report "no bound", never a small
    /// number — a small number would silently shrink the window.
    #[test]
    fn unmodelled_syntax_reports_no_bound_rather_than_a_short_one() {
        assert_eq!(max_match_len(r"abc"), Some(3));
        assert_eq!(max_match_len(r"a{3}"), Some(3));
        assert_eq!(max_match_len(r"a{2,5}"), Some(5));
        assert_eq!(max_match_len(r"(?:ab|cde)"), Some(3));
        assert_eq!(max_match_len(r"a?b"), Some(2));
        assert_eq!(max_match_len(r"\bab\b"), Some(2));
        assert_eq!(max_match_len(r"a*"), None);
        assert_eq!(max_match_len(r"a+"), None);
        assert_eq!(max_match_len(r"a{2,}"), None);
        // Unbalanced / truncated input must not be reported as bounded.
        assert_eq!(max_match_len(r"(?:ab"), None);
        assert_eq!(max_match_len(r"[a-z"), None);
        assert_eq!(max_match_len(r"ab)"), None);
    }

    // ── configuration ─────────────────────────────────────────────────────

    #[test]
    fn config_none_means_the_derived_bound_and_zero_means_off() {
        let derived = derive_holdback().bytes;
        let mut cfg = crate::config::DlpConfig::default();
        assert_eq!(cfg.stream_holdback_bytes, None, "default must not be 0");
        assert_eq!(resolve_holdback(&cfg), derived);
        cfg.stream_holdback_bytes = Some(0);
        assert_eq!(resolve_holdback(&cfg), 0);
        cfg.stream_holdback_bytes = Some(256);
        assert_eq!(resolve_holdback(&cfg), 256);
    }
}
