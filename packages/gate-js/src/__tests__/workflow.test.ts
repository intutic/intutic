/**
 * Tests for `@intutic/gate/workflow`.
 *
 * `@ai-sdk/workflow`, `workflow`, and `ai` ARE installed as devDependencies
 * (see package.json) and used two ways here, matching vercel.test.ts's style:
 *
 *   1. The REAL `FatalError.is` from the `workflow` package (re-exported from
 *      `@workflow/errors` via `@workflow/core`) is run against this adapter's
 *      thrown refusals — the load-bearing duck-type test: the durable
 *      runtime's retry/abort decision consults exactly this predicate, so
 *      this is the difference between "a governance denial aborts the run"
 *      and "a governance denial retry-loops until max attempts".
 *   2. Real exported types (`ai`'s `tool()`, `@ai-sdk/workflow`'s
 *      `WorkflowAgentOptions`) structurally confirm `intuticNeedsApproval()`
 *      is assignable to the tool-level `needsApproval` surface the workflow
 *      agent loop actually consults.
 *
 * No live durable run is exercised — that needs a Workflow DevKit deployment
 * (workflow-server/world) this environment does not have (see the TD entry
 * this phase filed). The runtime behaviour under test is this adapter's own
 * functions against a `FakeGate`, per wrapTools.test.ts's pattern.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { FatalError } from 'workflow'
import { tool } from 'ai'
import { z } from 'zod'
import type { WorkflowAgentOptions } from '@ai-sdk/workflow'
import { IntuticGateRefusal } from '../errors.js'
import { Gate, install } from '../gate.js'
import {
  IntuticWorkflowRefusal,
  intuticNeedsApproval,
  withIntuticApproval,
  wrapWorkflowTools,
} from '../workflow.js'

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

const APPROVAL_OPTIONS = { toolCallId: 'tc_1', messages: [], context: undefined }

/** Read the composed needsApproval off a wrapped tool, typed for invocation. */
function approvalOf(tool: unknown): (input: unknown, options: unknown) => Promise<boolean> {
  return (tool as { needsApproval: (input: unknown, options: unknown) => Promise<boolean> })
    .needsApproval
}

afterEach(() => {
  install(null)
})

// ------------------------------------------------------------------------
// Structural type checks. Never invoked — a drift in the real tool-level
// `needsApproval` surface (the one @ai-sdk/workflow's agent loop consults)
// fails the type-checking pass here.
// ------------------------------------------------------------------------
function _typeCheckOnly(): void {
  const gated = tool({
    description: 'x',
    inputSchema: z.object({ command: z.string() }),
    needsApproval: intuticNeedsApproval('gated'),
    execute: async () => 'ok',
  })
  // The whole record (with our needsApproval attached) must satisfy the real
  // WorkflowAgentOptions tools slot.
  const _opts: Pick<WorkflowAgentOptions, 'model' | 'tools'> = {
    model: 'anthropic/claude-opus' as WorkflowAgentOptions['model'],
    tools: withIntuticApproval({ gated }),
  }
  void _opts
}

