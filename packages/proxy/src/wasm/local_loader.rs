//! Local WASM rule ingestion — `~/.intutic/wasm/` directory loader.
//!
//! Standalone open-core proxies have no control plane pushing rule bundles
//! into Valkey. Instead, compiled rules dropped into the local rules
//! directory (default `~/.intutic/wasm`; override with `INTUTIC_WASM_DIR` or
//! `intutic_settings.wasm_local_dir`) are picked up within ~5 s of a change,
//! using the same TTL-rescan pattern as the Valkey registry — rules only
//! matter when a request arrives, so no background watcher is needed.
//!
//! Naming convention: `NN_name.wasm`, where `NN` is a numeric priority
//! (lower runs first). Files without the prefix get priority 100.
//!
//! Local rules run in the identical sandbox as Valkey-sourced rules and are
//! merged with them at evaluation time. KILL short-circuits, so the union is
//! most-restrictive-wins: a local rule can add blocks but can never
//! neutralize a centrally-synced rule.

use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use wasmtime::{Engine, Module};

use super::registry::LoadedModule;

/// Far above any real rule (typical compiled rules are <100 KB), but stops an
/// accidental huge file from being slurped into memory.
const MAX_RULE_FILE_BYTES: u64 = 10 * 1024 * 1024;

/// Priority assigned to files without a `NN_` prefix.
pub const DEFAULT_PRIORITY: u32 = 100;

/// Resolve the local rules directory: `INTUTIC_WASM_DIR` env var, then the
/// `intutic_settings.wasm_local_dir` config value, then `~/.intutic/wasm`.
pub fn resolve_local_dir(config_override: Option<&str>) -> PathBuf {
    if let Ok(dir) = std::env::var("INTUTIC_WASM_DIR") {
        if !dir.is_empty() {
            return expand_home(&dir);
        }
    }
    if let Some(dir) = config_override {
        if !dir.is_empty() {
            return expand_home(dir);
        }
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".intutic").join("wasm")
}

fn expand_home(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
        return PathBuf::from(home).join(rest);
    }
    PathBuf::from(path)
}

/// `(mtime, size)` signature of every `*.wasm` file in the directory.
///
/// A missing directory is `Ok(empty)` (first-run UX). Any other I/O error is
/// propagated so the caller can retain the previously loaded rules instead of
/// mistaking a transient EACCES/EIO for "all rules deleted" — silently
/// dropping local Kill rules would be an enforcement bypass.
pub fn scan_signatures(dir: &Path) -> std::io::Result<HashMap<PathBuf, (SystemTime, u64)>> {
    let mut signatures = HashMap::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(signatures),
        Err(e) => return Err(e),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("wasm") {
            continue;
        }
        if let Ok(meta) = entry.metadata() {
            if meta.is_file() {
                let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                signatures.insert(path, (mtime, meta.len()));
            }
        }
    }
    Ok(signatures)
}

/// Parse `NN_name.wasm` into `(priority, display name)`.
/// `10_block-prod-db.wasm` → `(10, "block-prod-db")`;
/// `my-rule.wasm` → `(100, "my-rule")`.
pub fn parse_priority(file_name: &str) -> (u32, String) {
    let stem = file_name.strip_suffix(".wasm").unwrap_or(file_name);
    if let Some((prefix, rest)) = stem.split_once('_') {
        if !prefix.is_empty() && !rest.is_empty() {
            if let Ok(priority) = prefix.parse::<u32>() {
                return (priority, rest.to_string());
            }
        }
    }
    (DEFAULT_PRIORITY, stem.to_string())
}

