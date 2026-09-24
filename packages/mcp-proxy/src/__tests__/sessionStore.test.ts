/**
 * The shared session window (Wave 5.3, TD-437): two proxy processes of one
 * harness session — modelled here as two `SessionState`s with the same scope
 * and separate stores — see each other's calls, share a reask ladder, and
 * fall back to their own window the moment Valkey is not there.
 *
 * Runs against a real Valkey when one answers at `VALKEY_URL` (the docker
 * test stack, or a local one); otherwise the Valkey cases are skipped and the
 * fallback cases, which need no Valkey, still run.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Redis } from 'ioredis'
import { SessionState, TOOL_SEQUENCE_CAP } from '../session.js'
import {
  ValkeySessionStore,
  sessionKeys,
  REASK_WINDOW_SECS,
  type SharedSessionStore,
  type SharedWindowSnapshot,
} from '../sessionStore.js'
import { ToolCallInterceptor } from '../interceptor.js'
import { PolicyClient, type SopRule } from '../policy.js'
import { GovernanceEmitter } from '../emitter.js'

const VALKEY_URL = process.env['VALKEY_URL'] ?? process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379'

/** A scope nothing else in this Valkey uses. */
const uniqueScope = () => `ws_test:mcp:${process.pid}:${Math.random().toString(36).slice(2, 10)}`

