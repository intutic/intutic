//! Configuration loader — LiteLLM-compatible config.yaml parser.
//!
//! Reads the same config.yaml format as BerriAI/LiteLLM and LiteLLM-Rust.
//! Adds Intutic-specific settings under `intutic_settings`.

use serde::Deserialize;
use std::path::Path;

/// What the router does with the model it selects.
///
/// `Enforce` is the `Default` so an existing config keeps its behaviour. A
/// router that silently stops routing is the worse of the two failure
/// directions — the operator sees no change and assumes it is still working.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum RoutingMode {
    /// Do not route at all. Distinct from `enabled: false`, which also skips
    /// the reward loop; `Off` is for turning routing off while leaving the rest
    /// of the machinery observable.
    Off,
    /// Select, record, and serve the requested model anyway.
    Shadow,
    #[default]
    Enforce,
}


/// Top-level configuration structure
#[derive(Debug, Deserialize, Clone)]
pub struct ProxyConfig {
    /// LiteLLM model list (provider routes).
    ///
    /// Defaults to empty. Upstreams are resolved from `ANTHROPIC_UPSTREAM_URL`
    /// and friends at request time (see proxy.rs), so an empty list is a valid
    /// standalone setup rather than a misconfiguration — and without a default
    /// here, a proxy with no config.yaml cannot start at all.
    #[serde(default)]
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
    #[serde(default)]
    pub routing: RoutingConfig,
    /// Override for the local WASM rule directory (default: `~/.intutic/wasm`).
    /// The `INTUTIC_WASM_DIR` env var takes precedence over this value.
    #[serde(default)]
    pub wasm_local_dir: Option<String>,
    /// `/fix` and `/draw` command behaviour.
    #[serde(default)]
    pub commands: CommandsConfig,
    /// Local memory vaults searched by `/fix`.
    #[serde(default)]
    pub memory: MemoryConfig,
    /// Default ceiling for a workflow (loop run).
    #[serde(default)]
    pub workflow: WorkflowConfig,
    /// Response-side tool-call gate.
    #[serde(default)]
    pub response_gate: ResponseGateConfig,
}

/// Refusing a forbidden tool call in the model's *response*, before the client
/// can execute it (`plugins::response_gate`).
///
/// Both fields default to the safe direction. `enabled` is on because the
/// alternative is a deny list that only takes effect one turn after the call it
/// forbids has already run — which is what the request-side check alone gives
/// you, and is not what an operator writing `deny_tools` believes they bought.
///
/// The gate is inert for any role with an empty deny list, so a default-on
/// fail-closed gate cannot affect a workspace that has declared no policy.
#[derive(Debug, Deserialize, Clone)]
pub struct ResponseGateConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,

    /// What to do when the response body will not parse and a deny list is in
    /// force: refuse (`true`, the default) or forward it unverified.
    ///
    /// Streaming is unaffected — see `plugins::response_gate` for why a stream
    /// cannot honour this without ending every stream rather than a suspect one.
    #[serde(default = "default_true")]
    pub fail_closed: bool,
}

impl Default for ResponseGateConfig {
    fn default() -> Self {
        Self { enabled: true, fail_closed: true }
    }
}

/// Default spend ceiling for a workflow, for deployments with no control plane.
///
/// `WorkflowBudgetDetector` compares a loop run's spend against a ceiling written
/// by "whoever started the run". In the enterprise deployment that is the control
/// plane. In open core nothing wrote it, so the ceiling was always absent, which
/// correctly reads as "unbudgeted" — and the detector could therefore never fire.
/// This gives open core a writer without changing the enterprise behaviour: the
/// value is only ever set if no ceiling exists.
#[derive(Debug, Deserialize, Clone)]
pub struct WorkflowConfig {
    /// Ceiling in USD applied to a loop run that arrives without one. `None`
    /// leaves runs uncapped, which is the behaviour before this setting existed.
    #[serde(default)]
    pub default_budget_usd: Option<f64>,
}

