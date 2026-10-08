/**
 * MCP call budgets (budget.ts): counted in Valkey across proxies, refused at
 * the limit, reset with the period, alerted once per period, and resolved
 * through the fail setting when Valkey cannot answer.
 *
 * The counting cases run against a real Valkey when one answers at
 * `VALKEY_URL` (the docker test stack: `VALKEY_URL=redis://127.0.0.1:6380`);
 * otherwise they are reported as skipped, never as passed. The
 * fail-open/closed cases need no Valkey.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Redis } from 'ioredis'
import type { McpBudget, McpBudgetPolicy } from '@intutic/shared-types'
import { GuardedValkey } from '../guardedValkey.js'
import { McpBudgetEnforcer, ValkeyBudgetStore, budgetCounterKey, exceededReason, type BudgetStore } from '../budget.js'
import { ToolCallInterceptor } from '../interceptor.js'
import { PolicyClient, UNRESTRICTED_REGISTRY, type McpPrincipal, type McpRegistryPolicy, type SopRule } from '../policy.js'
import { GovernanceEmitter, type DetectionFinding, type EventKind } from '../emitter.js'
import { fallbackBudgetCaller } from '../proxy.js'

const VALKEY_URL = process.env['VALKEY_URL'] ?? process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379'

const HOUR = 3_600_000
/** 14:37:12Z — 22m48s before the hour resets. */
const T0 = Date.parse('2026-10-08T14:37:12Z')

const uniqueWorkspace = () => `ws_budget_test_${process.pid}_${Math.random().toString(36).slice(2, 10)}`

const serverBudget: McpBudget = { id: 'gh-hourly', scope: 'server', server: 'github', period: 'hour', limit: 3 }
const policyOf = (...budgets: McpBudget[]): McpBudgetPolicy => ({ budgets, warnAtPct: 60 })

class Clock {
  constructor(public ms: number) {}
  now = () => this.ms
}

class StubPolicy extends PolicyClient {
  budgets: McpBudgetPolicy = policyOf()
  principal: McpPrincipal | undefined
  failOpen: boolean | undefined
  constructor() {
    super('http://localhost:0', '', 'ws_test', 60_000)
  }
  override getRules(): readonly SopRule[] { return [] }
  override matchRule(): SopRule | null { return null }
  override getRegistry(): McpRegistryPolicy | undefined { return UNRESTRICTED_REGISTRY }
  override getMcpBudgets(): McpBudgetPolicy { return this.budgets }
  override getPrincipal(): McpPrincipal | undefined { return this.principal }
  override getFailOpen(): boolean | undefined { return this.failOpen }
  override getAnomalyMode(): 'enforce' | 'warn' | 'off' | undefined { return 'off' }
  override async ready(): Promise<void> {}
}

interface Emitted { kind: EventKind; toolName: string; reason?: string; finding?: DetectionFinding; budget?: unknown }

class CapturingEmitter extends GovernanceEmitter {
  emitted: Emitted[] = []
  constructor() {
    super('http://localhost:0', '', '/dev/null', 'ws_test', 'per-session')
  }
  override emit(kind: EventKind, toolName: string, _input: unknown, reason?: string, finding?: DetectionFinding, budget?: unknown): void {
    this.emitted.push({ kind, toolName, reason, finding, budget })
  }
  kinds(): EventKind[] {
    return this.emitted.map((e) => e.kind)
  }
}

function interceptorWith(enforcer: McpBudgetEnforcer, policy: StubPolicy, emitter: CapturingEmitter, failOpen = true) {
  return new ToolCallInterceptor(policy, emitter, failOpen, 'github', 'warn', undefined, 'off', {}, undefined, 'ws_test', undefined, enforcer)
}

describe('fallbackBudgetCaller', () => {
  it('prefers the key prefix, then the OS user', () => {
    expect(fallbackBudgetCaller({ apiKeyPrefix: 'vk_abcdefghi', osUser: 'dana', serverName: 's' })).toBe('key:vk_abcdefghi')
    expect(fallbackBudgetCaller({ osUser: 'dana', serverName: 's' })).toBe('os:dana')
    expect(fallbackBudgetCaller({ serverName: 's' })).toBe('unknown')
  })
})