async function waitReady(store: ValkeySessionStore, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  // The store connects lazily in the background; give it a moment.
  while (Date.now() < deadline) {
    const probe = await store.readWindow('probe', Date.now(), 60_000)
    if (probe) return
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** The same minimal stub `interceptor.test.ts` uses: no rules, no allowlists, defaults everywhere. */
class StubPolicyClient extends PolicyClient {
  constructor() {
    super('http://localhost:0', '', 'ws_test', 60_000)
  }
  override getRules(): readonly SopRule[] { return [] }
  override getAllowedServers(): readonly string[] { return [] }
  override getInjectionAction(): 'warn' | 'block' | undefined { return undefined }
  override getAnomalyMode(): 'enforce' | 'warn' | 'off' | undefined { return undefined }
  override getAnomalyOverrides(): Readonly<Record<string, 'steer' | 'reask' | 'kill' | 'off'>> { return {} }
  override matchRule(): SopRule | null { return null }
}

class CapturingEmitter extends GovernanceEmitter {
  emitted: string[] = []
  constructor() {
    super('http://localhost:0', '', '/dev/null', 'ws_test', 'per-session')
  }
  override emit(kind: string): void {
    this.emitted.push(kind)
  }
}

describe('ValkeySessionStore (shared across sibling processes)', () => {
  let probe: Redis
  let available = false

  beforeAll(async () => {
    probe = new Redis(VALKEY_URL, { lazyConnect: true, maxRetriesPerRequest: 1 })
    try {
      await probe.connect()
      available = true
    } catch {
      probe.disconnect()
    }
  })

  afterAll(async () => {
    if (available) await probe.quit().catch(() => {})
  })

  const withStores = async (n: number, fn: (stores: ValkeySessionStore[], scope: string) => Promise<void>) => {
    if (!available) return
    const scope = uniqueScope()
    const stores = Array.from({ length: n }, () => new ValkeySessionStore(VALKEY_URL))
    try {
      await Promise.all(stores.map((s) => waitReady(s)))
      await fn(stores, scope)
    } finally {
      await probe.del(sessionKeys.tools(scope), sessionKeys.calls(scope)).catch(() => {})
      const reaskKeys = await probe.keys(sessionKeys.reask(scope, '*')).catch(() => [] as string[])
      if (reaskKeys.length) await probe.del(...reaskKeys).catch(() => {})
      await Promise.all(stores.map((s) => s.close()))
    }
  }

  it('two sibling proxies see one sequence: a ping-pong across them fires in a third', async () => {
    await withStores(3, async ([a, b, c], scope) => {
      const A = new SessionState({ scope, store: a })
      const B = new SessionState({ scope, store: b })
      // read/write alternating across two processes: neither alone ever
      // sees a cycle, which is exactly the blindness TD-437 recorded.
      for (let i = 0; i < 3; i++) {
        A.recordCall('read')
        await A.flush()
        B.recordCall('write')
        await B.flush()
      }
      expect(await probe.lrange(sessionKeys.tools(scope), 0, -1)).toEqual(['read', 'write', 'read', 'write', 'read', 'write'])

      const C = new SessionState({ scope, store: c })
      const window = await C.loadWindow('read')
      expect(window.shared).toBe(true)
      expect(window.prospective).toEqual(['read', 'write', 'read', 'write', 'read', 'write', 'read'])
      expect(window.callsLast60s).toBe(6)

      const emitter = new CapturingEmitter()
      const interceptor = new ToolCallInterceptor(new StubPolicyClient(), emitter, true, 'unknown', 'warn', C)
      const decision = await interceptor.decide('read', {})
      expect(decision.action, 'the seventh call completes a ping-pong nobody local could see').toBe('block')
      expect((decision as { reason: string }).reason).toMatch(/loop detected/i)
      expect(emitter.emitted).toContain('anomaly_detected')
    })
  })

  it('the reask ladder is one counter across siblings, with the Rust TTL set on creation only', async () => {
    await withStores(2, async ([a, b], scope) => {
      const A = new SessionState({ scope, store: a })
      const B = new SessionState({ scope, store: b })
      expect(await A.incrReaskAttemptShared('consecutive_repeat')).toBe(1)
      const ttlAfterFirst = await probe.pttl(sessionKeys.reask(scope, 'consecutive_repeat'))
      expect(ttlAfterFirst).toBeGreaterThan((REASK_WINDOW_SECS - 5) * 1000)
      await new Promise((r) => setTimeout(r, 30))
      expect(await B.incrReaskAttemptShared('consecutive_repeat')).toBe(2)
      const ttlAfterSecond = await probe.pttl(sessionKeys.reask(scope, 'consecutive_repeat'))
      expect(ttlAfterSecond, 'a second trip must not refresh the window').toBeLessThanOrEqual(ttlAfterFirst)
      // Independent per key, as before.
      expect(await B.incrReaskAttemptShared('wasm:rule_x')).toBe(1)
    })
  })

  it('caps the shared sequence at TOOL_SEQUENCE_CAP, oldest evicted first, and prunes the call window', async () => {
    await withStores(1, async ([a], scope) => {
      const A = new SessionState({ scope, store: a })
      for (let i = 0; i < TOOL_SEQUENCE_CAP + 5; i++) {
        A.recordCall(`tool_${i}`)
        await A.flush()
      }
      const stored = await probe.lrange(sessionKeys.tools(scope), 0, -1)
      expect(stored).toHaveLength(TOOL_SEQUENCE_CAP)
      expect(stored[0]).toBe('tool_5')
      expect(await probe.ttl(sessionKeys.tools(scope))).toBeGreaterThan(0)
      expect(await probe.ttl(sessionKeys.calls(scope))).toBeGreaterThan(0)

      // A call recorded two minutes ago is outside the 60 s window.
      await probe.zadd(sessionKeys.calls(scope), Date.now() - 120_000, 'old-call')
      const window = await A.loadWindow('next')
      expect(window.shared).toBe(true)
      expect(window.callsLast60s).toBe(TOOL_SEQUENCE_CAP + 5)
    })
  })

  it('an unreachable Valkey costs nothing: the per-process window answers at once, with no unhandled rejection', async () => {
    const store = new ValkeySessionStore('redis://127.0.0.1:1', { timeoutMs: 50 })
    const rejections: unknown[] = []
    const onRejection = (r: unknown) => rejections.push(r)
    process.on('unhandledRejection', onRejection)
    try {
      const s = new SessionState({ scope: 'ws_test:mcp:none', store })
      s.recordCall('a')
      const started = Date.now()
      const window = await s.loadWindow('b')
      expect(Date.now() - started).toBeLessThan(50)
      expect(window).toEqual({ prospective: ['a', 'b'], callsLast60s: 1, shared: false })
      expect(await s.incrReaskAttemptShared('k')).toBe(1)
      expect(await s.incrReaskAttemptShared('k')).toBe(2)
      await new Promise((r) => setTimeout(r, 200))
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onRejection)
      await store.close()
    }
  })
})

describe('SessionState fallback rules (no Valkey needed)', () => {
  it('a store that never answers loses to the local window after the timeout', async () => {
    const hanging: SharedSessionStore = {
      readWindow: () => new Promise<SharedWindowSnapshot | undefined>(() => {}),
      recordCall: () => new Promise<boolean>(() => {}),
      incrReaskAttempt: () => new Promise<number | undefined>(() => {}),
      close: async () => {},
    }
    // The timeout lives in ValkeySessionStore's guard; a raw hanging store is
    // wrapped the same way here to pin the contract SessionState relies on.
    const guarded: SharedSessionStore = {
      readWindow: (...args) => Promise.race([hanging.readWindow(...args), new Promise<undefined>((r) => setTimeout(() => r(undefined), 20))]),
      recordCall: (...args) => Promise.race([hanging.recordCall(...args), new Promise<boolean>((r) => setTimeout(() => r(false), 20))]),
      incrReaskAttempt: (...args) => Promise.race([hanging.incrReaskAttempt(...args), new Promise<undefined>((r) => setTimeout(() => r(undefined), 20))]),
      close: async () => {},
    }
    const s = new SessionState({ scope: 'ws_test:mcp:hang', store: guarded })
    s.recordCall('a')
    const started = Date.now()
    const window = await s.loadWindow('b')
    expect(Date.now() - started).toBeLessThan(200)
    expect(window.shared).toBe(false)
    expect(window.prospective).toEqual(['a', 'b'])
    expect(await s.incrReaskAttemptShared('k')).toBe(1)
  })

  it('a scope without a store, or a store without a scope, is the per-process window', async () => {
    const noStore = new SessionState({ scope: 'ws_test:mcp:1' })
    noStore.recordCall('a')
    expect(await noStore.loadWindow('b')).toEqual({ prospective: ['a', 'b'], callsLast60s: 1, shared: false })

    let called = 0
    const store: SharedSessionStore = {
      readWindow: async () => { called += 1; return { sequence: ['x'], callsLast60s: 9 } },
      recordCall: async () => { called += 1; return true },
      incrReaskAttempt: async () => { called += 1; return 7 },
      close: async () => {},
    }
    const noScope = new SessionState({ store })
    noScope.recordCall('a')
    expect(await noScope.loadWindow('b')).toEqual({ prospective: ['a', 'b'], callsLast60s: 1, shared: false })
    expect(await noScope.incrReaskAttemptShared('k')).toBe(1)
    expect(called, 'a store is never consulted without a scope').toBe(0)
  })

  it('a shared reask answer wins, and the local counter keeps counting underneath it', async () => {
    let shared = 4
    const store: SharedSessionStore = {
      readWindow: async () => undefined,
      recordCall: async () => true,
      incrReaskAttempt: async () => (shared += 1),
      close: async () => {},
    }
    const s = new SessionState({ scope: 'ws_test:mcp:2', store })
    expect(await s.incrReaskAttemptShared('k')).toBe(5)
    expect(s.getReaskAttempts('k'), 'the local map is bumped too, so a mid-ladder fallback continues').toBe(1)
  })
})
