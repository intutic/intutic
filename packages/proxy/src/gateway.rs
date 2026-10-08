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
use std::sync::{OnceLock, PoisonError, RwLock};

/// Gateway front-door configuration: `intutic_settings.gateway`.
///
/// `requireVk` and `requireProvisionedKey` can also be set remotely
/// (`intutic gateway config set`, i.e. `PATCH /api/v1/gateways/:id/config`):
/// a registered self-hosted gateway pulls them on its heartbeat
/// (`heartbeat.rs`) and lays them over this boot config with
/// [`apply_remote_gateway_config`], without a restart.
#[derive(Debug, Deserialize, Clone, Copy, Default)]
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
    /// Narrows `require_provisioned_key` to the workspaces the control plane
    /// marks `byokRequired` on their key (paid plans, minus trials and the
    /// operator's exempt list) — the hosted gateway's posture, where a free
    /// trial may ride the platform key but a paying tier brings its own. Set
    /// by `INTUTIC_GATEWAY_REQUIRE_PROVISIONED_KEY=paid`. Has no effect while
    /// `require_provisioned_key` is off. See `provisioned_key_required`.
    #[serde(default)]
    pub provisioned_key_paid_only: bool,
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
        // `paid` turns enforcement on for paying workspaces only; `true` keeps
        // its original meaning (every workspace), so a deployment already
        // running with `true` is unchanged.
        let (require_provisioned_key, provisioned_key_paid_only) =
            match std::env::var("INTUTIC_GATEWAY_REQUIRE_PROVISIONED_KEY") {
                Ok(v) => match v.trim().to_ascii_lowercase().as_str() {
                    "1" | "true" => (true, false),
                    "paid" => (true, true),
                    "0" | "false" => (false, false),
                    _ => (cfg.require_provisioned_key, cfg.provisioned_key_paid_only),
                },
                Err(_) => (cfg.require_provisioned_key, cfg.provisioned_key_paid_only),
            };
        let local_judge = match std::env::var("INTUTIC_GATEWAY_LOCAL_JUDGE") {
            Ok(v) => match v.trim().to_ascii_lowercase().as_str() {
                "1" | "true" => true,
                "0" | "false" => false,
                _ => cfg.local_judge,
            },
            Err(_) => cfg.local_judge,
        };
        GatewayConfig {
            require_vk,
            require_provisioned_key,
            provisioned_key_paid_only,
            local_judge,
        }
    }
}

/// The config this process booted with (config file + env). Kept apart from
/// the live config so a remote overlay is always laid over the boot values,
/// never over a previous overlay.
static BOOT_CONFIG: OnceLock<GatewayConfig> = OnceLock::new();

/// What every request is checked against. Replaced whole under the write
/// lock, so a reader sees the old config or the new one, never a mix of the
/// two. `None` until `init_gateway_config` runs.
static LIVE_CONFIG: RwLock<Option<GatewayConfig>> = RwLock::new(None);

/// Install the process-wide boot config. Call once, from `main`, after config
/// load. A second call is ignored, matching the egress policy's set-once
/// discipline for a boot-time security posture; the remotely set fields
/// change afterwards only through [`apply_remote_gateway_config`].
pub fn init_gateway_config(cfg: GatewayConfig) -> bool {
    if BOOT_CONFIG.set(cfg).is_ok() {
        *LIVE_CONFIG.write().unwrap_or_else(PoisonError::into_inner) = Some(cfg);
    }
    gateway_config().require_vk
}

/// The live config, or the safe default (`require_vk: false`) if none was
/// installed — so an uninitialised gateway module never blocks a request that
/// today's behaviour would have allowed (unit tests, embedders). A copy, so
/// the caller decides against one consistent snapshot.
pub fn gateway_config() -> GatewayConfig {
    LIVE_CONFIG
        .read()
        .unwrap_or_else(PoisonError::into_inner)
        .unwrap_or_default()
}

/// Swap in the boot config with `remote` laid over it, and return what is now
/// live. Takes effect for the next request; nothing restarts.
pub fn apply_remote_gateway_config(remote: &RemoteGatewayConfig) -> GatewayConfig {
    let next = remote.apply_to(&BOOT_CONFIG.get().copied().unwrap_or_default());
    *LIVE_CONFIG.write().unwrap_or_else(PoisonError::into_inner) = Some(next);
    next
}

