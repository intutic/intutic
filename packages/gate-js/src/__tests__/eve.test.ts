/**
 * Tests for `@intutic/gate/eve`.
 *
 * `eve@0.39.1` IS installed as a devDependency (see package.json) and its
 * real exports are BOTH imported for structural type checks (a drift in
 * eve's `Approval`/`ApprovalStatus`/hook shapes rejects this file) AND
 * exercised at runtime where the machinery allows it without a live agent
 * session: `defineTool`/`defineMcpClientConnection` accept this adapter's
 * policies for real, `defineHook` accepts `intuticAuditHooks()`'s definition
 * for real, and eve's own shipped `once()`/`always()`/`never()` helpers run
 * inside the documented composition pattern. No live `eve dev` session or
 * model call is exercised (that needs a running durable runtime and a model
 * credential — see docs/TECH_DEBT.md TD-411); the enforcement behaviour under
 * test is this adapter's own functions against a `FakeGate`, matching
 * vercel.test.ts / dsh.test.ts's style.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { defineTool } from 'eve/tools'
import { defineMcpClientConnection } from 'eve/connections'
import { defineHook } from 'eve/hooks'
import { always, never, once } from 'eve/tools/approval'
import type { Approval, ApprovalContext, ApprovalStatus } from 'eve/tools/approval'
import { GateClient } from '../client.js'
import { IntuticGateRefusal } from '../errors.js'
import { Gate, install } from '../gate.js'
import {
  EVE_APPROVAL_TOOL_NAME,
  intuticApproval,
  intuticAuditHooks,
  intuticConnectionApproval,
  withIntuticProxy,
  type EveApprovalContext,
  type EveApprovalStatus,
} from '../eve.js'

// Same pattern vercel.test.ts / dsh.test.ts use: a Gate whose guard() is
// fully controllable, so these tests exercise the adapter's plumbing rather
// than the four real tiers (already covered by gate.test.ts).
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

/** Captures emits instead of POSTing them. */
class FakeGateClient extends GateClient {
  emitted: Array<{ event: string; toolName: string; reason: string; toolInput: unknown }> = []
  constructor() {
    super({ sessionId: 'test-session' })
  }
  override async emit(event: string, toolName: string, reason = '', toolInput?: unknown): Promise<boolean> {
    this.emitted.push({ event, toolName, reason, toolInput })
    return true
  }
}

/** Minimal ctx satisfying the slice intuticApproval reads. */
function ctxFor(toolName: string, toolInput?: unknown): EveApprovalContext {
  return { toolName, toolInput }
}

afterEach(() => {
  install(null)
})

// ------------------------------------------------------------------------
// Structural type checks against the REAL eve@0.39.1 types. Never invoked —
// a drift in eve's `Approval`/`ApprovalStatus`/`ApprovalContext` shapes
// fails this file's compile, not a caller's.
// ------------------------------------------------------------------------
function _typeCheckOnly(): void {
  // The factory's product is a real eve Approval (tool AND connection form).
  const _approval: Approval = intuticApproval()
  const _connApproval: Approval = intuticConnectionApproval()
  void _approval
  void _connApproval

  // The real ApprovalContext is assignable to the structural slice this
  // adapter declares (i.e. our policy can be handed the real thing).
  const acceptsRealCtx = (real: ApprovalContext): EveApprovalContext => real
  void acceptsRealCtx

  // Status fidelity both ways, including the boolean back-compat forms.
  const toReal = (s: EveApprovalStatus): ApprovalStatus => s
  const fromReal = (s: ApprovalStatus): EveApprovalStatus => s
  void toReal
  void fromReal

  // eve's own helpers remain usable beside ours (the composition pattern).
  const _helpers: Approval[] = [always(), never(), once()]
  void _helpers
}
void _typeCheckOnly

