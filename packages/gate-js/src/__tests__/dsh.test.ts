/**
 * dsh.test.ts
 *
 * Two layers of coverage:
 *   1. `createPreExecuteListener` against a controllable fake `Gate` — event
 *      extraction, the refusal-to-decision mapping, the fail-closed default,
 *      and the waterfall next()-calling on allow. No network, no filesystem,
 *      no real Cordis context needed.
 *   2. One integration test mounting `apply()` on a REAL `@deepseek-ai/cordis`
 *      `Context` and dispatching through its real `waterfall()` — confirming
 *      this plugin's `ctx.on('tools/pre-execute', ...)` registration and
 *      return-shape actually satisfy Cordis's real waterfall mechanics, not
 *      just this test file's assumptions about them. `@deepseek-ai/cordis` is
 *      a devDependency of this package only (see dsh.ts's module doc for why
 *      it is not a runtime dependency of the plugin itself).
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { IntuticGateRefusal } from '../errors.js'
import { active, Gate, install } from '../gate.js'
import dshPlugin, {
  apply,
  createPreExecuteListener,
  inject,
  PLUGIN_NAME,
  type DshPreToolDecision,
  type DshToolExecution,
} from '../dsh.js'

// Same pattern wrapTools.test.ts uses: a Gate whose guard() is fully
// controllable, so these tests exercise the plugin's plumbing rather than
// the four real tiers (already covered by gate.test.ts).
class FakeGate extends Gate {
  calls: Array<{ toolName: string; toolInput: Record<string, unknown> }> = []
  private readonly mode: 'allow' | 'refuse' | 'crash'
  constructor(mode: 'allow' | 'refuse' | 'crash' = 'allow') {
    super({ enforce: true })
    this.mode = mode
  }
  override async guard(toolName: string, toolInput: Record<string, unknown>): Promise<void> {
    this.calls.push({ toolName, toolInput })
    if (this.mode === 'refuse') throw new IntuticGateRefusal('nope', 'TEST')
    if (this.mode === 'crash') throw new TypeError('boom')
  }
}

afterEach(() => {
  install(null)
})

describe('dsh plugin shape', () => {
  it('exports name/inject/apply consistently, both named and as the default Plugin object', () => {
    expect(PLUGIN_NAME).toBe('intutic-governance')
    expect(inject).toEqual(['tools'])
    expect(typeof apply).toBe('function')
    expect(dshPlugin).toEqual({ name: PLUGIN_NAME, inject, apply })
  })
})

describe('createPreExecuteListener: allow path', () => {
  it('calls the gate, then calls next() so the waterfall (and dsh built-ins) still run', async () => {
    const gate = new FakeGate('allow')
    const listener = createPreExecuteListener(gate)
    let builtinRan = false
    const decision = await listener({ name: 'read_file', arguments: { path: 'a.txt' } }, async () => {
      builtinRan = true
      return { kind: 'allow' }
    })
    expect(decision).toEqual({ kind: 'allow' })
    expect(builtinRan).toBe(true)
    expect(gate.calls).toEqual([{ toolName: 'read_file', toolInput: { path: 'a.txt' } }])
  })

  it('wraps a non-object arguments value as { args: [value] } so the gate still has something to evaluate', async () => {
    const gate = new FakeGate('allow')
    const listener = createPreExecuteListener(gate)
    await listener({ name: 'weird_tool', arguments: 'a bare string' }, async () => ({ kind: 'allow' }))
    expect(gate.calls).toEqual([{ toolName: 'weird_tool', toolInput: { args: ['a bare string'] } }])
  })
})

describe('createPreExecuteListener: deny path', () => {
  it('returns {kind:"deny", reason} on IntuticGateRefusal, and never calls next()', async () => {
    const gate = new FakeGate('refuse')
    const listener = createPreExecuteListener(gate)
    let builtinRan = false
    const decision = await listener({ name: 'bash', arguments: { command: 'rm -rf /' } }, async () => {
      builtinRan = true
      return { kind: 'allow' }
    })
    expect(decision).toEqual({ kind: 'deny', reason: '[Intutic Governance] BLOCKED: nope' })
    expect(builtinRan).toBe(false)
  })
})

describe('createPreExecuteListener: fail-closed on an unexpected crash', () => {
  it('denies (never throws out of the waterfall) when the gate throws something other than IntuticGateRefusal', async () => {
    const gate = new FakeGate('crash')
    const listener = createPreExecuteListener(gate)
    const decision = await listener({ name: 'write', arguments: {} }, async () => ({ kind: 'allow' }))
    expect(decision).toEqual({
      kind: 'deny',
      reason: '[Intutic Governance] BLOCKED: gate crashed (boom) — failing closed rather than allowing an unevaluated call.',
    })
  })
})

describe('apply(): real Cordis Context integration', () => {
  it('registers a tools/pre-execute listener that a real ctx.waterfall() dispatch reaches, and installs the gate process-wide', async () => {
    const ctx = new Context()
    // enforce:false short-circuits Gate.guard() to an immediate allow (see
    // gate.ts's guard()) without touching the filesystem or network — this
    // test is about the Cordis wiring, not the four tiers' own behaviour.
    apply(ctx as unknown as Parameters<typeof apply>[0], { enforce: false })
    expect(active()).not.toBeNull()

    let builtinRan = false
    const exec: DshToolExecution = { name: 'read_file', arguments: { path: 'a.txt' } }
    const decision: DshPreToolDecision = await ctx.waterfall(
      'tools/pre-execute' as never,
      exec as never,
      (async () => {
        builtinRan = true
        return { kind: 'allow' }
      }) as never,
    )
    expect(decision).toEqual({ kind: 'allow' })
    expect(builtinRan).toBe(true)
  })
})
