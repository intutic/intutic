//! egress_policy.rs — the L1 enforcement layer (LLD #63 §4).
//!
//! Today the proxy TLS-MITMs AI-provider hosts and tunnels everything else
//! through untouched (`tls_mitm::handle_connect`). That is mediation, not
//! control: it can inspect an AI call, but it cannot *deny* a connection to
//! anywhere. This module adds the decision that turns the proxy into an egress
//! chokepoint — for the traffic that reaches it. Layers L2 (host firewall) and
//! L3 (sandbox) are what make reaching it non-optional; see the LLD.
//!
//! ## The three modes
//!
//! - `Off`     — today's behaviour exactly: AI hosts are intercepted, every
//!               other host is tunnelled. Nothing is ever denied. This is the
//!               default, so an existing deployment sees no change.
//! - `Monitor` — same connectivity as `Off` (nothing is denied), but every
//!               connection that *would* be denied under `Enforce` is logged as
//!               `egress_would_deny`. This lets an operator measure blast radius
//!               before committing to enforcement.
//! - `Enforce` — AI hosts are intercepted; hosts on the allow policy are
//!               tunnelled; **everything else is denied** (the CONNECT gets a
//!               403 and no tunnel is opened).
//!
//! ## The allow policy
//!
//! A host is allowed when it is a built-in AI provider (`hostname_filter`), or
//! it matches an operator allow entry. Allow entries come from config
//! (`intutic_settings.egress.allow`) and the `INTUTIC_EGRESS_ALLOW` env var
//! (comma-separated; merged with config). Three entry forms:
//!
//! - exact host      — `api.internal.corp` matches that host and its subdomains
//!                      (`x.api.internal.corp`), mirroring `hostname_filter`.
//! - leading-dot     — `.internal.corp` matches any host ending in that suffix.
//! - CIDR / bare IP  — `10.0.0.0/8`, `192.168.1.5` match an **IP-literal**
//!                      CONNECT target inside the range.
//!
//! CIDR entries match only when the CONNECT target is itself an IP literal. We
//! deliberately do not resolve DNS names here: a resolve in the hot path would
//! be both a latency cost and a spoofing surface (the name could resolve to a
//! different address than the one the kernel will dial). Name policy is matched
//! by name; address policy is matched by address.

use std::collections::BTreeSet;
use std::net::IpAddr;
use std::path::Path;
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, RwLock};

use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::hostname_filter::is_ai_provider_host;
use crate::paths::intutic_dir;

/// How aggressively the proxy enforces egress. Defaults to `Off` so an existing
/// config keeps its exact behaviour (no connection is ever denied).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum EgressMode {
    #[default]
    Off,
    Monitor,
    Enforce,
}

impl EgressMode {
    /// Parse from a free-form string (env var). Unknown values fall back to the
    /// safe default (`Off`) rather than failing the boot — an operator typo in
    /// an *enforcement* knob must never silently harden into a deny-all.
    pub fn parse_lenient(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "enforce" => EgressMode::Enforce,
            "monitor" => EgressMode::Monitor,
            _ => EgressMode::Off,
        }
    }
}

/// What to do with one CONNECT target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EgressDecision {
    /// AI provider host — terminate TLS and run the governance pipeline.
    Mitm,
    /// Permitted — open the transparent tunnel.
    Allow,
    /// Blocked (`Enforce` only) — refuse the CONNECT, open no tunnel.
    Deny,
    /// Would be blocked under `Enforce`, but `Monitor` mode lets it through.
    /// The caller opens the tunnel *and* logs it, so blast radius is visible.
    WouldDeny,
}

/// Deserialized config block: `intutic_settings.egress`.
#[derive(Debug, Deserialize, Clone, Default)]
pub struct EgressConfig {
    #[serde(default)]
    pub mode: EgressMode,
    /// Allow entries (exact host, `.suffix`, or CIDR/bare-IP). Merged with
    /// `INTUTIC_EGRESS_ALLOW`.
    #[serde(default)]
    pub allow: Vec<String>,
}