describe('intuticApproval: allow path', () => {
  it("calls the gate, then resolves 'not-applicable'", async () => {
    const gate = new FakeGate()
    const approval = intuticApproval({ gate })
    const status = await approval(ctxFor('read_file', { path: 'a.txt' }))
    expect(status).toBe('not-applicable')
    expect(gate.calls).toEqual([{ toolName: 'read_file', toolInput: { path: 'a.txt' } }])
  })

  it("resolves 'user-approval' instead when onAllow requests eve's human flow on top", async () => {
    const approval = intuticApproval({ gate: new FakeGate(), onAllow: 'user-approval' })
    const status = await approval(ctxFor('refund_charge', { amount: 5 }))
    expect(status).toBe('user-approval')
  })

  it('falls back to the process-wide installed gate', async () => {
    const gate = new FakeGate()
    install(gate)
    const approval = intuticApproval()
    await approval(ctxFor('noop', {}))
    expect(gate.calls).toHaveLength(1)
  })

  it('renders an undefined toolInput as {} — eve documents toolInput can be undefined', async () => {
    const gate = new FakeGate()
    await intuticApproval({ gate })(ctxFor('bare_tool'))
    expect(gate.calls).toEqual([{ toolName: 'bare_tool', toolInput: {} }])
  })

  it('wraps a non-object toolInput as { args: [value] } so the gate still has something to evaluate', async () => {
    const gate = new FakeGate()
    await intuticApproval({ gate })(ctxFor('weird_tool', 'a bare string'))
    expect(gate.calls).toEqual([{ toolName: 'weird_tool', toolInput: { args: ['a bare string'] } }])
  })
})

describe('intuticApproval: refusal path', () => {
  it("resolves {type:'denied', reason} on refusal — the AI SDK 7 denial status", async () => {
    const approval = intuticApproval({ gate: new FakeGate('refuse') })
    const status = await approval(ctxFor('shell', { command: 'rm -rf /' }))
    expect(status).toEqual({
      type: 'denied',
      reason: expect.stringContaining('[Intutic Governance] BLOCKED:'),
    })
  })

  it('re-throws a non-refusal error rather than treating it as a denial — a thrown policy fails the turn (never a silent allow)', async () => {
    const approval = intuticApproval({ gate: new FakeGate('crash') })
    await expect(approval(ctxFor('x', {}))).rejects.toThrow('boom')
  })

  it('never returns a boolean itself — the boolean forms are eve back-compat this adapter leaves to legacy policies', async () => {
    expect(typeof (await intuticApproval({ gate: new FakeGate() })(ctxFor('a', {})))).not.toBe('boolean')
    expect(typeof (await intuticApproval({ gate: new FakeGate('refuse') })(ctxFor('a', {})))).not.toBe(
      'boolean',
    )
  })
})

describe('intuticApproval: no gate configured', () => {
  it('throws a clear error rather than running unguarded', async () => {
    const approval = intuticApproval()
    await expect(approval(ctxFor('x', {}))).rejects.toThrow(/No gate configured/)
  })
})

describe('intuticConnectionApproval', () => {
  it('guards the QUALIFIED connection tool name as-is (no prefix stripping)', async () => {
    const gate = new FakeGate()
    const approval = intuticConnectionApproval({ gate })
    const status = await approval(ctxFor('support__add_internal_note', { body: 'hi' }))
    expect(status).toBe('not-applicable')
    expect(gate.calls).toEqual([
      { toolName: 'support__add_internal_note', toolInput: { body: 'hi' } },
    ])
  })

  it('denies with the same status shape as the tool-level policy', async () => {
    const approval = intuticConnectionApproval({ gate: new FakeGate('refuse') })
    const status = await approval(ctxFor('billing__updateSubscription', { plan: 'max' }))
    expect(status).toEqual({ type: 'denied', reason: expect.stringContaining('BLOCKED') })
  })
})

describe('composition with eve’s own shipped approval helpers (real machinery)', () => {
  // The documented pattern from eve.ts's IntuticApprovalOptions doc: Intutic
  // denies first; otherwise the caller's own flow decides — here, eve's REAL
  // once() helper (which keys off ctx.approvedTools).
  function composed(gate: Gate) {
    const intutic = intuticApproval({ gate })
    return async (ctx: { toolName: string; toolInput?: unknown; approvedTools: ReadonlySet<string> }) => {
      const verdict = await intutic(ctx)
      if (typeof verdict === 'object' && verdict?.type === 'denied') return verdict
      return once<unknown>()(ctx as never)
    }
  }

  it('a governance denial wins before once() is consulted', async () => {
    const status = await composed(new FakeGate('refuse'))({
      toolName: 'refund_charge',
      toolInput: {},
      approvedTools: new Set<string>(),
    })
    expect(status).toEqual({ type: 'denied', reason: expect.stringContaining('BLOCKED') })
  })

  it("on allow, eve's real once() decides: 'user-approval' before first approval, 'not-applicable' after", async () => {
    const run = composed(new FakeGate('allow'))
    expect(
      await run({ toolName: 'refund_charge', toolInput: {}, approvedTools: new Set() }),
    ).toBe('user-approval')
    expect(
      await run({ toolName: 'refund_charge', toolInput: {}, approvedTools: new Set(['refund_charge']) }),
    ).toBe('not-applicable')
  })
})

