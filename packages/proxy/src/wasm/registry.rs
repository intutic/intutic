//! WASM Plugin Registry — loads plugins from Valkey, supports hot-reload.

use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;
use wasmtime::{Engine, Module};

use super::context::{RequestContext, Verdict};
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

/// Plugin registry — manages loaded WASM plugins per workspace
pub struct PluginRegistry {
    engine: Engine,
    workspace_modules: RwLock<HashMap<String, WorkspaceModules>>,
}

impl PluginRegistry {
    /// Create a new plugin registry, loading plugins from Valkey
    pub async fn new(_valkey: &Arc<redis::aio::ConnectionManager>) -> anyhow::Result<Arc<Self>> {
        let mut config = wasmtime::Config::new();
        config.consume_fuel(true);
        let engine = Engine::new(&config)?;

        tracing::info!("WASM plugin registry initialized (Phase 4: with wasmtime host support)");
        Ok(Arc::new(Self {
            engine,
            workspace_modules: RwLock::new(HashMap::new()),
        }))
    }

    /// Number of loaded plugins globally
    pub async fn plugin_count(&self) -> usize {
        let guard = self.workspace_modules.read().await;
        guard.values().map(|w| w.modules.len()).sum()
    }

    /// Run all plugins in priority order, short-circuit on KILL
    pub async fn evaluate(
        &self,
        valkey: &Arc<redis::aio::ConnectionManager>,
        ctx: &RequestContext,
    ) -> Verdict {
        let workspace_id = &ctx.workspace_id;

        // Sync rules on cache expiration
        if let Err(e) = self.ensure_up_to_date(valkey, workspace_id).await {
            tracing::error!(
                "Failed to sync WASM plugins for workspace {}: {}",
                workspace_id,
                e
            );
        }

        let modules_guard = self.workspace_modules.read().await;
        if let Some(ws_mods) = modules_guard.get(workspace_id) {
            let mut modules = ws_mods.modules.clone();
            modules.sort_by_key(|m| m.priority);

            for m in modules {
                let verdict = evaluate_wasm_rule(&self.engine, &m.module, ctx).await;
                if let Verdict::Kill { .. } = verdict {
                    return verdict;
                }
            }
        }

        Verdict::Bypass
    }

    async fn ensure_up_to_date(
        &self,
        valkey: &Arc<redis::aio::ConnectionManager>,
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

        let mut conn = valkey.as_ref().clone();
        let key = format!("wasm:plugins:{}", workspace_id);

        let plugins_json: Option<String> = conn.get(&key).await?;

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
                    let bin_key = format!("wasm:binary:{}", desc.sha256);
                    let bin_bytes: Option<Vec<u8>> = conn.get(&bin_key).await?;
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
                        tracing::warn!("WASM binary missing in Valkey for hash: {}", desc.sha256);
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