/// One CIDR block, family-tagged, stored as the masked network + prefix length.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Cidr {
    V4 { net: u32, prefix: u8 },
    V6 { net: u128, prefix: u8 },
}

impl Cidr {
    /// Parse `"10.0.0.0/8"`, `"::1/128"`, or a bare IP (treated as a /32 or
    /// /128). Returns `None` for anything that is not an IP or CIDR — those
    /// entries are treated as host/domain rules instead.
    fn parse(entry: &str) -> Option<Cidr> {
        let (addr_part, prefix_part) = match entry.split_once('/') {
            Some((a, p)) => (a, Some(p)),
            None => (entry, None),
        };
        let ip = IpAddr::from_str(addr_part.trim()).ok()?;
        match ip {
            IpAddr::V4(v4) => {
                let prefix = match prefix_part {
                    Some(p) => p.trim().parse::<u8>().ok().filter(|&n| n <= 32)?,
                    None => 32,
                };
                let bits = u32::from(v4);
                Some(Cidr::V4 { net: mask_u32(bits, prefix), prefix })
            }
            IpAddr::V6(v6) => {
                let prefix = match prefix_part {
                    Some(p) => p.trim().parse::<u8>().ok().filter(|&n| n <= 128)?,
                    None => 128,
                };
                let bits = u128::from(v6);
                Some(Cidr::V6 { net: mask_u128(bits, prefix), prefix })
            }
        }
    }

    fn contains(&self, ip: &IpAddr) -> bool {
        match (self, ip) {
            (Cidr::V4 { net, prefix }, IpAddr::V4(v4)) => {
                mask_u32(u32::from(*v4), *prefix) == *net
            }
            (Cidr::V6 { net, prefix }, IpAddr::V6(v6)) => {
                mask_u128(u128::from(*v6), *prefix) == *net
            }
            _ => false, // cross-family never matches
        }
    }
}

/// Strip a trailing `:port` from a CONNECT authority *without* mangling an
/// IPv6 literal. A naive `split(':')` truncates `2001:db8::1` to `2001`, so we
/// handle the three forms the authority can take: bracketed (`[::1]:443`), a
/// bare IPv6 literal (more than one colon, no port), and the ordinary
/// `host:port` / plain-host case. Returns a lower-cased host.
fn normalize_host(h: &str) -> String {
    let h = h.trim();
    // Bracketed IPv6, with or without a port: [::1] or [2001:db8::1]:443
    if let Some(rest) = h.strip_prefix('[') {
        if let Some(end) = rest.find(']') {
            return rest[..end].to_ascii_lowercase();
        }
    }
    // A bare IPv6 literal has more than one colon and no port suffix we can
    // safely strip — use it as-is.
    if h.matches(':').count() > 1 {
        return h.to_ascii_lowercase();
    }
    // Ordinary host:port or plain host.
    h.split(':').next().unwrap_or(h).to_ascii_lowercase()
}

fn mask_u32(bits: u32, prefix: u8) -> u32 {
    if prefix == 0 {
        0
    } else {
        let mask = u32::MAX << (32 - prefix as u32);
        bits & mask
    }
}

fn mask_u128(bits: u128, prefix: u8) -> u128 {
    if prefix == 0 {
        0
    } else {
        let mask = u128::MAX << (128 - prefix as u32);
        bits & mask
    }
}

/// The compiled egress policy. Built once at startup from config + env, then
/// consulted by `handle_connect` on every CONNECT.
#[derive(Debug, Clone, Default)]
pub struct EgressPolicy {
    mode: EgressMode,
    /// Exact-host and `.suffix` allow entries, lower-cased.
    host_rules: Vec<String>,
    cidr_rules: Vec<Cidr>,
}

