/**
 * wasm/worker.ts — The ONE dedicated `worker_threads` worker hosting every
 * compiled WASM governance rule.
 *
 * Runs in its own thread (spawned by `wasm/runner.ts`). Owns a
 * `Map<ruleId, WebAssembly.Module>` — compiled ONCE per file and cached here
 * — but instantiates a FRESH `WebAssembly.Instance` (fresh guest memory) for
 * every `evaluate` message, mirroring the Rust runner's actual per-evaluation
 * `Store` and preventing any cross-request state leakage between calls that
 * happen to share a rule.
 *
 * Protocol (see `runner.ts` for the main-thread side):
 *   compile  { type:'compile',  id, ruleId, bytes }  -> { type:'compile-result',  id, ruleId, ok, unsupportedImports?, readsReferencedFiles?, error? }
 *   remove   { type:'remove', ruleId }                  (no reply)
 *   evaluate { type:'evaluate', id, ruleId, bytes }   -> { type:'evaluate-result', id, ruleId, ok, code?, reason?, error? }
 *
 * A guest `abort` call is inert (hostImports.ts logs and returns); an
 * uncaught exception or trap during instantiation/evaluation is caught here
 * and reported as `ok:false` — the caller (runner.ts) treats that as
 * fail-open ALLOW, exactly like a timeout, never a crash.
 *
 * @module
 */

import { parentPort } from 'node:worker_threads'
import { unsupportedWasmImports, WASM_HOST_IMPORTS } from '@intutic/shared-types'
import { createHostImports } from './hostImports.js'

/**
 * Longest reason a guest may return — ported from `runner.rs`'s
 * `MAX_GUEST_REASON` (confirmed: `const MAX_GUEST_REASON: usize = 480;`).
 */
const MAX_GUEST_REASON = 480

/**
 * Highest code point treated as a control character for the purpose of
 * stripping a guest-supplied reason string, plus the DEL character — the
 * ASCII-control-range equivalent of Rust's `char::is_control`, which
 * `runner.rs`'s `read_guest_reason` filters out for the same reason (a
 * control character would corrupt a log line or an HTTP header downstream).
 * Implemented as an explicit char-code filter rather than a regex literal,
 * to keep raw control bytes out of this file's own source text.
 */
const MAX_C0_CONTROL_CODE = 0x1f
const DEL_CODE = 0x7f

function stripControlCharacters(text: string): string {
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code <= MAX_C0_CONTROL_CODE || code === DEL_CODE) continue
    out += ch
  }
  return out
}

interface CompileMessage {
  type: 'compile'
  id: number
  ruleId: string
  bytes: ArrayBuffer
}
interface RemoveMessage {
  type: 'remove'
  ruleId: string
}
interface EvaluateMessage {
  type: 'evaluate'
  id: number
  ruleId: string
  bytes: ArrayBuffer
}
type InMessage = CompileMessage | RemoveMessage | EvaluateMessage

const modules = new Map<string, WebAssembly.Module>()

function importsUsingReadReferencedFile(module: WebAssembly.Module): boolean {
  return WebAssembly.Module.imports(module).some(
    (i) => i.module === 'env' && i.name === 'read_referenced_file' && i.kind === 'function',
  )
}

