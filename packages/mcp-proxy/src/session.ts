/**
 * session.ts — SessionState: in-process, per-proxy-process session state for
 * Phase 2 anomaly detection.
 *
 * ## Scope: one process, one session, no cross-session persistence
 *
 * Each `McpGovernanceProxy` process fronts exactly one real MCP server for
 * exactly one harness session (the same fact `tofu.ts`'s module doc and
 * `config.ts`'s `serverName` field are built around). This class holds that
 * session's tool-call history and per-detector reask counters in a plain
 * object, in memory, for the lifetime of the process — there is no Valkey
 * key, no cross-session read, no persistence across a process restart. That
 * is a genuine v1 scope limit, not an oversight: the Rust LLM-traffic proxy's
 * anomaly plugin is a long-lived multi-tenant service with a Valkey-backed
 * rolling window (`tool_history_scope` in `proxy.rs`) shared across a
 * session's requests as they arrive at different proxy instances behind a
 * load balancer. This MCP proxy is a single stdio child process per session
 * — there is no second instance to share state with, so an in-process object
 * is both sufficient and correctly scoped, not a cut corner. Recorded as a TD
 * entry (see the Phase 2 report) so the limit is a decision on record, not a
 * silent gap discovered later.
 *
 * @module
 */

import * as node_crypto from 'node:crypto'

/**
 * Ported from the Rust proxy's `TOOL_SEQUENCE_CAP` (referenced by
 * `anchor_projection`'s doc comment in `detectors.rs`, which states the cap
 * is 60 and that `ANCHOR_FREQ_SLOTS` (256) must exceed it) — same cap, same
 * "oldest evicted first" rolling-window semantics.
 */
export const TOOL_SEQUENCE_CAP = 60

/** The subset of a `tools/list` tool entry the tool-poisoning detector needs. */
export interface ToolsListEntry {
  name: string
  description?: string
}

/** Rolling window Phase 3's `calls_last_60s` context field is computed over. */
const CALLS_WINDOW_MS = 60_000

export class SessionState {
  /**
   * A per-process identifier standing in for `RequestContext.session_id`
   * (Phase 3, `wasm/context.ts`) — this proxy has no wire-level session id
   * of its own (unlike the Rust LLM proxy, which reads one off the inbound
   * request), so a random id generated once at process start is the honest
   * substitute: stable for this process's lifetime, never claiming to be
   * anything the harness itself asserted.
   */
  readonly sessionId: string = node_crypto.randomUUID()
  private sequence: string[] = []
  /** Wall-clock time of each entry in `sequence`, same indices, same cap —
   *  kept only for `callsInLastMs`; nothing else in this class reads it. */
  private timestamps: number[] = []
  /**
   * The most recent TOFU check result for this session's server (tofu.ts,
   * evaluated in `proxy.ts`'s response-direction `handleServerLine` — TOFU
   * only ever runs against a `tools/list` RESPONSE, never a `tools/call`
   * request, so this is the honest way to surface it to Phase 3's WASM
   * context, which builds from the request-direction `interceptor.decide`
   * pipeline). `undefined` until at least one `tools/list` response has been
   * checked; a `'skipped'` TOFU outcome (no tools declared) leaves this
   * unchanged rather than resetting it, since "skipped" asserts nothing
   * about whether a mismatch was seen earlier.
   */
  private toolContractChanged: boolean | undefined
  /**
   * Reask attempt counts, keyed by detector id (Phase 2) or `wasm:<ruleId>`
   * (Phase 3 — "a WASM rule's reask counter is independent of an anomaly
   * detector's," per the Phase 3 spec). A lifetime-per-session count, not a
   * consecutive-trip count: `mod.rs`'s own doc says "trips of the same
   * finding in ONE SESSION," not "consecutive trips," and a lifetime count
   * is also the simpler, harder-to-game reading — an agent alternating
   * between tripping and briefly correcting could otherwise reset its way
   * out of ever hardening.
   */
  private reaskAttempts = new Map<string, number>()
  /**
   * The most recent post-curation `tools/list` response this session saw —
   * Phase 1's wiring already computes this array (allowlist filtering +
   * operator overrides applied); the tool-poisoning detector (Phase 2) reads
   * it from here rather than re-deriving it.
   */
  private toolsList: ToolsListEntry[] = []

  /** Append a tool name to the rolling window, evicting the oldest past the cap. */
  recordCall(toolName: string): void {
    this.sequence.push(toolName)
    this.timestamps.push(Date.now())
    if (this.sequence.length > TOOL_SEQUENCE_CAP) {
      const drop = this.sequence.length - TOOL_SEQUENCE_CAP
      this.sequence.splice(0, drop)
      this.timestamps.splice(0, drop)
    }
  }

  /**
   * Calls recorded within the last `windowMs` — Phase 3's `calls_last_60s`
   * context field. Bounded by `TOOL_SEQUENCE_CAP`'s own window like every
   * other read of `sequence`/`timestamps`: a burst that outlasts 60 real
   * calls undercounts, the same honest limit `TOOL_SEQUENCE_CAP` already
   * imposes on every sequence-based detector.
   */
  callsInLastMs(windowMs: number = CALLS_WINDOW_MS): number {
    const cutoff = Date.now() - windowMs
    let count = 0
    for (const t of this.timestamps) if (t >= cutoff) count += 1
    return count
  }

  setToolContractChanged(changed: boolean): void {
    this.toolContractChanged = changed
  }

  /** `undefined` until at least one `tools/list` response has been TOFU-checked. */
  getToolContractChanged(): boolean | undefined {
    return this.toolContractChanged
  }

  /** The recorded sequence, oldest first. */
  getSequence(): readonly string[] {
    return this.sequence
  }

  /**
   * The sequence AS IF `toolName` were the next call — used to evaluate
   * anomaly detectors BEFORE a decision is made, without mutating state.
   * `interceptor.decide()` calls this to detect (e.g.) a fifth consecutive
   * repeat on the call that WOULD BE the fifth, not the one after it;
   * `recordCall` only actually persists the entry once the call is allowed
   * (see `handleHarnessLine`, proxy.ts).
   */
  prospectiveSequence(toolName: string): readonly string[] {
    const next = [...this.sequence, toolName]
    return next.length > TOOL_SEQUENCE_CAP ? next.slice(next.length - TOOL_SEQUENCE_CAP) : next
  }

  /** Increment and return this key's reask attempt count. */
  incrReaskAttempt(key: string): number {
    const next = (this.reaskAttempts.get(key) ?? 0) + 1
    this.reaskAttempts.set(key, next)
    return next
  }

  /** Current reask attempt count for a key, `0` if it has never tripped. */
  getReaskAttempts(key: string): number {
    return this.reaskAttempts.get(key) ?? 0
  }

  setToolsList(tools: readonly ToolsListEntry[]): void {
    this.toolsList = [...tools]
  }

  getToolsList(): readonly ToolsListEntry[] {
    return this.toolsList
  }
}