impl EgressPolicy {
    /// Build from a config block plus the `INTUTIC_EGRESS_MODE` /
    /// `INTUTIC_EGRESS_ALLOW` env vars. Env mode overrides config mode; env
    /// allow entries are added to (not replacing) config ones.
    pub fn from_config_and_env(cfg: &EgressConfig) -> EgressPolicy {
        let mode = match std::env::var("INTUTIC_EGRESS_MODE") {
            Ok(v) if !v.trim().is_empty() => EgressMode::parse_lenient(&v),
            _ => cfg.mode,
        };

        let mut entries: BTreeSet<String> = BTreeSet::new();
        for e in &cfg.allow {
            let t = e.trim();
            if !t.is_empty() {
                entries.insert(t.to_string());
            }
        }
        if let Ok(env_allow) = std::env::var("INTUTIC_EGRESS_ALLOW") {
            for e in env_allow.split(',') {
                let t = e.trim();
                if !t.is_empty() {
                    entries.insert(t.to_string());
                }
            }
        }

        Self::from_entries(mode, entries.into_iter())
    }

    /// Core constructor, split out so tests can build a policy without touching
    /// process env.
    pub fn from_entries<I: IntoIterator<Item = String>>(mode: EgressMode, entries: I) -> EgressPolicy {
        let mut host_rules = Vec::new();
        let mut cidr_rules = Vec::new();
        for e in entries {
            let e = e.trim();
            if e.is_empty() {
                continue;
            }
            if let Some(c) = Cidr::parse(e) {
                cidr_rules.push(c);
            } else {
                host_rules.push(e.to_ascii_lowercase());
            }
        }
        EgressPolicy { mode, host_rules, cidr_rules }
    }

    pub fn mode(&self) -> EgressMode {
        self.mode
    }

    /// Return a copy of this policy with a central (control-plane) policy layered
    /// on top (LLD #63 §4). The central `mode`, when present, is authoritative;
    /// the central allow entries are **unioned** with the local ones, so a
    /// developer's local infra allowances are never dropped by a central list.
    /// A central `mode` of `None` (central management not configured) leaves the
    /// local mode untouched.
    pub fn with_central(&self, central_mode: Option<EgressMode>, central_allow: &[String]) -> EgressPolicy {
        let mut host_rules = self.host_rules.clone();
        let mut cidr_rules = self.cidr_rules.clone();
        for e in central_allow {
            let e = e.trim();
            if e.is_empty() {
                continue;
            }
            if let Some(c) = Cidr::parse(e) {
                if !cidr_rules.contains(&c) {
                    cidr_rules.push(c);
                }
            } else {
                let lower = e.to_ascii_lowercase();
                if !host_rules.contains(&lower) {
                    host_rules.push(lower);
                }
            }
        }
        EgressPolicy {
            mode: central_mode.unwrap_or(self.mode),
            host_rules,
            cidr_rules,
        }
    }

    /// True if `host` matches an operator allow entry (host/domain rules only;
    /// CIDR rules are checked separately against IP-literal targets).
    fn host_allowed(&self, host: &str) -> bool {
        let host = normalize_host(host);
        self.host_rules.iter().any(|rule| {
            if let Some(suffix) = rule.strip_prefix('.') {
                // ".internal.corp" → matches host ending in ".internal.corp"
                // and the bare "internal.corp" itself.
                host == suffix || host.ends_with(&format!(".{suffix}"))
            } else {
                // "example.com" → matches "example.com" and "*.example.com",
                // never "notexample.com" (mirrors hostname_filter).
                host == *rule || host.ends_with(&format!(".{rule}"))
            }
        })
    }

    fn ip_allowed(&self, host: &str) -> bool {
        let host = normalize_host(host);
        match IpAddr::from_str(&host) {
            Ok(ip) => self.cidr_rules.iter().any(|c| c.contains(&ip)),
            Err(_) => false, // not an IP literal — CIDR rules do not apply
        }
    }