/// Compile every rule file in the given signature set (from
/// [`scan_signatures`]). Fail-open per file: a corrupt or mid-copy file is
/// logged and skipped, and if a previous good module exists for the same file
/// it is retained until a valid replacement compiles.
pub fn load_local_modules(
    engine: &Engine,
    signatures: &HashMap<PathBuf, (SystemTime, u64)>,
    previous: &[LoadedModule],
) -> Vec<LoadedModule> {
    let mut modules = Vec::new();

    for (path, (_mtime, size)) in signatures {
        let file_name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        let rule_id = format!("local:{}", file_name);

        if *size > MAX_RULE_FILE_BYTES {
            tracing::warn!(
                file = %path.display(),
                size_bytes = %size,
                "local WASM rule exceeds size cap — skipped"
            );
            continue;
        }

        let compiled = std::fs::read(path)
            .map_err(anyhow::Error::from)
            .and_then(|bytes| {
                let sha256 = hex::encode(Sha256::digest(&bytes));
                let module = Module::from_binary(engine, &bytes)?;
                Ok((sha256, module))
            });

        match compiled {
            Ok((sha256, module)) => {
                let (priority, name) = parse_priority(&file_name);
                modules.push(LoadedModule {
                    rule_id,
                    name,
                    sha256,
                    priority,
                    module,
                });
            }
            Err(e) => {
                // Fail-open: keep the previous good module for this file, if any.
                if let Some(prev) = previous.iter().find(|m| m.rule_id == rule_id) {
                    tracing::warn!(
                        file = %path.display(),
                        error = %e,
                        "local WASM rule failed to load — retaining previous version"
                    );
                    modules.push(prev.clone());
                } else {
                    tracing::warn!(
                        file = %path.display(),
                        error = %e,
                        "local WASM rule failed to load — skipped"
                    );
                }
            }
        }
    }

    modules
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_priority_with_prefix() {
        assert_eq!(
            parse_priority("10_block-prod-db.wasm"),
            (10, "block-prod-db".to_string())
        );
        assert_eq!(parse_priority("05_a.wasm"), (5, "a".to_string()));
    }

    #[test]
    fn parse_priority_without_prefix_defaults() {
        assert_eq!(
            parse_priority("my-rule.wasm"),
            (DEFAULT_PRIORITY, "my-rule".to_string())
        );
        // Underscore present but prefix not numeric → default priority.
        assert_eq!(
            parse_priority("block_prod.wasm"),
            (DEFAULT_PRIORITY, "block_prod".to_string())
        );
        // Leading underscore (empty prefix) → default priority.
        assert_eq!(
            parse_priority("_hidden.wasm"),
            (DEFAULT_PRIORITY, "_hidden".to_string())
        );
    }

    #[test]
    fn scan_treats_missing_dir_as_empty_and_ignores_non_wasm() {
        // Missing dir → Ok(empty): first-run UX, not an error.
        let missing = PathBuf::from("/nonexistent/intutic-wasm-test");
        assert!(scan_signatures(&missing).unwrap().is_empty());

        let dir = std::env::temp_dir().join(format!(
            "intutic-wasm-scan-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("notes.txt"), b"not a rule").unwrap();
        std::fs::write(dir.join("10_rule.wasm"), b"\0asm").unwrap();
        let sigs = scan_signatures(&dir).unwrap();
        assert_eq!(sigs.len(), 1);
        assert!(sigs.keys().all(|p| p.ends_with("10_rule.wasm")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn scan_propagates_unreadable_dir_instead_of_faking_empty() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!(
            "intutic-wasm-noperm-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o000)).unwrap();
        // Running as root would still succeed — only assert when the read fails.
        if std::fs::read_dir(&dir).is_err() {
            assert!(scan_signatures(&dir).is_err());
        }
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_dir_precedence() {
        // Config override wins over the home default…
        std::env::remove_var("INTUTIC_WASM_DIR");
        assert_eq!(
            resolve_local_dir(Some("/custom/dir")),
            PathBuf::from("/custom/dir")
        );
        // …and the env var wins over the config override.
        std::env::set_var("INTUTIC_WASM_DIR", "/env/dir");
        assert_eq!(
            resolve_local_dir(Some("/custom/dir")),
            PathBuf::from("/env/dir")
        );
        std::env::remove_var("INTUTIC_WASM_DIR");
    }
}