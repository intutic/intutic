//! EXPERIMENTAL: Rego policies compiled by OPA (`opa build -t wasm`) as WASM rules.
//!
//! Off unless `INTUTIC_EXPERIMENTAL_REGO_WASM=1`, and then only for rules in the
//! local rules directory. A spike, not a supported rule format: rules from the
//! control plane, the CLI's install-time checks, host builtins and the shadow and
//! replay tooling all still speak only the native ABI.
//!
//! An OPA module speaks a different ABI from an Intutic rule. It *imports* its
//! linear memory (`env.memory`) instead of exporting it, imports `opa_abort`
//! and the `opa_builtinN` dispatchers for builtins it cannot run itself, and is
//! driven through `opa_eval` rather than `evaluate(offset, len)`. This module is
//! the shim: it supplies those imports, writes the request context as the
//! policy's `input` (`policy_input`), and maps the result to a verdict.
//!
//! Contract with the policy: package `intutic`, a `deny` set of messages, built
//! with `-e intutic/deny`. A non-empty set blocks with its first message; an
//! empty or undefined one allows. Evaluation runs under the same limits as every
//! rule — 16 MB of memory, 1,000,000 fuel, a 5 ms timeout — and fails open the
//! same way.
//!
//! Builtins that need the host (`sprintf`, `time.now_ns`, `http.send`, …) are
//! not provided. A policy that uses one is refused at load, by asking the
//! module's own `builtins` export, instead of failing on every request.

use super::context::{RequestContext, Verdict};
use super::referenced_files::ReferencedFiles;
use super::runner::{sanitize_reason, WasmState};
use std::sync::Arc;
use std::time::Duration;
use wasmtime::{
    Engine, ExternType, Instance, Linker, Memory, MemoryType, Module, Store, StoreLimitsBuilder,
};

/// The flag that turns the shim on.
pub const FLAG: &str = "INTUTIC_EXPERIMENTAL_REGO_WASM";

/// The one entrypoint the shim evaluates.
pub const ENTRYPOINT: &str = "intutic/deny";

/// 16 MB, the same cap `runner::evaluate_wasm_rule` puts on a rule's memory.
const MAX_MEMORY_PAGES: u32 = 256;
const FUEL: u64 = 1_000_000;
const WASM_PAGE: usize = 64 * 1024;

/// Whether the experimental shim is on in this process.
pub fn enabled() -> bool {
    std::env::var(FLAG).is_ok_and(|v| v == "1")
}

/// Whether `module` was produced by `opa build -t wasm`: it imports its memory
/// and exports OPA's evaluation entry point and ABI version.
pub fn is_opa_module(module: &Module) -> bool {
    let imports_memory = module
        .imports()
        .any(|i| i.module() == "env" && i.name() == "memory");
    let exports = |name: &str| module.exports().any(|e| e.name() == name);
    imports_memory && exports("opa_eval") && exports("opa_wasm_abi_version")
}

/// Refuse, at load, a module this shim cannot run: an import it does not
/// provide, an ABI older than the one-shot `opa_eval` (1.2), no `intutic/deny`
/// entrypoint, or builtins that need the host.
pub fn check_loadable(engine: &Engine, module: &Module) -> anyhow::Result<()> {
    for import in module.imports() {
        let ok = import.module() == "env"
            && (import.name() == "memory"
                || import.name() == "opa_abort"
                || import.name() == "opa_println"
                || import.name().starts_with("opa_builtin"));
        if !ok {
            anyhow::bail!(
                "OPA module imports `{}.{}`, which the experimental Rego shim does not provide",
                import.module(),
                import.name()
            );
        }
    }

    let (mut store, instance, memory) = instantiate(engine, module)?;
    let abi = |store: &mut Store<WasmState>, name: &str| -> anyhow::Result<i32> {
        instance
            .get_global(&mut *store, name)
            .and_then(|g| g.get(&mut *store).i32())
            .ok_or_else(|| anyhow::anyhow!("missing ABI global `{name}`"))
    };
    let (major, minor) = (
        abi(&mut store, "opa_wasm_abi_version")?,
        abi(&mut store, "opa_wasm_abi_minor_version")?,
    );
    if major != 1 || minor < 2 {
        anyhow::bail!("OPA WASM ABI {major}.{minor}; the shim needs 1.2 or later (opa_eval)");
    }

    let builtins = dump_export(&mut store, &instance, &memory, "builtins")?;
    if builtins.as_object().is_none_or(|b| !b.is_empty()) {
        anyhow::bail!(
            "the policy needs builtins the host does not provide: {builtins}. Use builtins OPA \
             compiles into the module (concat, contains, regex.match, startswith, …)"
        );
    }
    entrypoint_id(&mut store, &instance, &memory)?;
    Ok(())
}

