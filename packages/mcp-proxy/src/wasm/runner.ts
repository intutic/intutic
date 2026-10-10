/**
 * wasm/runner.ts — WasmRunner: owns the one dedicated `worker_threads`
 * Worker (worker.ts), the local-rules loader (loader.ts), the workspace's
 * control-plane rules (cloudRules.ts), and the evaluate-all-rules union logic
 * ported from `packages/proxy/src/wasm/registry.rs`'s `evaluate_inner`
 * (most-restrictive-wins, short-circuit on a block, carry the first reask
 * through).
 *
 * Both sources run as one list in priority order, lower first; on a tie a
 * control-plane rule runs before a local one, as in `registry.rs`. Local rules
 * are `local:<file name>`; a control-plane rule keeps the control plane's id,
 * the one the LLM proxy and the dashboard name it by. A control-plane rule in
 * `SHADOW` mode is evaluated like any other and logged, and never decides the
 * call — not even when it reaches no verdict.
 *
 * ## Divergences from the Rust runner (all recorded as TD entries)
 *
 * - **Fuel: the same 1,000,000-instruction budget, metered a different
 *   way.** V8 has no fuel hook, so `wasmFuel.ts` (shared-types) rewrites each rule at load to
 *   count its own instructions and trap when the budget runs out (TD-440).
 *   A rule that exhausts it reaches no verdict, as under Wasmtime.
 * - **The deadline is a backstop, not the limit.** Fuel is the limit: it is
 *   deterministic, so a rule within budget is never refused because the
 *   machine is busy. The deadline catches what fuel cannot see — a bulk
 *   `memory.fill` costs one instruction whatever its length, a host call
 *   costs none — and it races a `postMessage` round trip that the
 *   in-process Wasmtime call never pays. See {@link EVALUATE_TIMEOUT_MS}.
 * - **Guest memory ceiling: the same 16MB, enforced a different way.**
 *   `runner.rs` sets a `StoreLimits` cap; V8 has no such hook, but it does
 *   enforce the maximum a module declares, so `worker.ts` rewrites the
 *   module's memory section to declare 16MB as its maximum before compiling
 *   (`wasmMemoryCap.ts`). A `memory.grow` past it returns -1 as it would under
 *   Wasmtime. Not a divergence any more; TD-440 records how it got here.
 * - **Rego rules (OPA builds) run through `@intutic/shared-types`' Rego
 *   host**, with their own instruction budget (`wasmFuel.ts`'s
 *   `REGO_FUEL_BUDGET`) and deadline (`REGO_EVALUATE_TIMEOUT_MS`), and
 *   reply with a decision instead of a verdict code — a hold has none.
 * - **`read_referenced_file` is served from a pre-read table**
 *   (`referencedFiles.ts`, the port of `referenced_files.rs`), prefetched
 *   once per `evaluate()` only when a loaded rule imports the function and
 *   `INTUTIC_WASM_MANIFEST_ROOT` is set; otherwise every call refuses,
 *   exactly as the Rust proxy answers with no root configured.
 *
 * @module
 */

import { Worker } from 'node:worker_threads'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createStderrLogger as createLogger } from '../stderrLog.js'
import type { WasmRuleDescriptor } from '@intutic/shared-types'
import { WasmLoader, resolveWasmDir, type CompileFailureReason, type CompileOutcome } from './loader.js'
import type { CloudRuleBridge, CloudRuleSet } from './cloudRules.js'
import { buildRegoInput, buildWasmContext, type WasmContextInput } from './context.js'
import { prefetch, resolveRoot, ReferencedFiles, type ReferencedFilesTable } from './referencedFiles.js'

const log = createLogger('mcp-proxy-wasm-runner')

/**
 * A native rule's deadline: a backstop for stalls the instruction budget
 * cannot see, set well above the time any rule within budget takes on a busy
 * machine, because a rule that reaches no verdict refuses the call.
 *
 * Measured on a 14-core machine, idle and with 100 busy threads (about the
 * oversubscription of a 4-vCPU CI runner running every package's suite): the
 * 1,000,000-instruction budget runs out in at most 2 ms either way, and a
 * worker round trip for a 60 KB context takes at most 0.5 ms idle and 3.9 ms
 * loaded. The Rego round trip below shows the loaded machine also stalls a
 * thread for hundreds of milliseconds, which is what one second covers.
 */
export const EVALUATE_TIMEOUT_MS = 1_000