/// The remotely set part of [`GatewayConfig`], as `GET
/// /api/v1/gateways/:id/config` returns it. `None` means nobody set that
/// field remotely, so the boot value stands. `localJudge` is deliberately not
/// here: where judged content goes is the operator's decision, never the
/// control plane's.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RemoteGatewayConfig {
    pub require_vk: Option<bool>,
    pub require_provisioned_key: Option<bool>,
}

impl RemoteGatewayConfig {
    /// Parse the route's `config` object. All or nothing: a known field with a
    /// value that is not a boolean rejects the whole object, so a config this
    /// proxy only half understands is never applied. Unknown fields (written
    /// by a newer control plane) are returned for the caller to log, and
    /// otherwise ignored.
    pub fn from_json(
        config: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<(Self, Vec<String>), String> {
        let mut remote = Self::default();
        let mut unknown = Vec::new();
        for (key, value) in config {
            let field = match key.as_str() {
                "requireVk" => &mut remote.require_vk,
                "requireProvisionedKey" => &mut remote.require_provisioned_key,
                _ => {
                    unknown.push(key.clone());
                    continue;
                }
            };
            *field = Some(
                value
                    .as_bool()
                    .ok_or_else(|| format!("{key} must be a boolean, got {value}"))?,
            );
        }
        Ok((remote, unknown))
    }

    /// `boot` with every remotely set field laid over it. A field means
    /// what its env var means: `requireProvisionedKey: true` enforces for
    /// every workspace, as `INTUTIC_GATEWAY_REQUIRE_PROVISIONED_KEY=true`
    /// does, not only paying ones (`=paid`).
    pub fn apply_to(&self, boot: &GatewayConfig) -> GatewayConfig {
        let mut next = *boot;
        if let Some(require_vk) = self.require_vk {
            next.require_vk = require_vk;
        }
        if let Some(required) = self.require_provisioned_key {
            next.require_provisioned_key = required;
            next.provisioned_key_paid_only = false;
        }
        next
    }
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

/// Whether this request's workspace must use its own provider key, given the
/// installed config and the key record's `byokRequired` (from the control
/// plane's cached auth entry or `/auth/key-context`).
pub fn provisioned_key_required_for(byok_required: Option<bool>) -> bool {
    provisioned_key_required(&gateway_config(), byok_required)
}

/// The pure decision behind `provisioned_key_required_for`. Under `paid`, only
/// an explicit `Some(false)` exempts a workspace: an entry that predates the
/// field (or a control plane that never sends it) enforces, so a missing
/// answer can never put a paying workspace on the platform key.
pub fn provisioned_key_required(cfg: &GatewayConfig, byok_required: Option<bool>) -> bool {
    cfg.require_provisioned_key && !(cfg.provisioned_key_paid_only && byok_required == Some(false))
}

/// True if `local_judge` is on (LLD #68 §2 phase 2). A tiny wrapper for the
/// same reason as `requires_vk_only` above.
pub fn uses_local_judge() -> bool {
    gateway_config().local_judge
}

/// The org this deployment is a dedicated managed cell for (LLD #71), or
/// `None` — the shared gateway and every self-hosted deployment. Set by the
/// cell provisioner via `INTUTIC_GATEWAY_ORG_ID` in the cell's pod env; read
/// once (a boot-time security posture, same set-once discipline as
/// `GATEWAY_CONFIG`). A pinned cell also sets `INTUTIC_GATEWAY_REQUIRE_VK=true`
/// — pinning only ever evaluates vk-authenticated identities, and the vk-only
/// front door is what guarantees every request has one.
pub fn cell_org_pin() -> Option<&'static str> {
    static PIN: OnceLock<Option<String>> = OnceLock::new();
    PIN.get_or_init(|| {
        std::env::var("INTUTIC_GATEWAY_ORG_ID")
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    })
    .as_deref()
}

/// A pinned cell's admission decision for one authenticated key. Pure — no
/// I/O, no globals — so every arm is unit-testable.
#[derive(Debug, PartialEq, Eq)]
pub enum OrgPinDecision {
    /// The key's workspace belongs to this cell's org.
    Allow,
    /// The key belongs to a DIFFERENT org → 403. Never a fall-through: a
    /// cell serving another org's traffic is the exact cross-tenant exposure
    /// dedicated cells exist to remove.
    Mismatch,
    /// The record carries no org (a cached auth entry written before the
    /// control plane included the field). Not a verdict — the caller must
    /// revalidate against the control plane, whose `/auth/key-context` is
    /// authoritative, and fail CLOSED if the org still cannot be
    /// established. Guessing "probably fine" here would quietly disable the
    /// pin for exactly the entries least likely to be fresh.
    Unverified,
}

pub fn org_pin_decision(pinned_org: &str, record_org: Option<&str>) -> OrgPinDecision {
    match record_org {
        Some(org) if org == pinned_org => OrgPinDecision::Allow,
        Some(_) => OrgPinDecision::Mismatch,
        None => OrgPinDecision::Unverified,
    }
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
        assert!(!token_allowed(
            "Bearer vk_looks_like_it_but_has_a_prefix",
            true
        ));
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
        assert!(
            GatewayConfig::from_config_and_env(&GatewayConfig {
                require_vk: false,
                ..Default::default()
            })
            .require_vk
        );

        // 2. Env override false wins over config true.
        std::env::set_var("INTUTIC_GATEWAY_REQUIRE_VK", "0");
        assert!(
            !GatewayConfig::from_config_and_env(&GatewayConfig {
                require_vk: true,
                ..Default::default()
            })
            .require_vk
        );

        // 3. An unrecognised env value must not silently harden a config-false
        //    workspace — a typo in a hardening flag stays whatever config said.
        std::env::set_var("INTUTIC_GATEWAY_REQUIRE_VK", "yesplease");
        assert!(
            !GatewayConfig::from_config_and_env(&GatewayConfig {
                require_vk: false,
                ..Default::default()
            })
            .require_vk
        );

        // 4. No env var set at all keeps the config value, either direction.
        std::env::remove_var("INTUTIC_GATEWAY_REQUIRE_VK");
        assert!(
            !GatewayConfig::from_config_and_env(&GatewayConfig {
                require_vk: false,
                ..Default::default()
            })
            .require_vk
        );
        assert!(
            GatewayConfig::from_config_and_env(&GatewayConfig {
                require_vk: true,
                ..Default::default()
            })
            .require_vk
        );
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

        // `paid` = enforcement on, narrowed to paying workspaces; `true` keeps
        // meaning every workspace, even over a config that said paid-only.
        std::env::set_var("INTUTIC_GATEWAY_REQUIRE_PROVISIONED_KEY", "paid");
        let paid = GatewayConfig::from_config_and_env(&GatewayConfig::default());
        assert!(paid.require_provisioned_key && paid.provisioned_key_paid_only);
        std::env::set_var("INTUTIC_GATEWAY_REQUIRE_PROVISIONED_KEY", "true");
        let all = GatewayConfig::from_config_and_env(&GatewayConfig {
            require_provisioned_key: true,
            provisioned_key_paid_only: true,
            ..Default::default()
        });
        assert!(all.require_provisioned_key && !all.provisioned_key_paid_only);
        std::env::remove_var("INTUTIC_GATEWAY_REQUIRE_PROVISIONED_KEY");
    }

