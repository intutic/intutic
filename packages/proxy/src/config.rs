//! Configuration loader — LiteLLM-compatible config.yaml parser.
//!
//! Reads the same config.yaml format as BerriAI/LiteLLM and LiteLLM-Rust.
//! Adds Intutic-specific settings under `intutic_settings`.

use serde::Deserialize;
use std::path::Path;

/// Top-level configuration structure
#[derive(Debug, Deserialize, Clone)]
pub struct ProxyConfig {
    /// LiteLLM model list (provider routes)
    pub model_list: Vec<ModelEntry>,

    /// LiteLLM general settings
    #[serde(default)]
    pub general_settings: GeneralSettings,

    /// Intutic-specific settings (WASM, DLP, SnipCompactor)
    #[serde(default)]
    pub intutic_settings: IntuticSettings,
}

#[derive(Debug, Deserialize, Clone)]
pub struct ModelEntry {
    pub model_name: String,
    pub litellm_params: LiteLLMParams,
}

#[derive(Debug, Deserialize, Clone)]
pub struct LiteLLMParams {
    pub model: String,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub api_base: Option<String>,
}

#[derive(Debug, Deserialize, Clone, Default)]
pub struct GeneralSettings {
    #[serde(default)]
    pub master_key: Option<String>,
    #[serde(default)]
    pub database_url: Option<String>,
}

#[derive(Debug, Deserialize, Clone, Default)]
pub struct IntuticSettings {
    #[serde(default)]
    pub snip_compactor: SnipCompactorConfig,
    #[serde(default)]
    pub dlp: DlpConfig,
    #[serde(default)]
    pub harness_overrides: HarnessOverrides,
    #[serde(default)]
    pub policy: PolicyConfig,
}

/// Policy enforcement settings — controls connection to the control plane
/// for pre-request SOP policy checks.
///
/// If `fail_closed` is true (the default), a policy check failure or timeout
/// causes the request to be rejected with 503. If false, the request is
/// allowed through (fail-open, useful in dev mode only).
#[derive(Debug, Deserialize, Clone)]
pub struct PolicyConfig {
    /// Base URL of the Intutic control plane (e.g., `https://api.intutic.ai`).
    /// Set via `CONTROL_PLANE_URL` env var (takes precedence over config file).
    #[serde(default)]
    pub control_plane_url: Option<String>,

    /// Whether to block the request (fail closed) when the control plane
    /// is unreachable or returns an unexpected error.
    #[serde(default = "default_true")]
    pub fail_closed: bool,

    /// Timeout in milliseconds for the policy check HTTP call.
    #[serde(default = "default_policy_timeout_ms")]
    pub timeout_ms: u64,

    // ── Multi-region (WS-6MR) ─────────────────────────────────────────────────
    /// The region this proxy instance is running in (e.g., "us", "eu", "apac").
    /// Read from `INTUTIC_REGION` env var. Used to tag requests and switch
    /// the `control_plane_url` to the matching regional endpoint.
    #[serde(default)]
    pub current_region: Option<String>,

    /// Fallback region to use when the primary region is unreachable.
    /// Read from `INTUTIC_FALLBACK_REGION` env var.
    /// When set and the primary control-plane fails health checks, the proxy
    /// re-routes policy calls to the fallback region URL instead of failing closed.
    #[serde(default)]
    pub fallback_region: Option<String>,

    /// Control-plane URL for the fallback region.
    /// Derived automatically from `fallback_region` using the same URL pattern as
    /// `control_plane_url`, or set explicitly via `FALLBACK_REGION_URL`.
    #[serde(default)]
    pub fallback_region_url: Option<String>,
}

impl PolicyConfig {
    /// Returns the effective control-plane URL, accounting for region overrides.
    /// Falls back to the fallback region URL if the primary is known to be down
    /// (proxy-side circuit-breaker must set `INTUTIC_USE_FALLBACK=1`).
    pub fn effective_control_plane_url(&self) -> Option<&str> {
        if std::env::var("INTUTIC_USE_FALLBACK").as_deref() == Ok("1") {
            if let Some(ref furl) = self.fallback_region_url {
                return Some(furl.as_str());
            }
        }
        self.control_plane_url.as_deref()
    }
}

