//! Checksum-validated PII detectors.
//!
//! The definition — ids, regexes, validator names, default actions, the card
//! IIN table and the IBAN length table — is `pii_detectors.json`, shared
//! byte for byte with the MCP proxy (`packages/mcp-proxy/src/dlpPii.ts` reads
//! the copy in `@intutic/shared-types`). This file holds what JSON cannot: the
//! validators and the boundary rule. `dlpPii.ts` implements both identically,
//! and `packages/shared-types/fixtures/pii-detector-vectors.json` runs the same
//! cases through each.
//!
//! # Why a regex is only a candidate
//!
//! The secret patterns in `dlp.rs` are anchored on vendor prefixes, so a match
//! is the finding. A digit run has no prefix: the regex finds something
//! card-shaped and the validator decides whether it is a card. Checksums do
//! most of the work — Luhn rejects nine of ten random digit runs, IBAN's
//! mod-97 ninety-six of ninety-seven — and the IIN and country-length tables
//! reject most of what is left.
//!
//! # The boundary rule
//!
//! `\b` means different things in Rust (Unicode) and JavaScript (ASCII), so
//! neither regex uses it; the boundary is checked here, the same way in both:
//!
//! - The characters on either side must not be ASCII letters, digits or `_`.
//!   A card number inside `order_4111…` is an identifier, not a card.
//! - Both scanners read JSON as sent, where a newline is the two characters
//!   `\n`. A match right after `\n`, `\r` or `\t` counts as bounded, otherwise
//!   every SSN at the start of a prompt line would be missed. A match starting
//!   right after a backslash starts inside an escape and is rejected; the
//!   search moves on one character, which finds `john@…` in `\njohn@…`.
//! - `numeric` detectors also reject a match glued to more digits by `.` or
//!   `-`: `0.4111…` is a decimal fraction, and a fifth group after a
//!   card-shaped `NNNN-NNNN-NNNN-NNNN` says it is a key or serial, not a card.
//!
//! A rejected candidate resumes the search one character after where it
//! started, not after where it ended, so a card number right after `12 ` is
//! still found.

use std::collections::BTreeMap;

use once_cell::sync::Lazy;
use regex::Regex;
use serde::Deserialize;

/// The shared definition, embedded at compile time.
pub(crate) const DEFINITION_JSON: &str = include_str!("pii_detectors.json");

#[derive(Deserialize)]
struct Definition {
    detectors: Vec<DetectorDef>,
    card_brands: Vec<CardBrand>,
    iban_lengths: BTreeMap<String, usize>,
}

#[derive(Deserialize)]
struct DetectorDef {
    id: String,
    category: String,
    description: String,
    regex: String,
    boundary: String,
    validator: String,
    default_action: String,
}

#[derive(Deserialize)]
struct CardBrand {
    /// Not read by the scanner; it names the row for whoever edits the table.
    #[allow(dead_code)]
    brand: String,
    /// Inclusive `[low, high]` prefix ranges, both the same number of digits.
    prefixes: Vec<(String, String)>,
    lengths: Vec<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Validator {
    CardLuhn,
    IbanMod97,
    SsnRanges,
    EmailShape,
    PhoneDigits,
}

/// One compiled detector.
pub struct Detector {
    pub id: String,
    pub category: String,
    pub description: String,
    pub regex: Regex,
    /// `off`, `redact` or `block`.
    pub default_action: String,
    numeric: bool,
    validator: Validator,
}

static DEFINITION: Lazy<Definition> =
    Lazy::new(|| serde_json::from_str(DEFINITION_JSON).expect("pii_detectors.json must parse"));

static DETECTORS: Lazy<Vec<Detector>> = Lazy::new(|| {
    DEFINITION
        .detectors
        .iter()
        .map(|d| Detector {
            id: d.id.clone(),
            category: d.category.clone(),
            description: d.description.clone(),
            regex: Regex::new(&d.regex)
                .unwrap_or_else(|e| panic!("pii detector {} regex: {e}", d.id)),
            default_action: d.default_action.clone(),
            numeric: match d.boundary.as_str() {
                "numeric" => true,
                "word" => false,
                other => panic!("pii detector {} has unknown boundary {other}", d.id),
            },
            validator: match d.validator.as_str() {
                "card_luhn" => Validator::CardLuhn,
                "iban_mod97" => Validator::IbanMod97,
                "ssn_ranges" => Validator::SsnRanges,
                "email_shape" => Validator::EmailShape,
                "phone_digits" => Validator::PhoneDigits,
                other => panic!("pii detector {} has unknown validator {other}", d.id),
            },
        })
        .collect()
});

/// Every PII detector, in definition order, whatever its configured action.
pub fn detectors() -> &'static [Detector] {
    &DETECTORS
}