    #[test]
    fn provisioned_key_required_by_mode_and_workspace_answer() {
        let off = GatewayConfig::default();
        let all = GatewayConfig {
            require_provisioned_key: true,
            ..Default::default()
        };
        let paid = GatewayConfig {
            require_provisioned_key: true,
            provisioned_key_paid_only: true,
            ..Default::default()
        };
        for answer in [Some(true), Some(false), None] {
            assert!(
                !provisioned_key_required(&off, answer),
                "off never enforces ({answer:?})"
            );
            assert!(
                provisioned_key_required(&all, answer),
                "true enforces everywhere ({answer:?})"
            );
        }
        assert!(
            provisioned_key_required(&paid, Some(true)),
            "paid plan brings its own key"
        );
        assert!(
            !provisioned_key_required(&paid, Some(false)),
            "trial/exempt rides the platform key"
        );
        assert!(
            provisioned_key_required(&paid, None),
            "no answer from the control plane enforces"
        );
        // paid-only without the main switch is inert.
        let inert = GatewayConfig {
            provisioned_key_paid_only: true,
            ..Default::default()
        };
        assert!(!provisioned_key_required(&inert, Some(true)));
    }

    #[test]
    fn uninitialised_global_never_requires_provisioned_key() {
        assert!(!requires_provisioned_key());
    }