impl Default for PolicyConfig {
    fn default() -> Self {
        let current_region = std::env::var("INTUTIC_REGION").ok();
        let fallback_region = std::env::var("INTUTIC_FALLBACK_REGION").ok();

        // Derive fallback URL from region name using standard URL pattern:
        //   eu   -> https://api.eu.intutic.ai
        //   apac -> https://api.apac.intutic.ai
        //   us   -> https://api.intutic.ai  (no subdomain for primary)
        let fallback_region_url = std::env::var("FALLBACK_REGION_URL").ok().or_else(|| {
            fallback_region.as_deref().map(|r| match r {
                "us" => "https://api.intutic.ai".to_string(),
                other => format!("https://api.{other}.intutic.ai"),
            })
        });

        Self {
            control_plane_url: std::env::var("CONTROL_PLANE_URL").ok(),
            fail_closed: true,
            timeout_ms: 3_000,
            current_region,
            fallback_region,
            fallback_region_url,
        }
    }
}

/// Known harness base-URL environment variables.
///
/// Each AI coding harness uses a different env var to override the LLM endpoint:
/// - Claude Code:  `ANTHROPIC_BASE_URL`  → POST /v1/messages
/// - Cursor:       `OPENAI_BASE_URL`     → POST /v1/chat/completions
/// - Antigravity:  `GEMINI_API_ENDPOINT` → POST /v1beta/models/{model}:generateContent
/// - Codex CLI:    `OPENAI_BASE_URL`     → POST /v1/responses
/// - n8n:          Per-node "Base URL" field in credential settings
///
/// See ADR-004 Decision 5 and LLD §5 (Harness Compatibility Matrix).
#[derive(Debug, Deserialize, Clone)]
pub struct HarnessOverrides {
    /// Whether to advertise the proxy URL in health check responses
    #[serde(default = "default_true")]
    pub advertise_url: bool,
    /// The external URL of this proxy (used in setup instructions)
    #[serde(default)]
    pub proxy_external_url: Option<String>,
}

impl Default for HarnessOverrides {
    fn default() -> Self {
        Self {
            advertise_url: true,
            proxy_external_url: None,
        }
    }
}

#[derive(Debug, Deserialize, Clone)]
pub struct SnipCompactorConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_max_tool_output_tokens")]
    pub max_tool_output_tokens: usize,
    #[serde(default = "default_collapse_threshold")]
    pub collapse_repetitions_above: usize,
    #[serde(default = "default_true")]
    pub import_dedup: bool,
    #[serde(default = "default_true")]
    pub stack_trace_dedup: bool,
    #[serde(default = "default_true")]
    pub whitespace_normalize: bool,

    // ── JSON-aware compression (snip_json.rs) ──────────────────────────────
    /// Maximum number of array items to retain before collapsing the tail.
    #[serde(default = "default_json_max_array_items")]
    pub json_max_array_items: usize,
    /// Maximum characters to keep from a JSON string value.
    /// Values shorter than this are always preserved verbatim.
    #[serde(default = "default_json_max_string_value_chars")]
    pub json_max_string_value_chars: usize,
    /// Minimum Shannon entropy (0–1) for a string value to be preserved verbatim
    /// despite being longer than `json_max_string_value_chars`.
    /// High-entropy values (UUIDs, hashes, API keys) are kept.
    #[serde(default = "default_json_entropy_threshold")]
    pub json_entropy_threshold: f64,

    // ── Code skeleton extraction (snip_code.rs) ────────────────────────────
    /// When true, code blocks detected in tool outputs are compressed to their
    /// structural skeleton (function signatures, type definitions, imports).
    #[serde(default = "default_true")]
    pub code_skeleton_enabled: bool,
    /// Minimum line count for a code block to be worth skeleton-extracting.
    /// Blocks shorter than this pass through unchanged.
    #[serde(default = "default_code_skeleton_min_lines")]
    pub code_skeleton_min_lines: usize,

    /// TD-008: Enable per-thread incremental parse cache for code skeleton extraction.
    /// When true, identical code blocks (same content hash) are not re-parsed by
    /// tree-sitter on the same thread — the cached skeleton is returned immediately.
    ///
    /// Activate only after 30-day telemetry review confirms:
    ///   - p99 code input > 50 KB  AND  same-content hit rate > 20%.
    ///
    /// Default: false (cache disabled; negligible overhead when off).
    #[serde(default)]
    pub code_skeleton_incremental_cache: bool,
}

