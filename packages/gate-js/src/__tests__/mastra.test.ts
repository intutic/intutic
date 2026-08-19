/**
 * Tests for `@intutic/gate/mastra`.
 *
 * `@mastra/core` IS installed as a devDependency (see package.json) and its
 * real exported types are imported below (`ToolHooks` from
 * `@mastra/core/dist/tools/types.js`'s public surface, re-exported off
 * `@mastra/core/agent`) to structurally confirm `intuticHooks()`'s return
 * value satisfies the real `Agent` constructor's `hooks` option — a
 * compile-time check (TypeScript rejects the file if the shapes drift), not
 * a live Mastra agent run. No live `Agent`/model call is exercised here; the
 * runtime behaviour under test is this adapter's own `beforeToolCall`
 * function against a `FakeGate`, matching `wrapTools.test.ts`'s style.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { Agent } from '@mastra/core/agent'
import { IntuticGateRefusal } from '../errors.js'
import { Gate, install } from '../gate.js'
import { intuticHooks, type MastraToolHookContext } from '../mastra.js'

// A stand-in Gate whose `guard` is fully controllable, so these tests exercise
// intuticHooks' plumbing without touching the filesystem or network.
class FakeGate extends Gate {
  calls: Array<{ toolName: string; toolInput: Record<string, unknown> }> = []
  private readonly refuse: boolean
  constructor(refuse = false) {
    super({ enforce: true })
    this.refuse = refuse
  }
  override async guard(toolName: string, toolInput: Record<string, unknown>): Promise<void> {
    this.calls.push({ toolName, toolInput })
    if (this.refuse) throw new IntuticGateRefusal('nope', 'TEST')
  }
}

afterEach(() => {
  install(null)
})

// ------------------------------------------------------------------------
// Structural type check: intuticHooks() must be assignable to the real
// Agent constructor's `hooks` option. This block is never invoked — its job
// is to fail `tsc`/vitest's type-checking pass if @mastra/core's real
// `ToolHooks` shape ever drifts from what mastra.ts assumes.
// ------------------------------------------------------------------------
function _typeCheckOnly(): void {
  type AgentCtorOptions = ConstructorParameters<typeof Agent>[0]
  const hooks = intuticHooks()
  const _opts: Pick<AgentCtorOptions, 'hooks'> = { hooks }
  void _opts
}

describe('intuticHooks: allow path', () => {
  it('calls the gate, then returns undefined (proceed)', async () => {
    const gate = new FakeGate()
    const { beforeToolCall } = intuticHooks({ gate })
    const ctx: MastraToolHookContext = { toolName: 'read_file', input: { path: 'a.txt' } }
    const result = await beforeToolCall(ctx)
    expect(result).toBeUndefined()
    expect(gate.calls).toEqual([{ toolName: 'read_file', toolInput: { path: 'a.txt' } }])
  })

  it('falls back to the process-wide installed gate', async () => {
    const gate = new FakeGate()
    install(gate)
    const { beforeToolCall } = intuticHooks()
    await beforeToolCall({ toolName: 'noop', input: {} })
    expect(gate.calls).toHaveLength(1)
  })
})

describe('intuticHooks: refusal path', () => {
  it('returns {proceed:false, output} on refusal, using the default denial shape', async () => {
    const gate = new FakeGate(true)
    const { beforeToolCall } = intuticHooks({ gate })
    const result = await beforeToolCall({ toolName: 'shell', input: { command: 'rm -rf /' } })
    expect(result).toBeDefined()
    expect(result!.proceed).toBe(false)
    expect(result!.output).toMatchObject({
      error: true,
      message: expect.stringContaining('[Intutic Governance] BLOCKED:'),
      code: 'TEST',
    })
  })

  it('honours a custom denialOutput shaper', async () => {
    const gate = new FakeGate(true)
    const { beforeToolCall } = intuticHooks({
      gate,
      denialOutput: ({ toolName, refusal }) => ({ deleted: false, reason: `${toolName}: ${refusal.reason}` }),
    })
    const result = await beforeToolCall({ toolName: 'delete_record', input: { id: 'x' } })
    expect(result).toEqual({ proceed: false, output: { deleted: false, reason: 'delete_record: nope' } })
  })

  it('re-throws a non-refusal error rather than treating it as a deny', async () => {
    class ExplodingGate extends Gate {
      override async guard(): Promise<void> {
        throw new Error('boom')
      }
    }
    const { beforeToolCall } = intuticHooks({ gate: new ExplodingGate({ enforce: true }) })
    await expect(beforeToolCall({ toolName: 'x', input: {} })).rejects.toThrow('boom')
  })
})

describe('intuticHooks: no gate configured', () => {
  it('throws a clear error rather than running unguarded', async () => {
    const { beforeToolCall } = intuticHooks()
    await expect(beforeToolCall({ toolName: 'x', input: {} })).rejects.toThrow(/No gate configured/)
  })
})

// keep the type-check function reachable so it is not tree-shaken/flagged unused
void _typeCheckOnly
