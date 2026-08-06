//! Host function imports for WASM plugins.

use wasmtime::{Caller, Linker, Module};

/// Every host function a rule may import, declared once.
///
/// This exists because the list had already drifted: the CLI's install-time
/// validation shim in `tools/cli/src/commands/policy.ts` offered a fourth
/// import, `seed`, which this module has never registered. AssemblyScript emits
/// `env.seed` for anything reaching `Math.random()`, so such a rule passed
/// `intutic policy install` — the command whose entire job is to refuse rules
/// that cannot instantiate — and then failed to link on every request, where
/// the runner's fail-open turned it into `Bypass`. An installed rule enforcing
/// nothing, permanently, reported only as a per-request `warn`.
///
/// `seed` is deliberately absent rather than added. A governance verdict that
/// samples is not a verdict: the same request gets different answers, "why was
/// I blocked?" becomes unanswerable, and the replay corpus assumes determinism.
/// Wasmtime with fuel is otherwise fully deterministic, so this is the only
/// nondeterminism anyone could introduce.
///
/// `tools/scripts/check-wasm-host-imports.js` asserts this list and the CLI's
/// agree. One place, or they drift — which is exactly what happened.
pub const HOST_IMPORTS: &[&str] = &["log_info", "abort", "trace"];

/// Reject a module that names a host import the proxy does not provide.
///
/// Lives here rather than in `local_loader` because there are two loaders.
/// It guarded only the local-disk path, so a rule pushed from the dashboard
/// compiled clean, counted as an active plugin, and then failed to link on
/// every request — landing in the runner's `Ok(Err(_)) => Verdict::Bypass`
/// arm. Same defect, different route, and the cloud route is the one an
/// operator cannot inspect.
///
/// `Module::from_binary` compiles without resolving imports, so a rule
/// importing `env.seed` — which AssemblyScript emits for `Math.random()` —
/// used to load cleanly, count as an active plugin, and appear in
/// `intutic policy list-local`. It then failed `linker.instantiate` on *every*
/// request, and the runner's fail-open converted that into `Bypass`. The
/// operator had an installed rule enforcing nothing, permanently.
///
/// A link failure is not the transient condition fail-open exists for. It is a
/// property of the file and will hold for every request that file is present
/// for, so the honest moment to report it is once, at load.
pub fn check_imports_resolvable(module: &Module) -> anyhow::Result<()> {
    for import in module.imports() {
        // `env` is the only module the linker defines; anything else is
        // unresolvable by construction.
        let known = import.module() == "env"
            && HOST_IMPORTS.contains(&import.name());
        if !known {
            anyhow::bail!(
                "imports `{}.{}`, which the proxy does not provide. Available \
                 host imports: {}. A rule that cannot link never runs — it \
                 would be skipped on every request rather than enforcing.",
                import.module(),
                import.name(),
                HOST_IMPORTS.join(", "),
            );
        }
    }
    Ok(())
}

