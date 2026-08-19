/**
 * Tests for `@intutic/gate/harness`.
 *
 * `@ai-sdk/harness` IS installed as a devDependency (see package.json) and
 * used two ways here, matching vercel.test.ts's style:
 *
 *   1. Its real exported types are imported to structurally confirm this
 *      adapter's continuation/static-approval/settings shapes are assignable
 *      to the real ones — compile-time checks that reject the file if the
 *      shipped shapes drift.
 *   2. Its REAL `collectHarnessAgentToolApprovalContinuations` machinery is
 *      run against a message transcript carrying THIS adapter's produced
 *      `tool-approval-response` parts, confirming the real collector
 *      round-trips our responses into continuations — not just that our
 *      types line up on paper.
 *
 * No live sandbox or HarnessAgent turn is exercised — that needs a Vercel
 * Sandbox deployment this environment does not have (see the TD entry this
 * phase filed). The runtime behaviour under test is this adapter's own
 * functions against a `FakeGate`, per wrapTools.test.ts's pattern.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type {
  HarnessAgentPermissionMode,
  HarnessAgentToolApprovalConfiguration,
  HarnessAgentToolApprovalContinuation,
} from '@ai-sdk/harness/agent'
import { collectHarnessAgentToolApprovalContinuations } from '@ai-sdk/harness/agent'
import type { HarnessV1NetworkPolicy } from '@ai-sdk/harness'
import type { ModelMessage } from 'ai'
import { IntuticGateRefusal } from '../errors.js'
import { Gate, install } from '../gate.js'
import {
  intuticApprovalResponder,
  intuticStaticApprovals,
  intuticSubmitApprovals,
  recommendedHarnessSettings,
  renderHarnessToolInput,
  type HarnessApprovalRequest,
  type HarnessSessionLike,
  type HarnessToolApprovalContinuation,
} from '../harness.js'

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
// Structural type checks. Never invoked — a drift in `@ai-sdk/harness`'s
// real continuation/config/settings shapes fails the type-checking pass
// here, not at a caller's compile time.
// ------------------------------------------------------------------------
function _typeCheckOnly(): void {
  // Our continuations must be assignable where continueGenerate/continueStream
  // expect the real HarnessAgentToolApprovalContinuation[].
  const ours: HarnessToolApprovalContinuation[] = []
  const real: readonly HarnessAgentToolApprovalContinuation[] = ours
  void real

  // Our static approval record must satisfy HarnessAgentSettings.toolApproval.
  const approvals: HarnessAgentToolApprovalConfiguration = intuticStaticApprovals(['a', 'b'])
  void approvals

  // recommendedHarnessSettings() must produce a real permission mode and a
  // real network policy (the custom branch of the real union requires an
  // allow field — this checks our constructed values satisfy it, with NO
  // cast: RecommendedNetworkPolicy is deliberately narrow enough to assign).
  const settings = recommendedHarnessSettings({ allowedHosts: ['registry.npmjs.org'] })
  const mode: HarnessAgentPermissionMode = settings.permissionMode
  void mode
  const policy: HarnessV1NetworkPolicy = settings.networkPolicy
  void policy
}

describe('renderHarnessToolInput', () => {
  it('passes a plain object through as-is', () => {
    expect(renderHarnessToolInput({ path: 'a.txt' })).toEqual({ path: 'a.txt' })
  })

  it('JSON-parses the string a HarnessAgentPendingToolApproval carries', () => {
    expect(renderHarnessToolInput('{"command":"rm -rf /"}')).toEqual({ command: 'rm -rf /' })
  })

  it('wraps an unparseable string as { args: [...] }', () => {
    expect(renderHarnessToolInput('not json')).toEqual({ args: ['not json'] })
  })

  it('wraps a non-object value (parsed or direct) as { args: [...] }', () => {
    expect(renderHarnessToolInput('[1,2]')).toEqual({ args: [[1, 2]] })
    expect(renderHarnessToolInput(42)).toEqual({ args: [42] })
    expect(renderHarnessToolInput(null)).toEqual({ args: [null] })
  })
})

describe('intuticApprovalResponder: allow path', () => {
  it('calls the gate per request and produces approved continuations', async () => {
    const gate = new FakeGate('allow')
    const respond = intuticApprovalResponder({ gate })
    const continuations = await respond([
      { approvalId: 'ap_1', toolCallId: 'tc_1', toolName: 'read_file', input: { path: 'a.txt' } },
    ])
    expect(continuations).toEqual([
      {
        approvalResponse: { type: 'tool-approval-response', approvalId: 'ap_1', approved: true },
        toolCall: { type: 'tool-call', toolCallId: 'tc_1', toolName: 'read_file', input: { path: 'a.txt' } },
      },
    ])
    expect(gate.calls).toEqual([{ toolName: 'read_file', toolInput: { path: 'a.txt' } }])
  })

  it('parses a pending-approval JSON-string input for both the gate and the continuation toolCall', async () => {
    const gate = new FakeGate('allow')
    const respond = intuticApprovalResponder({ gate })
    const continuations = await respond([
      // The HarnessAgentPendingToolApproval shape: input is a JSON string.
      { approvalId: 'ap_1', toolCallId: 'tc_1', toolName: 'bash', input: '{"command":"ls"}' },
    ])
    expect(gate.calls).toEqual([{ toolName: 'bash', toolInput: { command: 'ls' } }])
    expect(continuations[0]!.toolCall.input).toEqual({ command: 'ls' })
  })

  it('falls back to the process-wide installed gate', async () => {
    const gate = new FakeGate('allow')
    install(gate)
    const respond = intuticApprovalResponder()
    await respond([{ approvalId: 'a', toolCallId: 't', toolName: 'noop', input: {} }])
    expect(gate.calls).toHaveLength(1)
  })

  it('preserves providerExecuted on both the response and the toolCall', async () => {
    const respond = intuticApprovalResponder({ gate: new FakeGate('allow') })
    const [c] = await respond([
      { approvalId: 'a', toolCallId: 't', toolName: 'x', input: {}, providerExecuted: true },
    ])
    expect(c!.approvalResponse.providerExecuted).toBe(true)
    expect(c!.toolCall.providerExecuted).toBe(true)
  })
})

describe('intuticApprovalResponder: deny path', () => {
  it('produces approved:false with the BLOCKED message as reason on refusal', async () => {
    const respond = intuticApprovalResponder({ gate: new FakeGate('refuse') })
    const [c] = await respond([
      { approvalId: 'ap_1', toolCallId: 'tc_1', toolName: 'bash', input: { command: 'rm -rf /' } },
    ])
    expect(c!.approvalResponse.approved).toBe(false)
    expect(c!.approvalResponse.reason).toBe('[Intutic Governance] BLOCKED: nope')
  })

  it('fails closed (deny, never throw) when the gate crashes with a non-refusal error', async () => {
    const respond = intuticApprovalResponder({ gate: new FakeGate('crash') })
    const [c] = await respond([{ approvalId: 'a', toolCallId: 't', toolName: 'write', input: {} }])
    expect(c!.approvalResponse.approved).toBe(false)
    expect(c!.approvalResponse.reason).toContain('gate crashed (boom)')
    expect(c!.approvalResponse.reason).toContain('failing closed')
  })

  it('evaluates each request independently — one denial does not poison the rest', async () => {
    class SelectiveGate extends Gate {
      override async guard(toolName: string): Promise<void> {
        if (toolName === 'bad') throw new IntuticGateRefusal('nope', 'TEST')
      }
    }
    const respond = intuticApprovalResponder({ gate: new SelectiveGate({ enforce: true }) })
    const continuations = await respond([
      { approvalId: 'a1', toolCallId: 't1', toolName: 'good', input: {} },
      { approvalId: 'a2', toolCallId: 't2', toolName: 'bad', input: {} },
    ])
    expect(continuations.map((c) => c.approvalResponse.approved)).toEqual([true, false])
  })
})

describe('intuticApprovalResponder: no gate configured', () => {
  it('rejects before evaluating anything rather than answering unguarded', async () => {
    const respond = intuticApprovalResponder()
    await expect(respond([{ approvalId: 'a', toolCallId: 't', toolName: 'x', input: {} }])).rejects.toThrow(
      /No gate configured/,
    )
  })
})

describe('the REAL collector round-trips this responder’s approval responses', () => {
  it('collectHarnessAgentToolApprovalContinuations recovers continuations equal to ours', async () => {
    const gate = new FakeGate('refuse')
    const respond = intuticApprovalResponder({ gate })
    const requests: HarnessApprovalRequest[] = [
      { approvalId: 'ap_1', toolCallId: 'tc_1', toolName: 'bash', input: { command: 'rm -rf /' } },
    ]
    const ours = await respond(requests)

    // The transcript shape the real collector documents: assistant message
    // carrying the tool-call and tool-approval-request parts, then a trailing
    // role:'tool' message carrying our approval-response parts.
    const messages: ModelMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'tc_1', toolName: 'bash', input: { command: 'rm -rf /' } },
          { type: 'tool-approval-request', approvalId: 'ap_1', toolCallId: 'tc_1' },
        ],
      },
      { role: 'tool', content: ours.map((c) => c.approvalResponse) },
    ]

    const collected = collectHarnessAgentToolApprovalContinuations({ messages })
    expect(collected).toHaveLength(1)
    expect(collected[0]!.approvalResponse).toEqual(ours[0]!.approvalResponse)
    expect(collected[0]!.toolCall).toEqual(ours[0]!.toolCall)
  })
})

describe('intuticSubmitApprovals', () => {
  it('submits through session.submitToolApproval when the adapter supports it', async () => {
    const submitted: Array<{ approvalId: string; approved: boolean; reason?: string }> = []
    const session: HarnessSessionLike = {
      submitToolApproval: async (input) => {
        submitted.push(input)
      },
    }
    const result = await intuticSubmitApprovals(
      session,
      [{ approvalId: 'ap_1', toolCallId: 'tc_1', toolName: 'bash', input: { command: 'rm -rf /' } }],
      { gate: new FakeGate('refuse') },
    )
    expect(result.submitted).toBe(true)
    expect(submitted).toEqual([
      { approvalId: 'ap_1', approved: false, reason: '[Intutic Governance] BLOCKED: nope' },
    ])
    // The continuations are still returned, so a caller does not re-run the
    // gate to fall back to the continuation path.
    expect(result.continuations).toHaveLength(1)
  })

  it('returns submitted:false (continuation path) when the adapter lacks submitToolApproval — per-adapter support varies', async () => {
    const session: HarnessSessionLike = {} // e.g. @ai-sdk/harness-grok-build@1.0.12
    const result = await intuticSubmitApprovals(
      session,
      [{ approvalId: 'a', toolCallId: 't', toolName: 'x', input: {} }],
      { gate: new FakeGate('allow') },
    )
    expect(result.submitted).toBe(false)
    expect(result.continuations).toHaveLength(1)
    expect(result.continuations[0]!.approvalResponse.approved).toBe(true)
  })
})

describe('intuticStaticApprovals', () => {
  it("marks every tool 'user-approval' so the responder gets a per-call verdict", () => {
    expect(intuticStaticApprovals(['deploy', 'query'])).toEqual({
      deploy: 'user-approval',
      query: 'user-approval',
    })
  })

  it('accepts the tools record itself and uses its keys', () => {
    expect(intuticStaticApprovals({ deploy: { execute: async () => null } })).toEqual({
      deploy: 'user-approval',
    })
  })

  it("marks explicitly listed tools 'denied' unconditionally", () => {
    expect(intuticStaticApprovals(['deploy', 'dropDatabase'], { deny: ['dropDatabase'] })).toEqual({
      deploy: 'user-approval',
      dropDatabase: 'denied',
    })
  })
})

describe('recommendedHarnessSettings', () => {
  it("recommends 'allow-edits' and deny-all egress by default — never the framework's own 'allow-all'", () => {
    expect(recommendedHarnessSettings()).toEqual({
      permissionMode: 'allow-edits',
      networkPolicy: { mode: 'deny-all' },
    })
  })

  it('builds a custom allow-list policy with the cloud-metadata CIDR denied when hosts are given', () => {
    expect(recommendedHarnessSettings({ permissionMode: 'allow-reads', allowedHosts: ['registry.npmjs.org'] })).toEqual({
      permissionMode: 'allow-reads',
      networkPolicy: {
        mode: 'custom',
        allowedHosts: ['registry.npmjs.org'],
        deniedCIDRs: ['169.254.169.254/32'],
      },
    })
  })
})

// keep the type-check function reachable so it is not tree-shaken/flagged unused
void _typeCheckOnly
