//! Host function imports for WASM plugins.

use wasmtime::{Caller, Linker};

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

    linker.func_wrap(
        "onnx_rules",
        "runOnnxInference",
        |_: Caller<'_, super::runner::WasmState>, _model_ptr: i32, input_ptr: i32| -> i32 {
            input_ptr
        },
    )?;

    Ok(())
}