/// Validated matches of one detector, as byte ranges, in text order.
pub fn find(det: &Detector, text: &str) -> Vec<(usize, usize)> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut pos = 0;
    while pos < text.len() {
        let Some(m) = det.regex.find_at(text, pos) else {
            break;
        };
        let start = m.start();
        let accepted = validate(det.validator, m.as_str())
            .map(|len| start + len)
            .filter(|&end| bounded(bytes, start, end, det.numeric));
        match accepted {
            Some(end) => {
                out.push((start, end));
                pos = end;
            }
            // Every detector's regex starts on an ASCII character, so one
            // byte on is a character boundary.
            None => pos = start + 1,
        }
    }
    out
}

/// Every detector over `text`, actions ignored: `(id, start, end)` in
/// definition order, then text order. What the conformance vectors and the
/// false-positive corpus measure — detection, separate from configuration.
pub fn detect_all(text: &str) -> Vec<(&'static str, usize, usize)> {
    let mut out = Vec::new();
    for det in detectors() {
        for (s, e) in find(det, text) {
            out.push((det.id.as_str(), s, e));
        }
    }
    out
}

fn is_word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn bounded(b: &[u8], start: usize, end: usize, numeric: bool) -> bool {
    if start > 0 {
        let p = b[start - 1];
        if p == b'\\' {
            return false;
        }
        let escaped = matches!(p, b'n' | b'r' | b't') && start >= 2 && b[start - 2] == b'\\';
        if is_word(p) && !escaped {
            return false;
        }
        if numeric && matches!(p, b'.' | b'-') && start >= 2 && b[start - 2].is_ascii_digit() {
            return false;
        }
    }
    if end < b.len() {
        let q = b[end];
        if is_word(q) {
            return false;
        }
        if numeric && matches!(q, b'.' | b'-') && b.get(end + 1).is_some_and(u8::is_ascii_digit) {
            return false;
        }
    }
    true
}

/// The accepted length of `span` (a prefix of it), or `None`.
fn validate(v: Validator, span: &str) -> Option<usize> {
    let ok = match v {
        Validator::CardLuhn => card(span),
        Validator::IbanMod97 => return iban(span),
        Validator::SsnRanges => ssn(span),
        Validator::EmailShape => email(span),
        Validator::PhoneDigits => {
            let n = span.bytes().filter(u8::is_ascii_digit).count();
            (10..=15).contains(&n)
        }
    };
    ok.then_some(span.len())
}

fn card(span: &str) -> bool {
    let digits: Vec<u8> = span.bytes().filter(u8::is_ascii_digit).collect();
    let n = digits.len();
    let known = DEFINITION.card_brands.iter().any(|b| {
        b.lengths.contains(&n)
            && b.prefixes.iter().any(|(lo, hi)| {
                let head = &digits[..lo.len().min(n)];
                head >= lo.as_bytes() && head <= hi.as_bytes()
            })
    });
    known && luhn(&digits)
}

