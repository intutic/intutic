/**
 * wasm/runner.ts — WasmRunner: owns the one dedicated `worker_threads`
 * Worker (worker.ts), the local-rules loader (loader.ts), and the
 * evaluate-all-rules union logic ported from
 * `packages/proxy/src/wasm/registry.rs`'s `evaluate_inner` (most-restrictive-
 * wins, short-circuit on a block, carry the first reask through).
 *
 * ## Divergences from the Rust runner (all recorded as TD entries)
 *
 * - **50ms per-rule deadline, not 5ms + fuel metering.** Wasmtime's `Store`
 *   can price guest instructions with fuel and enforce a hard wall-clock
 *   timeout independently; V8's WebAssembly has no fuel-equivalent
 *   instruction metering accessible from `worker_threads`, so a wall-clock
 *   race against a `postMessage` round trip (which also pays IPC overhead
 *   the in-process Wasmtime call never did) is the only backstop available
 *   here. 50ms, not 5ms, to keep that overhead from false-positiving a
 *   legitimate rule under normal load.
 * - **No explicit guest memory ceiling.** `runner.rs` sets a 16MB
 *   `StoreLimits` memory cap; V8's WebAssembly.Memory has its own built-in
 *   maximum (bounded by the module's own declared `maximum`, if any) but
 *   this runner does not impose a SEPARATE, proxy-owned ceiling the way the
 *   Rust `ResourceLimiter` does.
 * - **`read_referenced_file` always refuses.** See `hostImports.ts`.
 *
 * @module
 */

import { Worker } from 'node:worker_threads'
import { createStderrLogger as createLogger } from '../stderrLog.js'
import { WasmLoader, resolveWasmDir, type CompileBridge, type CompileOutcome } from './loader.js'
import { buildWasmContext, type WasmContextInput } from './context.js'

const log = createLogger('mcp-proxy-wasm-runner')

/**
 * Per-rule evaluation deadline. See this module's doc comment for why this
 * is 50ms rather than `runner.rs`'s 5ms.
 */
const EVALUATE_TIMEOUT_MS = 50

/** Generous — compilation is not guest-controlled per evaluation, but a
 *  pathological file must not hang a rescan forever. */
const COMPILE_TIMEOUT_MS = 3_000

/** Consecutive per-rule timeouts before that rule is disabled until the next rescan. */
const MAX_CONSECUTIVE_TIMEOUTS = 3

export type WasmVerdict =
  | { code: 'allow' }
  | { code: 'block'; reason: string; ruleId: string }
  | { code: 'reask'; reason: string; ruleId: string }

interface PendingEntry {
  resolve: (value: unknown) => void
  timer: NodeJS.Timeout
}

/**
 * Resolves the worker script and, when running against TypeScript source
 * directly (tests, `tsx` dev mode), the env needed to load it.
 *
 * `import.meta.url` reflects THIS file's own real extension: `.js` once
 * built to `dist/`, `.ts` when a test runner or `tsx` executes the source
 * tree directly — vite/vitest's SSR transform preserves the real file path
 * for `import.meta.url` even though it transforms content on the fly. A
 * built `.js` sibling needs no help (plain Node module resolution); a `.ts`
 * sibling needs `tsx`'s ESM loader registered for the WORKER thread's own
 * module resolution — registering it on the current (parent) process does
 * not propagate to a `worker_threads` Worker.
 *
 * Delivered via `NODE_OPTIONS`, not `execArgv: ['--import', 'tsx/esm']`:
 * Node's `worker_threads` `execArgv` option only forwards a restricted
 * allowlist of CLI flags, and `--import`'s presence on that allowlist has
 * been version-dependent across Node 22.x — confirmed working locally on
 * Node 26 but silently dropped on Node 22 (this repo's CI pin), which left
 * the worker's own `./hostImports.js` -> `.ts` sibling import unresolved
 * (`ERR_MODULE_NOT_FOUND`) even though the worker script itself still
 * started. `NODE_OPTIONS` is honored by every worker regardless of the
 * `execArgv` allowlist, so it does not have this gap.
 */
function workerScriptSpec(): { url: URL; env?: NodeJS.ProcessEnv } {
  const isSource = import.meta.url.endsWith('.ts')
  const url = new URL(isSource ? './worker.ts' : './worker.js', import.meta.url)
  if (!isSource) return { url }
  const nodeOptions = [process.env.NODE_OPTIONS, '--import tsx/esm'].filter(Boolean).join(' ')
  return { url, env: { ...process.env, NODE_OPTIONS: nodeOptions } }
}

export class WasmRunner implements CompileBridge {
  private readonly loader: WasmLoader
  private worker: Worker | null = null
  private nextRequestId = 1
  private pending = new Map<number, PendingEntry>()
  private consecutiveTimeouts = new Map<string, number>()
  private disabledRuleIds = new Set<string>()