function handleCompile(msg: CompileMessage): void {
  try {
    const module = new WebAssembly.Module(new Uint8Array(msg.bytes))
    const unsupported = unsupportedWasmImports(module)
    if (unsupported.length > 0) {
      parentPort?.postMessage({
        type: 'compile-result',
        id: msg.id,
        ruleId: msg.ruleId,
        ok: false,
        unsupportedImports: unsupported,
      })
      return
    }
    modules.set(msg.ruleId, module)
    parentPort?.postMessage({
      type: 'compile-result',
      id: msg.id,
      ruleId: msg.ruleId,
      ok: true,
      readsReferencedFiles: importsUsingReadReferencedFile(module),
    })
  } catch (err) {
    parentPort?.postMessage({
      type: 'compile-result',
      id: msg.id,
      ruleId: msg.ruleId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

function handleRemove(msg: RemoveMessage): void {
  modules.delete(msg.ruleId)
}

/**
 * Ported from `runner.rs`'s `read_guest_reason`: two OPTIONAL zero-arg
 * exports, `reason_ptr()`/`reason_len()`, read only together. Every failure
 * path returns `undefined` and the caller falls back to a built-in string —
 * a guest that lies about its own memory is ignored, not trusted. Bounds are
 * checked against actual memory size, the length is capped at
 * `MAX_GUEST_REASON`, invalid UTF-8 is discarded (never lossily patched),
 * and control characters are stripped (they would corrupt a log line or an
 * HTTP header downstream) — the same discipline, in the same order, as the
 * Rust source.
 */
function readGuestReason(exportsObj: Record<string, unknown>, memory: WebAssembly.Memory): string | undefined {
  const ptrFn = exportsObj['reason_ptr']
  const lenFn = exportsObj['reason_len']
  if (typeof ptrFn !== 'function' || typeof lenFn !== 'function') return undefined

  let ptr: unknown
  let len: unknown
  try {
    ptr = (ptrFn as () => number)()
    len = (lenFn as () => number)()
  } catch {
    return undefined
  }
  if (typeof ptr !== 'number' || typeof len !== 'number') return undefined
  if (ptr <= 0 || len <= 0) return undefined

  const cappedLen = Math.min(len, MAX_GUEST_REASON)
  const end = ptr + cappedLen
  const bytes = new Uint8Array(memory.buffer)
  if (end > bytes.length) return undefined

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(ptr, end))
  } catch {
    return undefined
  }
  text = text.trim()
  if (text.length === 0) return undefined
  const stripped = stripControlCharacters(text)
  return stripped.length > 0 ? stripped : undefined
}

function handleEvaluate(msg: EvaluateMessage): void {
  const module = modules.get(msg.ruleId)
  if (!module) {
    parentPort?.postMessage({ type: 'evaluate-result', id: msg.id, ruleId: msg.ruleId, ok: false, error: 'rule not loaded' })
    return
  }

  try {
    // A holder object, not a reassigned `let`: the import object (needed by
    // `WebAssembly.Instance` below) has to exist BEFORE the instance's own
    // `memory` export does, so `createHostImports`'s closure reads through
    // one indirection that gets filled in once, right after instantiation.
    const memoryHolder: { current: WebAssembly.Memory | undefined } = { current: undefined }
    const env: WebAssembly.ModuleImports = createHostImports(() => memoryHolder.current)
    const instance = new WebAssembly.Instance(module, { env })
    const exportsObj = instance.exports as Record<string, unknown>

    const memExport = exportsObj['memory']
    if (!(memExport instanceof WebAssembly.Memory)) {
      throw new Error("WASM module missing 'memory' export")
    }
    memoryHolder.current = memExport
    const memory = memExport

    const contextBytes = new Uint8Array(msg.bytes)

    // allocate() primary, __new(size, id) AssemblyScript fallback — same
    // fallback order as runner.rs.
    let offset: number
    const allocateFn = exportsObj['allocate']
    const newFn = exportsObj['__new']
    if (typeof allocateFn === 'function') {
      offset = (allocateFn as (n: number) => number)(contextBytes.length)
    } else if (typeof newFn === 'function') {
      offset = (newFn as (size: number, id: number) => number)(contextBytes.length, 0)
    } else {
      throw new Error("WASM module missing 'allocate' or '__new' export")
    }

    // Re-read the memory view after allocate — it can grow memory, which
    // detaches any Uint8Array view taken before the call.
    new Uint8Array(memory.buffer, offset, contextBytes.length).set(contextBytes)

    const evaluateFn = exportsObj['evaluate']
    if (typeof evaluateFn !== 'function') {
      throw new Error("WASM module missing 'evaluate' export")
    }
    const code = (evaluateFn as (offset: number, len: number) => number)(offset, contextBytes.length)

    // Read inside the same call, deliberately: a guest that returns a
    // hostile length must not be able to buy extra time by doing so after
    // the verdict — same reasoning runner.rs states for its own placement.
    const reason = readGuestReason(exportsObj, memory)

    parentPort?.postMessage({ type: 'evaluate-result', id: msg.id, ruleId: msg.ruleId, ok: true, code, reason })
  } catch (err) {
    // A guest trap (including one following an `abort` call) lands here.
    // Reported as a failure, never re-thrown — the worker process must
    // survive one hostile or buggy rule to keep evaluating every other one.
    parentPort?.postMessage({
      type: 'evaluate-result',
      id: msg.id,
      ruleId: msg.ruleId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

parentPort?.on('message', (msg: InMessage) => {
  switch (msg.type) {
    case 'compile':
      handleCompile(msg)
      break
    case 'remove':
      handleRemove(msg)
      break
    case 'evaluate':
      handleEvaluate(msg)
      break
  }
})

// Referenced so a future accidental removal of the import in hostImports.ts
// is caught by a type error here, not by a rule silently linking a fifth
// host function this worker forgot to register — `createHostImports`
// already builds against `WASM_HOST_IMPORTS`' exact 4 names via
// `@intutic/shared-types`'s frozen list, imported above.
void WASM_HOST_IMPORTS