/// Registers host function imports into the linker.
pub fn register_host_imports(linker: &mut Linker<super::runner::WasmState>) -> anyhow::Result<()> {
    linker.func_wrap(
        "env",
        "log_info",
        |mut caller: Caller<'_, super::runner::WasmState>, ptr: i32, len: i32| {
            let mem = match caller.get_export("memory") {
                Some(wasmtime::Extern::Memory(mem)) => mem,
                _ => {
                    tracing::warn!("WASM plugin called log_info but no memory export was found");
                    return;
                }
            };
            let data = mem.data(&caller);
            let start = ptr as usize;
            let end = start + len as usize;
            if end <= data.len() {
                if let Ok(msg) = std::str::from_utf8(&data[start..end]) {
                    tracing::info!("[WASM RULE LOG] {}", msg);
                } else {
                    tracing::warn!("WASM plugin log_info payload is not valid UTF-8");
                }
            } else {
                tracing::warn!("WASM plugin log_info arguments out of memory bounds");
            }
        },
    )?;

    linker.func_wrap(
        "env",
        "abort",
        |_: Caller<'_, super::runner::WasmState>, msg: i32, file: i32, line: i32, col: i32| {
            tracing::warn!(
                "[WASM ABORT] msg_ptr={}, file_ptr={}, line={}, col={}",
                msg,
                file,
                line,
                col
            );
        },
    )?;

    linker.func_wrap(
        "env",
        "trace",
        |mut caller: Caller<'_, super::runner::WasmState>,
         ptr: i32,
         n: i32,
         _a0: f64,
         _a1: f64,
         _a2: f64,
         _a3: f64,
         _a4: f64| {
            let mem = match caller.get_export("memory") {
                Some(wasmtime::Extern::Memory(mem)) => mem,
                _ => {
                    tracing::warn!("WASM plugin called trace but no memory export was found");
                    return;
                }
            };
            let data = mem.data(&caller);
            let ptr = ptr as usize;
            if ptr >= 4 && ptr <= data.len() {
                let len_bytes = &data[ptr - 4..ptr];
                let len =
                    u32::from_le_bytes([len_bytes[0], len_bytes[1], len_bytes[2], len_bytes[3]])
                        as usize;
                let end = ptr + len;
                if end <= data.len() {
                    let utf16_data: Vec<u16> = data[ptr..end]
                        .chunks_exact(2)
                        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
                        .collect();
                    if let Ok(msg) = String::from_utf16(&utf16_data) {
                        tracing::info!("[WASM TRACE] {} (n={})", msg, n);
                        return;
                    }
                }
            }
            tracing::info!("[WASM TRACE] raw_ptr={}, n={}", ptr, n);
        },
    )?;

    // The `onnx_rules.runOnnxInference` host import was registered here and returned
    // its input pointer unchanged — an identity function standing in for neural
    // inference. Every caller therefore reconstructed its own input exactly, computed a
    // mean squared error of 0, and compared it against a 0.35 threshold that could
    // never be crossed. The WASM rule it backed was declared a KILL and could not fire.
    //
    // Removed with the rule. Sequence deviation is scored by
    // TransitionProbabilityDetector against a per-workspace distribution fitted from
    // successful runs, which needs no runtime here.
    //
    // This does narrow the host surface a user rule may import. A rule that declared
    // `runOnnxInference` will now fail to instantiate — which `intutic policy install`
    // rejects outright, by design. No behaviour is lost: any such rule was computing
    // MSE 0 and could never have blocked anything.

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasmtime::Engine;

    /// Builds a module importing exactly one function, from WAT.
    ///
    /// Hand-written rather than a checked-in `.wasm`, and deliberately not
    /// compiled with `asc`: a test that needs the AssemblyScript toolchain turns
    /// a missing-toolchain problem into a skipped assertion, and this is the
    /// assertion that stops a rule enforcing nothing.
    fn module_importing(engine: &Engine, module_name: &str, func: &str) -> Module {
        let wat = format!(r#"(module (import "{module_name}" "{func}" (func)))"#);
        Module::new(engine, wat).expect("fixture module should compile")
    }

    /// The bypass: `env.seed` is what AssemblyScript emits for `Math.random()`,
    /// the proxy has never registered it, and `Module::from_binary` compiles
    /// without resolving imports. So such a rule loaded, counted as an active
    /// plugin, and failed to link on every request — which the runner turns into
    /// `Verdict::Bypass`. It enforced nothing, and nothing said so.
    #[test]
    fn rejects_an_import_the_host_does_not_register() {
        let engine = Engine::default();
        let err = check_imports_resolvable(&module_importing(&engine, "env", "seed"))
            .expect_err("a rule importing env.seed must be refused at load");
        let msg = err.to_string();
        assert!(
            msg.contains("env") && msg.contains("seed"),
            "the failure must name the import so an author can act on it, got: {msg}"
        );
    }

    #[test]
    fn rejects_an_import_from_a_module_other_than_env() {
        let engine = Engine::default();
        // WASI is not linked. A rule reaching for the filesystem must not load.
        assert!(
            check_imports_resolvable(&module_importing(
                &engine,
                "wasi_snapshot_preview1",
                "fd_write"
            ))
            .is_err()
        );
    }

    /// The other half. A check that refuses everything would also pass the test
    /// above, and would take every real rule offline.
    #[test]
    fn accepts_every_import_the_host_actually_registers() {
        let engine = Engine::default();
        for name in HOST_IMPORTS {
            check_imports_resolvable(&module_importing(&engine, "env", name)).unwrap_or_else(|e| {
                panic!("env.{name} is registered by this module but rejected at load: {e}")
            });
        }
    }

    #[test]
    fn a_module_importing_nothing_is_fine() {
        let engine = Engine::default();
        let module = Module::new(&engine, "(module)").unwrap();
        assert!(check_imports_resolvable(&module).is_ok());
    }
}