describe('IntuticWorkflowRefusal: the FatalError duck-type contract', () => {
  it("passes the REAL workflow package's FatalError.is() — a denial aborts instead of retry-looping", () => {
    const refusal = new IntuticWorkflowRefusal('nope', 'TEST')
    expect(FatalError.is(refusal)).toBe(true)
  })

  it('a plain IntuticGateRefusal does NOT pass FatalError.is() — the rewrap is load-bearing, not decoration', () => {
    expect(FatalError.is(new IntuticGateRefusal('nope', 'TEST'))).toBe(false)
  })

  it('remains a real IntuticGateRefusal with the structured verdict and BLOCKED message intact', () => {
    const refusal = new IntuticWorkflowRefusal('nope', 'TEST', 'inc_1')
    expect(refusal).toBeInstanceOf(IntuticGateRefusal)
    expect(refusal.message).toBe('[Intutic Governance] BLOCKED: nope')
    expect(refusal.reason).toBe('nope')
    expect(refusal.code).toBe('TEST')
    expect(refusal.incidentId).toBe('inc_1')
    expect(refusal.name).toBe('FatalError')
    expect(refusal.fatal).toBe(true)
  })

  it('IntuticWorkflowRefusal.is() detects a refusal cross-realm (name + message prefix, no instanceof)', () => {
    const refusal = new IntuticWorkflowRefusal('nope', 'TEST')
    // Simulate the vm-realm boundary: a structurally identical plain object.
    const crossRealm = { name: refusal.name, message: refusal.message }
    expect(IntuticWorkflowRefusal.is(crossRealm)).toBe(true)
    // The real FatalError is fatal but not an Intutic refusal.
    expect(IntuticWorkflowRefusal.is(new FatalError('unrelated'))).toBe(false)
  })
})

describe('intuticNeedsApproval: allow path', () => {
  it("resolves false by default (onAllow 'auto') — the gate evaluated the call, no human pause", async () => {
    const gate = new FakeGate('allow')
    const needsApproval = intuticNeedsApproval('read_file', { gate })
    await expect(needsApproval({ path: 'a.txt' }, APPROVAL_OPTIONS)).resolves.toBe(false)
    expect(gate.calls).toEqual([{ toolName: 'read_file', toolInput: { path: 'a.txt' } }])
  })

  it("resolves true with onAllow 'human' — gate allows AND a human still approves (durable pause)", async () => {
    const needsApproval = intuticNeedsApproval('deploy', { gate: new FakeGate('allow'), onAllow: 'human' })
    await expect(needsApproval({}, APPROVAL_OPTIONS)).resolves.toBe(true)
  })

  it('falls back to the process-wide installed gate', async () => {
    const gate = new FakeGate('allow')
    install(gate)
    await expect(intuticNeedsApproval('noop')({}, APPROVAL_OPTIONS)).resolves.toBe(false)
    expect(gate.calls).toHaveLength(1)
  })

  it('wraps a non-object input as { args: [...] } so the gate still has something to evaluate', async () => {
    const gate = new FakeGate('allow')
    await intuticNeedsApproval('weird', { gate })('a bare string', APPROVAL_OPTIONS)
    expect(gate.calls).toEqual([{ toolName: 'weird', toolInput: { args: ['a bare string'] } }])
  })
})

describe('intuticNeedsApproval: deny path', () => {
  it('throws an IntuticWorkflowRefusal (never resolves true or false) on a blocked call', async () => {
    const needsApproval = intuticNeedsApproval('bash', { gate: new FakeGate('refuse') })
    const thrown = await needsApproval({ command: 'rm -rf /' }, APPROVAL_OPTIONS).then(
      () => null,
      (e: unknown) => e,
    )
    expect(thrown).toBeInstanceOf(IntuticWorkflowRefusal)
    expect(FatalError.is(thrown)).toBe(true)
    expect((thrown as IntuticWorkflowRefusal).message).toBe('[Intutic Governance] BLOCKED: nope')
  })

  it('re-throws a non-refusal gate crash UNTOUCHED — transient failures stay retryable', async () => {
    const needsApproval = intuticNeedsApproval('x', { gate: new FakeGate('crash') })
    const thrown = await needsApproval({}, APPROVAL_OPTIONS).then(
      () => null,
      (e: unknown) => e,
    )
    expect(thrown).toBeInstanceOf(TypeError)
    expect(FatalError.is(thrown)).toBe(false) // retryable, on purpose
  })
})

describe('intuticNeedsApproval: no gate configured', () => {
  it('throws FatalError-compatible (deterministic config error — retrying it would fail identically)', async () => {
    const needsApproval = intuticNeedsApproval('x')
    const thrown = await needsApproval({}, APPROVAL_OPTIONS).then(
      () => null,
      (e: unknown) => e,
    )
    expect(thrown).toBeInstanceOf(IntuticWorkflowRefusal)
    expect(FatalError.is(thrown)).toBe(true)
    expect((thrown as Error).message).toMatch(/No gate configured/)
  })
})