    // ── Remotely set config (pulled on the heartbeat) ───────────────────

    fn remote_json(value: serde_json::Value) -> serde_json::Map<String, serde_json::Value> {
        value.as_object().expect("an object").clone()
    }

    #[test]
    fn remote_config_parses_known_fields_and_reports_unknown_ones() {
        let (remote, unknown) = RemoteGatewayConfig::from_json(&remote_json(
            serde_json::json!({ "requireVk": true, "localJudge": true, "futureKnob": 3 }),
        ))
        .unwrap();
        assert_eq!(
            remote,
            RemoteGatewayConfig {
                require_vk: Some(true),
                require_provisioned_key: None,
            }
        );
        let mut unknown = unknown;
        unknown.sort();
        assert_eq!(unknown, ["futureKnob", "localJudge"]);

        let (empty, none) = RemoteGatewayConfig::from_json(&serde_json::Map::new()).unwrap();
        assert_eq!(empty, RemoteGatewayConfig::default());
        assert!(none.is_empty());
    }

    #[test]
    fn remote_config_with_a_mistyped_known_field_is_rejected_whole() {
        // requireVk parses fine on its own; the bad sibling must still sink the
        // whole object rather than apply half of it.
        let err = RemoteGatewayConfig::from_json(&remote_json(
            serde_json::json!({ "requireVk": true, "requireProvisionedKey": "yes" }),
        ))
        .unwrap_err();
        assert!(err.contains("requireProvisionedKey"), "{err}");
        assert!(RemoteGatewayConfig::from_json(&remote_json(
            serde_json::json!({ "requireVk": null })
        ))
        .is_err());
    }

    #[test]
    fn remote_config_overlays_only_the_fields_it_sets() {
        let boot = GatewayConfig {
            require_vk: true,
            require_provisioned_key: true,
            provisioned_key_paid_only: true,
            local_judge: true,
        };
        // Nothing set: the boot config, unchanged.
        let same = RemoteGatewayConfig::default().apply_to(&boot);
        assert!(same.require_vk && same.require_provisioned_key && same.provisioned_key_paid_only);

        let vk_off = RemoteGatewayConfig {
            require_vk: Some(false),
            require_provisioned_key: None,
        }
        .apply_to(&boot);
        assert!(!vk_off.require_vk);
        assert!(vk_off.require_provisioned_key && vk_off.provisioned_key_paid_only);
        assert!(vk_off.local_judge, "local judge is never remotely set");

        // true means every workspace, as the env var's `true` does.
        let all = RemoteGatewayConfig {
            require_vk: None,
            require_provisioned_key: Some(true),
        }
        .apply_to(&boot);
        assert!(all.require_provisioned_key && !all.provisioned_key_paid_only);
        let off = RemoteGatewayConfig {
            require_vk: None,
            require_provisioned_key: Some(false),
        }
        .apply_to(&boot);
        assert!(!off.require_provisioned_key);
    }

    // LLD #71 — the pure cell-admission decision, every arm. The Unverified
    // arm is the one worth staring at: it must be a distinct value, NOT a
    // pass and NOT a mismatch, because the caller's contract is "revalidate
    // then fail closed" — collapsing it into Allow would silently disable
    // the pin for stale cache entries, and collapsing it into Mismatch
    // would 403 valid keys for one cache-TTL after every deploy of this
    // feature.
    #[test]
    fn org_pin_decision_covers_match_mismatch_and_unknown() {
        assert_eq!(
            org_pin_decision("org_a", Some("org_a")),
            OrgPinDecision::Allow
        );
        assert_eq!(
            org_pin_decision("org_a", Some("org_b")),
            OrgPinDecision::Mismatch
        );
        assert_eq!(org_pin_decision("org_a", None), OrgPinDecision::Unverified);
        // Exact string equality — no prefix/suffix leniency that could let
        // "org_a2" ride "org_a"'s cell.
        assert_eq!(
            org_pin_decision("org_a", Some("org_a2")),
            OrgPinDecision::Mismatch
        );
    }

    // Deliberately does NOT test cell_org_pin() itself: it reads a
    // process-global env var through a OnceLock, so a test that sets
    // INTUTIC_GATEWAY_ORG_ID would race every other test AND freeze the
    // value for the rest of the process. The decision logic above is the
    // load-bearing part; the env read is the same three-line pattern
    // from_config_and_env already exercises.
}
