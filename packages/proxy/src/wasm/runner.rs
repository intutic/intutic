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
/// Longest reason a guest may return. A rule that needs more than this is
/// writing prose, and the string lands in an HTTP error body and an incident
/// description that are themselves length-capped downstream.
const MAX_GUEST_REASON: usize = 480;

/// Read an optional operator-facing reason from the guest.
///
/// Contract, both exports optional and read only together:
///   `reason_ptr() -> i32`   offset of UTF-8 bytes in linear memory
///   `reason_len() -> i32`   their length
///
/// Every failure path returns `None` and the caller falls back to the built-in
/// string. A rule that lies about its own memory gets ignored, not trusted: the
/// bounds are checked against actual memory size, the length is capped, and
/// invalid UTF-8 is discarded rather than lossily patched — a mangled reason in
/// an incident record is worse than an honest generic one.
fn read_guest_reason(
    store: &mut wasmtime::Store<WasmState>,
    instance: &wasmtime::Instance,
    memory: &wasmtime::Memory,
) -> Option<String> {
    let ptr_fn = instance.get_typed_func::<(), i32>(&mut *store, "reason_ptr").ok()?;
    let len_fn = instance.get_typed_func::<(), i32>(&mut *store, "reason_len").ok()?;

    let ptr = ptr_fn.call(&mut *store, ()).ok()?;
    let len = len_fn.call(&mut *store, ()).ok()?;
    if ptr <= 0 || len <= 0 {
        return None;
    }

    let (ptr, len) = (ptr as usize, (len as usize).min(MAX_GUEST_REASON));
    let data = memory.data(&*store);
    let end = ptr.checked_add(len)?;
    if end > data.len() {
        return None;
    }

    let text = std::str::from_utf8(&data[ptr..end]).ok()?.trim();
    if text.is_empty() {
        return None;
    }
    // Control characters would corrupt a log line or an HTTP header.
    Some(text.chars().filter(|c| !c.is_control()).collect())
}

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

        // Optionally read a reason the guest wants the operator to see.
        //
        // `evaluate` returns a bare i32, so until now every custom rule blocked
        // with the same hardcoded sentence: an author could express WHICH rule
        // fired only through the rule id, and could not say WHY at all. An
        // operator reading "Blocked by custom WASM governance rule" learns
        // nothing actionable, which is a poor showing for the one extension
        // point the product offers.
        //
        // Two OPTIONAL exports carry it. Absent, we fall back to the old string,
        // so every already-installed module keeps working byte-for-byte — this
        // must not become a flag day for rules that are already deployed.
        //
        // Read inside the same fuel/timeout budget as evaluate, deliberately: a
        // guest that returns a hostile length must not be able to buy extra time
        // by doing it after the verdict.
        let reason = read_guest_reason(&mut store, &instance, &memory);

        Ok((res, reason))
    };

    match tokio::time::timeout(Duration::from_millis(5), eval_future).await {
        Ok(Ok((verdict_val, guest_reason))) => {
            match verdict_val {
                0 => Verdict::Bypass,
                1 => Verdict::Kill {
                    reason: guest_reason
                        .clone()
                        .unwrap_or_else(|| "Blocked by custom WASM governance rule".to_string()),
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


#[cfg(test)]
mod guest_reason_tests {
    use super::*;
    use wasmtime::{Engine, Module, Store};

    /// Build a fixture guest and read whatever reason it offers.
    ///
    /// Targets `read_guest_reason` rather than `evaluate_wasm_rule` on purpose:
    /// the new logic is entirely about trusting-but-verifying guest-supplied
    /// pointers, and a full evaluation would drag in a RequestContext with
    /// thirty irrelevant fields without exercising one extra branch.
    fn reason_from(wat: &str) -> Option<String> {
        let engine = Engine::default();
        let module = Module::new(&engine, wat).expect("fixture should compile");
        let mut store = Store::new(&engine, WasmState { limits: Default::default() });
        let linker = wasmtime::Linker::new(&engine);
        let instance = linker
            .instantiate(&mut store, &module)
            .expect("fixture should instantiate");
        let memory = instance.get_memory(&mut store, "memory").expect("memory export");
        read_guest_reason(&mut store, &instance, &memory)
    }

    const REASON: &str = "image ...:latest is not pinned to an approved digest";

    #[test]
    fn a_guest_supplied_reason_is_returned() {
        let wat = format!(
            r#"(module
                 (memory (export "memory") 1)
                 (data (i32.const 64) "{REASON}")
                 (func (export "reason_ptr") (result i32) i32.const 64)
                 (func (export "reason_len") (result i32) i32.const {len}))"#,
            len = REASON.len()
        );
        assert_eq!(reason_from(&wat).as_deref(), Some(REASON));
    }

    #[test]
    fn a_module_without_the_exports_falls_back() {
        // Every rule installed before this feature. They must keep working.
        let wat = r#"(module (memory (export "memory") 1))"#;
        assert_eq!(reason_from(wat), None);
    }

    #[test]
    fn an_out_of_bounds_pointer_is_refused_not_trusted() {
        let wat = r#"(module
             (memory (export "memory") 1)
             (func (export "reason_ptr") (result i32) i32.const 1000000)
             (func (export "reason_len") (result i32) i32.const 32))"#;
        assert_eq!(reason_from(wat), None);
    }

    #[test]
    fn a_length_running_past_the_end_is_refused() {
        // ptr is valid, ptr+len is not. The addition must be checked, not just
        // the pointer.
        let wat = r#"(module
             (memory (export "memory") 1)
             (data (i32.const 64) "hi")
             (func (export "reason_ptr") (result i32) i32.const 65530)
             (func (export "reason_len") (result i32) i32.const 400))"#;
        assert_eq!(reason_from(wat), None);
    }

    #[test]
    fn a_zero_or_negative_pointer_falls_back() {
        for ptr in ["0", "-1"] {
            let wat = format!(
                r#"(module
                     (memory (export "memory") 1)
                     (func (export "reason_ptr") (result i32) i32.const {ptr})
                     (func (export "reason_len") (result i32) i32.const 4))"#
            );
            assert_eq!(reason_from(&wat), None, "ptr={ptr}");
        }
    }

    #[test]
    fn an_over_long_reason_is_capped_not_rejected() {
        // A rule writing prose still gets a usable verdict, truncated.
        let long = "A".repeat(1200);
        let wat = format!(
            r#"(module
                 (memory (export "memory") 1)
                 (data (i32.const 8) "{long}")
                 (func (export "reason_ptr") (result i32) i32.const 8)
                 (func (export "reason_len") (result i32) i32.const 1200))"#
        );
        assert_eq!(reason_from(&wat).map(|r| r.len()), Some(MAX_GUEST_REASON));
    }

    #[test]
    fn control_characters_are_stripped() {
        // They would corrupt a log line or an HTTP header downstream.
        let wat = r#"(module
             (memory (export "memory") 1)
             (data (i32.const 16) "bad\0a\09reason")
             (func (export "reason_ptr") (result i32) i32.const 16)
             (func (export "reason_len") (result i32) i32.const 12))"#;
        assert_eq!(reason_from(wat).as_deref(), Some("badreason"));
    }

    #[test]
    fn invalid_utf8_falls_back_rather_than_being_mangled() {
        let wat = r#"(module
             (memory (export "memory") 1)
             (data (i32.const 16) "\ff\fe\fd")
             (func (export "reason_ptr") (result i32) i32.const 16)
             (func (export "reason_len") (result i32) i32.const 3))"#;
        assert_eq!(reason_from(wat), None);
    }
}
