//! WASM Plugin Registry — loads plugins from Valkey and the local rules
//! directory (`~/.intutic/wasm`), both hot-reloaded on a 5 s TTL rescan.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};
use tokio::sync::RwLock;
use wasmtime::{Engine, Module};

use super::context::{RequestContext, Verdict};
use crate::store::ControlPlaneCache;
use super::local_loader;
use super::runner::evaluate_wasm_rule;

#[derive(Deserialize, Serialize, Clone)]
pub struct WasmPluginDescriptor {
    #[serde(rename = "ruleId")]
    pub rule_id: String,
    pub name: String,
    pub sha256: String,
    pub priority: u32,
}

#[derive(Clone)]
pub struct LoadedModule {
    pub rule_id: String,
    pub name: String,
    pub sha256: String,
    pub priority: u32,
    pub module: Module,
}

struct WorkspaceModules {
    last_checked: Instant,
    modules: Vec<LoadedModule>,
}

/// Rules loaded from the local directory (workspace-independent).
#[derive(Default)]
struct LocalRules {
    last_checked: Option<Instant>,
    signatures: HashMap<PathBuf, (SystemTime, u64)>,
    modules: Vec<LoadedModule>,
    /// Set by [`PluginRegistry::force_local_rescan`] to make the next scan
    /// reload unconditionally, even when the on-disk signatures are unchanged
    /// (mtime granularity can hide a same-second rewrite). Cleared on swap.
    force: bool,
}

/// Plugin registry — manages loaded WASM plugins per workspace
pub struct PluginRegistry {
    engine: Engine,
    workspace_modules: RwLock<HashMap<String, WorkspaceModules>>,
    local_dir: PathBuf,
    local_rules: RwLock<LocalRules>,
}

impl PluginRegistry {
    /// Create a new plugin registry. Local rules load from the rules directory
    /// (see [`local_loader::resolve_local_dir`]); control-plane-distributed
    /// rules are fetched lazily per workspace via [`Self::evaluate`].
    pub async fn new(local_dir_override: Option<&str>) -> anyhow::Result<Arc<Self>> {
        let mut config = wasmtime::Config::new();
        config.consume_fuel(true);
        let engine = Engine::new(&config)?;

        let local_dir = local_loader::resolve_local_dir(local_dir_override);
        tracing::info!(
            local_dir = %local_dir.display(),
            "WASM plugin registry initialized (local rules dir; control-plane rules load per workspace)"
        );
        Ok(Arc::new(Self {
            engine,
            workspace_modules: RwLock::new(HashMap::new()),
            local_dir,
            local_rules: RwLock::new(LocalRules::default()),
        }))
    }

    /// Number of loaded plugins globally (control-plane-sourced + local).
    pub async fn plugin_count(&self) -> usize {
        let guard = self.workspace_modules.read().await;
        let remote_count: usize = guard.values().map(|w| w.modules.len()).sum();
        drop(guard);
        remote_count + self.local_rules.read().await.modules.len()
    }

    /// Drop the local-dir rescan TTL and mark the next scan as forced, so the
    /// next evaluation rescans and reloads unconditionally — even if a replaced
    /// file kept an identical (mtime, size) signature. Used by integration
    /// tests and manual reload triggers.
    ///
    /// The force flag must NOT be expressed by clearing `signatures`: doing so
    /// makes an empty directory compare equal to the empty baseline, so the
    /// "every rule was deleted" case short-circuits and leaves the previously
    /// loaded modules enforcing forever.
    pub async fn force_local_rescan(&self) {
        let mut guard = self.local_rules.write().await;
        guard.last_checked = None;
        guard.force = true;
    }

    /// Run all plugins in priority order, short-circuit on KILL.
    ///
    /// Valkey-sourced and local rules are merged into one priority-ordered
    /// list (stable sort — ties keep Valkey rules first). Because KILL
    /// short-circuits and there is no verdict that overrides a block, the
    /// union is most-restrictive-wins: local rules can only add restrictions.
    pub async fn evaluate(
        &self,
        control_plane: &Arc<dyn ControlPlaneCache>,
        ctx: &RequestContext,
    ) -> Verdict {
        let workspace_id = &ctx.workspace_id;

        // Sync rules on cache expiration
        if let Err(e) = self.ensure_up_to_date(control_plane, workspace_id).await {
            tracing::error!(
                "Failed to sync WASM plugins for workspace {}: {}",
                workspace_id,
                e
            );
        }
        self.ensure_local_up_to_date().await;

        let mut modules: Vec<LoadedModule> = Vec::new();
        {
            let modules_guard = self.workspace_modules.read().await;
            if let Some(ws_mods) = modules_guard.get(workspace_id) {
                modules.extend(ws_mods.modules.iter().cloned());
            }
        }
        {
            let local_guard = self.local_rules.read().await;
            modules.extend(local_guard.modules.iter().cloned());
        }
        modules.sort_by_key(|m| m.priority);

        for m in modules {
            let verdict = evaluate_wasm_rule(&self.engine, &m.module, ctx).await;
            if let Verdict::Kill { reason, policy_id } = verdict {
                // The runner has no rule identity — attribute the block here
                // so logs and incidents name the rule that fired.
                return Verdict::Kill {
                    reason,
                    policy_id: policy_id.or_else(|| Some(m.rule_id.clone())),
                };
            }
        }

        Verdict::Bypass
    }