describe('MCP call budgets against Valkey', () => {
  let probe: Redis
  let available = false
  const connections: GuardedValkey[] = []
  const workspaces: string[] = []

  beforeAll(async () => {
    probe = new Redis(VALKEY_URL, { lazyConnect: true, maxRetriesPerRequest: 1 })
    try {
      await probe.connect()
      available = true
    } catch {
      probe.disconnect()
    }
  })

  afterEach(async ({ skip }) => {
    if (!available) skip()
    for (const ws of workspaces.splice(0)) {
      const keys = await probe.keys(`v2:mcpbudget:{${ws}}:*`)
      if (keys.length) await probe.del(...keys)
    }
  })

  afterAll(async () => {
    await Promise.all(connections.splice(0).map((c) => c.close()))
    if (available) await probe.quit().catch(() => {})
  })

  /** Two proxies of one workspace, each with its own Valkey connection — two processes, as far as Valkey can tell. */
  function twoProxies(clock: Clock, caller = 'key:vk_test') {
    const ws = uniqueWorkspace()
    workspaces.push(ws)
    const make = () => {
      const valkey = new GuardedValkey(VALKEY_URL, { timeoutMs: 1000 })
      connections.push(valkey)
      return new McpBudgetEnforcer(new ValkeyBudgetStore(valkey), ws, 'github', caller, clock.now)
    }
    return { ws, a: make(), b: make() }
  }

  it('shares one counter between two proxies and refuses the call over the limit', async ({ skip }) => {
    if (!available) skip()
    const clock = new Clock(T0)
    const { a, b } = twoProxies(clock)
    const policy = policyOf(serverBudget)
    expect((await a.check(policy, 'list_issues', null)).kind).toBe('allowed')
    expect((await b.check(policy, 'list_issues', null)).kind).toBe('allowed')
    expect((await a.check(policy, 'create_issue', null)).kind).toBe('allowed')

    const refused = await b.check(policy, 'list_issues', null)
    expect(refused.kind).toBe('exceeded')
    if (refused.kind !== 'exceeded') return
    expect(refused.standing.used).toBe(3)
    expect(refused.standing.resetAt.toISOString()).toBe('2026-10-08T15:00:00.000Z')
    expect(exceededReason(refused.standing, clock.ms)).toBe(
      'MCP call budget "gh-hourly" is used up (calls to github: 3 per hour): 3 of 3 calls made this hour. ' +
        'It resets at 2026-10-08T15:00:00.000Z (in 23 min). An owner or admin can change MCP budgets on the MCP Servers page.',
    )
  })

  it('never lets two racing proxies both take the last call', async ({ skip }) => {
    if (!available) skip()
    const { a, b } = twoProxies(new Clock(T0))
    const policy = policyOf({ ...serverBudget, limit: 10 })
    const verdicts = await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? a : b).check(policy, 't', null)))
    expect(verdicts.filter((v) => v.kind === 'allowed')).toHaveLength(10)
    expect(verdicts.filter((v) => v.kind === 'exceeded')).toHaveLength(20)
  })

  it('a refused call spends nothing, and the next period starts from zero', async ({ skip }) => {
    if (!available) skip()
    const clock = new Clock(T0)
    const { ws, a } = twoProxies(clock)
    const policy = policyOf({ ...serverBudget, limit: 1 })
    expect((await a.check(policy, 't', null)).kind).toBe('allowed')
    for (let i = 0; i < 3; i++) expect((await a.check(policy, 't', null)).kind).toBe('exceeded')
    const windowStart = Date.parse('2026-10-08T14:00:00Z')
    expect(await probe.get(`${budgetCounterKey(ws, 'gh-hourly', windowStart, '')}:count`)).toBe('1')

    clock.ms = T0 + HOUR
    expect((await a.check(policy, 't', null)).kind).toBe('allowed')
  })

  it('expires each counter after its window', async ({ skip }) => {
    if (!available) skip()
    const { ws, a } = twoProxies(new Clock(T0))
    await a.check(policyOf(serverBudget), 't', null)
    const ttl = await probe.ttl(`${budgetCounterKey(ws, 'gh-hourly', Date.parse('2026-10-08T14:00:00Z'), '')}:count`)
    // 22m48s to the hour, plus a minute of slack.
    expect(ttl).toBeGreaterThan(22 * 60)
    expect(ttl).toBeLessThanOrEqual(24 * 60 + 48)
  })

  it('warns once and reports the exhaustion once per period, whichever proxy crosses the line', async ({ skip }) => {
    if (!available) skip()
    const clock = new Clock(T0)
    const { a, b } = twoProxies(clock)
    const policy = policyOf({ ...serverBudget, limit: 5 }) // warns at 60%: the 3rd call
    const warnings: number[] = []
    const notices: boolean[] = []
    for (let i = 0; i < 9; i++) {
      const v = await (i % 2 ? a : b).check(policy, 't', null)
      if (v.kind === 'allowed') warnings.push(v.warnings.length)
      if (v.kind === 'exceeded') notices.push(v.notify)
    }
    expect(warnings).toEqual([0, 0, 1, 0, 0])
    expect(notices).toEqual([true, false, false, false])

    // A new hour warns again.
    clock.ms = T0 + HOUR
    const next: number[] = []
    for (let i = 0; i < 4; i++) {
      const v = await a.check(policy, 't', null)
      if (v.kind === 'allowed') next.push(v.warnings.length)
    }
    expect(next).toEqual([0, 0, 1, 0])
  })

  it('gives each member their own allowance under an each-member budget', async ({ skip }) => {
    if (!available) skip()
    const { a } = twoProxies(new Clock(T0))
    const policy = policyOf({ id: 'per-dev', scope: 'member', period: 'day', limit: 1 })
    expect((await a.check(policy, 't', 'mem_1')).kind).toBe('allowed')
    expect((await a.check(policy, 't', 'mem_1')).kind).toBe('exceeded')
    expect((await a.check(policy, 't', 'mem_2')).kind).toBe('allowed')
    // No member resolved: counted against the fallback caller instead.
    expect((await a.check(policy, 't', null)).kind).toBe('allowed')
    expect((await a.check(policy, 't', null)).kind).toBe('exceeded')
  })

  it('refuses through the interceptor with tool_blocked, and files the alerts as budget findings', async ({ skip }) => {
    if (!available) skip()
    const { a } = twoProxies(new Clock(T0))
    const policy = new StubPolicy()
    policy.budgets = policyOf({ ...serverBudget, limit: 2, period: 'day' })
    const emitter = new CapturingEmitter()
    const interceptor = interceptorWith(a, policy, emitter)

    expect((await interceptor.decide('list_issues', {})).action).toBe('allow')
    expect((await interceptor.decide('list_issues', {})).action).toBe('allow')
    const refused = await interceptor.decide('list_issues', {})
    expect(refused).toMatchObject({ action: 'block', reason: expect.stringContaining('resets at 2026-10-09T00:00:00.000Z') })
    await interceptor.decide('list_issues', {})

    expect(emitter.kinds()).toEqual([
      'tool_allowed',
      'mcp_budget_threshold',
      'tool_allowed',
      'mcp_budget_exceeded',
      'tool_blocked',
      'tool_blocked',
    ])
    const exceeded = emitter.emitted.find((e) => e.kind === 'mcp_budget_exceeded')!
    expect(exceeded.finding).toMatchObject({ detectorId: 'budget', kind: 'budget_breach', disposition: 'kill' })
    expect(exceeded.budget).toEqual({
      budgetId: 'gh-hourly',
      scope: 'server',
      server: 'github',
      period: 'day',
      limit: 2,
      used: 2,
      resetAt: '2026-10-09T00:00:00.000Z',
    })
  })
})

