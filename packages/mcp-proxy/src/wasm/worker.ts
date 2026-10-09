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
 *   compile  { type:'compile',  id, ruleId, bytes }  -> { type:'compile-result',  id, ruleId, ok, unsupportedImports?, readsReferencedFiles?, rego?, error? }
 *   remove   { type:'remove', ruleId }                  (no reply)
 *   evaluate { type:'evaluate', id, ruleId, bytes, files? } -> { type:'evaluate-result', id, ruleId, ok, code?, decision?, reason?, riskTier?, error?, fuelExhausted?, notADecision? }
 *
 * A Rego rule (an OPA build, `@intutic/shared-types`' Rego host) is compiled
 * and evaluated here too; its `evaluate` bytes are the Rego input document and
 * its reply carries `decision` instead of `code`.
 *
 * `files` is the per-evaluation referenced-files table (TD-441), posted only
 * to a rule that imports `read_referenced_file`; it is rebuilt here into the
 * host-import state, so the main thread never shares memory with the guest.
 *
 * A guest `abort` call is inert (hostImports.ts logs and returns); an
 * uncaught exception or trap during instantiation/evaluation is caught here
 * and reported as `ok:false` — the caller (runner.ts) treats that as a rule
 * that reached no verdict, exactly like a timeout, never a crash.
 *
 * @module
 */

import { parentPort } from 'node:worker_threads'
import { createHash } from 'node:crypto'
import {
  REGO_DISABLE_ENV,
  evaluateRegoRule,
  isOpaModule,
  loadRegoRule,
  regoDecision,
  RegoResultError,
  unsupportedWasmImports,
  WASM_HOST_IMPORTS,
  type RegoHostOptions,
  type RegoRule,
} from '@intutic/shared-types'
import { createHostImports, newHostImportState } from './hostImports.js'
import { ReferencedFiles, type ReferencedFilesTable } from './referencedFiles.js'
import { capDeclaredMemory, WASM_PAGE_BYTES } from './memoryCap.js'
import { DEFAULT_FUEL_BUDGET, FUEL_EXPORT, REGO_FUEL_BUDGET, meterFuel } from './fuel.js'

/**
 * Guest memory ceiling, `runner.rs`'s 16MB `StoreLimits` (TD-440). Enforced at
 * load by `capDeclaredMemory`: the module's own memory is rewritten to declare
 * this as its maximum, so V8 refuses any `memory.grow` past it (the call
 * returns -1) instead of growing. A module whose initial size is already over
 * it is refused, and so is an imported memory, which would sit outside the cap.
 */
export const MAX_GUEST_MEMORY_BYTES = 16 * 1024 * 1024

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
  files?: ReferencedFilesTable
}
type InMessage = CompileMessage | RemoveMessage | EvaluateMessage

const modules = new Map<string, WebAssembly.Module>()
/** Rego policies compiled by OPA, by rule id: a different ABI, run through the shared host. */
const regoRules = new Map<string, RegoRule>()

const regoHost: RegoHostOptions = {
  digest: (algorithm, data) => createHash(algorithm).update(data).digest('hex'),
}

/**
 * Load an OPA build as a Rego rule: metered like any rule, with the Rego
 * budget (`REGO_FUEL_BUDGET`), and checked by the shared host, which refuses
 * one needing a builtin it lacks.
 */
function compileRego(msg: CompileMessage): void {
  if (process.env[REGO_DISABLE_ENV] === '1') {
    throw new Error(`Rego rules are switched off on this host (${REGO_DISABLE_ENV}=1)`)
  }
  const bytes = new Uint8Array(msg.bytes)
  const rule = loadRegoRule(bytes, new WebAssembly.Module(meterFuel(bytes, REGO_FUEL_BUDGET)), regoHost)
  if (!rule) throw new Error('not an OPA build')
  modules.delete(msg.ruleId)
  regoRules.set(msg.ruleId, rule)
  parentPort?.postMessage({ type: 'compile-result', id: msg.id, ruleId: msg.ruleId, ok: true, readsReferencedFiles: false, rego: true })
}

function importsUsingReadReferencedFile(module: WebAssembly.Module): boolean {
  return WebAssembly.Module.imports(module).some(
    (i) => i.module === 'env' && i.name === 'read_referenced_file' && i.kind === 'function',
  )
}