impl Default for WorkflowConfig {
    fn default() -> Self {
        Self { default_budget_usd: None }
    }
}

/// Local markdown memory vaults (Obsidian, Logseq, Foam, or any notes folder).
///
/// This is the local-first counterpart to the cloud memory providers: search
/// runs on the developer's machine, so a private vault never leaves it.
#[derive(Debug, Deserialize, Clone)]
pub struct MemoryConfig {
    /// Master switch for local vault search.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Vault directories to search. `~` is expanded. A vault found by walking
    /// up from the working directory (one carrying a `.obsidian`, `.logseq` or
    /// `.foam` marker) is searched even when this list is empty.
    #[serde(default)]
    pub vaults: Vec<String>,
}

impl Default for MemoryConfig {
    fn default() -> Self {
        Self { enabled: true, vaults: Vec::new() }
    }
}

/// Settings for the `/fix` and `/draw` blocking commands.
#[derive(Debug, Deserialize, Clone, Default)]
pub struct CommandsConfig {
    /// When true, `/fix` does not answer locally: the synthesis card is
    /// appended to the user's prompt (command token stripped) and the turn is
    /// forwarded to the upstream provider, so the model sees the enhanced
    /// prompt. `/draw` stays blocking either way — a visualization has no
    /// upstream half. Default false: blocking costs zero tokens.
    #[serde(default)]
    pub non_blocking: bool,
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

    // Multi-region failover was removed on 2026-07-30. `current_region`,
    // `fallback_region`, `fallback_region_url` and `effective_control_plane_url()`
    // lived here: the accessor was called only by its own tests while production
    // read `control_plane_url` directly (proxy.rs:1226,1381,2021), and no env var
    // it needed was set in any manifest. TD-182 recorded the transform as done; it
    // never was. The control-plane half went the same day.
}

impl Default for PolicyConfig {
    fn default() -> Self {
        Self {
            control_plane_url: std::env::var("CONTROL_PLANE_URL").ok(),
            fail_closed: true,
            timeout_ms: 3_000,
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

/// An operator-supplied DLP pattern.
///
/// The built-in set in `dlp.rs` is deliberately narrow: every pattern there is
/// anchored on a literal prefix or magic substring, because a false positive in
/// a secret scanner teaches people to switch it off. That doctrine excludes a
/// whole class of things operators legitimately need to stop — PHI, customer
/// identifiers, internal record formats — which are shaped by *their* schema,
/// not by a vendor's.
///
/// Those cannot ship in the binary, and until now there was no way to add them
/// at all: `DlpConfig` was three booleans, `PATTERNS` was a `Lazy` built once,
/// and there was no env var, config key, or control-plane source. Adding one
/// pattern meant editing Rust and cutting a release.
#[derive(Debug, Deserialize, Clone)]
pub struct CustomDlpPattern {
    /// Stable identifier. Appears in `DlpFinding.pattern_name`, so the
    /// escalation detector counts distinct names — reuse one and two findings
    /// collapse into one for threshold purposes.
    pub name: String,
    /// Grouping used by SOP taint rules (`pii()`, `phi()`) and by the redaction
    /// placeholder, which is `[REDACTED_{CATEGORY}]`, uppercased.
    pub category: String,
    /// Rust `regex` crate syntax. Note: no lookaround. Use inline group flags
    /// such as `(?i: ... )` for case-insensitivity.
    pub regex: String,
    /// `block` or `redact`. Those are the only two the enforcer implements —
    /// there is no warn or mask tier — so anything else is rejected at boot
    /// rather than silently treated as one of them.
    #[serde(default = "default_redact_action")]
    pub action: String,
}

fn default_redact_action() -> String {
    "redact".to_string()
}

#[derive(Debug, Deserialize, Clone)]
pub struct DlpConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_true")]
    pub scan_input: bool,
    #[serde(default = "default_true")]
    pub scan_output: bool,
    /// Operator patterns, appended to the built-in set. Compiled once at boot;
    /// a bad regex is a named startup failure, never a panic at first scan.
    #[serde(default)]
    pub patterns: Vec<CustomDlpPattern>,
}

impl Default for DlpConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            scan_input: true,
            scan_output: true,
            patterns: Vec::new(),
        }
    }
}