/// Create the store, the imported memory and the stub imports, and instantiate.
fn instantiate(
    engine: &Engine,
    module: &Module,
) -> anyhow::Result<(Store<WasmState>, Instance, Memory)> {
    let limits = StoreLimitsBuilder::new()
        .memory_size(MAX_MEMORY_PAGES as usize * WASM_PAGE)
        .build();
    let mut store = Store::new(
        engine,
        WasmState::new(limits, Arc::new(ReferencedFiles::empty())),
    );
    store.limiter(|state| state);
    store.set_fuel(FUEL)?;

    let minimum = module
        .imports()
        .find_map(|i| match (i.module(), i.name(), i.ty()) {
            ("env", "memory", ExternType::Memory(m)) => Some(m.minimum()),
            _ => None,
        })
        .ok_or_else(|| anyhow::anyhow!("not an OPA module: no env.memory import"))?;
    let minimum = u32::try_from(minimum)?;
    if minimum > MAX_MEMORY_PAGES {
        anyhow::bail!(
            "the module asks for {minimum} pages of memory; the cap is {MAX_MEMORY_PAGES}"
        );
    }
    let memory = Memory::new(&mut store, MemoryType::new(minimum, Some(MAX_MEMORY_PAGES)))?;

    let mut linker: Linker<WasmState> = Linker::new(engine);
    linker.define(&store, "env", "memory", memory)?;
    linker.func_wrap("env", "opa_abort", |_: i32| -> anyhow::Result<()> {
        anyhow::bail!("the OPA policy aborted")
    })?;
    linker.func_wrap("env", "opa_println", |_: i32| {})?;
    // Unreachable for a module `check_loadable` accepted (its `builtins` map is
    // empty); defined so the module links, and trapping if a call ever arrives.
    let no_builtin = || anyhow::anyhow!("OPA host builtins are not provided");
    linker.func_wrap(
        "env",
        "opa_builtin0",
        move |_: i32, _: i32| -> anyhow::Result<i32> { Err(no_builtin()) },
    )?;
    linker.func_wrap(
        "env",
        "opa_builtin1",
        move |_: i32, _: i32, _: i32| -> anyhow::Result<i32> { Err(no_builtin()) },
    )?;
    linker.func_wrap(
        "env",
        "opa_builtin2",
        move |_: i32, _: i32, _: i32, _: i32| -> anyhow::Result<i32> { Err(no_builtin()) },
    )?;
    linker.func_wrap(
        "env",
        "opa_builtin3",
        move |_: i32, _: i32, _: i32, _: i32, _: i32| -> anyhow::Result<i32> { Err(no_builtin()) },
    )?;
    linker.func_wrap(
        "env",
        "opa_builtin4",
        move |_: i32, _: i32, _: i32, _: i32, _: i32, _: i32| -> anyhow::Result<i32> {
            Err(no_builtin())
        },
    )?;

    let instance = linker.instantiate(&mut store, module)?;
    Ok((store, instance, memory))
}

/// Call a no-argument export that returns the address of an OPA value and dump
/// it as JSON (`builtins`, `entrypoints`).
fn dump_export(
    store: &mut Store<WasmState>,
    instance: &Instance,
    memory: &Memory,
    name: &str,
) -> anyhow::Result<serde_json::Value> {
    let value = instance
        .get_typed_func::<(), i32>(&mut *store, name)?
        .call(&mut *store, ())?;
    let json = instance
        .get_typed_func::<i32, i32>(&mut *store, "opa_json_dump")?
        .call(&mut *store, value)?;
    Ok(serde_json::from_slice(&read_c_string(
        store, memory, json,
    )?)?)
}