impl Default for SnipCompactorConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            max_tool_output_tokens: 8192,
            collapse_repetitions_above: 3,
            import_dedup: true,
            stack_trace_dedup: true,
            whitespace_normalize: true,
            json_max_array_items: 3,
            json_max_string_value_chars: 20,
            json_entropy_threshold: 0.85,
            code_skeleton_enabled: true,
            code_skeleton_min_lines: 10,
            code_skeleton_incremental_cache: false,
        }
    }
}

#[derive(Debug, Deserialize, Clone)]
pub struct DlpConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_true")]
    pub scan_input: bool,
    #[serde(default = "default_true")]
    pub scan_output: bool,
}

impl Default for DlpConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            scan_input: true,
            scan_output: true,
        }
    }
}

fn default_true() -> bool {
    true
}
fn default_max_tool_output_tokens() -> usize {
    8192
}
fn default_collapse_threshold() -> usize {
    3
}
fn default_policy_timeout_ms() -> u64 {
    3_000
}
fn default_json_max_array_items() -> usize {
    3
}
fn default_json_max_string_value_chars() -> usize {
    20
}
fn default_json_entropy_threshold() -> f64 {
    0.85
}
fn default_code_skeleton_min_lines() -> usize {
    10
}

pub fn load_config(path: &str) -> anyhow::Result<ProxyConfig> {
    let contents = std::fs::read_to_string(Path::new(path))?;
    let mut config: ProxyConfig = serde_yaml::from_str(&contents)?;

    // Environment variables take precedence over config file
    if let Ok(env_url) = std::env::var("CONTROL_PLANE_URL") {
        if !env_url.is_empty() {
            config.intutic_settings.policy.control_plane_url = Some(env_url);
        }
    }

    // Dynamically route based on INTUTIC_REGION (Phase 5 WS-5MR Gap 2.6 / TD-182)
    if let Ok(region) = std::env::var("INTUTIC_REGION") {
        if !region.is_empty() {
            if let Some(ref mut url) = config.intutic_settings.policy.control_plane_url {
                if url.contains("api.intutic.ai") {
                    *url = url.replace("api.intutic.ai", &format!("api.{}.intutic.ai", region));
                } else if url.contains("control-plane.intutic.svc") {
                    *url = url.replace(
                        "control-plane.intutic.svc",
                        &format!("control-plane.intutic-{}.svc", region),
                    );
                }
            }
        }
    }

    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;
    use once_cell::sync::Lazy;
    use std::sync::Mutex;

    static ENV_MUTEX: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

    #[test]
    fn test_region_url_rewriting() {
        let _lock = ENV_MUTEX.lock().unwrap();
        // Temp file setup
        let config_content = r#"
model_list: []
general_settings: {}
intutic_settings:
  policy:
    control_plane_url: "https://api.intutic.ai"
"#;
        let temp_dir = std::env::temp_dir();
        let file_path = temp_dir.join("test_config.yaml");
        std::fs::write(&file_path, config_content).unwrap();

        // 1. Unset env vars
        std::env::remove_var("INTUTIC_REGION");
        let config = load_config(file_path.to_str().unwrap()).unwrap();
        assert_eq!(
            config.intutic_settings.policy.control_plane_url.as_deref(),
            Some("https://api.intutic.ai")
        );

        // 2. Set INTUTIC_REGION to eu
        std::env::set_var("INTUTIC_REGION", "eu");
        let config = load_config(file_path.to_str().unwrap()).unwrap();
        assert_eq!(
            config.intutic_settings.policy.control_plane_url.as_deref(),
            Some("https://api.eu.intutic.ai")
        );

        // 3. Set INTUTIC_REGION to apac with control-plane.intutic.svc
        let config_content_svc = r#"
model_list: []
general_settings: {}
intutic_settings:
  policy:
    control_plane_url: "http://control-plane.intutic.svc:3001"
"#;
        std::fs::write(&file_path, config_content_svc).unwrap();
        std::env::set_var("INTUTIC_REGION", "apac");
        let config = load_config(file_path.to_str().unwrap()).unwrap();
        assert_eq!(
            config.intutic_settings.policy.control_plane_url.as_deref(),
            Some("http://control-plane.intutic-apac.svc:3001")
        );

        std::env::remove_var("INTUTIC_REGION");
        let _ = std::fs::remove_file(file_path);
    }

    /// MR4: INTUTIC_FALLBACK_REGION derives the fallback URL automatically.
    #[test]
    fn test_fallback_region_url_derivation() {
        let _lock = ENV_MUTEX.lock().unwrap();
        // eu fallback → https://api.eu.intutic.ai
        std::env::set_var("INTUTIC_FALLBACK_REGION", "eu");
        std::env::remove_var("FALLBACK_REGION_URL");
        let cfg = PolicyConfig::default();
        assert_eq!(cfg.fallback_region.as_deref(), Some("eu"));
        assert_eq!(
            cfg.fallback_region_url.as_deref(),
            Some("https://api.eu.intutic.ai")
        );
        std::env::remove_var("INTUTIC_FALLBACK_REGION");

        // apac fallback → https://api.apac.intutic.ai
        std::env::set_var("INTUTIC_FALLBACK_REGION", "apac");
        let cfg = PolicyConfig::default();
        assert_eq!(
            cfg.fallback_region_url.as_deref(),
            Some("https://api.apac.intutic.ai")
        );
        std::env::remove_var("INTUTIC_FALLBACK_REGION");

        // us fallback → https://api.intutic.ai (primary, no subdomain)
        std::env::set_var("INTUTIC_FALLBACK_REGION", "us");
        let cfg = PolicyConfig::default();
        assert_eq!(
            cfg.fallback_region_url.as_deref(),
            Some("https://api.intutic.ai")
        );
        std::env::remove_var("INTUTIC_FALLBACK_REGION");

        // Explicit FALLBACK_REGION_URL takes precedence over derivation
        std::env::set_var("INTUTIC_FALLBACK_REGION", "eu");
        std::env::set_var("FALLBACK_REGION_URL", "https://my-custom-eu.example.com");
        let cfg = PolicyConfig::default();
        assert_eq!(
            cfg.fallback_region_url.as_deref(),
            Some("https://my-custom-eu.example.com")
        );
        std::env::remove_var("INTUTIC_FALLBACK_REGION");
        std::env::remove_var("FALLBACK_REGION_URL");
    }

    /// MR4: effective_control_plane_url() switches to fallback when INTUTIC_USE_FALLBACK=1.
    #[test]
    fn test_effective_control_plane_url_failover() {
        let _lock = ENV_MUTEX.lock().unwrap();
        std::env::remove_var("INTUTIC_USE_FALLBACK");
        let cfg = PolicyConfig {
            control_plane_url: Some("https://api.intutic.ai".to_string()),
            fallback_region_url: Some("https://api.eu.intutic.ai".to_string()),
            fallback_region: Some("eu".to_string()),
            current_region: Some("us".to_string()),
            fail_closed: true,
            timeout_ms: 3_000,
        };

        // Without failover flag: returns primary URL
        assert_eq!(
            cfg.effective_control_plane_url(),
            Some("https://api.intutic.ai")
        );

        // With failover flag: returns fallback URL
        std::env::set_var("INTUTIC_USE_FALLBACK", "1");
        assert_eq!(
            cfg.effective_control_plane_url(),
            Some("https://api.eu.intutic.ai")
        );
        std::env::remove_var("INTUTIC_USE_FALLBACK");
    }

    /// MR4: INTUTIC_REGION sets current_region in PolicyConfig::default().
    #[test]
    fn test_current_region_from_env() {
        let _lock = ENV_MUTEX.lock().unwrap();
        std::env::set_var("INTUTIC_REGION", "apac");
        let cfg = PolicyConfig::default();
        assert_eq!(cfg.current_region.as_deref(), Some("apac"));
        std::env::remove_var("INTUTIC_REGION");

        // Absent env var → None
        let cfg = PolicyConfig::default();
        assert!(cfg.current_region.is_none());
    }
}
