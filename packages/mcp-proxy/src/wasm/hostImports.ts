/**
 * wasm/hostImports.ts — The 4 frozen host imports (`WASM_HOST_IMPORTS` from
 * `@intutic/shared-types`), implemented for this proxy's `worker_threads`
 * sandbox.
 *
 * Built from `packages/proxy/src/wasm/host.rs` (the Rust behavior each
 * import must match) and from `packages/wasm-sdk/__tests__/generatedRules.test.ts`'s
 * `HOST_IMPL` (the reference Node-side implementation the task named as the
 * base to build from). `log_info`/`abort`/`trace` mirror `host.rs`'s
 * tracing-log behavior, routed through this package's own `createStderrLogger`
 * (never `console.log`/stdout — the same stdio-isolation rule every other
 * module in this package follows). `read_referenced_file` ALWAYS refuses
 * (`-2`, `ERR_REFUSED` — verified against `referenced_files.rs`): there is no
 * MCP-side file resolver in v1, a stated, deliberate limitation ("refusal is
 * a value," not a bug) recorded as a TD entry.
 *
 * @module
 */

import { createStderrLogger as createLogger } from '../stderrLog.js'

const log = createLogger('mcp-proxy-wasm-host')

/** `referenced_files.rs`'s `ERR_REFUSED` — confirmed: `pub const ERR_REFUSED: i32 = -2;`. */
export const ERR_REFUSED = -2

/**
 * Decode a UTF-8 string out of a WASM instance's linear memory. Returns `''`
 * on any bounds/decode failure — mirrors `host.rs`'s own posture of logging
 * a warning and returning without acting, never trapping the guest over a
 * malformed log call.
 */
function readUtf8(memory: WebAssembly.Memory, ptr: number, len: number): string | null {
  if (ptr < 0 || len < 0) return null
  const bytes = new Uint8Array(memory.buffer)
  const end = ptr + len
  if (end > bytes.length) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(ptr, end))
  } catch {
    return null
  }
}

/**
 * Builds the `env.*` import object for one WASM instance. `getMemory` is a
 * thunk rather than a captured value because the memory export does not
 * exist until AFTER `WebAssembly.instantiate` returns, while the import
 * object has to be supplied BEFORE it — the same ordering `host.rs` avoids
 * entirely by reading `caller.get_export("memory")` inside each call; this
 * is the Node-side equivalent of that lazy lookup.
 */
export function createHostImports(getMemory: () => WebAssembly.Memory | undefined): WebAssembly.ModuleImports {
  return {
    log_info: (ptr: number, len: number): void => {
      const memory = getMemory()
      if (!memory) {
        log.warn({ action: 'wasm_host_no_memory', call: 'log_info' }, 'WASM rule called log_info with no memory export')
        return
      }
      const msg = readUtf8(memory, ptr, len)
      if (msg === null) {
        log.warn({ action: 'wasm_log_info_bad_args' }, 'WASM rule log_info payload out of bounds or not valid UTF-8')
        return
      }
      log.info({ action: 'wasm_rule_log' }, msg)
    },

    // Mirrors host.rs's `abort` import: log only, never throw/trap. A guest
    // unhandled-exception calling `abort` must not crash the evaluation —
    // the caller (worker.ts) still wraps the whole `evaluate` call so any
    // resulting trap fails open, but this import itself is inert.
    abort: (msgPtr: number, filePtr: number, line: number, col: number): void => {
      log.warn(
        { action: 'wasm_abort', msgPtr, filePtr, line, col },
        'WASM rule called abort (AssemblyScript unhandled exception)',
      )
    },

    // Best-effort decode of AssemblyScript's `String#trace` layout — a
    // length-prefixed UTF-16LE string with the 4-byte length immediately
    // before `ptr`. Falls back to logging the raw pointer/length, same as
    // host.rs's own fallback branch, rather than treating a decode failure
    // as fatal.
    trace: (ptr: number, n: number): void => {
      const memory = getMemory()
      if (!memory) return
      if (ptr >= 4) {
        const bytes = new Uint8Array(memory.buffer)
        if (ptr <= bytes.length) {
          const lenBytes = bytes.subarray(ptr - 4, ptr)
          const len = new DataView(lenBytes.buffer, lenBytes.byteOffset, 4).getUint32(0, true)
          const end = ptr + len
          if (end <= bytes.length) {
            try {
              const utf16 = new Uint16Array(bytes.buffer, bytes.byteOffset + ptr, len / 2)
              const msg = String.fromCharCode(...utf16)
              log.info({ action: 'wasm_trace', n }, msg)
              return
            } catch {
              // fall through to the raw fallback below
            }
          }
        }
      }
      log.info({ action: 'wasm_trace_raw', ptr, n }, 'WASM trace (undecoded)')
    },

    // ALWAYS refuses — see this module's doc comment. No MCP-side file
    // resolver exists in v1; every call gets ERR_REFUSED regardless of its
    // arguments, matching the reference test harness's own HOST_IMPL.
    read_referenced_file: (_pathPtr: number, _pathLen: number, _outPtr: number, _outCap: number): number => {
      return ERR_REFUSED
    },
  }
}
