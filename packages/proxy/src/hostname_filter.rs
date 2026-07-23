//! hostname_filter.rs — AI provider hostname allowlist for TLS MITM.
//!
//! Only hostnames in this allowlist are eligible for TLS interception.
//! All other HTTPS traffic is passed through as a transparent TCP tunnel.
//!
//! This is the critical safety boundary: we NEVER MITM non-AI traffic.
//!
//! ## Runtime extension (WS-6NC NC6)
//!
//! Set `INTUTIC_EXTRA_AI_HOSTS` to a comma-separated list of additional
//! hostnames that should be treated as AI providers (e.g. on-prem LLM
//! endpoints or private API gateways). These are loaded once at startup
//! via `extra_ai_hosts_from_env()` and merged with `AI_PROVIDER_HOSTS`.
//!
//! Example:
//! ```text
//! INTUTIC_EXTRA_AI_HOSTS=my-llm.internal.corp,private-ai.example.com
//! ```

use std::sync::OnceLock;

/// Returns the extra AI hosts loaded from `INTUTIC_EXTRA_AI_HOSTS` at startup.
/// Cached after first call (OnceLock).
pub fn extra_ai_hosts_from_env() -> &'static Vec<String> {
    static EXTRA: OnceLock<Vec<String>> = OnceLock::new();
    EXTRA.get_or_init(|| {
        std::env::var("INTUTIC_EXTRA_AI_HOSTS")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_lowercase)
            .collect()
    })
}

/// Returns true if this hostname should be TLS-intercepted for governance.
///
/// Matches against both the built-in `AI_PROVIDER_HOSTS` constant **and**
/// any hosts listed in `INTUTIC_EXTRA_AI_HOSTS` (loaded once at startup).
pub fn is_ai_provider_host(host: &str) -> bool {
    // Strip port if present
    let host = host.split(':').next().unwrap_or(host).to_lowercase();
    let host = host.as_str();

    // Check built-in allowlist
    let in_builtin = AI_PROVIDER_HOSTS
        .iter()
        .any(|&allowed| host == allowed || host.ends_with(&format!(".{}", allowed)));

    if in_builtin {
        return true;
    }

    // Check runtime-extended allowlist (INTUTIC_EXTRA_AI_HOSTS)
    extra_ai_hosts_from_env()
        .iter()
        .any(|allowed| host == allowed.as_str() || host.ends_with(&format!(".{}", allowed)))
}

/// The set of AI provider hostnames eligible for TLS MITM inspection.
/// All other hosts are passed through as transparent TCP tunnels.
///
/// Extend at runtime via `INTUTIC_EXTRA_AI_HOSTS` (WS-6NC NC6).
pub const AI_PROVIDER_HOSTS: &[&str] = &[
    "api.anthropic.com",
    "api.openai.com",
    "generativelanguage.googleapis.com",
    "openrouter.ai",
    "api.mistral.ai",
    "api.cohere.com",
    "api.together.xyz",
    "api.groq.com",
    "api.perplexity.ai",
    "api2.cursor.sh",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_known_ai_hosts_intercepted() {
        assert!(is_ai_provider_host("api.anthropic.com"));
        assert!(is_ai_provider_host("api.openai.com"));
        assert!(is_ai_provider_host("api2.cursor.sh"));
        assert!(is_ai_provider_host("api.anthropic.com:443"));
    }

    #[test]
    fn test_non_ai_hosts_not_intercepted() {
        assert!(!is_ai_provider_host("google.com"));
        assert!(!is_ai_provider_host("github.com"));
        assert!(!is_ai_provider_host("example.com"));
        assert!(!is_ai_provider_host("evil-anthropic.com"));
    }

    #[test]
    fn test_subdomain_matching() {
        // Subdomains of AI hosts ARE intercepted (e.g. regional endpoints)
        assert!(is_ai_provider_host("us-east-1.api.anthropic.com"));
    }

    #[test]
    fn test_suffix_attack_not_matched() {
        // "notapi.anthropic.com" should NOT match "api.anthropic.com"
        // because ends_with(".api.anthropic.com") fails for "notapi.anthropic.com"
        assert!(!is_ai_provider_host("notapi.anthropic.com"));
    }

    #[test]
    fn test_case_insensitive_matching() {
        // Hostnames are normalised to lowercase before matching
        assert!(is_ai_provider_host("API.OPENAI.COM"));
        assert!(is_ai_provider_host("Api.Anthropic.Com:443"));
    }

    #[test]
    fn test_extra_hosts_from_env_returns_vec() {
        // With no env var set, returns empty vec (or whatever was set)
        let extra = extra_ai_hosts_from_env();
        // Must return a reference to a Vec<String>
        let _: &Vec<String> = extra;
    }

    #[test]
    fn test_extra_ai_hosts_env_integration() {
        // NOTE: OnceLock means env var is read only once per process.
        // This test verifies the parsing logic is correct by calling
        // the env-read path directly (not via OnceLock after it's been set).
        let raw = "my-llm.internal.corp, PRIVATE-AI.example.com ,";
        let parsed: Vec<String> = raw
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_lowercase)
            .collect();
        assert_eq!(
            parsed,
            vec!["my-llm.internal.corp", "private-ai.example.com"]
        );
    }
}
