//! gateway.rs — the L2 hosted-gateway front door (LLD #64 §2, TD-334 increment 2).
//!
//! A single managed proxy already authenticates and workspace-scopes traffic
//! per request (the `vk_` virtual-key auth in `proxy.rs`). What it does NOT do
//! by default is refuse a **non-`vk_`** credential — and for a single
//! developer's local proxy that is correct: `intutic exec` may hand it a raw
//! Anthropic OAuth token or API key, and the proxy opportunistically stores
//! that credential for the one workspace the developer's own config points at
//! (`workspace:credentials:{ws}`, `proxy.rs`'s "Dynamic session credential
//! capture").
//!
//! On a **shared, multi-tenant gateway** that same behaviour is a hole: the
//! workspace comes from the caller-supplied `x-workspace-id` header, so an
//! unauthenticated request naming an arbitrary workspace and carrying any
//! non-`vk_` bearer token would overwrite *that workspace's* stored upstream
//! credential — before any budget/auth check downstream even runs. This
//! module is the opt-in switch that closes it: when the gateway front door is
//! enabled, only `vk_` virtual keys are accepted, and the credential-capture
//! path is unreachable.
//!
//! Off by default, so a single-tenant local proxy or an enterprise
//! self-hosted deployment serving one company's own developers keeps today's
//! behaviour unchanged. This is a NEW posture beyond "managed" — a company's
//! self-hosted proxy is `managed` (has a control plane) but not necessarily a
//! *shared* gateway serving multiple unrelated tenants, so this is its own
//! flag rather than piggy-backing on `CONTROL_PLANE_URL`.

use serde::Deserialize;
use std::sync::OnceLock;

/// Gateway front-door configuration: `intutic_settings.gateway`.
#[derive(Debug, Deserialize, Clone, Default)]
pub struct GatewayConfig {
    /// When true, only `vk_` virtual keys are accepted — every other bearer
    /// token is refused with 401 before any workspace resolution or
    /// credential capture runs. Off by default.
    #[serde(default)]
    pub require_vk: bool,
    /// LLD #64 §4 — Enforced BYO-key. When true, a workspace with no
    /// deliberately provisioned upstream credential (`workspace:credentials:{ws}`,
    /// set via the dashboard's provider-key panel, never opportunistic capture)
    /// gets refused with 402 instead of silently riding the proxy pod's own
    /// shared `ANTHROPIC_API_KEY`/etc. Off by default: a single-tenant local
    /// proxy or an enterprise self-hosted deployment has no reason to refuse
    /// its own operator-configured shared key. See `fetch_provider_credential`
    /// in `proxy.rs`.
    #[serde(default)]
    pub require_provisioned_key: bool,
    /// LLD #68 §2 phase 2 — local judge for self-hosted gateways. When true,
    /// finalize-time judge evaluation is answered by a LOCAL LiteLLM
    /// instance (`LITELLM_LOCAL_URL`, see `judge_local.rs`) instead of
    /// `{CONTROL_PLANE_URL}/api/v1/judge/finalize` — so the content being
    /// judged never leaves the org's own infrastructure. Off by default:
    /// the SaaS judge path (richer — mid-stream chunk grading, personal
    /// SOPs, incident persistence) stays the default for every deployment
    /// that already has it. Deliberately NOT exposed through `PATCH
    /// .../gateways/:id/config` (remote-config surface) — a gateway
    /// operator turning this on is a statement about where their own
    /// content goes, not something the SaaS control plane should be able
    /// to flip on their behalf.
    #[serde(default)]
    pub local_judge: bool,
}