describe('withIntuticApproval: composition with the tool’s own needsApproval', () => {
  it('attaches the gate to every tool, keyed by record name', async () => {
    const gate = new FakeGate('allow')
    const tools = withIntuticApproval(
      {
        alpha: { execute: async () => 'a' },
        beta: { execute: async () => 'b' },
      },
      { gate },
    )
    await approvalOf(tools.alpha)({}, APPROVAL_OPTIONS)
    await approvalOf(tools.beta)({}, APPROVAL_OPTIONS)
    expect(gate.calls.map((c) => c.toolName)).toEqual(['alpha', 'beta'])
  })

  it('a tool that already said needsApproval:true keeps its human pause after the gate allows', async () => {
    const tools = withIntuticApproval(
      { risky: { needsApproval: true, execute: async () => null } },
      { gate: new FakeGate('allow') },
    )
    await expect(approvalOf(tools.risky)({}, APPROVAL_OPTIONS)).resolves.toBe(true)
  })

  it("a prior needsApproval FUNCTION still runs (with the original arguments) after the gate allows", async () => {
    const seen: unknown[] = []
    const tools = withIntuticApproval(
      {
        risky: {
          needsApproval: (input: unknown, options: unknown) => {
            seen.push(input, options)
            return true
          },
          execute: async () => null,
        },
      },
      { gate: new FakeGate('allow') },
    )
    await expect(approvalOf(tools.risky)({ n: 1 }, APPROVAL_OPTIONS)).resolves.toBe(true)
    expect(seen).toEqual([{ n: 1 }, APPROVAL_OPTIONS])
  })

  it('a blocked call throws before the prior needsApproval is consulted at all', async () => {
    let priorRan = false
    const tools = withIntuticApproval(
      {
        risky: {
          needsApproval: () => {
            priorRan = true
            return false
          },
          execute: async () => null,
        },
      },
      { gate: new FakeGate('refuse') },
    )
    await expect(approvalOf(tools.risky)({}, APPROVAL_OPTIONS)).rejects.toBeInstanceOf(
      IntuticWorkflowRefusal,
    )
    expect(priorRan).toBe(false)
  })

  it('does not mutate the input record or its tools', async () => {
    const original = { alpha: { execute: async () => 'a' } }
    const wrapped = withIntuticApproval(original, { gate: new FakeGate('allow') })
    expect(original.alpha).not.toHaveProperty('needsApproval')
    expect(wrapped.alpha).not.toBe(original.alpha)
  })
})

describe('wrapWorkflowTools: execute-level defence in depth', () => {
  it('gates execute and throws a FatalError-compatible refusal on block — a durable step must not retry a denial', async () => {
    const tools = wrapWorkflowTools(
      { bash: { execute: async () => 'ran' } },
      new FakeGate('refuse'),
    )
    const thrown = await (tools.bash!.execute as () => Promise<unknown>)().then(
      () => null,
      (e: unknown) => e,
    )
    expect(thrown).toBeInstanceOf(IntuticWorkflowRefusal)
    expect(FatalError.is(thrown)).toBe(true)
  })

  it('runs the real body untouched on allow', async () => {
    const gate = new FakeGate('allow')
    const tools = wrapWorkflowTools({ echo: { execute: async (input: unknown) => input } }, gate)
    await expect((tools.echo!.execute as (i: unknown) => Promise<unknown>)({ v: 1 })).resolves.toEqual({
      v: 1,
    })
    expect(gate.calls).toEqual([{ toolName: 'echo', toolInput: { v: 1 } }])
  })
})

// keep the type-check function reachable so it is not tree-shaken/flagged unused
void _typeCheckOnly
