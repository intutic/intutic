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
///
/// `read_referenced_file` is the one addition since. It is not a filesystem
/// import: the host resolves and reads the file before the sandbox exists, and
/// this import copies bytes out of a table the guest cannot influence. See
/// [`super::referenced_files`] for the guards and what they cost.
pub const HOST_IMPORTS: &[&str] = &["log_info", "abort", "trace", "read_referenced_file"];

/// Name of the referenced-file import, for callers that need to ask a module
/// whether it uses one.
///
/// Spelled out again in [`HOST_IMPORTS`] rather than referenced, because
/// `tools/scripts/check-wasm-host-imports.js` reads that array as source text
/// and a constant in the slot would make the parity gate silently see three
/// imports where there are four. `host_import_list_contains_the_file_reader`
/// asserts the two agree.
pub const READ_REFERENCED_FILE: &str = "read_referenced_file";

/// Whether this module imports [`READ_REFERENCED_FILE`].
///
/// Answered once at load time and cached on the loaded module, so the registry
/// can decide whether a request needs any disk I/O at all before it does any.
/// A module that does not import it must cost exactly what it cost before the
/// feature existed — no resolution, no `stat`, no read.
pub fn module_reads_referenced_files(module: &Module) -> bool {
    module
        .imports()
        .any(|i| i.module() == "env" && i.name() == READ_REFERENCED_FILE)
}

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

