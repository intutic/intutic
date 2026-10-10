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
 * No durable run is exercised here; live runs on the Workflow DevKit's local
 * world are a separate, opt-in rig. The runtime behaviour
 * under test is this adapter's own functions against a `FakeGate`, per
 * wrapTools.test.ts's pattern, with the workflow VM simulated by the global
 * marker the runtime sets there (`Symbol.for('WORKFLOW_USE_STEP')`).
 */
import { readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { FatalError } from 'workflow'
import { tool } from 'ai'
import { z } from 'zod'
import type { WorkflowAgentOptions } from '@ai-sdk/workflow'
import { IntuticGateRefusal } from '../errors.js'
import { Gate, install } from '../gate.js'
import {
  IntuticWorkflowRefusal,
  intuticApprovalStep,
  intuticNeedsApproval,
  withIntuticApproval,
  wrapWorkflowTools,
  type IntuticGateStep,
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
    if (this.mode === 'refuse') throw new IntuticGateRefusal('nope', 'SNAPSHOT')
    if (this.mode === 'crash') throw new TypeError('boom')
  }
}

const APPROVAL_OPTIONS = { toolCallId: 'tc_1', messages: [], context: undefined }

/** Read the composed needsApproval off a wrapped tool, typed for invocation. */
function approvalOf(tool: unknown): (input: unknown, options: unknown) => Promise<boolean> {
  return (tool as { needsApproval: (input: unknown, options: unknown) => Promise<boolean> })
    .needsApproval
}

// The Workflow DevKit sets this on the workflow VM's global object only.
const WORKFLOW_USE_STEP = Symbol.for('WORKFLOW_USE_STEP')
const vmGlobal = globalThis as Record<symbol, unknown>

/** Run `fn` as though inside the workflow VM (the runtime's own marker). */
async function inWorkflowVm<T>(fn: () => Promise<T>): Promise<T> {
  vmGlobal[WORKFLOW_USE_STEP] = () => undefined
  try {
    return await fn()
  } finally {
    delete vmGlobal[WORKFLOW_USE_STEP]
  }
}

/** A stand-in for the caller's `"use step"` function: records its calls and
 *  delegates to intuticApprovalStep() with a FakeGate, as the docs show. Its
 *  body runs OUTSIDE the VM marker, as a real step body runs in Node.js. */
function fakeStep(gate: Gate, onAllow?: 'auto' | 'human') {
  const calls: Array<[string, unknown]> = []
  const step: IntuticGateStep = async (toolName, input) => {
    calls.push([toolName, input])
    const marker = vmGlobal[WORKFLOW_USE_STEP]
    delete vmGlobal[WORKFLOW_USE_STEP]
    try {
      return await intuticApprovalStep(toolName, input, { gate, onAllow })
    } finally {
      if (marker !== undefined) vmGlobal[WORKFLOW_USE_STEP] = marker
    }
  }
  return { step, calls }
}