impl GatewayConfig {
    /// Build from config plus the `INTUTIC_GATEWAY_REQUIRE_VK` /
    /// `INTUTIC_GATEWAY_REQUIRE_PROVISIONED_KEY` env vars (env wins when set
    /// to a recognised value; an unrecognised value is ignored rather than
    /// treated as true — a typo in a *hardening* flag must not silently
    /// soften it, but it also must never silently harden past what config
    /// declared without an explicit, spelled-correctly opt-in).
    pub fn from_config_and_env(cfg: &GatewayConfig) -> GatewayConfig {
        let require_vk = match std::env::var("INTUTIC_GATEWAY_REQUIRE_VK") {
            Ok(v) => match v.trim().to_ascii_lowercase().as_str() {
                "1" | "true" => true,
                "0" | "false" => false,
                _ => cfg.require_vk,
            },
            Err(_) => cfg.require_vk,
        };
        let require_provisioned_key = match std::env::var("INTUTIC_GATEWAY_REQUIRE_PROVISIONED_KEY") {
            Ok(v) => match v.trim().to_ascii_lowercase().as_str() {
                "1" | "true" => true,
                "0" | "false" => false,
                _ => cfg.require_provisioned_key,
            },
            Err(_) => cfg.require_provisioned_key,
        };
        let local_judge = match std::env::var("INTUTIC_GATEWAY_LOCAL_JUDGE") {
            Ok(v) => match v.trim().to_ascii_lowercase().as_str() {
                "1" | "true" => true,
                "0" | "false" => false,
                _ => cfg.local_judge,
            },
            Err(_) => cfg.local_judge,
        };
        GatewayConfig { require_vk, require_provisioned_key, local_judge }
    }
}

static GATEWAY_CONFIG: OnceLock<GatewayConfig> = OnceLock::new();

/// Install the process-wide gateway config. Call once, from `main`, after
/// config load. A second call is ignored, matching the egress policy's
/// set-once discipline for a boot-time security posture.
pub fn init_gateway_config(cfg: GatewayConfig) -> bool {
    let require_vk = cfg.require_vk;
    let _ = GATEWAY_CONFIG.set(cfg);
    GATEWAY_CONFIG.get().map(|c| c.require_vk).unwrap_or(require_vk)
}

/// The installed config, or the safe default (`require_vk: false`) if none
/// was installed — so an uninitialised gateway module never blocks a request
/// that today's behaviour would have allowed (unit tests, embedders).
pub fn gateway_config() -> &'static GatewayConfig {
    static DEFAULT: OnceLock<GatewayConfig> = OnceLock::new();
    GATEWAY_CONFIG
        .get()
        .unwrap_or_else(|| DEFAULT.get_or_init(GatewayConfig::default))
}

/// True if `require_vk` is on. A tiny wrapper so call sites read as intent
/// ("is the gateway front door enforcing vk-only?") rather than reaching into
/// the config struct directly.
pub fn requires_vk_only() -> bool {
    gateway_config().require_vk
}

/// True if `require_provisioned_key` is on (LLD #64 §4, Enforced BYO-key). A
/// tiny wrapper for the same reason as `requires_vk_only` above.
pub fn requires_provisioned_key() -> bool {
    gateway_config().require_provisioned_key
}

/// True if `local_judge` is on (LLD #68 §2 phase 2). A tiny wrapper for the
/// same reason as `requires_vk_only` above.
pub fn uses_local_judge() -> bool {
    gateway_config().local_judge
}

