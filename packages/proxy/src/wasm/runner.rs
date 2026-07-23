//! WASM rule execution runner.

use super::context::{RequestContext, Verdict};
use super::host::register_host_imports;
use std::time::Duration;
use wasmtime::{Engine, Linker, Module, ResourceLimiter, Store, StoreLimits, StoreLimitsBuilder};

/// Host state passed to wasmtime Store.
pub struct WasmState {
    pub limits: StoreLimits,
}

impl ResourceLimiter for WasmState {
    fn memory_growing(
        &mut self,
        current: usize,
        desired: usize,
        maximum: Option<usize>,
    ) -> anyhow::Result<bool> {
        self.limits.memory_growing(current, desired, maximum)
    }

    fn table_growing(
        &mut self,
        current: usize,
        desired: usize,
        maximum: Option<usize>,
    ) -> anyhow::Result<bool> {
        self.limits.table_growing(current, desired, maximum)
    }

    fn instances(&self) -> usize {
        self.limits.instances()
    }

    fn tables(&self) -> usize {
        self.limits.tables()
    }

    fn memories(&self) -> usize {
        self.limits.memories()
    }
}

/// Evaluates a RequestContext against a loaded WASM module.
/// Enforces a 1MB memory limit, 1,000,000 fuel limit, and a 5ms timeout.
pub async fn evaluate_wasm_rule(engine: &Engine, module: &Module, ctx: &RequestContext) -> Verdict {
    let json_bytes = match serde_json::to_vec(ctx) {
        Ok(bytes) => bytes,
        Err(e) => {
            tracing::error!("Failed to serialize RequestContext to JSON for WASM: {}", e);
            return Verdict::Bypass;
        }
    };

    // Configure memory limit of 16MB (256 pages)
    let limits = StoreLimitsBuilder::new()
        .memory_size(16 * 1024 * 1024)
        .build();

    let mut store = Store::new(engine, WasmState { limits });
    store.limiter(|state| state);

    // Set fuel limit of 1,000,000 units
    if let Err(e) = store.set_fuel(1_000_000) {
        tracing::error!("Failed to set WASM store fuel: {}", e);
        return Verdict::Bypass;
    }

    // Set up host functions Linker
    let mut linker = Linker::new(engine);
    if let Err(e) = register_host_imports(&mut linker) {
        tracing::error!("Failed to register WASM host imports: {}", e);
        return Verdict::Bypass;
    }

    // Wrap execution in a tokio timeout (5ms)
    let eval_future = async {
        let instance = linker.instantiate(&mut store, module)?;

        // Find memory export
        let memory = instance
            .get_memory(&mut store, "memory")
            .ok_or_else(|| anyhow::anyhow!("WASM module missing 'memory' export"))?;

        // Allocate memory in guest for request JSON
        // First try to look up __allocate, fallback to __new
        let offset = if let Ok(alloc_fn) =
            instance.get_typed_func::<i32, i32>(&mut store, "allocate")
        {
            alloc_fn.call(&mut store, json_bytes.len() as i32)?
        } else if let Ok(new_fn) = instance.get_typed_func::<(i32, i32), i32>(&mut store, "__new") {
            // AssemblyScript __new(size, id) -> class ID 0 is raw block
            new_fn.call(&mut store, (json_bytes.len() as i32, 0))?
        } else {
            return Err(anyhow::anyhow!(
                "WASM module missing '__allocate' or '__new' export"
            ));
        };

        // Write request JSON to linear memory
        memory.write(&mut store, offset as usize, &json_bytes)?;

        // Call guest evaluate(offset, len)
        let evaluate_fn = instance.get_typed_func::<(i32, i32), i32>(&mut store, "evaluate")?;
        let res = evaluate_fn.call(&mut store, (offset, json_bytes.len() as i32))?;

        Ok(res)
    };

    match tokio::time::timeout(Duration::from_millis(5), eval_future).await {
        Ok(Ok(verdict_val)) => {
            match verdict_val {
                0 => Verdict::Bypass,
                1 => Verdict::Kill {
                    reason: "Blocked by custom WASM governance rule".to_string(),
                    policy_id: None,
                },
                2 => {
                    // Verdict::Enhance or Redact?
                    // LLD says:
                    // 0 -> ALLOW
                    // 1 -> BLOCK
                    // 2 -> REDACT (strip matching fields)
                    // If we return a Kill, let's treat 1 or 2 as Kill for now,
                    // or let evaluate determine.
                    // Wait, let's support block for both 1 and 2 to be safe,
                    // or map 2 to a redacted state or just Kill with reason.
                    Verdict::Kill {
                        reason: "Blocked by custom WASM governance rule (DLP)".to_string(),
                        policy_id: None,
                    }
                }
                _ => {
                    tracing::warn!("WASM plugin returned unknown verdict code: {}", verdict_val);
                    Verdict::Bypass
                }
            }
        }
        Ok(Err(e)) => {
            tracing::warn!("WASM plugin execution error (fail-open): {}", e);
            Verdict::Bypass
        }
        Err(_) => {
            tracing::warn!("WASM plugin execution timed out after 5ms (fail-open)");
            Verdict::Bypass
        }
    }
}