describe('real eve definition machinery accepts this adapter', () => {
  it('defineTool() (real, runtime) accepts approval: intuticApproval()', () => {
    const policy = intuticApproval({ gate: new FakeGate() })
    const tool = defineTool({
      description: 'Refund a charge.',
      inputSchema: { type: 'object', properties: { amount: { type: 'number' } } },
      approval: policy,
      async execute() {
        return { ok: true }
      },
    })
    expect(tool.approval).toBe(policy)
  })

  it('defineMcpClientConnection() (real, runtime) accepts approval: intuticConnectionApproval()', () => {
    const policy = intuticConnectionApproval({ gate: new FakeGate() })
    const conn = defineMcpClientConnection({
      url: 'https://support.example.com/mcp',
      description: 'Support tickets.',
      approval: policy,
    })
    expect(conn.approval).toBe(policy)
  })

  it('defineHook() (real, runtime) accepts intuticAuditHooks() unchanged', () => {
    const hooks = intuticAuditHooks({ client: new FakeGateClient() })
    const definition = defineHook(hooks)
    expect(definition).toBe(hooks) // defineHook is eve's identity-with-types helper
    expect(Object.keys(hooks.events)).toEqual(['approval.candidate', 'approval.settled'])
  })
})

describe('intuticAuditHooks: event mapping', () => {
  const ctx = { session: { id: 'sess-1' }, agent: { name: 'root' } }
  const base = { requestId: 'req-1', responderPrincipalId: 'user:alice', sequence: 1, stepIndex: 0, turnId: 't-1' }

  it("approval.settled 'approved' → tool_allowed under the synthetic eve:approval tool name", async () => {
    const client = new FakeGateClient()
    const hooks = intuticAuditHooks({ client })
    await hooks.events['approval.settled'](
      { type: 'approval.settled', data: { ...base, outcome: 'approved' } },
      ctx,
    )
    expect(client.emitted).toEqual([
      {
        event: 'tool_allowed',
        toolName: EVE_APPROVAL_TOOL_NAME,
        reason: expect.stringContaining('approved by user:alice'),
        toolInput: { ...base, outcome: 'approved' },
      },
    ])
    expect(client.emitted[0]!.reason).toContain('req-1')
  })

  it("approval.settled 'cancelled' → tool_blocked, labelled as a human veto, not a gate refusal", async () => {
    const client = new FakeGateClient()
    await intuticAuditHooks({ client }).events['approval.settled'](
      { type: 'approval.settled', data: { ...base, outcome: 'cancelled' } },
      ctx,
    )
    expect(client.emitted).toHaveLength(1)
    expect(client.emitted[0]!.event).toBe('tool_blocked')
    expect(client.emitted[0]!.reason).toContain('Human veto')
    expect(client.emitted[0]!.reason).toContain('not an Intutic gate refusal')
  })

  it("approval.candidate 'pending' is routine lifecycle — no emit", async () => {
    const client = new FakeGateClient()
    await intuticAuditHooks({ client }).events['approval.candidate'](
      { type: 'approval.candidate', data: { ...base, candidateId: 'c-1', outcome: 'pending' } },
      ctx,
    )
    expect(client.emitted).toEqual([])
  })

  it.each(['rejected', 'failed', 'timed-out', 'stale'] as const)(
    "approval.candidate '%s' → tool_flagged with the outcome and request in the reason",
    async (outcome) => {
      const client = new FakeGateClient()
      await intuticAuditHooks({ client }).events['approval.candidate'](
        {
          type: 'approval.candidate',
          data: { ...base, candidateId: 'c-1', outcome, reason: 'because' },
        },
        ctx,
      )
      expect(client.emitted).toEqual([
        {
          event: 'tool_flagged',
          toolName: EVE_APPROVAL_TOOL_NAME,
          reason: `eve approval candidate ${outcome} (request req-1, responder user:alice): because`,
          toolInput: { ...base, candidateId: 'c-1', outcome, reason: 'because' },
        },
      ])
    },
  )
})

describe('withIntuticProxy re-export', () => {
  it('is the vercel.ts helper, re-exported — one routing implementation, not two', async () => {
    const vercel = await import('../vercel.js')
    expect(withIntuticProxy).toBe(vercel.withIntuticProxy)
  })
})