/// The pure decision: is this token acceptable under the current front-door
/// policy? Exported and pure (no I/O, no global state) so it is unit-testable
/// without installing global config.
///
/// `require_vk = false` accepts everything (today's behaviour, unchanged).
/// `require_vk = true` accepts only tokens starting with `vk_`; empty tokens
/// are always rejected regardless (the pre-existing `missing_key` 401 in
/// `proxy.rs` already handles that case, but the decision is correct
/// standalone too — used directly by its unit tests).
pub fn token_allowed(token: &str, require_vk: bool) -> bool {
    if !require_vk {
        return true;
    }
    !token.is_empty() && token.starts_with("vk_")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn off_by_default_accepts_everything() {
        assert!(token_allowed("vk_abc123", false));
        assert!(token_allowed("sk-ant-oat-raw-oauth-token", false));
        assert!(token_allowed("anything at all", false));
    }

    #[test]
    fn require_vk_accepts_only_vk_prefixed_tokens() {
        assert!(token_allowed("vk_abc123_ws_xyz", true));
        assert!(!token_allowed("sk-ant-oat-raw-oauth-token", true));
        assert!(!token_allowed("Bearer vk_looks_like_it_but_has_a_prefix", true));
        assert!(!token_allowed("", true));
    }

    // The four env-var scenarios below run as ONE test function rather than
    // four `#[test]`s: cargo runs tests in parallel threads by default, and
    // `std::env::set_var`/`remove_var` on the same key from concurrent test
    // threads race — this was caught for real (two of the four split-out
    // tests flaked depending on scheduling) before being consolidated.
    #[test]
    fn env_var_scenarios_run_sequentially_to_avoid_a_cross_test_race() {
        // 1. Env override true wins over config false.
        std::env::set_var("INTUTIC_GATEWAY_REQUIRE_VK", "true");
        assert!(GatewayConfig::from_config_and_env(&GatewayConfig { require_vk: false, ..Default::default() }).require_vk);

        // 2. Env override false wins over config true.
        std::env::set_var("INTUTIC_GATEWAY_REQUIRE_VK", "0");
        assert!(!GatewayConfig::from_config_and_env(&GatewayConfig { require_vk: true, ..Default::default() }).require_vk);

        // 3. An unrecognised env value must not silently harden a config-false
        //    workspace — a typo in a hardening flag stays whatever config said.
        std::env::set_var("INTUTIC_GATEWAY_REQUIRE_VK", "yesplease");
        assert!(!GatewayConfig::from_config_and_env(&GatewayConfig { require_vk: false, ..Default::default() }).require_vk);

        // 4. No env var set at all keeps the config value, either direction.
        std::env::remove_var("INTUTIC_GATEWAY_REQUIRE_VK");
        assert!(!GatewayConfig::from_config_and_env(&GatewayConfig { require_vk: false, ..Default::default() }).require_vk);
        assert!(GatewayConfig::from_config_and_env(&GatewayConfig { require_vk: true, ..Default::default() }).require_vk);
    }

    #[test]
    fn uninitialised_global_never_blocks() {
        // Without init_gateway_config(), the accessor must read as "off" so an
        // uninitialised module cannot start refusing traffic that worked before
        // this feature existed.
        assert!(!requires_vk_only());
        assert!(token_allowed("sk-ant-anything", requires_vk_only()));
    }

    // ── require_provisioned_key (LLD #64 §4) ────────────────────────────

    #[test]
    fn require_provisioned_key_off_by_default() {
        assert!(!GatewayConfig::default().require_provisioned_key);
    }

    // Same single-test consolidation as the require_vk env-var scenarios
    // above, for the same reason: std::env::set_var/remove_var on the same
    // key from concurrent test threads races.
    #[test]
    fn require_provisioned_key_env_var_scenarios_run_sequentially() {
        std::env::set_var("INTUTIC_GATEWAY_REQUIRE_PROVISIONED_KEY", "true");
        assert!(
            GatewayConfig::from_config_and_env(&GatewayConfig {
                require_vk: false,
                require_provisioned_key: false,
                ..Default::default()
            })
            .require_provisioned_key
        );

        std::env::set_var("INTUTIC_GATEWAY_REQUIRE_PROVISIONED_KEY", "0");
        assert!(
            !GatewayConfig::from_config_and_env(&GatewayConfig {
                require_vk: false,
                require_provisioned_key: true,
                ..Default::default()
            })
            .require_provisioned_key
        );

        // An unrecognised value must not silently harden a config-false
        // workspace -- same "typo in a hardening flag" discipline as require_vk.
        std::env::set_var("INTUTIC_GATEWAY_REQUIRE_PROVISIONED_KEY", "yesplease");
        assert!(
            !GatewayConfig::from_config_and_env(&GatewayConfig {
                require_vk: false,
                require_provisioned_key: false,
                ..Default::default()
            })
            .require_provisioned_key
        );

        std::env::remove_var("INTUTIC_GATEWAY_REQUIRE_PROVISIONED_KEY");
        assert!(
            !GatewayConfig::from_config_and_env(&GatewayConfig {
                require_vk: false,
                require_provisioned_key: false,
                ..Default::default()
            })
            .require_provisioned_key
        );
        // Deliberately does NOT touch INTUTIC_GATEWAY_REQUIRE_VK here: that
        // var is exclusively owned by
        // `env_var_scenarios_run_sequentially_to_avoid_a_cross_test_race`
        // above, and #[test] functions run concurrently by default -- two
        // functions mutating the same process-global env var would
        // reintroduce the exact race this file's existing tests already
        // work around. The two config fields are independent by
        // construction (separate, non-interacting `match` arms in
        // `from_config_and_env`), so there is no runtime behavior here that
        // needs a cross-var test to catch.
    }

    #[test]
    fn uninitialised_global_never_requires_provisioned_key() {
        assert!(!requires_provisioned_key());
    }
}
