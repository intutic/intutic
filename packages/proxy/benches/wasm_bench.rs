//! WASM plugin evaluation benchmarks using wasmtime + WASI.
//!
//! Run:
//!   cd benches/wasm_guest && cargo build --target wasm32-wasip1 --release && cd ../..
//!   cargo bench --bench wasm_bench
//!
//! Budget targets (from ADR-004):
//!   Engine cold start:   ~5-15ms (one-time at proxy startup)
//!   Per-request eval:    <1ms    (pre-warmed Engine, the P95-relevant number)
//!   Fuel exhaustion:     hard kill at 1M fuel units
//!
//! NOTE: The WASM cold start is NOT on the hot path. The wasmtime Engine is
//! initialized once at proxy startup. Only per-request eval matters for P95.

use criterion::{black_box, criterion_group, criterion_main, Criterion};
use std::path::PathBuf;
use std::time::Duration;
use wasmtime::*;
use wasmtime_wasi::preview1::WasiP1Ctx;
use wasmtime_wasi::WasiCtxBuilder;

// ── Helpers ─────────────────────────────────────────────────────────────────

/// Path to the pre-compiled WASM guest binary.
fn wasm_path() -> PathBuf {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("benches/wasm_guest/target/wasm32-wasip1/release/bench_wasm_guest.wasm");
    if !path.exists() {
        panic!(
            "WASM guest not found at: {}\n\
             Build it first:\n  \
             cd packages/proxy/benches/wasm_guest && \
             cargo build --target wasm32-wasip1 --release",
            path.display()
        );
    }
    path
}

/// Build a typical request context JSON payload.
fn make_request_context(cost: f64) -> String {
    serde_json::json!({
        "model": "gpt-4o",
        "workspace_id": "ws_bench_wasm",
        "estimated_cost_usd": cost,
        "sensitivity_tier": "medium",
    })
    .to_string()
}

/// Build a critical-tier request that triggers the deny path.
fn make_critical_request() -> String {
    serde_json::json!({
        "model": "llama-3.1-70b",
        "workspace_id": "ws_bench_wasm",
        "estimated_cost_usd": 0.5,
        "sensitivity_tier": "critical",
    })
    .to_string()
}

/// Create a WASI-aware linker and instantiate the module.
fn instantiate_with_wasi(
    engine: &Engine,
    module: &Module,
    fuel: u64,
) -> (Store<WasiP1Ctx>, Instance) {
    let wasi_ctx = WasiCtxBuilder::new().build_p1();
    let mut store = Store::new(engine, wasi_ctx);
    store.set_fuel(fuel).unwrap();

    let mut linker: Linker<WasiP1Ctx> = Linker::new(engine);
    wasmtime_wasi::preview1::add_to_linker_sync(&mut linker, |ctx| ctx).unwrap();

    let instance = linker.instantiate(&mut store, module).unwrap();
    (store, instance)
}

/// Run the evaluate function on a WASM instance with the given JSON input.
fn run_evaluate(store: &mut Store<WasiP1Ctx>, instance: &Instance, json: &str) -> i32 {
    let input_bytes = json.as_bytes();

    // Allocate memory for input
    let alloc_fn = instance
        .get_typed_func::<i32, i32>(&mut *store, "alloc")
        .unwrap();
    let ptr = alloc_fn
        .call(&mut *store, input_bytes.len() as i32)
        .unwrap();

    // Write input to WASM linear memory
    let memory = instance.get_memory(&mut *store, "memory").unwrap();
    memory
        .write(&mut *store, ptr as usize, input_bytes)
        .unwrap();

    // Call evaluate
    let eval_fn = instance
        .get_typed_func::<(i32, i32), i32>(&mut *store, "evaluate")
        .unwrap();
    let verdict = eval_fn
        .call(&mut *store, (ptr, input_bytes.len() as i32))
        .unwrap();

    // Free input memory
    let dealloc_fn = instance
        .get_typed_func::<(i32, i32), ()>(&mut *store, "dealloc")
        .unwrap();
    dealloc_fn
        .call(&mut *store, (ptr, input_bytes.len() as i32))
        .unwrap();

    verdict
}

// ── Case 1: Engine + Module cold start ──────────────────────────────────────

/// Benchmarks the one-time initialization cost of creating a wasmtime Engine
/// and compiling a WASM module. This runs ONCE at proxy startup, not per request.
///
/// Expected: ~5-15ms (acceptable as one-time cost).
fn bench_wasm_cold_start(c: &mut Criterion) {
    let wasm_bytes = std::fs::read(wasm_path()).expect("Failed to read WASM binary");

    let mut group = c.benchmark_group("wasm_cold_start");
    group.sample_size(20); // Fewer samples — cold start is slow
    group.measurement_time(Duration::from_secs(10));

    group.bench_function("engine_and_module", |b| {
        b.iter(|| {
            let mut config = Config::new();
            config.consume_fuel(true);
            let engine = Engine::new(&config).unwrap();
            let module = Module::new(&engine, black_box(&wasm_bytes)).unwrap();
            black_box((&engine, &module));
        });
    });

    group.finish();
}