    /// The decision for one CONNECT target. AI-provider hosts are always
    /// `Mitm` regardless of mode — governance of AI traffic is the point, and
    /// intercepting is stricter than tunnelling, never looser.
    pub fn decide(&self, host: &str, _port: u16) -> EgressDecision {
        if is_ai_provider_host(host) {
            return EgressDecision::Mitm;
        }
        match self.mode {
            EgressMode::Off => EgressDecision::Allow,
            EgressMode::Monitor => {
                if self.host_allowed(host) || self.ip_allowed(host) {
                    EgressDecision::Allow
                } else {
                    EgressDecision::WouldDeny
                }
            }
            EgressMode::Enforce => {
                if self.host_allowed(host) || self.ip_allowed(host) {
                    EgressDecision::Allow
                } else {
                    EgressDecision::Deny
                }
            }
        }
    }
}

/// One central egress policy as read from the daemon-written file: the
/// authoritative mode (or `None` = central management not configured) and the
/// allow entries to union with local config.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CentralEgressPolicy {
    pub mode: Option<EgressMode>,
    pub allow: Vec<String>,
}

/// Default location of the daemon-written central egress policy:
/// `~/.intutic/hooks/egress-policy.json` (same directory as the policy
/// snapshot). Overridable with `INTUTIC_EGRESS_POLICY_FILE` (tests, non-default
/// homes).
pub fn default_egress_policy_path() -> std::path::PathBuf {
    if let Ok(p) = std::env::var("INTUTIC_EGRESS_POLICY_FILE") {
        if !p.trim().is_empty() {
            return std::path::PathBuf::from(p);
        }
    }
    intutic_dir().join("hooks").join("egress-policy.json")
}

/// Parse a daemon-written `egress-policy.json` (LLD #63 §4), verifying its
/// digest and — when a workspace id is known — its workspace. Returns the
/// central policy it declares, or `None` on any error / mismatch. Fail-closed
/// toward local config: a corrupt, foreign, or unparseable file degrades to
/// "keep the config-derived policy", never to weaker enforcement than the
/// operator configured.
pub fn load_local_egress_file(
    path: &Path,
    expected_workspace: Option<&str>,
) -> Option<CentralEgressPolicy> {
    let text = std::fs::read_to_string(path).ok()?;
    let doc: serde_json::Value = serde_json::from_str(&text).ok()?;

    let workspace = doc.get("workspace")?.as_str()?;
    if let Some(expected) = expected_workspace {
        if workspace != expected {
            return None; // a file written for a different workspace
        }
    }
    let file_digest = doc.get("digest")?.as_str()?;

    // `mode` is a string (off/monitor/enforce) or JSON null (central management
    // not configured). An unknown string is rejected rather than guessed.
    let mode_str = doc.get("mode").and_then(|m| m.as_str());
    let mode = match mode_str {
        Some("off") => Some(EgressMode::Off),
        Some("monitor") => Some(EgressMode::Monitor),
        Some("enforce") => Some(EgressMode::Enforce),
        None => None,
        Some(_) => return None,
    };
    let allow: Vec<String> = doc
        .get("allow")?
        .as_array()?
        .iter()
        .filter_map(|v| v.as_str().map(str::to_string))
        .collect();

    // Recompute the digest over the SAME canonical string the daemon used:
    // `mode-or-empty` then each allow entry, newline-joined (see egressPolicy.ts
    // `egressDigestInput`). A mismatch means truncation or tampering.
    let canonical: String = std::iter::once(mode_str.unwrap_or("").to_string())
        .chain(allow.iter().cloned())
        .collect::<Vec<_>>()
        .join("\n");
    let mut h = Sha256::new();
    h.update(canonical.as_bytes());
    let computed = format!("{:x}", h.finalize());
    if computed.get(..32) != Some(file_digest) {
        return None;
    }

    Some(CentralEgressPolicy { mode, allow })
}