  constructor(dirOverride?: string) {
    this.loader = new WasmLoader(resolveWasmDir(dirOverride))
  }

  /** The resolved local rules directory, for logging. */
  getDir(): string {
    return this.loader.getDir()
  }

  /** Currently loaded rule ids (`local:<file name>`), priority order — observability for callers/tests. */
  getLoadedRuleIds(): string[] {
    return this.loader.getRules().map((r) => r.ruleId)
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const { url, env } = workerScriptSpec()
    const worker = new Worker(url, env ? { env } : undefined)
    worker.on('message', (msg: { type: string; id?: number }) => {
      if (typeof msg.id !== 'number') return
      const entry = this.pending.get(msg.id)
      if (!entry) return // already timed out and removed
      clearTimeout(entry.timer)
      this.pending.delete(msg.id)
      entry.resolve(msg)
    })
    worker.on('error', (err) => {
      log.error({ action: 'wasm_worker_error', err: err.message }, 'WASM worker thread error')
    })
    this.worker = worker
    return worker
  }

  /** Send one message and wait for its correlated reply, or `null` on timeout. */
  private send<T>(msg: Record<string, unknown> & { id: number }, timeoutMs: number): Promise<T | null> {
    const worker = this.ensureWorker()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(msg['id'] as number)
        resolve(null)
      }, timeoutMs)
      this.pending.set(msg['id'] as number, { resolve: (v) => resolve(v as T), timer })
      worker.postMessage(msg)
    })
  }

  private allocId(): number {
    const id = this.nextRequestId
    this.nextRequestId += 1
    return id
  }

  // ── CompileBridge, consumed by WasmLoader.rescan ──────────────────────

  async compile(ruleId: string, bytes: Uint8Array): Promise<CompileOutcome> {
    const id = this.allocId()
    const reply = await this.send<{
      ok: boolean
      readsReferencedFiles?: boolean
      unsupportedImports?: string[]
      error?: string
    }>({ type: 'compile', id, ruleId, bytes: toArrayBuffer(bytes) }, COMPILE_TIMEOUT_MS)
    if (!reply) return { ok: false, error: `compile timed out after ${COMPILE_TIMEOUT_MS}ms` }
    if (!reply.ok) {
      const fallback =
        reply.unsupportedImports && reply.unsupportedImports.length > 0
          ? `imports ${reply.unsupportedImports.join(', ')}, which this proxy does not provide`
          : 'unknown compile error'
      return { ok: false, error: reply.error ?? fallback, unsupportedImports: reply.unsupportedImports }
    }
    return { ok: true, readsReferencedFiles: reply.readsReferencedFiles ?? false }
  }

  remove(ruleId: string): void {
    this.ensureWorker().postMessage({ type: 'remove', ruleId })
    this.consecutiveTimeouts.delete(ruleId)
    this.disabledRuleIds.delete(ruleId)
  }

  // ── Rescan (driven by the existing policy-tick timer — see policy.ts) ──

  /**
   * Rescans `~/.intutic/wasm/` and (re)compiles anything changed. Also
   * clears every rule's disabled-by-timeout status — "disable that rule
   * until the next policy-driven rescan" is this call.
   */
  async rescan(): Promise<void> {
    await this.loader.rescan(this)
    this.disabledRuleIds.clear()
    this.consecutiveTimeouts.clear()
  }

  /** Terminates the worker and respawns a fresh one, resending every currently-loaded rule's bytes so its module cache is rebuilt. */
  private async respawnWorker(): Promise<void> {
    const old = this.worker
    this.worker = null
    if (old) {
      // Fail every request still waiting on the dead worker rather than
      // leaving its promise unresolved forever.
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer)
        entry.resolve({ ok: false, error: 'worker terminated' })
        this.pending.delete(id)
      }
      await old.terminate()
    }
    // Force-reload every currently-known file into the new worker — its
    // module cache started empty. `force: true` mirrors this loader's own
    // "worker cache was lost, nothing on disk moved" case.
    await this.loader.rescan(this, true)
  }

  // ── Evaluation ───────────────────────────────────────────────────────

  /**
   * Evaluates every currently loaded, non-disabled rule (priority order)
   * against one context, mirroring `registry.rs`'s `evaluate_inner`:
   * short-circuit on the first block, carry the first reask through in case
   * a later, higher-priority rule still blocks, `allow` when nothing fired
   * or every loaded rule was fail-open (timeout/trap/unmapped code).
   */
  async evaluate(input: WasmContextInput): Promise<WasmVerdict> {
    const rules = this.loader.getRules().filter((r) => !this.disabledRuleIds.has(r.ruleId))
    if (rules.length === 0) return { code: 'allow' }

    const contextBytes = Buffer.from(JSON.stringify(buildWasmContext(input)))
    let pendingReask: { code: 'reask'; reason: string; ruleId: string } | null = null

    for (const rule of rules) {
      const result = await this.evaluateOne(rule.ruleId, contextBytes)
      if (result === null) continue // fail-open ALLOW for this rule (timeout, trap, or worker error)

      switch (result.code) {
        case 0:
          break // Bypass — try the next rule
        case 1:
          return { code: 'block', reason: result.reason ?? 'Blocked by custom WASM governance rule', ruleId: rule.ruleId }
        case 2:
          // Deprecated REDACT code — the guest never receives the request
          // body (this context carries no raw payload), so redaction was
          // never expressible. Treated as a block, loudly, mirroring
          // runner.rs's own handling exactly.
          log.warn(
            { action: 'wasm_deprecated_verdict', ruleId: rule.ruleId },
            'WASM rule returned deprecated verdict code 2 (REDACT); treating as a block. Return 1 to block, or 3 to reask.',
          )
          return {
            code: 'block',
            reason: result.reason ?? 'Blocked by custom WASM governance rule (legacy code 2)',
            ruleId: rule.ruleId,
          }
        case 3:
          if (!pendingReask) {
            pendingReask = {
              code: 'reask',
              reason: result.reason ?? 'Refused by custom WASM governance rule — revise and retry',
              ruleId: rule.ruleId,
            }
          }
          break
        default:
          log.warn(
            { action: 'wasm_unmapped_verdict', ruleId: rule.ruleId, code: result.code },
            'WASM rule returned an unmapped verdict code; allowing. Valid codes are 0 (allow), 1 (block), 3 (reask).',
          )
          break
      }
    }

    return pendingReask ?? { code: 'allow' }
  }

  /** One rule's evaluation, raced against `EVALUATE_TIMEOUT_MS`. `null` means fail-open (timeout, worker error, or guest trap). */
  private async evaluateOne(
    ruleId: string,
    contextBytes: Buffer,
  ): Promise<{ code: number; reason?: string } | null> {
    const id = this.allocId()
    const reply = await this.send<{ ok: boolean; code?: number; reason?: string; error?: string }>(
      { type: 'evaluate', id, ruleId, bytes: toArrayBuffer(contextBytes) },
      EVALUATE_TIMEOUT_MS,
    )

    if (reply === null) {
      // Timed out. Mirrors `runner.rs`'s `Err(_) => Bypass` — this call
      // fails open — plus the MCP-specific per-rule consecutive-timeout
      // disable ladder the task calls for.
      log.warn({ action: 'wasm_evaluate_timeout', ruleId, timeoutMs: EVALUATE_TIMEOUT_MS }, 'WASM rule evaluation timed out — failing open')
      const attempts = (this.consecutiveTimeouts.get(ruleId) ?? 0) + 1
      this.consecutiveTimeouts.set(ruleId, attempts)
      // terminate + lazily respawn: the NEXT evaluate() call pays the
      // respawn cost via ensureWorker()/rescan(force); triggered here so a
      // wedged worker does not keep timing out every rule behind it in this
      // same evaluate() loop.
      await this.respawnWorker()
      if (attempts >= MAX_CONSECUTIVE_TIMEOUTS) {
        this.disabledRuleIds.add(ruleId)
        log.warn(
          { action: 'wasm_rule_disabled', ruleId, consecutiveTimeouts: attempts },
          'WASM rule disabled after consecutive timeouts — will retry on the next policy-driven rescan',
        )
      }
      return null
    }

    if (!reply.ok) {
      // Worker-reported failure: a guest trap (including one following an
      // `abort` call) or an internal error. Fail-open ALLOW for this call,
      // never a crash — matches the task's explicit instruction.
      log.warn({ action: 'wasm_evaluate_error', ruleId, err: reply.error }, 'WASM rule evaluation failed — failing open')
      return null
    }

    // A clean reply resets this rule's timeout streak.
    this.consecutiveTimeouts.delete(ruleId)
    return { code: reply.code ?? -1, reason: reply.reason }
  }

  /** Terminates the worker. Safe to call even if one was never spawned. */
  async shutdown(): Promise<void> {
    const worker = this.worker
    this.worker = null
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.resolve({ ok: false, error: 'runner shut down' })
      this.pending.delete(id)
    }
    if (worker) await worker.terminate()
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  // Structured-clone (postMessage) needs an ArrayBuffer, not a Node Buffer
  // view that may share a larger underlying pool — slice guarantees the
  // bytes sent are exactly, and only, this rule's/context's own.
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

// Re-exported so callers (interceptor.ts) can build a `WasmContextInput`
// without a second import from `./context.js`.
export type { WasmContextInput }