/**
 * A Rego rule's deadline, on the same reasoning with the Rego budget
 * (`REGO_FUEL_BUDGET`): the destructive-shell example on the largest input
 * (64 KB) takes at most 6 ms idle and 430 ms loaded, round trip included, and
 * a loop using up the whole budget takes up to 350 ms idle and 4.4 s loaded.
 * Ten seconds is over twice that, so on a loaded machine the budget still
 * stops a runaway rule first, and only a stall fuel cannot see waits this long.
 */
export const REGO_EVALUATE_TIMEOUT_MS = 10_000

/** Generous — compilation is not guest-controlled per evaluation, but a
 *  pathological file must not hang a rescan forever. */
const COMPILE_TIMEOUT_MS = 3_000

/**
 * Consecutive per-rule runaways (a timeout, or the instruction budget running
 * out) before that rule is quarantined until the next rescan.
 */
export const MAX_CONSECUTIVE_RUNAWAYS = 3

/**
 * Why a rule reached no verdict, in the one word a refusal and a log line use
 * — the Rust proxy's `limits::Stop` — plus `quarantined`: not evaluated at
 * all, after {@link MAX_CONSECUTIVE_RUNAWAYS} runaways in a row.
 */
export type RuleStop = 'deadline' | 'budget' | 'error' | 'result' | 'quarantined'

export type WasmVerdict =
  | { code: 'allow' }
  | { code: 'block'; reason: string; ruleId: string }
  | { code: 'reask'; reason: string; ruleId: string }
  /** A Rego rule's `hold`: the interceptor puts the call through the decisions API. */
  | { code: 'hold'; reason: string; ruleId: string; riskTier?: string }
  /**
   * A rule reached no verdict: the call is refused as `GOVERNANCE_UNAVAILABLE`,
   * whatever the proxy's fail setting (see {@link WasmRunner.evaluate}).
   */
  | { code: 'unavailable'; reason: string; ruleId: string; stop: RuleStop }

/** One rule's answer: a native verdict code, or a Rego rule's decision. */
type RuleResult =
  | { code: number; reason?: string }
  | { decision: 'allow' | 'deny' | 'hold' | 'reask'; reason?: string; riskTier?: string }

/** A rule that ran and reached no verdict: why, in a phrase ("it ran past its 1 s deadline"). */
interface RuleFailure {
  stop: Exclude<RuleStop, 'quarantined'>
  detail: string
}

/**
 * One shadowed rule's outcome on one call, as the LLM proxy reports it on a
 * trace (`registry.rs`'s `ShadowReport`): the bypasses are reported too,
 * because they are the denominator promotion divides by.
 */
export interface ShadowReport {
  ruleId: string
  /** False when the rule allowed the call; true for a block, a reask, a hold, or no verdict. */
  wouldAct: boolean
}

/** One rule as evaluation sees it, whichever source it came from. */
interface ActiveRule {
  ruleId: string
  priority: number
  rego: boolean
  readsReferencedFiles: boolean
  /** A control-plane rule in `SHADOW` mode: evaluated and logged, never deciding. */
  shadow: boolean
}

interface PendingEntry {
  resolve: (value: unknown) => void
  timer: NodeJS.Timeout
}

/**
 * Resolves the worker script to spawn.
 *
 * Always prefers the BUILT `dist/wasm/worker.js` when it exists on disk,
 * even while this module itself is running as TypeScript source (a test
 * runner, `tsx` dev mode) — plain compiled JS needs no loader help to
 * resolve its own sibling `./hostImports.js` import, sidestepping
 * `worker_threads` module-resolution entirely. `turbo.json` declares
 * `test: { dependsOn: ['build'] }`, so `dist/` is guaranteed fresh by the
 * time `pnpm turbo test` (CI's invocation) runs any package's suite.
 *
 * Only falls back to spawning the `.ts` source directly (via `tsx`'s ESM
 * loader, registered on the worker's own `execArgv`) when no build has run
 * yet — e.g. `vitest run` invoked standalone, bypassing turbo. That
 * fallback path is NOT reliably portable: `execArgv: ['--import',
 * 'tsx/esm']` (and the `NODE_OPTIONS`-delivered equivalent, also tried) both
 * failed to propagate the loader hook to the worker's own sibling import on
 * this repo's CI runner (Node 22, Linux) despite both working locally
 * (Node 26, macOS) — a real, observed Node-version-dependent gap in how
 * `worker_threads` applies ESM loader hooks, not a hypothetical one. Run
 * `pnpm --filter @intutic/mcp-governance-proxy build` first if iterating on
 * this file with bare `vitest` outside of `turbo test`.
 */
