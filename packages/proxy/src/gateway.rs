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
}

impl GatewayConfig {
    /// Build from config plus the `INTUTIC_GATEWAY_REQUIRE_VK` env var (env
    /// wins when set to a recognised value; an unrecognised value is ignored
    /// rather than treated as true — a typo in a *hardening* flag must not
    /// silently soften it, but it also must never silently harden past what
    /// config declared without an explicit, spelled-correctly opt-in).
    pub fn from_config_and_env(cfg: &GatewayConfig) -> GatewayConfig {
        let require_vk = match std::env::var("INTUTIC_GATEWAY_REQUIRE_VK") {
            Ok(v) => match v.trim().to_ascii_lowercase().as_str() {
                "1" | "true" => true,
                "0" | "false" => false,
                _ => cfg.require_vk,
            },
            Err(_) => cfg.require_vk,
        };
        GatewayConfig { require_vk }
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
        assert!(GatewayConfig::from_config_and_env(&GatewayConfig { require_vk: false }).require_vk);

        // 2. Env override false wins over config true.
        std::env::set_var("INTUTIC_GATEWAY_REQUIRE_VK", "0");
        assert!(!GatewayConfig::from_config_and_env(&GatewayConfig { require_vk: true }).require_vk);

        // 3. An unrecognised env value must not silently harden a config-false
        //    workspace — a typo in a hardening flag stays whatever config said.
        std::env::set_var("INTUTIC_GATEWAY_REQUIRE_VK", "yesplease");
        assert!(!GatewayConfig::from_config_and_env(&GatewayConfig { require_vk: false }).require_vk);

        // 4. No env var set at all keeps the config value, either direction.
        std::env::remove_var("INTUTIC_GATEWAY_REQUIRE_VK");
        assert!(!GatewayConfig::from_config_and_env(&GatewayConfig { require_vk: false }).require_vk);
        assert!(GatewayConfig::from_config_and_env(&GatewayConfig { require_vk: true }).require_vk);
    }

    #[test]
    fn uninitialised_global_never_blocks() {
        // Without init_gateway_config(), the accessor must read as "off" so an
        // uninitialised module cannot start refusing traffic that worked before
        // this feature existed.
        assert!(!requires_vk_only());
        assert!(token_allowed("sk-ant-anything", requires_vk_only()));
    }
}