fn entrypoint_id(
    store: &mut Store<WasmState>,
    instance: &Instance,
    memory: &Memory,
) -> anyhow::Result<i32> {
    let entrypoints = dump_export(store, instance, memory, "entrypoints")?;
    entrypoints
        .get(ENTRYPOINT)
        .and_then(|v| v.as_i64())
        .and_then(|v| i32::try_from(v).ok())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "no `{ENTRYPOINT}` entrypoint (has {entrypoints}); build with `opa build -t wasm -e {ENTRYPOINT}`"
            )
        })
}

/// The NUL-terminated string OPA wrote at `addr`, bounded by memory.
fn read_c_string(store: &Store<WasmState>, memory: &Memory, addr: i32) -> anyhow::Result<Vec<u8>> {
    let data = memory.data(store);
    let start = usize::try_from(addr)?;
    let rest = data
        .get(start..)
        .ok_or_else(|| anyhow::anyhow!("string address {addr} is outside memory"))?;
    let len = rest
        .iter()
        .position(|&b| b == 0)
        .ok_or_else(|| anyhow::anyhow!("unterminated string at {addr}"))?;
    Ok(rest[..len].to_vec())
}

/// The policy's `input`: the request context without `tools`.
///
/// OPA parses its input inside the sandbox at about 135 fuel per byte, so the
/// 1,000,000-fuel budget covers roughly 7 KB of JSON. The tool schemas a coding
/// agent declares on every request (names and full descriptions) run to tens of
/// kilobytes and would exhaust the budget before the policy ran, failing every
/// evaluation open. The calls being made (`tool_calls`) and everything else stay.
fn policy_input(ctx: &RequestContext) -> serde_json::Result<Vec<u8>> {
    let mut value = serde_json::to_value(ctx)?;
    if let Some(obj) = value.as_object_mut() {
        obj.remove("tools");
    }
    serde_json::to_vec(&value)
}

/// Evaluate one OPA rule against `ctx`.
pub async fn evaluate_opa_rule(engine: &Engine, module: &Module, ctx: &RequestContext) -> Verdict {
    let input = match policy_input(ctx) {
        Ok(bytes) => bytes,
        Err(e) => {
            tracing::error!("Failed to serialize RequestContext for the OPA rule: {e}");
            return Verdict::Bypass;
        }
    };
    let run = async {
        let (mut store, instance, memory) = instantiate(engine, module)?;
        let entrypoint = entrypoint_id(&mut store, &instance, &memory)?;

        // `data` is the empty document: Intutic passes everything as `input`.
        let malloc = instance.get_typed_func::<i32, i32>(&mut store, "opa_malloc")?;
        let parse = instance.get_typed_func::<(i32, i32), i32>(&mut store, "opa_json_parse")?;
        let doc = malloc.call(&mut store, 2)?;
        memory.write(&mut store, usize::try_from(doc)?, b"{}")?;
        let data = parse.call(&mut store, (doc, 2))?;

        // ABI 1.2 one-shot eval: the input is written at the heap pointer and
        // the heap continues after it.
        let heap = instance
            .get_typed_func::<(), i32>(&mut store, "opa_heap_ptr_get")?
            .call(&mut store, ())?;
        let start = usize::try_from(heap)?;
        let end = start + input.len();
        if end > memory.data_size(&store) {
            let pages = (end - memory.data_size(&store)).div_ceil(WASM_PAGE) as u64;
            memory.grow(&mut store, pages)?;
        }
        memory.write(&mut store, start, &input)?;
        let eval = instance
            .get_typed_func::<(i32, i32, i32, i32, i32, i32, i32), i32>(&mut store, "opa_eval")?;
        let len = i32::try_from(input.len())?;
        let result = eval.call(&mut store, (0, entrypoint, data, heap, len, heap + len, 0))?;
        let json = read_c_string(&store, &memory, result)?;
        Ok::<_, anyhow::Error>(serde_json::from_slice::<serde_json::Value>(&json)?)
    };

    match tokio::time::timeout(Duration::from_millis(5), run).await {
        Ok(Ok(result)) => verdict_from_result(&result),
        Ok(Err(e)) => {
            tracing::warn!("OPA rule execution error (fail-open): {e}");
            Verdict::Bypass
        }
        Err(_) => {
            tracing::warn!("OPA rule timed out after 5ms (fail-open)");
            Verdict::Bypass
        }
    }
}