/// Contextual bandit routing settings (LLD #26).
///
/// In control-plane-managed workspaces the Valkey feature-flag hash
/// (`workspace:feature_flags:{ws}` → `ff_bandit_routing`) is authoritative.
/// `enabled` only applies when that hash is absent — i.e. standalone
/// open-core mode with no control plane managing the workspace.
#[derive(Debug, Deserialize, Clone)]
pub struct RoutingConfig {
    /// `None` — defer entirely to the Valkey feature flag (control-plane managed).
    /// `Some(true)` — enable bandit routing in standalone mode.
    #[serde(default)]
    pub enabled: Option<bool>,

    /// Candidate model pool for Thompson sampling. Requests for models outside
    /// this pool bypass the bandit entirely. Names must match `model_list`
    /// entries so provider resolution and pricing stay accurate.
    #[serde(default = "default_candidate_models")]
    pub candidate_models: Vec<String>,

    /// When set, any Anthropic-bound model is rewritten to this ID after
    /// routing. `None` (the default) leaves the routed model untouched.
    ///
    /// Note this fires AFTER selection, so a workspace using it gets no reward
    /// signal: crediting the chosen arm with a different model's behaviour is
    /// worse than learning nothing. See `override_fired` in proxy.rs.
    #[serde(default)]
    pub anthropic_model_override: Option<String>,

    /// What routing does with its selection.
    ///
    /// `Shadow` runs `route_model` in full and records what it would have
    /// picked, while the request is served with the model the caller asked for.
    /// That yields reach and exposure — "we would have downgraded 34% of
    /// requests, $X/mo" — and **nothing about quality**, because the other model
    /// never ran. Only mirroring can measure that.
    #[serde(default)]
    pub mode: RoutingMode,

    /// Fraction of eligible requests to mirror, in `[0.0, 0.05]`.
    ///
    /// Mirroring issues the SAME request to the routed candidate as well,
    /// serves the requested model's response, and scores the candidate's off the
    /// latency path. It is the only thing in the plan that produces real quality
    /// evidence — shadow cannot, because the cheap model never ran.
    ///
    /// Capped at 5%: every mirrored request is paid for twice.
    #[serde(default)]
    pub mirror_sample_rate: f64,

    #[serde(default)]
    pub reward: RewardConfig,
}

impl Default for RoutingConfig {
    fn default() -> Self {
        Self {
            enabled: None,
            candidate_models: default_candidate_models(),
            anthropic_model_override: None,
            // Enforce: an existing config keeps routing. A router that silently
            // stops routing is the worse failure direction.
            mode: RoutingMode::default(),
            // No mirroring unless asked for. Every mirrored request is paid for
            // twice, so it must be opted into rather than defaulted on.
            mirror_sample_rate: 0.0,
            reward: RewardConfig::default(),
        }
    }
}

/// Local deterministic reward loop settings.
///
/// Rewards are computed only from signals the proxy already observes
/// (upstream success, latency vs SLO, token anomaly, cost ratio) — no LLM
/// judge. The update rule matches the control-plane reward cron so arm state
/// stays continuous when a workspace upgrades to cloud-managed learning.
#[derive(Debug, Deserialize, Clone)]
pub struct RewardConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,

    /// Latency SLO; responses slower than this are penalised proportionally.
    /// Includes full stream duration for streaming responses.
    #[serde(default = "default_latency_slo_ms")]
    pub latency_slo_ms: u32,

    /// Maximum reward deduction for exceeding the latency SLO.
    #[serde(default = "default_latency_penalty")]
    pub latency_penalty: f64,

    /// Reward deduction when the token-anomaly detector fires.
    #[serde(default = "default_token_anomaly_penalty")]
    pub token_anomaly_penalty: f64,

    /// Maximum reward deduction when the routed model costs more than the
    /// requested model would have.
    #[serde(default = "default_cost_penalty")]
    pub cost_penalty: f64,
}