function handleCompile(msg: CompileMessage): void {
  try {
    if (isOpaModule(new WebAssembly.Module(new Uint8Array(msg.bytes)))) {
      compileRego(msg)
      return
    }
    const capped = capDeclaredMemory(new Uint8Array(msg.bytes), MAX_GUEST_MEMORY_BYTES / WASM_PAGE_BYTES)
    const module = new WebAssembly.Module(meterFuel(capped, DEFAULT_FUEL_BUDGET))
    if (WebAssembly.Module.imports(module).some((i) => i.kind === 'memory')) {
      throw new Error('WASM rule imports its memory; a rule must define and export its own')
    }
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
    regoRules.delete(msg.ruleId)
    modules.set(msg.ruleId, module)
    parentPort?.postMessage({
      type: 'compile-result',
      id: msg.id,
      ruleId: msg.ruleId,
      ok: true,
      readsReferencedFiles: importsUsingReadReferencedFile(module),
      rego: false,
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
  regoRules.delete(msg.ruleId)
}

/**
 * Evaluate a Rego rule against the input document the runner built
 * (`buildRegoInput`). Replies with the decision rather than a verdict code:
 * a hold has no native code.
 */
function evaluateRego(msg: EvaluateMessage, rule: RegoRule): void {
  let fuel: WebAssembly.Global | undefined
  try {
    const result = evaluateRegoRule(rule, new TextDecoder().decode(msg.bytes), {
      ...regoHost,
      onInstance: (exportsObj) => {
        const g = exportsObj[FUEL_EXPORT]
        if (g instanceof WebAssembly.Global) fuel = g
      },
    })
    const decision = regoDecision(result, rule.entrypoint)
    parentPort?.postMessage({
      type: 'evaluate-result',
      id: msg.id,
      ruleId: msg.ruleId,
      ok: true,
      decision: decision.decision,
      reason: 'reason' in decision ? decision.reason : undefined,
      riskTier: decision.riskTier ?? rule.riskTier,
    })
  } catch (err) {
    const fuelExhausted = fuel !== undefined && (fuel.value as number) < 0
    parentPort?.postMessage({
      type: 'evaluate-result',
      id: msg.id,
      ruleId: msg.ruleId,
      ok: false,
      fuelExhausted,
      notADecision: err instanceof RegoResultError,
      error: fuelExhausted
        ? `Rego rule ran out of its ${REGO_FUEL_BUDGET}-instruction budget`
        : err instanceof Error ? err.message : String(err),
    })
  }
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
  const rego = regoRules.get(msg.ruleId)
  if (rego) {
    evaluateRego(msg, rego)
    return
  }
  const module = modules.get(msg.ruleId)
  if (!module) {
    parentPort?.postMessage({ type: 'evaluate-result', id: msg.id, ruleId: msg.ruleId, ok: false, error: 'rule not loaded' })
    return
  }

  // Read in the catch below: a trap with the counter below zero is the
  // instruction budget running out, not the rule's own `unreachable`.
  let fuel: WebAssembly.Global | undefined
  try {
    // A holder object, not a reassigned `let`: the import object (needed by
    // `WebAssembly.Instance` below) has to exist BEFORE the instance's own
    // `memory` export does, so `createHostImports`'s closure reads through
    // one indirection that gets filled in once, right after instantiation.
    const memoryHolder: { current: WebAssembly.Memory | undefined } = { current: undefined }
    const hostState = newHostImportState(ReferencedFiles.fromTable(msg.files))
    const env: WebAssembly.ModuleImports = createHostImports(() => memoryHolder.current, hostState)
    const instance = new WebAssembly.Instance(module, { env })
    const exportsObj = instance.exports as Record<string, unknown>
    const fuelExport = exportsObj[FUEL_EXPORT]
    if (fuelExport instanceof WebAssembly.Global) fuel = fuelExport

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
    const fuelExhausted = fuel !== undefined && (fuel.value as number) < 0
    parentPort?.postMessage({
      type: 'evaluate-result',
      id: msg.id,
      ruleId: msg.ruleId,
      ok: false,
      fuelExhausted,
      error: fuelExhausted
        ? `WASM rule ran out of its ${DEFAULT_FUEL_BUDGET}-instruction budget`
        : err instanceof Error ? err.message : String(err),
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