// ── Process-global policy ────────────────────────────────────────────────
//
// `handle_connect` is a free handler with no access to `AppState`, so the
// policy lives in a process-global cell initialised from `main` after config
// load. It is swappable behind an `RwLock<Arc<..>>` so the daemon-distributed
// central policy can be **hot-reloaded** into a running proxy (LLD #63 §4)
// without a restart. Uninitialised (unit tests, embedders) it reads as a
// default `Off` policy, so nothing is ever denied by an uninitialised policy.

static GLOBAL_POLICY: OnceLock<RwLock<Arc<EgressPolicy>>> = OnceLock::new();

static DENIED_COUNT: AtomicU64 = AtomicU64::new(0);
static WOULD_DENY_COUNT: AtomicU64 = AtomicU64::new(0);

fn policy_cell() -> &'static RwLock<Arc<EgressPolicy>> {
    GLOBAL_POLICY.get_or_init(|| RwLock::new(Arc::new(EgressPolicy::default())))
}

/// Install the process-wide policy. Call from `main` after config load. Unlike
/// the previous set-once version this replaces the current policy, because the
/// same cell is later hot-reloaded by `swap_global_policy`.
pub fn init_global_policy(policy: EgressPolicy) -> EgressMode {
    swap_global_policy(policy)
}

/// Atomically replace the process-wide policy (hot reload). Returns the new
/// mode so the caller can log a transition.
pub fn swap_global_policy(policy: EgressPolicy) -> EgressMode {
    let mode = policy.mode;
    *policy_cell().write().unwrap() = Arc::new(policy);
    mode
}

/// A snapshot of the current policy. Returns an owned `Arc` so the read lock is
/// released immediately; the caller decides against the snapshot even if a
/// reload swaps the global a moment later.
pub fn global_policy() -> Arc<EgressPolicy> {
    policy_cell().read().unwrap().clone()
}

/// Record that a connection was denied (`Enforce`). Kept as a counter so an
/// operator can see enforcement is live at `GET /intutic/egress`, never silent.
pub fn record_denied() {
    DENIED_COUNT.fetch_add(1, Ordering::Relaxed);
}

/// Record a `Monitor`-mode would-deny.
pub fn record_would_deny() {
    WOULD_DENY_COUNT.fetch_add(1, Ordering::Relaxed);
}

pub fn denied_count() -> u64 {
    DENIED_COUNT.load(Ordering::Relaxed)
}

