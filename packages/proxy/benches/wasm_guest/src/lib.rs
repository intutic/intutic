//! Minimal WASM guest for proxy plugin benchmarks.
//!
//! Exports `evaluate(ptr, len) -> i32` which:
//!   1. Reads a JSON RequestContext from the given memory pointer
//!   2. Returns a verdict: 0 = Bypass (no enforcement)
//!
//! Build:
//!   cd benches/wasm_guest
//!   cargo build --target wasm32-wasip1 --release
//!
//! Output: target/wasm32-wasip1/release/bench_wasm_guest.wasm

use serde::Deserialize;

/// Simplified RequestContext matching the proxy's WASM plugin interface.
#[derive(Deserialize)]
struct RequestContext {
    model: String,
    #[serde(default)]
    workspace_id: String,
    #[serde(default)]
    estimated_cost_usd: f64,
    #[serde(default)]
    sensitivity_tier: String,
}

/// Verdict codes matching the proxy's enum:
///   0 = Bypass (no action)
///   1 = Allow  (explicit allow)
///   2 = Modify (rewrite request)
///   3 = Deny   (block request)
const VERDICT_BYPASS: i32 = 0;
const VERDICT_DENY: i32 = 3;

/// WASM entrypoint: evaluate governance rule.
///
/// # Safety
/// `ptr` must point to a valid UTF-8 JSON string of `len` bytes
/// allocated in the WASM linear memory.
#[no_mangle]
pub extern "C" fn evaluate(ptr: *const u8, len: usize) -> i32 {
    // Read the JSON from linear memory
    let slice = unsafe { std::slice::from_raw_parts(ptr, len) };
    let json_str = match std::str::from_utf8(slice) {
        Ok(s) => s,
        Err(_) => return VERDICT_DENY,
    };

    // Parse the request context
    let ctx: RequestContext = match serde_json::from_str(json_str) {
        Ok(c) => c,
        Err(_) => return VERDICT_DENY,
    };

    // Simple rule: deny if estimated cost > $10
    if ctx.estimated_cost_usd > 10.0 {
        return VERDICT_DENY;
    }

    // Simple rule: deny if sensitivity is "critical" and model is not approved
    if ctx.sensitivity_tier == "critical"
        && !ctx.model.contains("claude")
        && !ctx.model.contains("gpt-4o")
    {
        return VERDICT_DENY;
    }

    VERDICT_BYPASS
}

/// Allocate memory for the host to write the JSON input.
#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// Free previously allocated memory.
///
/// # Safety
/// `ptr` must have been returned by `alloc` with the same `len`.
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    let _ = Vec::from_raw_parts(ptr, 0, len);
}