describe('MCP call budgets when Valkey cannot answer', () => {
  const unavailableStore: BudgetStore = { count: async () => undefined }

  it.each([
    ['no Valkey configured', undefined],
    ['Valkey not answering', unavailableStore],
  ])('%s: fail-open lets a covered call through uncounted', async (_name, store) => {
    const policy = new StubPolicy()
    policy.budgets = policyOf(serverBudget)
    const emitter = new CapturingEmitter()
    const enforcer = new McpBudgetEnforcer(store, 'ws_test', 'github', 'unknown')
    expect((await interceptorWith(enforcer, policy, emitter, true).decide('t', {})).action).toBe('allow')
    expect(emitter.kinds()).toEqual(['tool_allowed'])
  })

  it.each([
    ['no Valkey configured', undefined],
    ['Valkey not answering', unavailableStore],
  ])('%s: fail-closed refuses it and names the setting', async (_name, store) => {
    const policy = new StubPolicy()
    policy.budgets = policyOf(serverBudget)
    const emitter = new CapturingEmitter()
    const enforcer = new McpBudgetEnforcer(store, 'ws_test', 'github', 'unknown')
    const decision = await interceptorWith(enforcer, policy, emitter, false).decide('t', {})
    expect(decision.action).toBe('block')
    expect((decision as { reason: string }).reason).toMatch(/"gh-hourly" cover this call.*fail-closed/)
    expect(emitter.kinds()).toEqual(['tool_blocked'])
  })

  it("follows the workspace's delivered fail behaviour over the local one", async () => {
    const policy = new StubPolicy()
    policy.budgets = policyOf(serverBudget)
    policy.failOpen = false
    const enforcer = new McpBudgetEnforcer(undefined, 'ws_test', 'github', 'unknown')
    expect((await interceptorWith(enforcer, policy, new CapturingEmitter(), true).decide('t', {})).action).toBe('block')
  })

  it('a call no budget covers never needs Valkey, even fail-closed', async () => {
    const policy = new StubPolicy()
    policy.budgets = policyOf({ ...serverBudget, server: 'gitlab' })
    const enforcer = new McpBudgetEnforcer(undefined, 'ws_test', 'github', 'unknown')
    expect((await interceptorWith(enforcer, policy, new CapturingEmitter(), false).decide('t', {})).action).toBe('allow')
  })

  it('an unreachable Valkey answers within the timeout', async () => {
    const valkey = new GuardedValkey('redis://127.0.0.1:1', { timeoutMs: 50 })
    try {
      const enforcer = new McpBudgetEnforcer(new ValkeyBudgetStore(valkey), 'ws_test', 'github', 'unknown')
      const started = Date.now()
      expect((await enforcer.check(policyOf(serverBudget), 't', null)).kind).toBe('unavailable')
      expect(Date.now() - started).toBeLessThan(500)
    } finally {
      await valkey.close()
    }
  })
})