function workerScriptSpec(): { url: URL; execArgv: string[] } {
  const srcUrl = new URL('./worker.ts', import.meta.url)
  const distPath = fileURLToPath(srcUrl).replace(/\/src\/wasm\/worker\.ts$/, '/dist/wasm/worker.js')
  if (existsSync(distPath)) {
    return { url: new URL(`file://${distPath}`), execArgv: [] }
  }
  const isSource = import.meta.url.endsWith('.ts')
  const url = new URL(isSource ? './worker.ts' : './worker.js', import.meta.url)
  return { url, execArgv: isSource ? ['--import', 'tsx/esm'] : [] }
}

export class WasmRunner implements CloudRuleBridge {
  private readonly loader: WasmLoader
  private worker: Worker | null = null
  private nextRequestId = 1
  private pending = new Map<number, PendingEntry>()
  private consecutiveRunaways = new Map<string, number>()
  /** The worker replacing one that missed a deadline, while its rules recompile. */
  private respawning: Promise<void> | null = null
  private quarantined = new Set<string>()

  /**
   * @param dirOverride - the local rules directory (see `resolveWasmDir`).
   * @param cloud - the workspace's control-plane rules; absent where there is
   *   no control plane to fetch them from (tests, local-only use).
   */
  constructor(
    dirOverride?: string,
    private readonly cloud?: CloudRuleSet,
  ) {
    this.loader = new WasmLoader(resolveWasmDir(dirOverride))
  }

  /** The resolved local rules directory, for logging. */
  getDir(): string {
    return this.loader.getDir()
  }

  /** Currently loaded rule ids, in evaluation order — observability for callers/tests. */
  getLoadedRuleIds(): string[] {
    return this.activeRules().map((r) => r.ruleId)
  }

  /**
   * Every loaded rule in evaluation order: by priority, and on a tie the
   * control-plane rules first (a stable sort over cloud-then-local, as
   * `registry.rs` sorts).
   */
  private activeRules(): ActiveRule[] {
    const cloud: ActiveRule[] = (this.cloud?.getRules() ?? []).map((r) => ({
      ruleId: r.ruleId,
      priority: r.priority,
      rego: r.rego,
      readsReferencedFiles: r.readsReferencedFiles,
      shadow: r.mode === 'SHADOW',
    }))
    const local: ActiveRule[] = this.loader.getRules().map((r) => ({
      ruleId: r.ruleId,
      priority: r.priority,
      rego: r.rego,
      readsReferencedFiles: r.readsReferencedFiles,
      shadow: false,
    }))
    return [...cloud, ...local].sort((a, b) => a.priority - b.priority)
  }

  /**
   * Brings the control-plane rules in line with the descriptors the policy
   * carries. `undefined` — no policy from the control plane yet — leaves them
   * as they are. See `CloudRuleSet.sync` for when this waits.
   */
  async syncCloudRules(descriptors: readonly WasmRuleDescriptor[] | undefined): Promise<void> {
    if (!this.cloud || !descriptors) return
    await this.respawning
    await this.cloud.sync(descriptors, this)
  }

