//! Local `~/.intutic/config.json` reader — Wave 6.3 of the audit-remediation
//! programme ("Two Interviews, Seventy-Five Verdicts").
//!
//! One cached parse of the config file, serving two things that used to be
//! handled inconsistently:
//!
//! - `get_max_daily_budget()` — moved here from `local_spend.rs`, now
//!   actually cached. It was called on every request, synchronously,
//!   uncached — `local_spend.rs`'s own doc comment on `get_local_spend`
//!   documents exactly this defect (an uncached read costing up to 1.31ms
//!   against an 8.7µs full detector chain) as the reason THAT function got
//!   cached; `get_max_daily_budget` never got the same fix.
//! - `get_allowed_models()` — new. `~/.intutic/config.json`'s `allowedModels`
//!   key, read by `NullControlPlaneCache::allowed_models` so a standalone
//!   proxy (no control plane) can still enforce a local allowlist, the same
//!   enforcement machinery `ControlPlaneCache::allowed_models` already
//!   drives for managed deployments.
//!
//! A 60-second TTL, not `local_spend.rs`'s 5-second `SPEND_CACHE_TTL`: a
//! spend log is appended to many times a second by this same process; a
//! config file is edited by a human, rarely, and even then a minute's delay
//! before a change takes effect is an acceptable trade for not touching disk
//! on every request. No `OnceLock`-at-boot either — the proxy runs long
//! under launchd/systemd, and requiring a process restart to pick up an
//! edited allowlist is the exact operational shape `local_spend.rs`'s own
//! TTL cache was built to avoid.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

fn intutic_dir() -> PathBuf {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| "/tmp".to_string());
    PathBuf::from(home).join(".intutic")
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
struct LocalConfigJson {
    #[serde(rename = "maxDailyBudgetUsd", alias = "max_daily_budget_usd")]
    max_daily_budget_usd: Option<f64>,
    #[serde(rename = "allowedModels", alias = "allowed_models")]
    allowed_models: Option<Vec<String>>,
}

const LOCAL_CONFIG_CACHE_TTL: Duration = Duration::from_secs(60);

static LOCAL_CONFIG_CACHE: once_cell::sync::Lazy<Mutex<Option<(LocalConfigJson, Instant)>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(None));

/// A parse error must NEVER become deny-all — an operator's typo in
/// `config.json` degrading to "every request refused" would turn a cosmetic
/// mistake into an outage. Falls back to `LocalConfigJson::default()`
/// (unrestricted budget default, no model restriction) on any read or parse
/// failure, same fail-open direction `local_spend.rs::get_max_daily_budget`
/// already used before this module existed.
fn read_config_from_disk() -> LocalConfigJson {
    let config_path = intutic_dir().join("config.json");
    if !config_path.exists() {
        return LocalConfigJson::default();
    }
    match std::fs::read_to_string(&config_path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => LocalConfigJson::default(),
    }
}

/// The cached parse. Caches the negative (no config file, or a config file
/// with neither field set) too — the common case for most standalone
/// installs — so it costs one `Instant::elapsed` comparison, not a syscall,
/// on every request past the first.
fn cached_config() -> LocalConfigJson {
    if let Ok(guard) = LOCAL_CONFIG_CACHE.lock() {
        if let Some((cfg, read_at)) = guard.as_ref() {
            if read_at.elapsed() < LOCAL_CONFIG_CACHE_TTL {
                return cfg.clone();
            }
        }
    }
    let cfg = read_config_from_disk();
    if let Ok(mut guard) = LOCAL_CONFIG_CACHE.lock() {
        *guard = Some((cfg.clone(), Instant::now()));
    }
    cfg
}

/// Today's local daily spend cap, in USD. Defaults to 10.0 when unset,
/// unparseable, or the file doesn't exist.
pub fn get_max_daily_budget() -> f64 {
    cached_config().max_daily_budget_usd.unwrap_or(10.0)
}