afterEach(() => {
  install(null)
  delete vmGlobal[WORKFLOW_USE_STEP]
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

  // The step-based form — the one that works on a WorkflowAgent — fits the
  // same real surfaces.
  const step: IntuticGateStep = async () => false
  const viaStep = tool({
    description: 'x',
    inputSchema: z.object({ command: z.string() }),
    needsApproval: intuticNeedsApproval('viaStep', { step, onAllow: 'human' }),
    execute: async () => 'ok',
  })
  const _stepOpts: Pick<WorkflowAgentOptions, 'tools'> = {
    tools: withIntuticApproval({ viaStep }, { step }),
  }
  void _stepOpts

  // A Gate instance cannot cross into the workflow VM, so { step } and
  // { gate } are mutually exclusive.
  // @ts-expect-error — gate and step together are rejected
  intuticNeedsApproval('x', { step, gate: new Gate({ enforce: false }) })
}

describe('IntuticWorkflowRefusal: the FatalError duck-type contract', () => {
  it("passes the REAL workflow package's FatalError.is() — a denial aborts instead of retry-looping", () => {
    const refusal = new IntuticWorkflowRefusal('nope', 'SNAPSHOT')
    expect(FatalError.is(refusal)).toBe(true)
  })

  it('a plain IntuticGateRefusal does NOT pass FatalError.is() — the rewrap is load-bearing, not decoration', () => {
    expect(FatalError.is(new IntuticGateRefusal('nope', 'SNAPSHOT'))).toBe(false)
  })

  it('remains a real IntuticGateRefusal with the structured verdict and BLOCKED message intact', () => {
    const refusal = new IntuticWorkflowRefusal('nope', 'SNAPSHOT', 'inc_1')
    expect(refusal).toBeInstanceOf(IntuticGateRefusal)
    expect(refusal.message).toBe('[Intutic Governance] BLOCKED: nope')
    expect(refusal.reason).toBe('nope')
    expect(refusal.code).toBe('SNAPSHOT')
    expect(refusal.incidentId).toBe('inc_1')
    expect(refusal.name).toBe('FatalError')
    expect(refusal.fatal).toBe(true)
  })

  it('IntuticWorkflowRefusal.is() detects a refusal cross-realm (name + message prefix, no instanceof)', () => {
    const refusal = new IntuticWorkflowRefusal('nope', 'SNAPSHOT')
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

describe('intuticApprovalStep: the body of the caller\'s "use step" function', () => {
  it("resolves false on allow (onAllow 'auto'), true with onAllow 'human'", async () => {
    const gate = new FakeGate('allow')
    await expect(intuticApprovalStep('read_file', { path: 'a' }, { gate })).resolves.toBe(false)
    await expect(intuticApprovalStep('deploy', {}, { gate, onAllow: 'human' })).resolves.toBe(true)
    expect(gate.calls.map((c) => c.toolName)).toEqual(['read_file', 'deploy'])
  })

  it('throws a FatalError-compatible IntuticWorkflowRefusal on block — the step runs once, no retry', async () => {
    const thrown = await intuticApprovalStep('bash', { command: 'x' }, { gate: new FakeGate('refuse') }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(thrown).toBeInstanceOf(IntuticWorkflowRefusal)
    expect(FatalError.is(thrown)).toBe(true)
  })

  it('re-throws a non-refusal crash untouched (the step retries a transient)', async () => {
    const thrown = await intuticApprovalStep('x', {}, { gate: new FakeGate('crash') }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(thrown).toBeInstanceOf(TypeError)
    expect(FatalError.is(thrown)).toBe(false)
  })

  it('uses the installed gate, and fails closed (fatal) with none', async () => {
    await expect(intuticApprovalStep('x', {})).rejects.toMatchObject({ code: 'NO_GATE', name: 'FatalError' })
    const gate = new FakeGate('allow')
    install(gate)
    await expect(intuticApprovalStep('x', {})).resolves.toBe(false)
    expect(gate.calls).toHaveLength(1)
  })
})

describe('intuticNeedsApproval / withIntuticApproval with { step }: nothing Node-only runs in the VM', () => {
  it('only calls the step, with the tool name and the input, and returns its answer', async () => {
    const gate = new FakeGate('allow')
    const { step, calls } = fakeStep(gate)
    const needsApproval = intuticNeedsApproval('run_command', { step })
    await expect(inWorkflowVm(() => needsApproval({ command: 'ls' }, APPROVAL_OPTIONS))).resolves.toBe(false)
    expect(calls).toEqual([['run_command', { command: 'ls' }]])
    expect(gate.calls).toEqual([{ toolName: 'run_command', toolInput: { command: 'ls' } }])
  })

  it("onAllow 'human' on the workflow side asks for a human even when the step allows without one", async () => {
    const { step } = fakeStep(new FakeGate('allow'))
    const needsApproval = intuticNeedsApproval('deploy', { step, onAllow: 'human' })
    await expect(inWorkflowVm(() => needsApproval({}, APPROVAL_OPTIONS))).resolves.toBe(true)
  })

  it("the step's own onAllow 'human' is honoured too (either side asking is enough)", async () => {
    const { step } = fakeStep(new FakeGate('allow'), 'human')
    await expect(intuticNeedsApproval('deploy', { step })({}, APPROVAL_OPTIONS)).resolves.toBe(true)
  })

  it('a refusal from the step propagates untouched — as the FatalError it arrives as across the step boundary', async () => {
    const crossed = new FatalError('[Intutic Governance] BLOCKED: nope')
    const step: IntuticGateStep = async () => {
      throw crossed
    }
    const thrown = await inWorkflowVm(() =>
      intuticNeedsApproval('bash', { step })({}, APPROVAL_OPTIONS).then(
        () => null,
        (e: unknown) => e,
      ),
    )
    expect(thrown).toBe(crossed)
    expect(IntuticWorkflowRefusal.is(thrown)).toBe(true)
  })

  it('withIntuticApproval({ step }) gates every tool through the step, keyed by record name, and keeps a prior needsApproval', async () => {
    const { step, calls } = fakeStep(new FakeGate('allow'))
    const tools = withIntuticApproval(
      {
        alpha: { execute: async () => 'a' },
        risky: { needsApproval: true, execute: async () => null },
      },
      { step },
    )
    await inWorkflowVm(async () => {
      await expect(approvalOf(tools.alpha)({ n: 1 }, APPROVAL_OPTIONS)).resolves.toBe(false)
      await expect(approvalOf(tools.risky)({ n: 2 }, APPROVAL_OPTIONS)).resolves.toBe(true)
    })
    expect(calls).toEqual([
      ['alpha', { n: 1 }],
      ['risky', { n: 2 }],
    ])
  })
})

describe('in-process evaluation inside the workflow VM: a clear error instead of `require is not defined`', () => {
  it('intuticNeedsApproval() without { step } throws a fatal refusal naming the "use step" fix, and never calls the gate', async () => {
    const gate = new FakeGate('allow')
    const thrown = await inWorkflowVm(() =>
      intuticNeedsApproval('run_command', { gate })({}, APPROVAL_OPTIONS).then(
        () => null,
        (e: unknown) => e,
      ),
    )
    expect(thrown).toBeInstanceOf(IntuticWorkflowRefusal)
    expect(FatalError.is(thrown)).toBe(true)
    expect((thrown as IntuticWorkflowRefusal).code).toBe('WORKFLOW_SANDBOX')
    expect((thrown as Error).message).toMatch(/workflow sandbox/)
    expect((thrown as Error).message).toMatch(/"use step"/)
    expect((thrown as Error).message).toMatch(/\{ step: intuticGate \}/)
    expect(gate.calls).toHaveLength(0)
  })

  it('withIntuticApproval() without { step } fails the same way', async () => {
    const tools = withIntuticApproval({ alpha: { execute: async () => 'a' } }, { gate: new FakeGate('allow') })
    await expect(inWorkflowVm(() => approvalOf(tools.alpha)({}, APPROVAL_OPTIONS))).rejects.toMatchObject({
      code: 'WORKFLOW_SANDBOX',
    })
  })

  it('intuticApprovalStep() called directly in workflow code (no "use step") fails the same way', async () => {
    await expect(
      inWorkflowVm(() => intuticApprovalStep('x', {}, { gate: new FakeGate('allow') })),
    ).rejects.toMatchObject({ code: 'WORKFLOW_SANDBOX' })
  })

  it('outside the VM the in-process form keeps working (unchanged behaviour)', async () => {
    const gate = new FakeGate('allow')
    await expect(intuticNeedsApproval('x', { gate })({}, APPROVAL_OPTIONS)).resolves.toBe(false)
    expect(gate.calls).toHaveLength(1)
  })
})

describe('@intutic/gate/workflow is loadable in the workflow VM', () => {
  // The workflow bundler pulls this module (and everything it imports) into
  // the VM bundle of EVERY workflow in the app; one Node built-in anywhere in
  // that graph fails all of them at load with `require is not defined`
  // (observed with workflow/nitro). Walk the value-import graph
  // (type-only imports are erased) and assert it never reaches one.
  const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
  const VALUE_IMPORT =
    /^(?:import|export)\s+(?!type\b)(?:\{[^}]*\}|\*(?:\s+as\s+\w+)?|\w+(?:\s*,\s*\{[^}]*\})?)\s+from\s+'([^']+)'/gm
  const NODE_BUILTINS = new Set(builtinModules)

  function valueImportGraph(entry: string): { modules: string[]; external: string[] } {
    const seen = new Set<string>()
    const external = new Set<string>()
    const queue = [entry]
    while (queue.length > 0) {
      const file = queue.shift()!
      if (seen.has(file)) continue
      seen.add(file)
      for (const m of readFileSync(join(SRC, file), 'utf8').matchAll(VALUE_IMPORT)) {
        const spec = m[1]!
        if (spec.startsWith('./')) queue.push(spec.slice(2).replace(/\.js$/, '.ts'))
        else external.add(spec)
      }
    }
    return { modules: [...seen].sort(), external: [...external].sort() }
  }

  it('workflow.ts reaches no Node.js built-in through its value imports', () => {
    const { modules, external } = valueImportGraph('workflow.ts')
    expect(modules).toEqual(['errors.ts', 'registry.ts', 'workflow.ts', 'wrapTools.ts'])
    expect(external.filter((s) => s.startsWith('node:') || NODE_BUILTINS.has(s))).toEqual([])
  })

  it('the walker does see Node built-ins where they are (control: gate.ts)', () => {
    expect(valueImportGraph('gate.ts').external).toContain('node:fs')
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
