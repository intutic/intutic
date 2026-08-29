/**
 * Tests for `@intutic/gate/trueforge`.
 *
 * `@truefoundry/trueforge-core` IS installed as a devDependency (see
 * package.json) and its real exported types are imported below to
 * structurally confirm this adapter's `TrueforgeUserToolApprovalItem`/
 * `TrueforgeApprovalDecision` shapes are assignable to the real
 * `TurnInputItem` (`@truefoundry/trueforge-core/agent-session`) and
 * `ApprovalDecision` (`@truefoundry/trueforge-core/core`) types — a
 * compile-time check (TypeScript rejects the file if the shapes drift), not
 * a live TrueForge session. There is no synchronous approval-callback option
 * to drive end-to-end the way mastra.test.ts/vercel.test.ts do (see
 * trueforge.ts's module doc for why) — this adapter's own runtime behaviour
 * against a `FakeGate` is what the rest of this file exercises, matching
 * wrapTools.test.ts's/harness.test.ts's style.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { TurnInputItem } from '@truefoundry/trueforge-core/agent-session'
import type { ApprovalDecision } from '@truefoundry/trueforge-core/core'
import { IntuticGateRefusal } from '../errors.js'
import { Gate, install } from '../gate.js'
import {
  intuticApprovalResponder,
  renderTrueforgeToolInput,
  type TrueforgeApprovalDecision,
  type TrueforgeApprovalRequest,
  type TrueforgeUserToolApprovalItem,
} from '../trueforge.js'

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

// ------------------------------------------------------------------------
// Structural type checks. Never invoked — a drift in
// @truefoundry/trueforge-core's real TurnInputItem/ApprovalDecision shapes
// fails the type-checking pass here, not at a caller's compile time.
// ------------------------------------------------------------------------
function _typeCheckOnly(): void {
  const decision: TrueforgeApprovalDecision = { status: 'allow' }
  const real: ApprovalDecision = decision
  void real

  const item: TrueforgeUserToolApprovalItem = {
    type: 'user.tool_approval',
    thread_id: 'thread_1',
    tool_call_id: 'call_1',
    approval: { status: 'deny', reason: 'nope' },
  }
  const realItem: TurnInputItem = item
  void realItem
}

describe('renderTrueforgeToolInput', () => {
  it('passes a plain object through as-is', () => {
    expect(renderTrueforgeToolInput({ path: 'a.txt' })).toEqual({ path: 'a.txt' })
  })

  it('wraps a non-object input as { args: [...] }', () => {
    expect(renderTrueforgeToolInput('rm -rf /')).toEqual({ args: ['rm -rf /'] })
    expect(renderTrueforgeToolInput(null)).toEqual({ args: [null] })
    expect(renderTrueforgeToolInput([1, 2])).toEqual({ args: [[1, 2]] })
  })
})

function req(overrides: Partial<TrueforgeApprovalRequest> = {}): TrueforgeApprovalRequest {
  return {
    threadId: 'thread_1',
    toolCallId: 'call_1',
    toolName: 'read_file',
    input: { path: 'a.txt' },
    ...overrides,
  }
}

describe('intuticApprovalResponder: allow path', () => {
  it('calls the gate, then produces a status:allow item', async () => {
    const gate = new FakeGate('allow')
    const respond = intuticApprovalResponder({ gate })
    const result = await respond([req()])
    expect(result).toEqual([
      {
        type: 'user.tool_approval',
        thread_id: 'thread_1',
        tool_call_id: 'call_1',
        approval: { status: 'allow' },
      },
    ])
    expect(gate.calls).toEqual([{ toolName: 'read_file', toolInput: { path: 'a.txt' } }])
  })

  it('falls back to the process-wide installed gate', async () => {
    const gate = new FakeGate('allow')
    install(gate)
    const respond = intuticApprovalResponder()
    await respond([req({ toolName: 'noop', input: {} })])
    expect(gate.calls).toHaveLength(1)
  })

  it('evaluates a batch of requests independently, preserving order', async () => {
    const gate = new FakeGate('allow')
    const respond = intuticApprovalResponder({ gate })
    const result = await respond([
      req({ toolCallId: 'call_1', toolName: 'a' }),
      req({ toolCallId: 'call_2', toolName: 'b' }),
    ])
    expect(result.map((r) => r.tool_call_id)).toEqual(['call_1', 'call_2'])
    expect(gate.calls.map((c) => c.toolName)).toEqual(['a', 'b'])
  })
})

describe('intuticApprovalResponder: refusal path', () => {
  it('produces a status:deny item carrying the refusal message', async () => {
    const gate = new FakeGate('refuse')
    const respond = intuticApprovalResponder({ gate })
    const result = await respond([req({ toolName: 'shell', input: { command: 'rm -rf /' } })])
    expect(result).toEqual([
      {
        type: 'user.tool_approval',
        thread_id: 'thread_1',
        tool_call_id: 'call_1',
        approval: { status: 'deny', reason: expect.stringContaining('[Intutic Governance] BLOCKED:') },
      },
    ])
  })

  it('fails closed (deny, not a rejected promise) on a non-refusal gate crash', async () => {
    const gate = new FakeGate('crash')
    const respond = intuticApprovalResponder({ gate })
    const result = await respond([req()])
    expect(result[0]!.approval).toEqual({
      status: 'deny',
      reason: expect.stringContaining('gate crashed'),
    })
  })

  it('does not let one denied request in a batch block evaluation of the rest', async () => {
    const gate = new FakeGate('refuse')
    const respond = intuticApprovalResponder({ gate })
    const result = await respond([
      req({ toolCallId: 'call_1' }),
      req({ toolCallId: 'call_2' }),
    ])
    expect(result).toHaveLength(2)
    expect(result.every((r) => r.approval.status === 'deny')).toBe(true)
  })
})

describe('intuticApprovalResponder: no gate configured', () => {
  it('throws a clear error rather than answering approvals unguarded', async () => {
    const respond = intuticApprovalResponder()
    await expect(respond([req()])).rejects.toThrow(/No gate configured/)
  })
})

// keep the type-check function reachable so it is not tree-shaken/flagged unused
void _typeCheckOnly
