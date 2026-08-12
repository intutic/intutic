//! heartbeat.rs — self-hosted gateway heartbeat client (LLD #66, gateway phase 4).
//!
//! A self-hosted deployment (Docker/Kubernetes/bare-metal, LLD #66 §1) is
//! registered from the dashboard, which mints a `gwk_...` token
//! (`services/control-plane/src/routes/gateways.ts`'s `POST /api/v1/gateways`).
//! This module is what makes that registration *live*: once the operator sets
//! `INTUTIC_GATEWAY_TOKEN`/`INTUTIC_GATEWAY_ID` in the deployment's env, the
//! proxy periodically calls `POST /api/v1/gateways/:id/heartbeat`
//! (`services/control-plane/src/routes/gatewayHeartbeat.ts`) so the org's
//! dashboard can see the gateway is alive.
//!
//! Opt-in, mirroring `gateway.rs`'s absent-flag-means-unchanged-behavior
//! discipline: a proxy with neither env var set behaves exactly as it does
//! today (no outbound calls to this module at all). Both `INTUTIC_GATEWAY_TOKEN`
//! and `INTUTIC_GATEWAY_ID` are required together — the heartbeat endpoint is
//! per-gateway (`:id` in the URL, checked against the token's resolved
//! identity server-side), so a token with no known ID has nothing to call.
//!
//! v1 is deliberately status-up only: firing a heartbeat means "this process
//! is alive and looping," nothing more. There is no local health signal
//! (upstream LiteLLM reachability, active workspace count) collected yet —
//! `status` is always `"online"`, and `activeWorkspaces`/`litellmReachable`
//! are omitted rather than reported as a value this code doesn't actually
//! know. A failed heartbeat call is logged and retried on the next tick; it
//! never panics or blocks request handling, since a control-plane outage on
//! the operator's side must not take down request serving on this pod.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;

/// Heartbeat client configuration, built once at boot from the environment.
#[derive(Debug, Clone)]
pub struct HeartbeatConfig {
    pub gateway_id: String,
    pub gateway_token: String,
    pub control_plane_url: String,
    pub interval: Duration,
}