    /// Rescan the local rules directory at most every 5 s (same TTL pattern
    /// as the Valkey path). File I/O and compilation run on the blocking
    /// pool and entirely OUTSIDE the lock, so request evaluation never
    /// stalls behind a rescan. Any scan or load failure retains the
    /// previously loaded rules — a transient EACCES/EIO must never be
    /// mistaken for "all local rules deleted" (that would silently fail open
    /// on locally-installed Kill rules).
    async fn ensure_local_up_to_date(&self) {
        {
            let guard = self.local_rules.read().await;
            if let Some(at) = guard.last_checked {
                if at.elapsed() < Duration::from_secs(5) {
                    return;
                }
            }
        }
        let entered = Instant::now();

        let scan_dir = self.local_dir.clone();
        let new_signatures = match tokio::task::spawn_blocking(move || {
            local_loader::scan_signatures(&scan_dir)
        })
        .await
        {
            Ok(Ok(sigs)) => sigs,
            Ok(Err(e)) => {
                tracing::warn!(
                    dir = %self.local_dir.display(),
                    error = %e,
                    "local WASM rule scan failed — keeping previous rules"
                );
                self.local_rules.write().await.last_checked = Some(Instant::now());
                return;
            }
            Err(e) => {
                tracing::warn!(error = %e, "local WASM rule scan task failed — keeping previous rules");
                self.local_rules.write().await.last_checked = Some(Instant::now());
                return;
            }
        };

        // Compare and snapshot the previous modules under a short read lock.
        // An unchanged signature set means nothing on disk moved, so the loaded
        // modules are already correct — unless a forced rescan was requested.
        let previous = {
            let guard = self.local_rules.read().await;
            if !guard.force && new_signatures == guard.signatures {
                drop(guard);
                self.local_rules.write().await.last_checked = Some(Instant::now());
                return;
            }
            guard.modules.clone()
        };

        // Compile outside the lock — a large rule set must not block readers.
        let engine = self.engine.clone();
        let sigs_for_load = new_signatures.clone();
        let loaded = match tokio::task::spawn_blocking(move || {
            local_loader::load_local_modules(&engine, &sigs_for_load, &previous)
        })
        .await
        {
            Ok(loaded) => loaded,
            Err(e) => {
                tracing::warn!(error = %e, "local WASM rule load failed — keeping previous rules");
                self.local_rules.write().await.last_checked = Some(Instant::now());
                return;
            }
        };

        // Swap in under a short write lock; if a concurrent rescan finished
        // after we started, its result is fresher — keep it.
        let mut guard = self.local_rules.write().await;
        if let Some(at) = guard.last_checked {
            if at > entered {
                return;
            }
        }
        tracing::info!(
            dir = %self.local_dir.display(),
            rules = loaded.len(),
            "local WASM rules reloaded"
        );
        guard.modules = loaded;
        guard.signatures = new_signatures;
        guard.last_checked = Some(Instant::now());
        guard.force = false;
    }

    async fn ensure_up_to_date(
        &self,
        control_plane: &Arc<dyn ControlPlaneCache>,
        workspace_id: &str,
    ) -> anyhow::Result<()> {
        {
            let guard = self.workspace_modules.read().await;
            if let Some(ws_mods) = guard.get(workspace_id) {
                if ws_mods.last_checked.elapsed() < Duration::from_secs(5) {
                    return Ok(());
                }
            }
        }

        // Cache expired or missing -> update with write lock
        let mut guard = self.workspace_modules.write().await;
        if let Some(ws_mods) = guard.get(workspace_id) {
            if ws_mods.last_checked.elapsed() < Duration::from_secs(5) {
                return Ok(());
            }
        }

        let plugins_json = control_plane.wasm_plugins(workspace_id).await?;

        let mut new_modules = Vec::new();
        if let Some(json_str) = plugins_json {
            let descriptors: Vec<WasmPluginDescriptor> = serde_json::from_str(&json_str)?;

            let mut existing_map = HashMap::new();
            if let Some(ws_mods) = guard.get(workspace_id) {
                for m in &ws_mods.modules {
                    existing_map.insert(m.sha256.clone(), m.module.clone());
                }
            }

            for desc in descriptors {
                if let Some(module) = existing_map.get(&desc.sha256) {
                    new_modules.push(LoadedModule {
                        rule_id: desc.rule_id,
                        name: desc.name,
                        sha256: desc.sha256,
                        priority: desc.priority,
                        module: module.clone(),
                    });
                } else {
                    let bin_bytes = control_plane.wasm_binary(&desc.sha256).await?;
                    if let Some(bytes) = bin_bytes {
                        let module = Module::from_binary(&self.engine, &bytes)?;
                        new_modules.push(LoadedModule {
                            rule_id: desc.rule_id,
                            name: desc.name,
                            sha256: desc.sha256,
                            priority: desc.priority,
                            module,
                        });
                    } else {
                        tracing::warn!("WASM binary missing from control plane for hash: {}", desc.sha256);
                    }
                }
            }
        }

        guard.insert(
            workspace_id.to_string(),
            WorkspaceModules {
                last_checked: Instant::now(),
                modules: new_modules,
            },
        );

        Ok(())
    }
}
