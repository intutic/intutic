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
/// Enforces a 16MB memory limit, 1,000,000 fuel limit, and a 5ms timeout.
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
        // First try to look up `allocate`, fallback to AssemblyScript `__new`
        let offset = if let Ok(alloc_fn) =
            instance.get_typed_func::<i32, i32>(&mut store, "allocate")
        {
            alloc_fn.call(&mut store, json_bytes.len() as i32)?
        } else if let Ok(new_fn) = instance.get_typed_func::<(i32, i32), i32>(&mut store, "__new") {
            // AssemblyScript __new(size, id) -> class ID 0 is raw block
            new_fn.call(&mut store, (json_bytes.len() as i32, 0))?
        } else {
            return Err(anyhow::anyhow!(
                "WASM module missing 'allocate' or '__new' export"
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
                // `2` was specified as REDACT and can never have meant it.
                //
                // The guest is deliberately never given the request body —
                // `RequestContext` carries no prompt and no raw payload — so
                // there is nothing for a rule to redact. That is why the comment
                // that stood here was an unresolved argument with itself rather
                // than a decision.
                //
                // Retained as a kill, because an already-installed rule
                // returning `2` must not change meaning under an upgrade, and
                // named in the log so its author can move to `1`.
                //
                // `intutic policy install` still ACCEPTS this code — it must, or
                // reinstalling an existing rule would fail — but it warns. This
                // comment used to claim install refused it, which was simply
                // untrue: install checked membership of {0,1,2,3} and said
                // nothing about 2.
                2 => {
                    tracing::warn!(
                        "WASM rule returned deprecated verdict code 2 (REDACT). The guest \
                         never receives the request body, so redaction was never expressible; \
                         treating it as a block. Return 1 to block, or 3 to reask."
                    );
                    Verdict::Kill {
                        reason: "Blocked by custom WASM governance rule (legacy code 2)".to_string(),
                        policy_id: None,
                    }
                }
                // `3` = reask: refuse this attempt, tell the agent why, let it
                // retry. `attempts_remaining` is a placeholder — only the
                // request path knows how many tries are left, because only it
                // has incremented the counter. `policy_id` is filled in by the
                // registry, the only layer that knows the rule id.
                3 => Verdict::Reask {
                    reason: "Refused by custom WASM governance rule — revise and retry"
                        .to_string(),
                    attempts_remaining: 0,
                    policy_id: None,
                },
                _ => {
                    // Still fail-open, but loud and specific. A rule returning
                    // an unmapped code was silently allowed, so an author who
                    // invented a rung got no signal at all.
                    tracing::warn!(
                        code = verdict_val,
                        "WASM rule returned an unmapped verdict code; allowing. Valid codes \
                         are 0 (allow), 1 (block) and 3 (reask)."
                    );
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