  /**
   * Whether the workspace's control-plane rules are known: a descriptor list
   * has been applied (or this runner has no control plane to ask). Until then,
   * a call is judged without them, which the interceptor allows only under
   * the fail-open setting.
   */
  cloudRulesLoaded(): boolean {
    return !this.cloud || this.cloud.isLoaded()
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const { url, execArgv } = workerScriptSpec()
    const worker = new Worker(url, execArgv.length > 0 ? { execArgv } : undefined)
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
      rego?: boolean
      unsupportedImports?: string[]
      reason?: CompileFailureReason
      error?: string
    }>({ type: 'compile', id, ruleId, bytes: toArrayBuffer(bytes) }, COMPILE_TIMEOUT_MS)
    if (!reply) return { ok: false, reason: 'load_error', error: `compile timed out after ${COMPILE_TIMEOUT_MS}ms` }
    if (!reply.ok) {
      const fallback =
        reply.unsupportedImports && reply.unsupportedImports.length > 0
          ? `imports ${reply.unsupportedImports.join(', ')}, which this proxy does not provide`
          : 'unknown compile error'
      return {
        ok: false,
        reason: reply.reason ?? 'load_error',
        error: reply.error ?? fallback,
        unsupportedImports: reply.unsupportedImports,
      }
    }
    return { ok: true, readsReferencedFiles: reply.readsReferencedFiles ?? false, rego: reply.rego ?? false }
  }

  remove(ruleId: string): void {
    this.ensureWorker().postMessage({ type: 'remove', ruleId })
    this.replaced(ruleId)
  }

  /** A control-plane rule's version changed: the old version's runaways do not count against the new one. */
  replaced(ruleId: string): void {
    this.consecutiveRunaways.delete(ruleId)
    this.quarantined.delete(ruleId)
  }

  // ── Rescan (driven by the existing policy-tick timer — see policy.ts) ──

  /**
   * Rescans `~/.intutic/wasm/` and (re)compiles anything changed. Also
   * releases every quarantined rule — "quarantined until the next
   * policy-driven rescan" is this call.
   */
  async rescan(): Promise<void> {
    await this.respawning
    await this.loader.rescan(this)
    this.quarantined.clear()
    this.consecutiveRunaways.clear()
  }

  /**
   * Replaces the worker, resending every currently-loaded rule's bytes so the
   * new one's module cache is rebuilt, without waiting for the old one to stop.
   *
   * `Worker.terminate()` can take seconds: V8 stops a guest only at an
   * interrupt check, and a loop around a bulk `memory.fill` reaches one
   * rarely — measured, 1.5 s on an idle machine and 16 s on a loaded one. The
   * call that missed its deadline is refused at the deadline; the old worker
   * stops whenever V8 gets to it, and the next evaluation waits only for the
   * new worker's recompile (`respawning`, about 50 ms for three Rego rules).
   */
  private respawnWorker(): void {
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
      old.terminate().catch((err: unknown) => {
        log.warn({ action: 'wasm_worker_terminate_error', err: (err as Error).message }, 'WASM worker did not terminate cleanly')
      })
    }
    // Force-reload every currently-known file into the new worker — its
    // module cache started empty. `force: true` mirrors this loader's own
    // "worker cache was lost, nothing on disk moved" case. The control-plane
    // rules recompile from the bytes they were fetched with.
    const respawning = Promise.all([this.loader.rescan(this, true), this.cloud?.reload(this)])
      .then(() => undefined)
      .finally(() => {
        if (this.respawning === respawning) this.respawning = null
      })
    this.respawning = respawning
  }

  // ── Evaluation ───────────────────────────────────────────────────────

  /**
   * Evaluates every currently loaded rule (priority order) against one
   * context, as `registry.rs`'s `evaluate_inner` does: short-circuit on the
   * first block, carry the first hold and reask through in case a later rule
   * still blocks, `allow` when nothing fired.
   *
   * A rule that reaches no verdict — its deadline, its instruction budget, a
   * trap or other error, or a result that is not a verdict — refuses the call
   * (`unavailable`), whatever `mcpProxyFailBehavior` or
   * `INTUTIC_MCP_FAIL_OPEN` say. That setting exists for control-plane
   * outages, which an agent cannot cause; a rule's timeout an agent can cause
   * by padding its input, so it must never become an allow. The refusal
   * outranks a hold and a reask, since neither an approval nor a retry can
   * clear a call a rule never judged; a later rule's block still wins,
   * because it says what is wrong with the call.
   *
   * A quarantined rule (see {@link countRunaway}) refuses at once, without
   * anything being evaluated, until the next rescan.
   *
   * A `SHADOW` rule is evaluated in its place and decides nothing: what it
   * would have done, a refusal for reaching no verdict included, leaves the
   * call as the other rules decide it. Each evaluation is appended to
   * `shadowOut`, the evidence promotion out of shadow is judged on, and a
   * would-act is logged. A quarantined one is skipped, and reported as
   * nothing, since nothing ran.
   */
  async evaluate(input: WasmContextInput, shadowOut?: ShadowReport[]): Promise<WasmVerdict> {
    const rules = this.activeRules()
    const held = rules.find((r) => !r.shadow && this.quarantined.has(r.ruleId))
    if (held) {
      return {
        code: 'unavailable',
        stop: 'quarantined',
        ruleId: held.ruleId,
        reason: noVerdictReason(
          held.ruleId,
          'quarantined',
          `it is quarantined after ${MAX_CONSECUTIVE_RUNAWAYS} runaway evaluations in a row (deadline or budget), until the next rescan`,
        ),
      }
    }
    if (rules.length === 0) return { code: 'allow' }

    // Each built once, and only if a rule of that kind is loaded.
    let contextBytes: Buffer | undefined
    let regoBytes: Buffer | undefined
    const bytesFor = (rego: boolean): Buffer =>
      rego
        ? (regoBytes ??= Buffer.from(buildRegoInput(input)))
        : (contextBytes ??= Buffer.from(JSON.stringify(buildWasmContext(input))))
    let pendingReask: { code: 'reask'; reason: string; ruleId: string } | null = null
    let pendingHold: { code: 'hold'; reason: string; ruleId: string; riskTier?: string } | null = null
    let unavailable: Extract<WasmVerdict, { code: 'unavailable' }> | null = null

    // Read once per evaluation, before any rule runs, so the per-rule
    // deadline covers guest execution only — and only when a rule will ask.
    const files = rules.some((r) => r.readsReferencedFiles) ? await this.prefetchReferencedFiles(input) : undefined

    for (const rule of rules) {
      if (rule.shadow && this.quarantined.has(rule.ruleId)) continue
      const outcome = await this.evaluateOne(
        rule.ruleId,
        bytesFor(rule.rego),
        rule.rego ? REGO_EVALUATE_TIMEOUT_MS : EVALUATE_TIMEOUT_MS,
        rule.readsReferencedFiles ? files : undefined,
      )
      const failure = 'stop' in outcome ? outcome : undefinedVerdict(outcome)
      if (rule.shadow) {
        // A rule that reached no verdict would have refused the call, so it
        // counts as acting, as the LLM proxy counts its `Unavailable`.
        const wouldDo = failure ? `no verdict (${failure.stop}): ${failure.detail}` : describeResult(outcome as RuleResult)
        logShadow(rule.ruleId, wouldDo)
        shadowOut?.push({ ruleId: rule.ruleId, wouldAct: wouldDo !== undefined })
        continue
      }
      if (failure) {
        const quarantinedNow = this.quarantined.has(rule.ruleId)
        const detail = quarantinedNow
          ? `${failure.detail}; it is now quarantined until the next rescan, after ${MAX_CONSECUTIVE_RUNAWAYS} runaway evaluations in a row`
          : failure.detail
        log.warn(
          { action: 'wasm_rule_no_verdict', ruleId: rule.ruleId, stop: failure.stop },
          `WASM rule reached no verdict: ${detail} — refusing`,
        )
        if (!unavailable) {
          unavailable = {
            code: 'unavailable',
            stop: failure.stop,
            ruleId: rule.ruleId,
            reason: noVerdictReason(rule.ruleId, failure.stop, detail),
          }
        }
        continue
      }
      const result = outcome as RuleResult

      if ('decision' in result) {
        // A Rego rule. Same ordering as the native codes below: a block ends
        // it, and a hold waits for a person, so it outranks a reask.
        const reason = result.reason ?? 'Refused by Rego policy'
        if (result.decision === 'deny') return { code: 'block', reason, ruleId: rule.ruleId }
        if (result.decision === 'hold' && !pendingHold) {
          pendingHold = { code: 'hold', reason, ruleId: rule.ruleId, ...(result.riskTier ? { riskTier: result.riskTier } : {}) }
        }
        if (result.decision === 'reask' && !pendingReask) pendingReask = { code: 'reask', reason, ruleId: rule.ruleId }
        continue
      }

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
      }
    }

    return unavailable ?? pendingHold ?? pendingReask ?? { code: 'allow' }
  }

  /**
   * The referenced-files table for this evaluation (TD-441). With no
   * `INTUTIC_WASM_MANIFEST_ROOT` the table is empty and every read refuses.
   */
  private async prefetchReferencedFiles(input: WasmContextInput): Promise<ReferencedFilesTable> {
    const root = resolveRoot()
    if (!root) return ReferencedFiles.empty().toTable()
    const files = await prefetch([{ name: input.toolName, arguments: input.toolArguments ?? {} }], root)
    if (!files.isEmpty()) {
      log.debug({ action: 'wasm_referenced_files', readable: files.readableCount(), table: files.describe() }, 'referenced files resolved for WASM rules')
    }
    return files.toTable()
  }

  /** One rule's evaluation, raced against its deadline: its answer, or why it reached none. */
  private async evaluateOne(
    ruleId: string,
    contextBytes: Buffer,
    timeoutMs: number,
    files?: ReferencedFilesTable,
  ): Promise<RuleResult | RuleFailure> {
    // A worker replaced after a missed deadline has its rules only once they
    // recompile; an evaluation sent before then would find none.
    await this.respawning
    const id = this.allocId()
    const reply = await this.send<{
      ok: boolean
      code?: number
      decision?: 'allow' | 'deny' | 'hold' | 'reask'
      reason?: string
      riskTier?: string
      error?: string
      fuelExhausted?: boolean
      /** Set by the worker when a Rego rule's result is not a decision. */
      notADecision?: boolean
    }>(
      { type: 'evaluate', id, ruleId, bytes: toArrayBuffer(contextBytes), ...(files ? { files } : {}) },
      timeoutMs,
    )

    if (reply === null) {
      // Timed out: `runner.rs`'s deadline, plus this proxy's quarantine. The
      // worker is replaced so a wedged one does not time out every rule
      // behind it; this call does not wait for that (see respawnWorker).
      this.respawnWorker()
      this.countRunaway(ruleId)
      return { stop: 'deadline', detail: `it ran past its ${timeoutMs} ms deadline` }
    }

    if (!reply.ok && reply.fuelExhausted) {
      // The budget trapped the guest, so the worker is healthy: no respawn,
      // but the same quarantine count as a timeout, since it is the same
      // runaway rule caught sooner.
      this.countRunaway(ruleId)
      return { stop: 'budget', detail: 'it used up its instruction budget' }
    }

    if (!reply.ok) {
      // A guest trap (including one following an `abort` call), a result
      // that is not a decision, or an internal error — never a crash.
      return reply.notADecision
        ? { stop: 'result', detail: reply.error ?? 'it returned a result that is not a decision' }
        : { stop: 'error', detail: `it failed while running: ${reply.error ?? 'unknown error'}` }
    }

    // A clean reply resets this rule's runaway streak.
    this.consecutiveRunaways.delete(ruleId)
    if (reply.decision) {
      return {
        decision: reply.decision,
        ...(reply.reason ? { reason: reply.reason } : {}),
        ...(reply.riskTier ? { riskTier: reply.riskTier } : {}),
      }
    }
    return { code: reply.code ?? -1, reason: reply.reason }
  }

  /**
   * Counts one runaway (deadline or budget) against `ruleId`, quarantining
   * the rule at {@link MAX_CONSECUTIVE_RUNAWAYS} in a row. Logged once, at the
   * transition; what a quarantined rule means for a call is `evaluate`'s.
   */
  private countRunaway(ruleId: string): void {
    const runaways = (this.consecutiveRunaways.get(ruleId) ?? 0) + 1
    this.consecutiveRunaways.set(ruleId, runaways)
    if (runaways >= MAX_CONSECUTIVE_RUNAWAYS && !this.quarantined.has(ruleId)) {
      this.quarantined.add(ruleId)
      log.warn(
        { action: 'wasm_rule_quarantined', ruleId, consecutiveRunaways: runaways },
        'WASM rule quarantined after consecutive timeouts or budget exhaustion — retried on the next policy-driven rescan',
      )
    }
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

/** What a rule's answer would do to the call, for the shadow log; `undefined` when it allows. */
function describeResult(result: RuleResult): string | undefined {
  if ('decision' in result) return result.decision === 'allow' ? undefined : result.decision
  if (result.code === 0) return undefined
  return result.code === 3 ? 'reask' : 'block'
}

/** A shadowed rule's outcome, logged when it would have acted. */
function logShadow(ruleId: string, wouldDo: string | undefined): void {
  if (wouldDo === undefined) return
  log.info(
    { action: 'wasm_shadow_would_act', ruleId, shadowed: true, verdict: wouldDo },
    'WASM rule would have acted; shadow mode, call unchanged',
  )
}

/** A native code that is not a verdict: the rule reached none. */
function undefinedVerdict(result: RuleResult): RuleFailure | null {
  if ('decision' in result || [0, 1, 2, 3].includes(result.code)) return null
  return { stop: 'result', detail: `it returned ${result.code}, which is not a verdict code (0 allow, 1 block, 3 reask)` }
}

/** The refusal an agent reads when a rule reached no verdict: which rule, and why. */
function noVerdictReason(ruleId: string, stop: RuleStop, detail: string): string {
  return (
    `Custom rule ${ruleId} reached no verdict (${stop}): ${detail}. Tool call blocked: a ` +
    `rule that cannot decide never allows.`
  )
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