pub fn would_deny_count() -> u64 {
    WOULD_DENY_COUNT.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn enforce(entries: &[&str]) -> EgressPolicy {
        EgressPolicy::from_entries(
            EgressMode::Enforce,
            entries.iter().map(|s| s.to_string()),
        )
    }

    #[test]
    fn off_allows_everything_but_still_mitms_ai() {
        let p = EgressPolicy::from_entries(EgressMode::Off, std::iter::empty());
        assert_eq!(p.decide("api.anthropic.com", 443), EgressDecision::Mitm);
        assert_eq!(p.decide("github.com", 443), EgressDecision::Allow);
        assert_eq!(p.decide("evil.example.com", 443), EgressDecision::Allow);
    }

    #[test]
    fn enforce_denies_unlisted_and_mitms_ai() {
        let p = enforce(&["github.com"]);
        assert_eq!(p.decide("api.openai.com", 443), EgressDecision::Mitm);
        assert_eq!(p.decide("github.com", 443), EgressDecision::Allow);
        assert_eq!(p.decide("exfil.evil.com", 443), EgressDecision::Deny);
    }

    #[test]
    fn enforce_subdomain_and_suffix_rules() {
        let p = enforce(&["github.com", ".internal.corp"]);
        // bare-domain rule matches the domain and its subdomains
        assert_eq!(p.decide("github.com", 443), EgressDecision::Allow);
        assert_eq!(p.decide("codeload.github.com", 443), EgressDecision::Allow);
        // ".internal.corp" suffix rule
        assert_eq!(p.decide("db.internal.corp", 443), EgressDecision::Allow);
        assert_eq!(p.decide("internal.corp", 443), EgressDecision::Allow);
        // a suffix-attack host must NOT match the bare-domain rule
        assert_eq!(p.decide("notgithub.com", 443), EgressDecision::Deny);
    }

    #[test]
    fn enforce_cidr_matches_ip_literals_only() {
        let p = enforce(&["10.0.0.0/8", "192.168.1.5"]);
        assert_eq!(p.decide("10.4.5.6", 443), EgressDecision::Allow);
        assert_eq!(p.decide("192.168.1.5", 443), EgressDecision::Allow);
        // outside the range
        assert_eq!(p.decide("11.0.0.1", 443), EgressDecision::Deny);
        // a DNS name is never matched by a CIDR rule, even if it might resolve
        // into the range — we do not resolve in the decision path.
        assert_eq!(p.decide("host.example.com", 443), EgressDecision::Deny);
    }

    #[test]
    fn cidr_boundary_and_v6() {
        let p = enforce(&["203.0.113.0/24", "2001:db8::/32"]);
        assert_eq!(p.decide("203.0.113.255", 443), EgressDecision::Allow);
        assert_eq!(p.decide("203.0.114.0", 443), EgressDecision::Deny);
        assert_eq!(p.decide("2001:db8:dead:beef::1", 443), EgressDecision::Allow);
        assert_eq!(p.decide("2001:dead::1", 443), EgressDecision::Deny);
    }

    #[test]
    fn zero_prefix_matches_all_in_family() {
        let p = enforce(&["0.0.0.0/0"]);
        assert_eq!(p.decide("8.8.8.8", 443), EgressDecision::Allow);
        // but not a name (CIDR only matches IP literals)
        assert_eq!(p.decide("example.com", 443), EgressDecision::Deny);
    }

    #[test]
    fn monitor_never_denies_but_flags() {
        let p = EgressPolicy::from_entries(
            EgressMode::Monitor,
            ["github.com".to_string()].into_iter(),
        );
        assert_eq!(p.decide("api.anthropic.com", 443), EgressDecision::Mitm);
        assert_eq!(p.decide("github.com", 443), EgressDecision::Allow);
        // would be denied under Enforce, but Monitor lets it through + flags
        assert_eq!(p.decide("exfil.evil.com", 443), EgressDecision::WouldDeny);
    }

    #[test]
    fn ipv6_literals_are_not_mangled_by_port_stripping() {
        let p = enforce(&["2001:db8::/32"]);
        // bare IPv6 literal (the form that a naive split(':') breaks)
        assert_eq!(p.decide("2001:db8:dead:beef::1", 443), EgressDecision::Allow);
        // bracketed, no port
        assert_eq!(p.decide("[2001:db8::5]", 443), EgressDecision::Allow);
        // bracketed, with a port suffix that must be stripped
        assert_eq!(p.decide("[2001:db8::5]:8443", 443), EgressDecision::Allow);
        // outside the range, bracketed
        assert_eq!(p.decide("[2001:dead::1]:443", 443), EgressDecision::Deny);
    }

    #[test]
    fn ipv4_host_port_is_stripped() {
        let p = enforce(&["10.0.0.0/8"]);
        assert_eq!(p.decide("10.1.2.3:443", 443), EgressDecision::Allow);
    }

    #[test]
    fn host_matching_is_case_insensitive() {
        let p = enforce(&["GitHub.com"]);
        assert_eq!(p.decide("API.GITHUB.COM", 443), EgressDecision::Allow);
    }

    #[test]
    fn mode_parse_is_lenient_and_safe() {
        assert_eq!(EgressMode::parse_lenient("enforce"), EgressMode::Enforce);
        assert_eq!(EgressMode::parse_lenient("  Monitor "), EgressMode::Monitor);
        assert_eq!(EgressMode::parse_lenient("off"), EgressMode::Off);
        // an unknown value falls back to Off, never to Enforce
        assert_eq!(EgressMode::parse_lenient("enfroce"), EgressMode::Off);
        assert_eq!(EgressMode::parse_lenient(""), EgressMode::Off);
    }

    // ── Central policy distribution (LLD #63 §4) ──────────────────────────

    fn write_egress_file(dir: &std::path::Path, workspace: &str, mode_json: &str, allow: &[&str], digest_over: &str) -> std::path::PathBuf {
        let digest = {
            let mut h = Sha256::new();
            h.update(digest_over.as_bytes());
            format!("{:x}", h.finalize())[..32].to_string()
        };
        let allow_json = allow.iter().map(|a| format!("\"{a}\"")).collect::<Vec<_>>().join(",");
        let text = format!(
            "{{\"workspace\":\"{workspace}\",\"digest\":\"{digest}\",\"mode\":{mode_json},\"allow\":[{allow_json}]}}"
        );
        let path = dir.join(format!("egress-{}.json", digest));
        std::fs::write(&path, text).unwrap();
        path
    }

    #[test]
    fn central_file_loads_and_verifies_digest() {
        let dir = std::env::temp_dir();
        // canonical = "enforce\ngithub.com\n10.0.0.0/8"
        let p = write_egress_file(&dir, "wk_1", "\"enforce\"", &["github.com", "10.0.0.0/8"], "enforce\ngithub.com\n10.0.0.0/8");
        let central = load_local_egress_file(&p, Some("wk_1")).expect("valid file loads");
        assert_eq!(central.mode, Some(EgressMode::Enforce));
        assert_eq!(central.allow, vec!["github.com".to_string(), "10.0.0.0/8".to_string()]);
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn central_file_null_mode_means_unconfigured() {
        let dir = std::env::temp_dir();
        let p = write_egress_file(&dir, "wk_1", "null", &[], "");
        let central = load_local_egress_file(&p, Some("wk_1")).expect("loads");
        assert_eq!(central.mode, None); // central management not configured
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn central_file_rejected_on_digest_mismatch() {
        let dir = std::env::temp_dir();
        // digest computed over the WRONG canonical → must be rejected (tamper/truncation)
        let p = write_egress_file(&dir, "wk_1", "\"enforce\"", &["github.com"], "enforce\nWRONG");
        assert!(load_local_egress_file(&p, Some("wk_1")).is_none());
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn central_file_rejected_for_foreign_workspace() {
        let dir = std::env::temp_dir();
        let p = write_egress_file(&dir, "wk_OTHER", "\"enforce\"", &[], "enforce");
        // proxy expects wk_1 but the file is for wk_OTHER → refuse
        assert!(load_local_egress_file(&p, Some("wk_1")).is_none());
        // with no expected workspace, it is accepted (trusts the protected-path file)
        assert!(load_local_egress_file(&p, None).is_some());
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn with_central_mode_authoritative_allow_unioned() {
        let base = enforce(&["local.corp"]); // Enforce, allow local.corp
        // central: monitor + allow github.com
        let merged = base.with_central(Some(EgressMode::Monitor), &["github.com".to_string()]);
        assert_eq!(merged.mode(), EgressMode::Monitor); // central mode wins
        // both local and central allow entries survive
        assert_eq!(merged.decide("local.corp", 443), EgressDecision::Allow);
        assert_eq!(merged.decide("github.com", 443), EgressDecision::Allow);
        // central mode None leaves local mode untouched
        let merged2 = base.with_central(None, &["github.com".to_string()]);
        assert_eq!(merged2.mode(), EgressMode::Enforce);
        assert_eq!(merged2.decide("github.com", 443), EgressDecision::Allow);
    }

    #[test]
    fn uninitialised_global_is_off() {
        // Without init_global_policy(), the accessor must behave as Off so an
        // uninitialised policy never denies.
        assert_eq!(global_policy().mode(), EgressMode::Off);
        assert_eq!(global_policy().decide("anything.com", 443), EgressDecision::Allow);
    }
}