/// `env.read_referenced_file(path_ptr, path_len, out_ptr, out_cap) -> i32`
///
/// Copy the contents of a file **this request's tool calls referenced** into
/// guest memory.
///
/// # The shape, and why this one
///
/// * **The guest names a path; it never opens one.** The argument is a
///   *lookup key* into a table the host built before the sandbox existed, from
///   this request's tool-call arguments. There is no code path from a guest
///   string to an `open(2)`, so the worst a hostile rule can do is ask for
///   something and be told no. This is the whole security argument, and it is
///   why the function is not `open`/`read`/`close`.
/// * **Explicit output buffer, no host allocation.** The guest owns its linear
///   memory and its allocator; a host function that called `__new` on the
///   guest's behalf would have to trust an export to be an allocator, and would
///   run guest code from inside a host call.
/// * **`out_cap == 0` is a size query.** Returns the length and writes nothing,
///   so a guest can size its buffer in one extra call rather than the host
///   inventing a second import for it. Four arguments is already the widest
///   part of this surface; a fifth function would be wider.
/// * **A short buffer is refused, not filled.** A partial copy is
///   indistinguishable from a short file to the guest, and "the manifest did
///   not contain the thing I look for" is exactly the wrong conclusion for a
///   governance rule to reach by accident.
///
/// # Failure is always a value
///
/// Every path returns one of the negative codes in [`super::referenced_files`]
/// and none of them trap. A host trap would unwind the guest, fail the whole
/// evaluation, and land in the runner's fail-open arm — so a single malformed
/// call would silently switch off every *other* check the rule performs. A
/// refusal has to be something the rule can see and act on.
///
/// This function fails **closed** (an unreadable file is refused). That is not a
/// change to the runner's fail-open verdict semantics: it is a read decision,
/// and what the rule concludes from a refusal is still the rule's to decide.
fn read_referenced_file_impl(
    caller: &mut Caller<'_, super::runner::WasmState>,
    path_ptr: i32,
    path_len: i32,
    out_ptr: i32,
    out_cap: i32,
) -> i32 {
    use super::referenced_files as rf;

    // Charged before anything else, including argument validation, so a guest
    // cannot spin on cheap malformed calls any more than on expensive good
    // ones.
    {
        let state = caller.data_mut();
        if state.file_reads_remaining == 0 {
            tracing::warn!(
                "WASM rule exhausted its {} referenced-file reads in one evaluation",
                rf::MAX_READS_PER_EVALUATION
            );
            return rf::ERR_BUDGET;
        }
        state.file_reads_remaining -= 1;
    }

    let memory = match caller.get_export("memory") {
        Some(wasmtime::Extern::Memory(memory)) => memory,
        _ => {
            tracing::warn!("WASM plugin called read_referenced_file but no memory export was found");
            return rf::ERR_BAD_ARGS;
        }
    };

    if path_ptr < 0 || path_len <= 0 || path_len as usize > rf::MAX_GUEST_PATH_BYTES || out_cap < 0 {
        return rf::ERR_BAD_ARGS;
    }

    // Copied out rather than borrowed: the write below needs the store
    // mutably, and a slice into guest memory would still be borrowing it.
    let requested = {
        let data = memory.data(&*caller);
        let start = path_ptr as usize;
        let Some(end) = start.checked_add(path_len as usize) else {
            return rf::ERR_BAD_ARGS;
        };
        if end > data.len() {
            return rf::ERR_BAD_ARGS;
        }
        match std::str::from_utf8(&data[start..end]) {
            Ok(text) => text.to_string(),
            Err(_) => return rf::ERR_BAD_ARGS,
        }
    };

    // Cloning the `Arc` (not the table) detaches the lookup from the borrow of
    // the store, so the write below is free to take it mutably.
    let files = caller.data().files.clone();
    let bytes = match files.lookup(&requested) {
        Ok(bytes) => bytes,
        Err(code) => {
            // The reason is operator-facing only. The guest gets the code and
            // is told nothing it did not already supply.
            tracing::debug!(
                path = %requested,
                code,
                reason = %files.refusal_reason(&requested),
                "refused a WASM rule's referenced-file read"
            );
            return code;
        }
    };

    // Capped at MAX_REFERENCED_FILE_BYTES on the way in, so this fits an i32.
    let len = bytes.len();
    if out_cap == 0 {
        return len as i32;
    }
    if (out_cap as usize) < len {
        return rf::ERR_BUFFER_TOO_SMALL;
    }
    match memory.write(&mut *caller, out_ptr as usize, bytes) {
        Ok(()) => len as i32,
        // Out of bounds, which wasmtime reports rather than trapping. The
        // guest gave us a bad destination; that is its problem, not a reason to
        // fail the evaluation.
        Err(_) => rf::ERR_BAD_ARGS,
    }
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

    // The one host function that lets a rule see something other than the
    // request context. See `read_referenced_file_impl` for the contract and
    // `referenced_files` for why the host, not the guest, does the reading.
    linker.func_wrap(
        "env",
        "read_referenced_file",
        |mut caller: Caller<'_, super::runner::WasmState>,
         path_ptr: i32,
         path_len: i32,
         out_ptr: i32,
         out_cap: i32|
         -> i32 { read_referenced_file_impl(&mut caller, path_ptr, path_len, out_ptr, out_cap) },
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

    /// The parity gate reads `HOST_IMPORTS` as source text, so the name has to
    /// appear there as a literal. This is the assertion that catches someone
    /// tidying it into a constant reference and silently shrinking the list the
    /// gate believes in.
    #[test]
    fn host_import_list_contains_the_file_reader() {
        assert!(HOST_IMPORTS.contains(&READ_REFERENCED_FILE));
    }

    #[test]
    fn the_file_read_import_is_detected_only_when_present() {
        let engine = Engine::default();
        assert!(module_reads_referenced_files(&module_importing(
            &engine,
            "env",
            READ_REFERENCED_FILE
        )));
        assert!(!module_reads_referenced_files(&module_importing(
            &engine, "env", "log_info"
        )));
        assert!(!module_reads_referenced_files(
            &Module::new(&engine, "(module)").unwrap()
        ));
    }
}

/// `env.read_referenced_file`, exercised through real guests.
///
/// Hand-written WAT rather than compiled AssemblyScript, for the reason the
/// import-check fixtures give: a test that needs `asc` on PATH turns a missing
/// toolchain into a skipped assertion, and these are the assertions that stand
/// between a governance sandbox and arbitrary file disclosure.
#[cfg(test)]
mod referenced_file_tests {
    use super::*;
    use crate::wasm::referenced_files::{self as rf, ReferencedFiles};
    use crate::wasm::runner::WasmState;
    use std::path::PathBuf;
    use std::sync::Arc;
    use wasmtime::{Engine, Instance, Memory, Store};

    /// Where the fixture guests write what they were given.
    const OUT: i32 = 8192;

    /// A guest that asks the host for one path and returns the answer verbatim.
    ///
    /// `probe(out_cap) -> i32` is the host's own return value, so every
    /// assertion below is on exactly the number a real rule would see.
    fn probe_module(path: &str) -> String {
        format!(
            r#"(module
                 (import "env" "read_referenced_file"
                   (func $read (param i32 i32 i32 i32) (result i32)))
                 (memory (export "memory") 2)
                 (data (i32.const 16) "{path}")
                 (func (export "probe") (param $cap i32) (result i32)
                   (call $read (i32.const 16) (i32.const {len}) (i32.const {OUT}) (local.get $cap))))"#,
            len = path.len()
        )
    }

    struct Guest {
        store: Store<WasmState>,
        instance: Instance,
        memory: Memory,
    }

    impl Guest {
        fn new(wat: &str, files: ReferencedFiles) -> Self {
            let engine = Engine::default();
            let module = Module::new(&engine, wat).expect("fixture should compile");
            let mut linker = Linker::new(&engine);
            register_host_imports(&mut linker).expect("host imports should register");
            let mut store = Store::new(
                &engine,
                WasmState::new(Default::default(), Arc::new(files)),
            );
            let instance = linker
                .instantiate(&mut store, &module)
                .expect("fixture should instantiate");
            let memory = instance
                .get_memory(&mut store, "memory")
                .expect("memory export");
            Self { store, instance, memory }
        }

        /// `expect` here is the "never a host abort" assertion: a trap inside
        /// the host would surface as an `Err` and fail every one of these tests.
        fn probe(&mut self, out_cap: i32) -> i32 {
            self.instance
                .get_typed_func::<i32, i32>(&mut self.store, "probe")
                .expect("probe export")
                .call(&mut self.store, out_cap)
                .expect("the host must never trap the guest")
        }

        fn written(&self, len: usize) -> Vec<u8> {
            let data = self.memory.data(&self.store);
            data[OUT as usize..OUT as usize + len].to_vec()
        }
    }

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("intutic-wasm-host-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The motivating case, end to end: the tool call named a manifest, and the
    /// guest gets its bytes.
    #[test]
    fn a_guest_reads_a_manifest_its_tool_call_referenced() {
        let root = scratch("read");
        std::fs::create_dir_all(root.join("k8s")).unwrap();
        let manifest = b"image: registry.example.com/app:latest";
        std::fs::write(root.join("k8s/deploy.yaml"), manifest).unwrap();

        let files = rf::read_tokens(vec!["k8s/deploy.yaml".to_string()], &root);
        let mut guest = Guest::new(&probe_module("k8s/deploy.yaml"), files);

        // A zero capacity is the size query: it reports the length and writes
        // nothing, so the guest can size its buffer without a second import.
        assert_eq!(guest.probe(0), manifest.len() as i32);
        assert_eq!(guest.written(manifest.len()), vec![0u8; manifest.len()]);

        assert_eq!(guest.probe(4096), manifest.len() as i32);
        assert_eq!(guest.written(manifest.len()), manifest.to_vec());

        let _ = std::fs::remove_dir_all(&root);
    }

    /// Guard 1, from the guest's side. The file exists, sits inside the root
    /// and has an allowed extension — and is refused, because this request's
    /// tool calls did not name it. Without this the import would be a general
    /// file-read oracle wearing a narrow signature.
    #[test]
    fn a_path_the_tool_call_never_referenced_is_refused() {
        let root = scratch("unreferenced");
        std::fs::write(root.join("deploy.yaml"), b"kind: Deployment").unwrap();
        std::fs::write(root.join("secrets.yaml"), b"token: hunter2").unwrap();

        // Only `deploy.yaml` was referenced.
        let files = rf::read_tokens(vec!["deploy.yaml".to_string()], &root);
        let mut guest = Guest::new(&probe_module("secrets.yaml"), files);

        assert_eq!(guest.probe(4096), rf::ERR_REFUSED);
        assert_eq!(guest.written(16), vec![0u8; 16], "nothing may be written on a refusal");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// Guard 3, in the form that actually matters: the traversal is in the tool
    /// call, so it *is* referenced and has to be stopped by the path guard.
    #[test]
    fn a_referenced_traversal_is_refused() {
        let root = scratch("traversal");
        let outside = root
            .parent()
            .unwrap()
            .join(format!("intutic-wasm-host-outside-{}.yaml", std::process::id()));
        std::fs::write(&outside, b"secret: yes").unwrap();

        let token = format!("../{}", outside.file_name().unwrap().to_str().unwrap());
        let files = rf::read_tokens(vec![token.clone()], &root);
        let mut guest = Guest::new(&probe_module(&token), files);

        assert_eq!(guest.probe(4096), rf::ERR_REFUSED);
        assert_eq!(guest.written(11), vec![0u8; 11]);

        let _ = std::fs::remove_file(&outside);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Guard 6. The cap withholds the file rather than handing over a prefix:
    /// a rule that scans a truncated manifest for a violation, finds none and
    /// allows the deploy is a bypass the guest could not even detect.
    #[test]
    fn an_oversized_referenced_file_is_capped_not_truncated() {
        let root = scratch("oversize");
        std::fs::write(
            root.join("big.yaml"),
            vec![b'y'; rf::MAX_REFERENCED_FILE_BYTES + 1],
        )
        .unwrap();

        let files = rf::read_tokens(vec!["big.yaml".to_string()], &root);
        let mut guest = Guest::new(&probe_module("big.yaml"), files);

        assert_eq!(guest.probe(0), rf::ERR_TOO_LARGE);
        assert_eq!(guest.probe(1024 * 1024), rf::ERR_TOO_LARGE);
        assert_eq!(guest.written(64), vec![0u8; 64], "not one byte of a capped file");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// A referenced manifest that is not on disk. Distinguished from a refusal
    /// on purpose: an agent applying a manifest that does not exist is itself
    /// something a rule may want to act on.
    #[test]
    fn a_missing_referenced_file_is_a_clean_refusal() {
        let root = scratch("missing");
        let files = rf::read_tokens(vec!["gone.yaml".to_string()], &root);
        let mut guest = Guest::new(&probe_module("gone.yaml"), files);
        assert_eq!(guest.probe(4096), rf::ERR_NOT_FOUND);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// With the capability off — the default — there is no table, so the
    /// answer is the same refusal rather than a link failure or a trap. A rule
    /// written against a configured deployment must degrade, not explode.
    #[test]
    fn with_no_files_available_every_read_is_refused() {
        let mut guest = Guest::new(&probe_module("k8s/deploy.yaml"), ReferencedFiles::empty());
        assert_eq!(guest.probe(4096), rf::ERR_REFUSED);
    }

    /// A partial copy is indistinguishable from a short file to the guest, and
    /// "the manifest did not contain the thing I look for" is the worst wrong
    /// conclusion available to a governance rule.
    #[test]
    fn a_short_output_buffer_is_refused_rather_than_partly_filled() {
        let root = scratch("short-buffer");
        std::fs::write(root.join("d.yaml"), b"image: app:latest").unwrap();
        let files = rf::read_tokens(vec!["d.yaml".to_string()], &root);
        let mut guest = Guest::new(&probe_module("d.yaml"), files);

        assert_eq!(guest.probe(4), rf::ERR_BUFFER_TOO_SMALL);
        assert_eq!(guest.written(17), vec![0u8; 17], "no prefix may be written");
        // …and the correct size is one call away.
        assert_eq!(guest.probe(0), 17);

        let _ = std::fs::remove_dir_all(&root);
    }

    /// The bound that fuel cannot express: fuel prices guest instructions, and
    /// a loop calling this import buys an arbitrarily large host-side memcpy
    /// for a handful of them.
    #[test]
    fn the_per_evaluation_read_budget_is_enforced() {
        let root = scratch("budget");
        std::fs::write(root.join("d.yaml"), b"kind: Pod").unwrap();
        let files = rf::read_tokens(vec!["d.yaml".to_string()], &root);
        let mut guest = Guest::new(&probe_module("d.yaml"), files);

        for i in 0..rf::MAX_READS_PER_EVALUATION {
            assert_eq!(guest.probe(4096), 9, "call {i} should still be within budget");
        }
        assert_eq!(guest.probe(4096), rf::ERR_BUDGET);
        // Exhausted stays exhausted; the budget is not a rate limit.
        assert_eq!(guest.probe(0), rf::ERR_BUDGET);

        let _ = std::fs::remove_dir_all(&root);
    }

    /// A rule that lies about its own memory gets a value back, not a trap.
    /// A trap would unwind the evaluation into the runner's fail-open arm, so
    /// one malformed call would switch off every other check the rule performs.
    #[test]
    fn hostile_pointers_are_refused_without_trapping() {
        let hostile = format!(
            r#"(module
                 (import "env" "read_referenced_file"
                   (func $read (param i32 i32 i32 i32) (result i32)))
                 (memory (export "memory") 1)
                 (func (export "probe") (param $case i32) (result i32)
                   (block (result i32)
                     (if (i32.eq (local.get $case) (i32.const 0))
                       (then (br 1 (call $read (i32.const 999999) (i32.const 8)
                                               (i32.const {OUT}) (i32.const 64)))))
                     (if (i32.eq (local.get $case) (i32.const 1))
                       (then (br 1 (call $read (i32.const 16) (i32.const -1)
                                               (i32.const {OUT}) (i32.const 64)))))
                     (if (i32.eq (local.get $case) (i32.const 2))
                       (then (br 1 (call $read (i32.const 16) (i32.const 1000000)
                                               (i32.const {OUT}) (i32.const 64)))))
                     (if (i32.eq (local.get $case) (i32.const 3))
                       (then (br 1 (call $read (i32.const 16) (i32.const 8)
                                               (i32.const {OUT}) (i32.const -1)))))
                     (call $read (i32.const 16) (i32.const 3)
                                 (i32.const {OUT}) (i32.const 64))))
                 (data (i32.const 16) "\ff\fe\fd"))"#
        );
        let mut guest = Guest::new(&hostile, ReferencedFiles::empty());

        // Path pointer past the end of memory; length negative; length past the
        // end; negative capacity; and a path that is not UTF-8.
        for case in 0..=4 {
            assert_eq!(
                guest.probe(case),
                rf::ERR_BAD_ARGS,
                "case {case} must be a refusal, not a trap"
            );
        }
    }

    /// A destination the guest cannot actually hold is the guest's problem, and
    /// still not a trap.
    #[test]
    fn an_out_of_bounds_destination_is_refused_without_trapping() {
        let root = scratch("bad-dest");
        std::fs::write(root.join("d.yaml"), b"kind: Pod").unwrap();
        let files = rf::read_tokens(vec!["d.yaml".to_string()], &root);

        // One page of memory, writing at 900_000.
        let wat = r#"(module
             (import "env" "read_referenced_file"
               (func $read (param i32 i32 i32 i32) (result i32)))
             (memory (export "memory") 1)
             (data (i32.const 16) "d.yaml")
             (func (export "probe") (param i32) (result i32)
               (call $read (i32.const 16) (i32.const 6) (i32.const 900000) (i32.const 4096))))"#;
        let mut guest = Guest::new(wat, files);
        assert_eq!(guest.probe(0), rf::ERR_BAD_ARGS);

        let _ = std::fs::remove_dir_all(&root);
    }

    /// A guest with no `memory` export cannot be read from or written to, and
    /// must still get an answer.
    #[test]
    fn a_guest_without_memory_is_refused_without_trapping() {
        let wat = r#"(module
             (import "env" "read_referenced_file"
               (func $read (param i32 i32 i32 i32) (result i32)))
             (memory 1)
             (func (export "probe") (param i32) (result i32)
               (call $read (i32.const 16) (i32.const 6) (i32.const 32) (i32.const 64))))"#;
        let engine = Engine::default();
        let module = Module::new(&engine, wat).unwrap();
        let mut linker = Linker::new(&engine);
        register_host_imports(&mut linker).unwrap();
        let mut store = Store::new(
            &engine,
            WasmState::new(Default::default(), Arc::new(ReferencedFiles::empty())),
        );
        let instance = linker.instantiate(&mut store, &module).unwrap();
        let probe = instance
            .get_typed_func::<i32, i32>(&mut store, "probe")
            .unwrap();
        assert_eq!(probe.call(&mut store, 0).unwrap(), rf::ERR_BAD_ARGS);
    }
}