impl HeartbeatConfig {
    /// `None` means the heartbeat client stays off — either because the
    /// operator hasn't registered this deployment as a self-hosted gateway
    /// (the common case: SaaS gateway, single-tenant local proxy, enterprise
    /// deployment that hasn't opted in yet), or because the env is only
    /// partially configured, which is logged as a warning rather than
    /// silently ignored so a typo doesn't read as "heartbeat just isn't
    /// running for no reason."
    pub fn from_env() -> Option<Self> {
        let gateway_token = std::env::var("INTUTIC_GATEWAY_TOKEN")
            .ok()
            .filter(|v| !v.trim().is_empty())?;

        let gateway_id = match std::env::var("INTUTIC_GATEWAY_ID")
            .ok()
            .filter(|v| !v.trim().is_empty())
        {
            Some(id) => id,
            None => {
                tracing::warn!(
                    "INTUTIC_GATEWAY_TOKEN is set but INTUTIC_GATEWAY_ID is not — self-hosted \
                     gateway heartbeat disabled. Both are required (see the instructions \
                     returned when the gateway was registered from the dashboard)."
                );
                return None;
            }
        };

        let control_plane_url = match std::env::var("CONTROL_PLANE_URL")
            .ok()
            .filter(|v| !v.trim().is_empty())
        {
            Some(u) => u,
            None => {
                tracing::warn!(
                    "INTUTIC_GATEWAY_TOKEN is set but CONTROL_PLANE_URL is not — self-hosted \
                     gateway heartbeat disabled. Set CONTROL_PLANE_URL to the org's Intutic \
                     control plane (e.g. https://api.intutic.ai)."
                );
                return None;
            }
        };

        let interval_secs = std::env::var("INTUTIC_GATEWAY_HEARTBEAT_INTERVAL_SECS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .filter(|&s| s > 0)
            // Well under GATEWAY_HEARTBEAT_TTL=90s on the control-plane side
            // (services/control-plane/src/routes/gatewayHeartbeat.ts) so a
            // single dropped tick doesn't flip the dashboard to unreachable.
            .unwrap_or(30);

        Some(Self {
            gateway_id,
            gateway_token,
            control_plane_url,
            interval: Duration::from_secs(interval_secs),
        })
    }
}

#[derive(Debug, Serialize, PartialEq)]
struct HeartbeatBody {
    status: &'static str,
    #[serde(rename = "proxyVersion")]
    proxy_version: &'static str,
    #[serde(rename = "uptimeSeconds")]
    uptime_seconds: u64,
}

/// Pure — no I/O, no global state — so the payload shape is unit-testable
/// without a running server, same discipline as `gateway::token_allowed`.
fn build_heartbeat_body(uptime_seconds: u64) -> HeartbeatBody {
    HeartbeatBody {
        status: "online",
        proxy_version: env!("CARGO_PKG_VERSION"),
        uptime_seconds,
    }
}

/// Spawns the background heartbeat loop. Fire-and-forget: the returned
/// `JoinHandle` is intentionally dropped by callers (`main.rs` doesn't need
/// to await or cancel it — it runs for the lifetime of the process, same as
/// the guard-liveness probe loop it sits next to).
pub fn spawn_heartbeat_loop(http_client: Arc<reqwest::Client>, cfg: HeartbeatConfig) {
    let url = format!(
        "{}/api/v1/gateways/{}/heartbeat",
        cfg.control_plane_url.trim_end_matches('/'),
        cfg.gateway_id
    );
    let gateway_id = cfg.gateway_id.clone();
    let started = Instant::now();

    tokio::spawn(async move {
        let mut interval = tokio::time::interval(cfg.interval);
        interval.tick().await; // don't fire immediately at boot; wait one full interval first
        loop {
            interval.tick().await;
            let body = build_heartbeat_body(started.elapsed().as_secs());
            match http_client
                .post(&url)
                .bearer_auth(&cfg.gateway_token)
                .json(&body)
                .send()
                .await
            {
                Ok(resp) if resp.status().is_success() => {
                    tracing::debug!(gateway_id = %gateway_id, "gateway heartbeat sent");
                }
                Ok(resp) => {
                    tracing::warn!(
                        gateway_id = %gateway_id,
                        status = %resp.status(),
                        "gateway heartbeat rejected by control plane — will retry next tick"
                    );
                }
                Err(e) => {
                    tracing::warn!(
                        gateway_id = %gateway_id,
                        error = %e,
                        "gateway heartbeat request failed — will retry next tick"
                    );
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heartbeat_body_reports_online_and_real_version() {
        let body = build_heartbeat_body(42);
        assert_eq!(body.status, "online");
        assert_eq!(body.proxy_version, env!("CARGO_PKG_VERSION"));
        assert_eq!(body.uptime_seconds, 42);
    }

    #[test]
    fn heartbeat_body_serializes_to_the_route_schema() {
        // Matches heartbeatSchema in
        // services/control-plane/src/routes/gatewayHeartbeat.ts —
        // status ∈ {"online","degraded"}, proxyVersion/uptimeSeconds present.
        let json = serde_json::to_value(build_heartbeat_body(7)).unwrap();
        assert_eq!(json["status"], "online");
        assert!(json["proxyVersion"].is_string());
        assert_eq!(json["uptimeSeconds"], 7);
    }

    // Every scenario below touches process-global env vars, so — same
    // discipline as gateway.rs's env_var_scenarios_run_sequentially_to_avoid_a_cross_test_race
    // — they're consolidated into one #[test] rather than split out, since
    // cargo runs tests in parallel threads by default and concurrent
    // set_var/remove_var on the same keys races.
    #[test]
    fn from_env_scenarios_run_sequentially_to_avoid_a_cross_test_race() {
        // 1. Neither var set → disabled, the common case.
        std::env::remove_var("INTUTIC_GATEWAY_TOKEN");
        std::env::remove_var("INTUTIC_GATEWAY_ID");
        std::env::remove_var("CONTROL_PLANE_URL");
        assert!(HeartbeatConfig::from_env().is_none());

        // 2. Only the token set (ID and control-plane URL both missing) →
        //    disabled. Isolates the token-alone case before either of the
        //    other two guards could independently explain a None.
        std::env::set_var("INTUTIC_GATEWAY_TOKEN", "gwk_test_token");
        assert!(HeartbeatConfig::from_env().is_none());

        // 3. Token + control-plane URL set, ID still missing → disabled.
        //    CONTROL_PLANE_URL is deliberately set *before* this assertion
        //    (unlike step 2) so a broken/removed ID check is the only thing
        //    that could make this return None — if CONTROL_PLANE_URL were
        //    still unset here, that guard alone would produce the same
        //    None and this assertion would pass even with the ID check
        //    deleted entirely.
        std::env::set_var("CONTROL_PLANE_URL", "https://cp.example.com");
        assert!(HeartbeatConfig::from_env().is_none());

        // 4. All three set → enabled, with the expected default interval.
        std::env::set_var("INTUTIC_GATEWAY_ID", "gw_test123");
        let cfg = HeartbeatConfig::from_env().expect("fully configured, should be Some");
        assert_eq!(cfg.gateway_id, "gw_test123");
        assert_eq!(cfg.gateway_token, "gwk_test_token");
        assert_eq!(cfg.control_plane_url, "https://cp.example.com");
        assert_eq!(cfg.interval, Duration::from_secs(30));

        // 5. Custom interval respected; a non-numeric value falls back to
        //    the default rather than panicking or disabling the client.
        std::env::set_var("INTUTIC_GATEWAY_HEARTBEAT_INTERVAL_SECS", "10");
        assert_eq!(
            HeartbeatConfig::from_env().unwrap().interval,
            Duration::from_secs(10)
        );
        std::env::set_var("INTUTIC_GATEWAY_HEARTBEAT_INTERVAL_SECS", "not-a-number");
        assert_eq!(
            HeartbeatConfig::from_env().unwrap().interval,
            Duration::from_secs(30)
        );
        std::env::set_var("INTUTIC_GATEWAY_HEARTBEAT_INTERVAL_SECS", "0");
        assert_eq!(
            HeartbeatConfig::from_env().unwrap().interval,
            Duration::from_secs(30)
        );

        // Clean up so other tests in the binary that read these same env
        // vars (there are none today, but future ones) start from a known
        // state.
        std::env::remove_var("INTUTIC_GATEWAY_TOKEN");
        std::env::remove_var("INTUTIC_GATEWAY_ID");
        std::env::remove_var("CONTROL_PLANE_URL");
        std::env::remove_var("INTUTIC_GATEWAY_HEARTBEAT_INTERVAL_SECS");
    }

    #[test]
    fn heartbeat_url_joins_control_plane_url_and_gateway_id_correctly() {
        // Not exercised by from_env directly (the URL is built inside
        // spawn_heartbeat_loop), so assert the join logic itself: a trailing
        // slash on CONTROL_PLANE_URL must not produce a double slash.
        let joined = format!(
            "{}/api/v1/gateways/{}/heartbeat",
            "https://cp.example.com/".trim_end_matches('/'),
            "gw_abc"
        );
        assert_eq!(joined, "https://cp.example.com/api/v1/gateways/gw_abc/heartbeat");
    }
}
