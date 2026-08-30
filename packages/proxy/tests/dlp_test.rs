//! DLP scanner integration tests

#[test]
fn test_dlp_scanner_detects_secrets() {
    use intutic_proxy::dlp;

    // Fixture is runtime-assembled: the repo convention forbids contiguous
    // credential-shaped literals in source, in every package.
    let input = concat!(
        r#"{
        "api_key": "AKIA"#,
        r#"IOSFODNN7EXAMPLE",
        "github": "ghp_"#,
        r#"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
        "password": "supersecret"
    }"#
    );

    let findings = dlp::scan(input);
    assert!(findings.len() >= 2); // AWS key + GitHub token
    assert!(findings.iter().any(|f| f.pattern_name == "aws_access_key"));
    assert!(findings.iter().any(|f| f.pattern_name == "github_token"));
}

#[test]
fn test_dlp_redaction_replaces_secrets() {
    use intutic_proxy::dlp;

    let input = concat!("My key is AKIA", "IOSFODNN7EXAMPLE");
    let findings = dlp::scan(input);
    let redacted = dlp::redact(input, &findings);
    assert!(!redacted.contains("AKIA"));
    assert!(redacted.contains("[REDACTED_SECRET]"));
}
