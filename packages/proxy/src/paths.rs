//! The Intutic config/state directory — one definition, shared by every
//! module that reads or writes something under it.
//!
//! Before this module, five call sites (`ca_manager.rs`, `local_spend.rs`,
//! `local_config.rs`, `egress_policy.rs`, `store/memory.rs`) each carried
//! their own copy of the same `HOME`-then-`USERPROFILE` resolution. On
//! macOS/Linux that always resolved to `$HOME/.intutic`, so the duplication
//! was invisible — but on Windows, where `HOME` is typically unset, every
//! copy fell through to `%USERPROFILE%\.intutic`, while the TypeScript CLI's
//! own resolution (`tools/cli/src/config/paths.ts`'s `getIntuticDirFor`)
//! has always used `%APPDATA%\intutic` — a *different* directory. Anything
//! the proxy wrote there (trace logs, the local spend ledger, the CA
//! cert/key `caTrust.ts` installs into the OS trust store, the egress
//! policy snapshot, bandit state) was invisible to the CLI reading from the
//! other location, and vice versa — silently, since a missing file just
//! reads as "nothing recorded yet," not an error.
//!
//! `%APPDATA%\intutic` is the side this reconciles to: `paths.ts` is the
//! only place in the codebase that ever stated a rationale for either
//! location (matching the git-for-windows/npm convention of using
//! `%APPDATA%` for a tool's per-user config, not `%USERPROFILE%` directly),
//! and `caTrust.ts` already resolves the CA cert path through it — so of the
//! two disagreeing sides, the Rust one was the unexamined outlier.
//!
//! Must stay in sync with `getIntuticDirFor` in
//! `tools/cli/src/config/paths.ts`. Neither side reads the other's source,
//! so a future change to one has no compiler or test to catch drift from
//! the other — change both together.

use std::path::PathBuf;

/// The Intutic config/state directory for the current user.
/// - macOS/Linux: `$HOME/.intutic`
/// - Windows: `%APPDATA%\intutic`, falling back to
///   `%USERPROFILE%\AppData\Roaming\intutic` if `APPDATA` is unset (matching
///   `paths.ts`'s own fallback for the same case).
pub fn intutic_dir() -> PathBuf {
    if cfg!(windows) {
        if let Ok(appdata) = std::env::var("APPDATA") {
            if !appdata.trim().is_empty() {
                return PathBuf::from(appdata).join("intutic");
            }
        }
        let home = std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\".to_string());
        PathBuf::from(home).join("AppData").join("Roaming").join("intutic")
    } else {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
        PathBuf::from(home).join(".intutic")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::HOME_LOCK;

    // Unix branch — this is what actually runs in CI (see this module's own
    // doc comment: no CI job runs `cargo test` on Windows today, only a
    // release `cargo build`). Gated on `not(windows)` so it never runs
    // against the Windows branch's env vars by accident on a real Windows
    // host.
    #[cfg(not(windows))]
    #[test]
    fn resolves_under_home_on_unix() {
        let _lock = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("HOME", "/tmp/intutic_paths_test_home");
        let dir = intutic_dir();
        std::env::remove_var("HOME");
        assert_eq!(dir, PathBuf::from("/tmp/intutic_paths_test_home/.intutic"));
    }

    // Windows branch — only compiled (and only ever executed) on an actual
    // Windows host, since `cfg!(windows)` inside `intutic_dir()` is a
    // compile-time constant. Written so it is correct and ready the day a
    // Windows test job exists, not because anything runs it today.
    #[cfg(windows)]
    #[test]
    fn resolves_under_appdata_on_windows() {
        let _lock = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("APPDATA", "C:\\Users\\test\\AppData\\Roaming");
        let dir = intutic_dir();
        std::env::remove_var("APPDATA");
        assert_eq!(dir, PathBuf::from("C:\\Users\\test\\AppData\\Roaming\\intutic"));
    }

    #[cfg(windows)]
    #[test]
    fn falls_back_to_userprofile_appdata_roaming_when_appdata_unset() {
        let _lock = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::remove_var("APPDATA");
        std::env::set_var("USERPROFILE", "C:\\Users\\test");
        let dir = intutic_dir();
        std::env::remove_var("USERPROFILE");
        assert_eq!(dir, PathBuf::from("C:\\Users\\test\\AppData\\Roaming\\intutic"));
    }
}