/// The local approved-models allowlist, from `config.json`'s `allowedModels`.
///
/// `None` means unrestricted — absent config, an unset key, a malformed
/// file, AND an explicit empty list are all normalized to the same reading
/// here, matching `store::ControlPlaneCache::allowed_models`'s own
/// None-means-unrestricted contract (see that trait method's doc comment):
/// callers must treat an empty `Some` as unrestricted, so this function
/// normalizes `Some(vec![])` away at the read boundary rather than pushing
/// that responsibility onto every caller.
pub fn get_allowed_models() -> Option<Vec<String>> {
    match cached_config().allowed_models {
        Some(list) if !list.is_empty() => Some(list),
        _ => None,
    }
}

/// Clears the cached parse. Test-only — used both by this module's own
/// tests and by `local_spend.rs`'s (which now delegates `get_max_daily_budget`
/// here, so its `HOME`-mutating test must reset THIS cache too, not just its
/// own `SPEND_CACHE`, or it reads a value cached under a previous test's
/// `HOME`).
#[cfg(test)]
pub(crate) fn reset_cache_for_test() {
    if let Ok(mut guard) = LOCAL_CONFIG_CACHE.lock() {
        *guard = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::HOME_LOCK;
    use std::fs;

    fn fresh_home() -> (std::sync::MutexGuard<'static, ()>, tempfile_dir::TempDir) {
        let guard = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile_dir::TempDir::new();
        std::env::set_var("HOME", dir.path());
        *LOCAL_CONFIG_CACHE.lock().unwrap() = None;
        (guard, dir)
    }

    /// A minimal, dependency-free temp-dir helper — this crate has no
    /// `tempfile` dependency, and adding one for two test-only call sites
    /// is not worth it. Cleans up on drop.
    mod tempfile_dir {
        use std::path::{Path, PathBuf};

        pub struct TempDir(PathBuf);
        impl TempDir {
            pub fn new() -> Self {
                let dir = std::env::temp_dir().join(format!(
                    "intutic-local-config-test-{}-{}",
                    std::process::id(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_nanos()
                ));
                std::fs::create_dir_all(&dir).unwrap();
                Self(dir)
            }
            pub fn path(&self) -> &Path {
                &self.0
            }
        }
        impl Drop for TempDir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    fn write_config(dir: &std::path::Path, json: &str) {
        let intutic = dir.join(".intutic");
        fs::create_dir_all(&intutic).unwrap();
        fs::write(intutic.join("config.json"), json).unwrap();
    }

    #[test]
    fn no_config_file_is_unrestricted() {
        let (_guard, dir) = fresh_home();
        let _ = dir.path(); // no config.json written
        assert_eq!(get_allowed_models(), None);
        assert_eq!(get_max_daily_budget(), 10.0);
    }

    #[test]
    fn an_explicit_empty_list_is_unrestricted_not_deny_all() {
        let (_guard, dir) = fresh_home();
        write_config(dir.path(), r#"{"allowedModels": []}"#);
        assert_eq!(get_allowed_models(), None);
    }

    #[test]
    fn a_populated_list_is_returned_verbatim() {
        let (_guard, dir) = fresh_home();
        write_config(dir.path(), r#"{"allowedModels": ["claude-3-5-sonnet", "gpt-4o"]}"#);
        assert_eq!(
            get_allowed_models(),
            Some(vec!["claude-3-5-sonnet".to_string(), "gpt-4o".to_string()])
        );
    }

    #[test]
    fn a_malformed_config_is_unrestricted_not_deny_all() {
        let (_guard, dir) = fresh_home();
        write_config(dir.path(), "{ this is not valid json");
        // The one assertion that matters most: a parse error must never
        // become "no model may be used."
        assert_eq!(get_allowed_models(), None);
        assert_eq!(get_max_daily_budget(), 10.0);
    }

    #[test]
    fn both_camel_case_and_snake_case_keys_parse() {
        let (_guard, dir) = fresh_home();
        write_config(dir.path(), r#"{"max_daily_budget_usd": 42.5, "allowed_models": ["gpt-4o"]}"#);
        assert_eq!(get_max_daily_budget(), 42.5);
        assert_eq!(get_allowed_models(), Some(vec!["gpt-4o".to_string()]));
    }
}