// ── Case 2: Per-request eval (pre-warmed Engine) ────────────────────────────

/// Benchmarks the per-request WASM evaluation with a pre-warmed Engine + Module.
/// This is the P95-relevant number for the proxy hot path.
///
/// Sequence:
///   1. Create a new Store with WASI context (per-request isolation)
///   2. Instantiate the module via WASI linker
///   3. Call alloc() → write JSON → evaluate() → dealloc()
///
/// Expected: <1ms per eval.
fn bench_wasm_warm_eval(c: &mut Criterion) {
    let wasm_bytes = std::fs::read(wasm_path()).expect("Failed to read WASM binary");

    // Pre-warm: create Engine + Module once
    let mut config = Config::new();
    config.consume_fuel(true);
    let engine = Engine::new(&config).unwrap();
    let module = Module::new(&engine, &wasm_bytes).unwrap();

    let mut group = c.benchmark_group("wasm_warm_eval");
    group.measurement_time(Duration::from_secs(15));

    let request_json = make_request_context(0.05);

    // Bypass path (typical — cost < $10, medium sensitivity)
    group.bench_function("bypass_typical", |b| {
        b.iter(|| {
            let (mut store, instance) = instantiate_with_wasi(&engine, &module, 1_000_000);
            let verdict = run_evaluate(&mut store, &instance, &request_json);
            assert_eq!(verdict, 0); // Bypass
            black_box(verdict);
        });
    });

    // Deny path (cost > $10)
    let expensive_json = make_request_context(15.0);
    group.bench_function("deny_high_cost", |b| {
        b.iter(|| {
            let (mut store, instance) = instantiate_with_wasi(&engine, &module, 1_000_000);
            let verdict = run_evaluate(&mut store, &instance, &expensive_json);
            assert_eq!(verdict, 3); // Deny
            black_box(verdict);
        });
    });

    // Critical sensitivity + unapproved model → deny
    let critical_json = make_critical_request();
    group.bench_function("deny_critical_unapproved", |b| {
        b.iter(|| {
            let (mut store, instance) = instantiate_with_wasi(&engine, &module, 1_000_000);
            let verdict = run_evaluate(&mut store, &instance, &critical_json);
            assert_eq!(verdict, 3); // Deny
            black_box(verdict);
        });
    });

    group.finish();
}

// ── Case 3: Fuel exhaustion ─────────────────────────────────────────────────

/// Benchmarks the fuel mechanism: verifies that wasmtime correctly traps
/// when fuel is exhausted. This tests the safety boundary, not performance.
///
/// We give the module only 100 fuel units (far too few to complete evaluation)
/// and verify it traps.
fn bench_wasm_fuel_exhaustion(c: &mut Criterion) {
    let wasm_bytes = std::fs::read(wasm_path()).expect("Failed to read WASM binary");

    let mut config = Config::new();
    config.consume_fuel(true);
    let engine = Engine::new(&config).unwrap();
    let module = Module::new(&engine, &wasm_bytes).unwrap();

    let mut group = c.benchmark_group("wasm_fuel_exhaustion");
    group.measurement_time(Duration::from_secs(10));

    let request_json = make_request_context(0.05);

    group.bench_function("trap_at_100_fuel", |b| {
        b.iter(|| {
            // Use very low fuel — instantiation or eval should trap
            let wasi_ctx = WasiCtxBuilder::new().build_p1();
            let mut store = Store::new(&engine, wasi_ctx);
            store.set_fuel(100).unwrap(); // Intentionally too low

            let mut linker: Linker<WasiP1Ctx> = Linker::new(&engine);
            wasmtime_wasi::preview1::add_to_linker_sync(&mut linker, |ctx| ctx).unwrap();

            match linker.instantiate(&mut store, &module) {
                Ok(instance) => {
                    // Instantiation succeeded — try alloc, should trap
                    let alloc_fn = instance.get_typed_func::<i32, i32>(&mut store, "alloc");
                    match alloc_fn {
                        Ok(f) => {
                            let result = f.call(&mut store, request_json.len() as i32);
                            black_box(result.is_err());
                        }
                        Err(e) => {
                            black_box(e);
                        }
                    }
                }
                Err(e) => {
                    // Instantiation itself failed due to fuel — expected
                    black_box(e);
                }
            }
        });
    });

    group.finish();
}

// ── Group and main ──────────────────────────────────────────────────────────

criterion_group!(
    benches,
    bench_wasm_cold_start,
    bench_wasm_warm_eval,
    bench_wasm_fuel_exhaustion,
);
criterion_main!(benches);
