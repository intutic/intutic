/**
 * session.ts — SessionState: a proxy process's anomaly session state, shared
 * with its sibling processes through Valkey when one is configured.
 *
 * ## Scope: one harness session, several processes
 *
 * The sync daemon wraps EACH MCP server entry with its own `McpGovernanceProxy`
 * process (`mcpAutoWrite.ts`'s `wrapWithProxy`, in both `per-session` and
 * `daemon` mode), so one harness session runs one proxy per wrapped server.
 * This class holds the tool-call sequence and the per-detector reask counters
 * the anomaly detectors read. Until Wave 5.3 (TD-437) that state was
 * per-process only — a cross-server ping-pong was invisible, a reask budget
 * reset per server and per restart — and the module doc claimed there was
 * "no second instance to share state with", which was never true of the
 * wrapping the daemon writes.
 *
 * Now, when `SessionState` is given a scope (`sessionScope.ts`: the workspace
 * plus the parent harness process) and a store (`sessionStore.ts`: the
 * Rust proxy's Valkey window shape under its own namespace), the sequence,
 * the 60 s call window and the reask counters are read from and written to
 * the shared window, so every sibling sees every sibling's calls. The
 * in-process copy is still kept and is the fallback whenever the store is
 * absent, not connected, slow or failing — never a hard dependency, and
 * exactly today's behaviour in every one of those cases.
 *
 * Per process, deliberately: `toolsList` and `toolContractChanged` describe
 * THIS process's server (TOFU pins per {workspace, server}), and `sessionId`
 * is the random per-process id handed to WASM rules as `session_id`.
 *
 * @module
 */

import * as node_crypto from 'node:crypto'
import type { SharedSessionStore } from './sessionStore.js'

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

export interface SessionStateOptions {
  /** The shared-window scope (`sessionScope.ts`); absent = per-process only. */
  scope?: string
  /** The shared store; absent = per-process only. */
  store?: SharedSessionStore
}

/** What `decide()` evaluates against: the sequence AS IF the candidate were next. */
export interface SessionWindow {
  prospective: readonly string[]
  callsLast60s: number
  /** Whether the shared window answered; `false` means the per-process copy was used. */
  shared: boolean
}

export class SessionState {
  /** The shared-window scope, when this process has one. */
  readonly scope: string | undefined
  private readonly store: SharedSessionStore | undefined
  /** The most recent write-behind, so tests can await it before reading back. */
  private lastWrite: Promise<unknown> = Promise.resolve()

  constructor(opts: SessionStateOptions = {}) {
    this.scope = opts.scope
    this.store = opts.scope ? opts.store : undefined
  }

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

  /**
   * Append a tool name to the rolling window, evicting the oldest past the
   * cap — locally always, and to the shared window as a write-behind when
   * there is one (the tool-call path does not wait on it).
   */
  recordCall(toolName: string): void {
    const now = Date.now()
    this.sequence.push(toolName)
    this.timestamps.push(now)
    if (this.sequence.length > TOOL_SEQUENCE_CAP) {
      const drop = this.sequence.length - TOOL_SEQUENCE_CAP
      this.sequence.splice(0, drop)
      this.timestamps.splice(0, drop)
    }
    if (this.store && this.scope) {
      this.lastWrite = this.store.recordCall(this.scope, toolName, now).catch(() => false)
    }
  }

  /**
   * The window `decide()` evaluates against: the shared sequence plus the
   * candidate when the shared window answers, else the per-process copy.
   * `callsLast60s` excludes the candidate either way, matching what
   * `callsInLastMs()` returns before the call is recorded.
   */
  async loadWindow(toolName: string): Promise<SessionWindow> {
    if (this.store && this.scope) {
      const snapshot = await this.store.readWindow(this.scope, Date.now(), CALLS_WINDOW_MS)
      if (snapshot) {
        const next = [...snapshot.sequence, toolName]
        return {
          prospective: next.length > TOOL_SEQUENCE_CAP ? next.slice(next.length - TOOL_SEQUENCE_CAP) : next,
          callsLast60s: snapshot.callsLast60s,
          shared: true,
        }
      }
    }
    return { prospective: this.prospectiveSequence(toolName), callsLast60s: this.callsInLastMs(), shared: false }
  }

  /**
   * The reask ladder's counter, shared when the store answers. The local map
   * is always bumped too, so a mid-ladder fallback keeps counting from where
   * it was rather than restarting at one.
   */
  async incrReaskAttemptShared(key: string): Promise<number> {
    const local = this.incrReaskAttempt(key)
    if (this.store && this.scope) {
      const shared = await this.store.incrReaskAttempt(this.scope, key)
      if (shared !== undefined) return shared
    }
    return local
  }

  /** Awaits the most recent write-behind; tests only. */
  async flush(): Promise<void> {
    await this.lastWrite
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