fn luhn(digits: &[u8]) -> bool {
    let sum: u32 = digits
        .iter()
        .rev()
        .enumerate()
        .map(|(i, &c)| {
            let d = u32::from(c - b'0');
            if i % 2 == 1 {
                let x = d * 2;
                if x > 9 {
                    x - 9
                } else {
                    x
                }
            } else {
                d
            }
        })
        .sum();
    sum.is_multiple_of(10)
}

/// Truncates to the country's length, because the regex is greedy: on a
/// printed IBAN followed by ` EUR` it runs on into `EUR`.
fn iban(span: &str) -> Option<usize> {
    let want = *DEFINITION.iban_lengths.get(span.get(..2)?)?;
    let mut chars: Vec<u8> = Vec::with_capacity(want);
    let mut end = span.len();
    for (i, c) in span.bytes().enumerate() {
        if c == b' ' {
            continue;
        }
        if chars.len() == want {
            // A further character glued on (no space) makes it longer than
            // any IBAN of this country.
            if span.as_bytes()[i - 1] != b' ' {
                return None;
            }
            break;
        }
        chars.push(c);
        end = i + 1;
    }
    if chars.len() != want {
        return None;
    }
    // Move the country code and check digits to the end; letters count
    // A=10 … Z=35; the remainder mod 97 must be 1.
    chars.rotate_left(4);
    let mut rem: u32 = 0;
    for c in chars {
        let v = if c.is_ascii_digit() {
            u32::from(c - b'0')
        } else {
            u32::from(c - b'A') + 10
        };
        rem = if v >= 10 {
            (rem * 100 + v) % 97
        } else {
            (rem * 10 + v) % 97
        };
    }
    (rem == 1).then_some(end)
}

/// Never issued: area 000, 666 or 9xx; group 00; serial 0000.
fn ssn(span: &str) -> bool {
    let b = span.as_bytes();
    let (area, group, serial) = (&b[0..3], &b[4..6], &b[7..11]);
    area != b"000" && area != b"666" && area[0] != b'9' && group != b"00" && serial != b"0000"
}

fn email(span: &str) -> bool {
    let Some((local, domain)) = span.split_once('@') else {
        return false;
    };
    if local.starts_with('.') || local.ends_with('.') || local.contains("..") {
        return false;
    }
    let labels: Vec<&str> = domain.split('.').collect();
    if labels
        .iter()
        .any(|l| l.is_empty() || l.starts_with('-') || l.ends_with('-'))
    {
        return false;
    }
    let tld = labels[labels.len() - 1];
    if tld.len() < 2 || !tld.bytes().all(|c| c.is_ascii_alphabetic()) {
        return false;
    }
    // `icon@2x.png`: an asset scale suffix, not an address.
    let first = labels[0];
    let retina = first.len() >= 2
        && first.ends_with('x')
        && first[..first.len() - 1].bytes().all(|c| c.is_ascii_digit());
    !retina
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_definition_compiles() {
        assert_eq!(
            detectors()
                .iter()
                .map(|d| d.id.as_str())
                .collect::<Vec<_>>(),
            ["pii.card", "pii.iban", "pii.ssn", "pii.email", "pii.phone"]
        );
    }

    /// The MCP proxy reads the copy in `@intutic/shared-types`; this side
    /// fails the moment the two differ, and `dlpPii.test.ts` checks the
    /// other way round, so neither copy can change alone.
    #[test]
    fn the_definition_matches_the_mcp_proxy_copy() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../shared-types/src/piiDetectors.json");
        let other = std::fs::read_to_string(&path).expect("shared-types copy is readable");
        assert!(
            other == DEFINITION_JSON,
            "packages/proxy/src/dlp/pii_detectors.json and \
             packages/shared-types/src/piiDetectors.json differ; copy the edited one over the other"
        );
    }

    #[test]
    fn luhn_known_answers() {
        assert!(luhn(b"79927398713"));
        assert!(!luhn(b"79927398710"));
    }
}
