//! DLP Scanner — bidirectional regex-based secret/PII detection.
//!
//! Uses Rust `regex` crate (linear-time, ReDoS-safe).
//! Scans both input and output streams for secrets, PII, and credentials.

use once_cell::sync::Lazy;
use regex::Regex;

use crate::wasm::context::DlpFinding;

/// DLP pattern categories
static PATTERNS: Lazy<Vec<DlpPattern>> = Lazy::new(|| {
    vec![
        DlpPattern {
            name: "aws_access_key".into(),
            category: "secret".into(),
            regex: Regex::new(r"AKIA[0-9A-Z]{16}").unwrap(),
            action: "redact".into(),
        },
        DlpPattern {
            name: "github_token".into(),
            category: "secret".into(),
            regex: Regex::new(r"ghp_[0-9a-zA-Z]{36}").unwrap(),
            action: "redact".into(),
        },
        DlpPattern {
            name: "anthropic_api_key".into(),
            category: "secret".into(),
            regex: Regex::new(r"sk-ant-[A-Za-z0-9\-_]{10,}").unwrap(),
            action: "block".into(),
        },
        DlpPattern {
            name: "ssn".into(),
            category: "pii".into(),
            regex: Regex::new(r"\b\d{3}-\d{2}-\d{4}\b").unwrap(),
            action: "redact".into(),
        },
        DlpPattern {
            name: "bearer_token".into(),
            category: "credential".into(),
            regex: Regex::new(r"Bearer\s+[A-Za-z0-9\-._~+/]+=*").unwrap(),
            action: "redact".into(),
        },
        DlpPattern {
            name: "private_key".into(),
            category: "secret".into(),
            regex: Regex::new(r"-----BEGIN (RSA |EC |DSA )?PRIVATE KEY-----").unwrap(),
            action: "block".into(),
        },
    ]
});

struct DlpPattern {
    name: String,
    category: String,
    regex: Regex,
    action: String,
}

/// Scan text for DLP matches
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
