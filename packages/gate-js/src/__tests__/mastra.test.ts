/**
 * Tests for `@intutic/gate/mastra`.
 *
 * `@mastra/core` IS installed as a devDependency (see package.json) and its
 * real exported types are imported below (`ToolHooks` from
 * `@mastra/core/dist/tools/types.js`'s public surface, re-exported off
 * `@mastra/core/agent`) to structurally confirm `intuticHooks()`'s return
 * value satisfies the real `Agent` constructor's `hooks` option — a
 * compile-time check (TypeScript rejects the file if the shapes drift), not
 * a live Mastra agent run. Most of this file's runtime behaviour is this
 * adapter's own `beforeToolCall` function against a `FakeGate`, matching
 * `wrapTools.test.ts`'s style.
 *
 * TD-381 closer: the "real @mastra/core Agent.generate() integration" block
 * below drives the REAL `Agent.generate()` — @mastra/core's actual dispatch
 * loop, not a mocked-out one — with a stub `LanguageModelV4`
 * (`MockLanguageModelV4` from `ai/test`, also a real devDependency) that
 * emits a tool call. No API key, no network. Confirmed by reading
 * `@mastra/core@1.59.0`'s compiled `model-CAzmQiEl.js`/`llm-CIrl--nz.js`:
 * a bare object with `specificationVersion: 'v4'` passed as `model` is
 * auto-wrapped by `resolveLanguageModel` into `AISDKV7LanguageModel`, whose
 * `doGenerate()` calls straight through to the underlying mock's
 * `doGenerate()` (and synthesizes a `.stream` property from that result for
 * Mastra's internal stream-shaped consumers) — so `Agent.generate()` really
 * does invoke the stub model's `doGenerate`, and the real
 * `wrapToolWithHooks`/`beforeToolCall` plumbing this module doc's "Confirmed
 * against a real install" section describes really does run in between.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Agent } from '@mastra/core/agent'
import { createTool } from '@mastra/core/tools'
import { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod'
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

// ------------------------------------------------------------------------
// REAL @mastra/core Agent.generate() integration — no API key, no network:
// a stub LanguageModelV4 (MockLanguageModelV4 from `ai/test`) replays canned
// responses and @mastra/core's actual Agent/tool-dispatch machinery does
// everything else (tool resolution, hook wrapping, tool execution). Closes
// TD-381's "what would close this" gap for the Mastra half.
// ------------------------------------------------------------------------

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
}

function toolCallResult(toolCallId: string, toolName: string, input: unknown) {
  return {
    content: [
      { type: 'tool-call' as const, toolCallId, toolName, input: JSON.stringify(input) },
    ],
    finishReason: { unified: 'tool-calls' as const, raw: undefined },
    usage: USAGE,
  }
}

function finalTextResult(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    finishReason: { unified: 'stop' as const, raw: undefined },
    usage: USAGE,
  }
}

function deleteTool(onExecute: () => void) {
  return createTool({
    id: 'delete_everything',
    description: 'Deletes everything',
    inputSchema: z.object({ path: z.string() }),
    execute: async (inputData) => {
      onExecute()
      return { deleted: true, path: (inputData as { path: string }).path }
    },
  })
}

describe('real @mastra/core Agent.generate() integration', () => {
  afterEach(() => {
    install(null)
  })

  it('a denied tool call never executes; the real dispatch loop stops the model from seeing a result', async () => {
    const gate = new FakeGate(true)
    let executed = false
    const model = new MockLanguageModelV4({
      doGenerate: [
        toolCallResult('call_1', 'delete_everything', { path: 'prod.db' }),
        finalTextResult('done'),
      ],
    })
    const agent = new Agent({
      id: 'ops',
      name: 'ops',
      model,
      tools: { delete_everything: deleteTool(() => (executed = true)) },
      hooks: intuticHooks({ gate }),
    })

    const result = await agent.generate('wipe it', { maxSteps: 3 })

    expect(executed).toBe(false)
    expect(gate.calls).toEqual([{ toolName: 'delete_everything', toolInput: { path: 'prod.db' } }])
    // The gate's denial output reaches the model as the tool's own result —
    // the real dispatch loop, not a mock, is what produces this text.
    expect(JSON.stringify(result.toolResults ?? result.steps ?? result)).toContain(
      '[Intutic Governance] BLOCKED: nope',
    )
  })

  it('an allowed tool call executes untouched through the same real dispatch loop', async () => {
    const gate = new FakeGate(false)
    let executed = false
    const model = new MockLanguageModelV4({
      doGenerate: [
        toolCallResult('call_1', 'delete_everything', { path: 'scratch.txt' }),
        finalTextResult('done'),
      ],
    })
    const agent = new Agent({
      id: 'ops',
      name: 'ops',
      model,
      tools: { delete_everything: deleteTool(() => (executed = true)) },
      hooks: intuticHooks({ gate }),
    })

    const result = await agent.generate('clean it up', { maxSteps: 3 })

    expect(executed).toBe(true)
    expect(gate.calls).toEqual([{ toolName: 'delete_everything', toolInput: { path: 'scratch.txt' } }])
    expect(result.text).toBe('done')
  })
})

// keep the type-check function reachable so it is not tree-shaken/flagged unused
void _typeCheckOnly