impl Default for RewardConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            latency_slo_ms: 30_000,
            latency_penalty: 0.3,
            token_anomaly_penalty: 0.2,
            cost_penalty: 0.2,
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
fn default_candidate_models() -> Vec<String> {
    vec![
        "claude-3-5-sonnet".to_string(),
        "gpt-4o".to_string(),
        "gemini-2.0-flash".to_string(),
    ]
}
fn default_latency_slo_ms() -> u32 {
    30_000
}
fn default_latency_penalty() -> f64 {
    0.3
}
fn default_token_anomaly_penalty() -> f64 {
    0.2
}
fn default_cost_penalty() -> f64 {
    0.2
}

pub fn load_config(path: &str) -> anyhow::Result<ProxyConfig> {
    // A missing config file is not an error. `npm i -g @intutic/proxy` installs
    // a binary and nothing else, so a user following the documented install has
    // no config.yaml in their working directory — and this previously exited
    // with a bare `No such file or directory (os error 2)`, which says nothing
    // about what was being looked for (issue #1). Every field either has a
    // serde default or is optional, so defaults are a working standalone
    // configuration: DLP on, no control plane, upstreams from env.
    //
    // A file that exists but is malformed still fails: that is a real mistake
    // and silently ignoring it would be worse than stopping.
    let contents = match std::fs::read_to_string(Path::new(path)) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            tracing::info!(
                path = %path,
                "No config file found — running with built-in defaults. \
                 Set CONFIG_PATH to use one."
            );
            String::from("{}")
        }
        Err(e) => {
            return Err(anyhow::anyhow!("Failed to read config file '{}': {}", path, e));
        }
    };
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





    /// Absent `routing:` block yields control-plane-deferred defaults.
    #[test]
    fn test_routing_config_defaults() {
        let _lock = ENV_MUTEX.lock().unwrap();
        std::env::remove_var("INTUTIC_REGION");
        let config_content = r#"
model_list: []
general_settings: {}
intutic_settings: {}
"#;
        let file_path = std::env::temp_dir().join("test_routing_defaults.yaml");
        std::fs::write(&file_path, config_content).unwrap();
        let config = load_config(file_path.to_str().unwrap()).unwrap();

        let routing = &config.intutic_settings.routing;
        assert_eq!(routing.enabled, None);
        assert_eq!(
            routing.candidate_models,
            vec!["claude-3-5-sonnet", "gpt-4o", "gemini-2.0-flash"]
        );
        assert!(routing.anthropic_model_override.is_none());
        assert!(routing.reward.enabled);
        assert_eq!(routing.reward.latency_slo_ms, 30_000);
        assert!((routing.reward.latency_penalty - 0.3).abs() < f64::EPSILON);
        assert!((routing.reward.token_anomaly_penalty - 0.2).abs() < f64::EPSILON);
        assert!((routing.reward.cost_penalty - 0.2).abs() < f64::EPSILON);
        assert!(config.intutic_settings.wasm_local_dir.is_none());
        let _ = std::fs::remove_file(file_path);
    }

    /// The response gate must be on, and fail closed, without anyone writing a
    /// `response_gate:` block. A gate that ships off is a gate nobody enables.
    #[test]
    fn test_response_gate_defaults_on_and_closed() {
        let _lock = ENV_MUTEX.lock().unwrap();
        std::env::remove_var("INTUTIC_REGION");
        let file_path = std::env::temp_dir().join("test_response_gate_defaults.yaml");
        std::fs::write(&file_path, "model_list: []\nintutic_settings: {}\n").unwrap();
        let config = load_config(file_path.to_str().unwrap()).unwrap();

        let gate = &config.intutic_settings.response_gate;
        assert!(gate.enabled);
        assert!(gate.fail_closed);
        let _ = std::fs::remove_file(file_path);
    }

    /// Both switches are reachable from config.yaml, and one may be set without
    /// silently resetting the other.
    #[test]
    fn test_response_gate_explicit() {
        let _lock = ENV_MUTEX.lock().unwrap();
        std::env::remove_var("INTUTIC_REGION");
        let file_path = std::env::temp_dir().join("test_response_gate_explicit.yaml");
        std::fs::write(
            &file_path,
            "model_list: []\nintutic_settings:\n  response_gate:\n    fail_closed: false\n",
        )
        .unwrap();
        let config = load_config(file_path.to_str().unwrap()).unwrap();

        let gate = &config.intutic_settings.response_gate;
        assert!(gate.enabled, "an unspecified field must keep its default");
        assert!(!gate.fail_closed);
        let _ = std::fs::remove_file(file_path);
    }

    /// Explicit `routing:` block round-trips; unspecified reward fields keep defaults.
    #[test]
    fn test_routing_config_explicit() {
        let _lock = ENV_MUTEX.lock().unwrap();
        std::env::remove_var("INTUTIC_REGION");
        let config_content = r#"
model_list: []
intutic_settings:
  routing:
    enabled: true
    candidate_models: ["claude-3-5-sonnet", "gpt-4o"]
    anthropic_model_override: "claude-opus-4-5"
    reward:
      enabled: false
      latency_slo_ms: 5000
      latency_penalty: 0.5
  wasm_local_dir: "/custom/wasm"
"#;
        let file_path = std::env::temp_dir().join("test_routing_explicit.yaml");
        std::fs::write(&file_path, config_content).unwrap();
        let config = load_config(file_path.to_str().unwrap()).unwrap();

        let routing = &config.intutic_settings.routing;
        assert_eq!(routing.enabled, Some(true));
        assert_eq!(routing.candidate_models, vec!["claude-3-5-sonnet", "gpt-4o"]);
        assert_eq!(
            routing.anthropic_model_override.as_deref(),
            Some("claude-opus-4-5")
        );
        assert!(!routing.reward.enabled);
        assert_eq!(routing.reward.latency_slo_ms, 5_000);
        assert!((routing.reward.latency_penalty - 0.5).abs() < f64::EPSILON);
        // Unspecified fields fall back to defaults.
        assert!((routing.reward.token_anomaly_penalty - 0.2).abs() < f64::EPSILON);
        assert!((routing.reward.cost_penalty - 0.2).abs() < f64::EPSILON);
        assert_eq!(
            config.intutic_settings.wasm_local_dir.as_deref(),
            Some("/custom/wasm")
        );
        let _ = std::fs::remove_file(file_path);
    }

    /// `mode: off` must actually stop routing.
    ///
    /// The enum documented three values and only `Shadow` was ever read:
    /// `bandit_active` came from the feature flags or `routing.enabled`, so a
    /// workspace could set `mode: off` and keep routing AND keep enforcing. A
    /// config knob a reader would reasonably take for a kill switch, that
    /// stopped nothing. There was no test for `mode` at all.
    #[test]
    fn routing_mode_off_is_read_by_the_proxy() {
        let proxy = include_str!("proxy.rs");
        assert!(
            proxy.contains("RoutingMode::Off"),
            "`mode: off` is documented and never consulted — it must gate `bandit_active`",
        );
        // And it must gate the decision, not merely be mentioned.
        assert!(
            proxy.contains("let bandit_active = !routing_off"),
            "`off` must short-circuit `bandit_active`, or a remote flag overrides \
             the operator's stop",
        );
    }

    #[test]
    fn routing_mode_parses_all_three_values() {
        for (raw, want) in [
            ("off", RoutingMode::Off),
            ("shadow", RoutingMode::Shadow),
            ("enforce", RoutingMode::Enforce),
        ] {
            let got: RoutingMode =
                serde_yaml::from_str(&format!("{raw}")).expect("mode parses");
            assert_eq!(got, want, "`{raw}` must parse to {want:?}");
        }
    }
}