/// `[{"result": ["msg", …]}]` → block with the first message; an empty or
/// undefined `deny` → allow.
fn verdict_from_result(result: &serde_json::Value) -> Verdict {
    let messages = result
        .get(0)
        .and_then(|r| r.get("result"))
        .and_then(|r| r.as_array());
    match messages {
        Some(msgs) if !msgs.is_empty() => Verdict::Kill {
            reason: msgs[0]
                .as_str()
                .and_then(sanitize_reason)
                .unwrap_or_else(|| "Blocked by Rego policy".to_string()),
            policy_id: None,
        },
        _ => Verdict::Bypass,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// `tests/fixtures/rego/deny_shell.wasm`, compiled from `deny_shell.rego`
    /// beside it; see that directory's README for the command.
    const POLICY: &[u8] = include_bytes!("../../tests/fixtures/rego/deny_shell.wasm");

    fn engine() -> Engine {
        let mut config = wasmtime::Config::new();
        config.consume_fuel(true);
        Engine::new(&config).expect("engine")
    }

    fn ctx(command: &str) -> RequestContext {
        serde_json::from_value(json!({
            "session_id": "ses_1",
            "workspace_id": "ws_1",
            "virtual_key_prefix": "vk_1",
            "model": "claude-sonnet-4",
            "tools": [],
            "tool_calls": [{ "id": "call_1", "name": "Bash", "arguments": { "command": command } }],
            "estimated_input_tokens": 10,
            "budget_remaining_usd": 1.0,
            "risk_tier": "Low",
            "dlp_findings": [],
            "tool_sequence": []
        }))
        .expect("fixture context")
    }

    #[test]
    fn an_opa_build_is_recognised_and_loadable() {
        let engine = engine();
        let module = Module::new(&engine, POLICY).expect("compiles");
        assert!(is_opa_module(&module));
        check_loadable(&engine, &module).expect("loadable");
        // Not loadable through the native rule ABI: it imports its memory.
        assert!(super::super::host::check_imports_resolvable(&module).is_err());
    }

    #[test]
    fn a_native_rule_is_not_mistaken_for_an_opa_build() {
        let engine = engine();
        let wat = r#"(module (memory (export "memory") 1)
             (func (export "evaluate") (param i32 i32) (result i32) i32.const 0))"#;
        assert!(!is_opa_module(&Module::new(&engine, wat).unwrap()));
    }

    #[tokio::test]
    async fn the_rego_policy_blocks_a_destructive_shell_command() {
        let engine = engine();
        let module = Module::new(&engine, POLICY).unwrap();
        match evaluate_opa_rule(&engine, &module, &ctx("rm -rf / --no-preserve-root")).await {
            Verdict::Kill { reason, .. } => assert_eq!(
                reason,
                "destructive shell command blocked by Rego policy: rm -rf / --no-preserve-root"
            ),
            other => panic!("expected a block, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn the_rego_policy_allows_anything_else() {
        let engine = engine();
        let module = Module::new(&engine, POLICY).unwrap();
        assert_eq!(
            evaluate_opa_rule(&engine, &module, &ctx("ls -la")).await,
            Verdict::Bypass
        );
    }

    /// A coding agent declares dozens of tools with long descriptions on every
    /// request. Passed through, they alone would exhaust the fuel budget and the
    /// policy would fail open on exactly the traffic it exists for.
    #[tokio::test]
    async fn declared_tool_schemas_do_not_exhaust_the_fuel_budget() {
        let engine = engine();
        let module = Module::new(&engine, POLICY).unwrap();
        let mut c = ctx("rm -rf ~");
        c.tools = serde_json::from_value(serde_json::Value::Array(
            (0..30)
                .map(|i| json!({ "name": format!("tool_{i}"), "description": "d".repeat(2000) }))
                .collect(),
        ))
        .unwrap();
        assert!(serde_json::to_vec(&c).unwrap().len() > 60_000);
        assert!(matches!(
            evaluate_opa_rule(&engine, &module, &c).await,
            Verdict::Kill { .. }
        ));
    }

    #[test]
    fn deny_results_map_to_verdicts() {
        assert_eq!(verdict_from_result(&json!([])), Verdict::Bypass);
        assert_eq!(
            verdict_from_result(&json!([{"result": []}])),
            Verdict::Bypass
        );
        assert_eq!(
            verdict_from_result(&json!([{"result": ["no\nthanks"]}])),
            Verdict::Kill {
                reason: "nothanks".to_string(),
                policy_id: None
            }
        );
    }
}
