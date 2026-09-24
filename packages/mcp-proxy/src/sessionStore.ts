/**
 * sessionStore.ts — the Valkey-backed session window the sibling proxy
 * processes of one harness session share (TD-437, Wave 5.3).
 *
 * The Rust LLM proxy keeps a session's tool-call history in Valkey
 * (`store/valkey.rs`: a capped LIST for the sequence, a ZSET for the 60 s
 * call window, an INCR counter per reask key). This is the same shape under
 * its own namespace — `v2:mcpsession:` rather than the Rust `v2:session:` —
 * because the two lists carry different things (harness-level tool names vs.
 * LLM-proposed tool calls plus `action:` tokens) and must never read each
 * other.
 *
 * Never a hard dependency. Every operation fails open to `undefined`/`false`
 * and the caller (`SessionState`) falls back to its in-process window: when
 * no URL is configured, when the client is not connected (`status !==
 * 'ready'`, so an absent Valkey adds no latency), when a call takes longer
 * than {@link SHARED_WINDOW_TIMEOUT_MS}, or on any error. The proxy behaves
 * exactly as before Wave 5.3 in every one of those cases.
 *
 * @module
 */

import * as node_crypto from 'node:crypto'
import { Redis } from 'ioredis'
import { createStderrLogger } from './stderrLog.js'
import { describeConnectionError } from './valkeyErrors.js'
import { TOOL_SEQUENCE_CAP } from './session.js'

const log = createStderrLogger('mcp-proxy.sessionStore')

/** A shared read or write that takes longer than this loses to the local window. */
export const SHARED_WINDOW_TIMEOUT_MS = 200
/** Sliding lifetime of the sequence and call-window keys — the Rust `TOOL_SEQUENCE_TTL_SECS`. */
export const SESSION_WINDOW_TTL_SECS = 86_400
/** Lifetime of a reask allowance, set when the counter is created and never refreshed —
 *  the Rust `REASK_WINDOW_SECS`. A slow drip must not become immortal. */
export const REASK_WINDOW_SECS = 3_600

export const sessionKeys = {
  tools: (scope: string) => `v2:mcpsession:${scope}:tools`,
  calls: (scope: string) => `v2:mcpsession:${scope}:calls`,
  reask: (scope: string, key: string) => `v2:mcpsession:${scope}:reask:${key}`,
} as const

export interface SharedWindowSnapshot {
  /** Oldest first, at most {@link TOOL_SEQUENCE_CAP} entries. */
  sequence: string[]
  /** Calls recorded in the window ending now, across every sibling process. */
  callsLast60s: number
}

export interface SharedSessionStore {
  /** `undefined` = unavailable; the caller uses its local window. */
  readWindow(scope: string, nowMs: number, windowMs: number): Promise<SharedWindowSnapshot | undefined>
  /** `false` = not recorded remotely; the local window still has it. */
  recordCall(scope: string, toolName: string, nowMs: number): Promise<boolean>
  /** The count including this trip, or `undefined` when unavailable. */
  incrReaskAttempt(scope: string, key: string): Promise<number | undefined>
  close(): Promise<void>
}

export interface ValkeySessionStoreOptions {
  timeoutMs?: number
}

export class ValkeySessionStore implements SharedSessionStore {
  private readonly client: Redis
  private readonly timeoutMs: number
  private warned = false

  constructor(url: string, opts: ValkeySessionStoreOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? SHARED_WINDOW_TIMEOUT_MS
    this.client = new Redis(url, {
      lazyConnect: true,
      // No offline queue: a command issued before the connection is up must
      // fail now, not wait for a Valkey that may never answer.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 1000,
      retryStrategy: (times) => Math.min(1000 * 2 ** Math.min(times, 5), 30_000),
    })
    this.client.on('error', (err: unknown) => this.warnOnce('Valkey session store unreachable', err))
    void this.client.connect().catch((err: unknown) => this.warnOnce('Valkey session store connect failed', err))
  }

  async readWindow(scope: string, nowMs: number, windowMs: number): Promise<SharedWindowSnapshot | undefined> {
    return this.guarded(async () => {
      const results = await this.client
        .pipeline()
        .lrange(sessionKeys.tools(scope), 0, -1)
        .zcount(sessionKeys.calls(scope), nowMs - windowMs, '+inf')
        .exec()
      const sequence = results?.[0]?.[1]
      const calls = results?.[1]?.[1]
      if (!Array.isArray(sequence) || results?.[0]?.[0] || results?.[1]?.[0]) return undefined
      return { sequence: sequence.map(String), callsLast60s: Number(calls ?? 0) || 0 }
    })
  }

  async recordCall(scope: string, toolName: string, nowMs: number): Promise<boolean> {
    const done = await this.guarded(async () => {
      const tools = sessionKeys.tools(scope)
      const calls = sessionKeys.calls(scope)
      await this.client
        .pipeline()
        .rpush(tools, toolName)
        .ltrim(tools, -TOOL_SEQUENCE_CAP, -1)
        .expire(tools, SESSION_WINDOW_TTL_SECS)
        .zremrangebyscore(calls, '-inf', nowMs - 60_000)
        // A unique member per call, so two calls in the same millisecond are
        // both counted.
        .zadd(calls, nowMs, `${nowMs}-${node_crypto.randomUUID()}`)
        .expire(calls, SESSION_WINDOW_TTL_SECS)
        .exec()
      return true
    })
    return done === true
  }

  async incrReaskAttempt(scope: string, key: string): Promise<number | undefined> {
    return this.guarded(async () => {
      const k = sessionKeys.reask(scope, key)
      const n = await this.client.incr(k)
      if (n === 1) await this.client.expire(k, REASK_WINDOW_SECS)
      return n
    })
  }

  async close(): Promise<void> {
    try {
      await this.client.quit()
    } catch {
      this.client.disconnect()
    }
  }

  /**
   * The fail-open wrapper every operation goes through: nothing is attempted
   * unless the client is connected, nothing waits longer than the timeout,
   * and any failure is `undefined`.
   */
  private async guarded<T>(op: () => Promise<T>): Promise<T | undefined> {
    if (this.client.status !== 'ready') return undefined
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), this.timeoutMs)
      timer.unref()
    })
    try {
      return await Promise.race([op(), timeout])
    } catch (err) {
      this.warnOnce('Valkey session store operation failed', err)
      return undefined
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private warnOnce(msg: string, err: unknown): void {
    const detail = { err: describeConnectionError(err) }
    if (this.warned) {
      log.debug(detail, msg)
      return
    }
    this.warned = true
    log.warn(detail, `${msg} — falling back to the per-process session window`)
  }
}
