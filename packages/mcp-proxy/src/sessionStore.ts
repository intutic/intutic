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
 * no URL is configured, when the client is not connected (so an absent
 * Valkey adds no latency), when a call takes longer than
 * `VALKEY_COMMAND_TIMEOUT_MS`, or on any error — the guard every command on
 * the proxy's one Valkey connection goes through (guardedValkey.ts). The
 * proxy behaves exactly as before Wave 5.3 in every one of those cases.
 *
 * @module
 */

import * as node_crypto from 'node:crypto'
import type { GuardedValkey } from './guardedValkey.js'
import { TOOL_SEQUENCE_CAP } from './session.js'

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
}

export class ValkeySessionStore implements SharedSessionStore {
  /** The proxy's one Valkey connection, shared with its call budgets; the proxy closes it. */
  constructor(private readonly valkey: GuardedValkey) {}

  async readWindow(scope: string, nowMs: number, windowMs: number): Promise<SharedWindowSnapshot | undefined> {
    return this.valkey.run(async (client) => {
      const results = await client
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
    const done = await this.valkey.run(async (client) => {
      const tools = sessionKeys.tools(scope)
      const calls = sessionKeys.calls(scope)
      await client
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
    return this.valkey.run(async (client) => {
      const k = sessionKeys.reask(scope, key)
      const n = await client.incr(k)
      if (n === 1) await client.expire(k, REASK_WINDOW_SECS)
      return n
    })
  }
}
