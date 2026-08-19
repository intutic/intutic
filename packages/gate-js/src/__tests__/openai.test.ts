/**
 * Tests for `@intutic/gate/openai`.
 *
 * Three layers of coverage, matching the dsh test's split plus one more:
 *
 *   1. The adapter's own plumbing against a controllable `FakeGate` —
 *      argument parsing, the refusal→rejectContent mapping, the fail-closed
 *      default, approval composition — no network, no filesystem.
 *   2. Structural type checks against the REAL `@openai/agents@0.16.1`
 *      shipped types (a devDependency of this package only): the guardrail
 *      is assignable to the real `ToolInputGuardrailDefinition`, its outputs
 *      are byte-identical to `ToolGuardrailFunctionOutputFactory`'s, and
 *      wrapped tools still satisfy `new Agent({ tools })`. TypeScript
 *      rejects this file if the real shapes drift.
 *   3. REAL runner integration: `run(agent, input)` is driven end to end
 *      through `@openai/agents`' actual Runner with a stub `Model` (no API
 *      key, no network) — proving the injected guardrail is executed by the
 *      real `toolExecution.js` machinery, the tool body never runs on a
 *      refusal, the BLOCKED message becomes the model-visible tool output,
 *      and (the MCP gotcha) that `wrapAgent` gates tools materialized from
 *      `agent.mcpServers`, which never appear in `agent.tools` at all.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  Agent,
  RunContext,
  RunToolApprovalItem,
  ToolGuardrailFunctionOutputFactory,
  Usage,
  hostedMcpTool,
  run,
  shellTool,
  tool,
  webSearchTool,
} from '@openai/agents'
import type {
  MCPServer,
  Model,
  ModelRequest,
  ModelResponse,
  StreamEvent,
  Tool,
  ToolInputGuardrailDefinition,
  protocol,
} from '@openai/agents'
import { IntuticGateRefusal } from '../errors.js'
import { Gate, install } from '../gate.js'
import {
  GUARDRAIL_NAME,
  installOpenAiGate,
  intuticComputerNeedsApproval,
  intuticToolGuardrail,
  suppressAgentsTracingExport,
  toolInputFromArguments,
  wrapAgent,
  wrapTools,
} from '../openai.js'
import type { OpenAiToolApprovalItemLike } from '../openai.js'

// Same pattern the mastra/vercel/dsh tests use: a Gate whose guard() is
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

afterEach(() => {
  install(null)
  delete process.env.OPENAI_AGENTS_DISABLE_TRACING
  delete process.env.INTUTIC_SESSION_ID
})

// ------------------------------------------------------------------------
// Structural type checks. Never invoked — a drift in the real SDK's shapes
// fails `tsc`/vitest's type-checking pass here, not at a caller's compile
// time.
// ------------------------------------------------------------------------
function _typeCheckOnly(): void {
  // The guardrail is assignable to the real definition type — both to a
  // built FunctionTool's inputGuardrails array and to the tool() option.
  const guardrail: ToolInputGuardrailDefinition = intuticToolGuardrail()
  void guardrail

  const realTool = tool({
    name: 'noop',
    description: 'noop',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    strict: true,
    inputGuardrails: [intuticToolGuardrail()],
    execute: async () => 'ok',
  })

  // Wrapped tools still satisfy the real Agent constructor.
  const tools: Tool[] = wrapTools([realTool, webSearchTool(), hostedMcpTool({ serverLabel: 'x', serverUrl: 'https://example.invalid' })])
  const agent = new Agent({ name: 'x', tools })
  // wrapAgent accepts (and returns) the real Agent type.
  const wrapped: Agent = wrapAgent(agent)
  void wrapped

  // The guardrail's run() parameter accepts the real data shape.
  const fn: ToolInputGuardrailDefinition['run'] = intuticToolGuardrail().run
  void fn
}
void _typeCheckOnly

// ------------------------------------------------------------------------
// Helpers for the real-runner integration tests.
// ------------------------------------------------------------------------

function usage(): Usage {
  return new Usage()
}

function functionCallResponse(name: string, args: Record<string, unknown>): ModelResponse {
  const item: protocol.FunctionCallItem = {
    type: 'function_call',
    id: 'fc_1',
    callId: 'call_1',
    name,
    status: 'completed',
    arguments: JSON.stringify(args),
  }
  return { usage: usage(), output: [item] }
}

function finalMessageResponse(text: string): ModelResponse {
  const item: protocol.AssistantMessageItem = {
    type: 'message',
    id: 'msg_1',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text }],
  }
  return { usage: usage(), output: [item] }
}

/** A Model that replays canned responses — the real Runner drives everything
 *  else (tool resolution, guardrails, tool execution, output items). */
class FakeModel implements Model {
  requests: ModelRequest[] = []
  private i = 0
  constructor(private readonly responses: ModelResponse[]) {}
  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request)
    const response = this.responses[Math.min(this.i, this.responses.length - 1)]!
    this.i += 1
    return response
  }
  // eslint-disable-next-line require-yield
  async *getStreamedResponse(): AsyncIterable<StreamEvent> {
    throw new Error('streaming is not exercised by these tests')
  }
}

/** A minimal in-memory MCPServer — enough for the real `getAllMcpTools()`
 *  conversion path (`mcpToFunctionTool`) to materialize a genuine
 *  FunctionTool from it. */
function stubMcpServer(onCallTool: (toolName: string) => void): MCPServer {
  return {
    name: 'stub-mcp',
    cacheToolsList: false,
    async connect() {},
    async close() {},
    async listTools() {
      return [
        {
          name: 'mcp_delete',
          description: 'Delete a path via MCP',
          inputSchema: {
            type: 'object' as const,
            properties: { path: { type: 'string' } },
            required: ['path'],
            additionalProperties: false,
          },
        },
      ]
    },
    async callTool(toolName: string) {
      onCallTool(toolName)
      return [{ type: 'text', text: 'mcp ran' }]
    },
    async invalidateToolsCache() {},
  }
}

function newFunctionTool(onExecute: () => void) {
  return tool({
    name: 'delete_everything',
    description: 'Deletes everything',
    parameters: {
      type: 'object' as const,
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    strict: true,
    execute: async () => {
      onExecute()
      return 'deleted'
    },
  })
}

// ------------------------------------------------------------------------
// toolInputFromArguments
// ------------------------------------------------------------------------

describe('toolInputFromArguments', () => {
  it('parses a JSON object as-is', () => {
    expect(toolInputFromArguments('{"path":"a.txt"}')).toEqual({ path: 'a.txt' })
  })
  it('maps empty/missing arguments to {}', () => {
    expect(toolInputFromArguments('')).toEqual({})
    expect(toolInputFromArguments(undefined)).toEqual({})
    expect(toolInputFromArguments(null)).toEqual({})
  })
  it('wraps malformed JSON as { raw } so the gate still evaluates something', () => {
    expect(toolInputFromArguments('{not json')).toEqual({ raw: '{not json' })
  })
  it('wraps non-object JSON as { value }', () => {
    expect(toolInputFromArguments('[1,2]')).toEqual({ value: [1, 2] })
    expect(toolInputFromArguments('"bare"')).toEqual({ value: 'bare' })
  })
})

// ------------------------------------------------------------------------
// intuticToolGuardrail — unit
// ------------------------------------------------------------------------

describe('intuticToolGuardrail: allow path', () => {
  it('calls the gate with the parsed arguments, then allows', async () => {
    const gate = new FakeGate('allow')
    const guardrail = intuticToolGuardrail({ gate })
    const output = await guardrail.run({
      toolCall: { name: 'read_file', arguments: '{"path":"a.txt"}' },
    })
    expect(output).toEqual({ behavior: { type: 'allow' } })
    expect(gate.calls).toEqual([{ toolName: 'read_file', toolInput: { path: 'a.txt' } }])
  })

  it('falls back to the process-wide installed gate', async () => {
    const gate = new FakeGate('allow')
    install(gate)
    const output = await intuticToolGuardrail().run({ toolCall: { name: 'noop', arguments: '{}' } })
    expect(output.behavior).toEqual({ type: 'allow' })
    expect(gate.calls).toHaveLength(1)
  })
})

describe('intuticToolGuardrail: refusal path', () => {
  it('resolves rejectContent with the BLOCKED message, byte-identical to the real factory shape', async () => {
    const gate = new FakeGate('refuse')
    const output = await intuticToolGuardrail({ gate }).run({
      toolCall: { name: 'shell', arguments: '{"command":"rm -rf /"}' },
    })
    const message = '[Intutic Governance] BLOCKED: nope'
    expect(output.behavior).toEqual({ type: 'rejectContent', message })
    expect(output.outputInfo).toEqual({ code: 'TEST', incidentId: undefined })
    // Same shape the SDK's own factory produces — the runner treats both
    // identically.
    expect(output.behavior).toEqual(ToolGuardrailFunctionOutputFactory.rejectContent(message).behavior)
  })

  it('fails closed (rejectContent, never allow, never throw) on an unexpected gate crash', async () => {
    const gate = new FakeGate('crash')
    const output = await intuticToolGuardrail({ gate }).run({
      toolCall: { name: 'write', arguments: '{}' },
    })
    expect(output.behavior).toEqual({
      type: 'rejectContent',
      message:
        '[Intutic Governance] BLOCKED: gate crashed (boom) — failing closed rather than allowing an unevaluated call.',
    })
  })
})

describe('intuticToolGuardrail: no gate configured', () => {
  it('throws a clear error rather than running unguarded', async () => {
    await expect(
      intuticToolGuardrail().run({ toolCall: { name: 'x', arguments: '{}' } }),
    ).rejects.toThrow(/No gate configured/)
  })
})

// ------------------------------------------------------------------------
// wrapTools — per-type behaviour
// ------------------------------------------------------------------------

describe('wrapTools: function tools', () => {
  it('injects the intutic guardrail first, preserving existing guardrails, and is idempotent', () => {
    const gate = new FakeGate()
    const existing = { name: 'mine', run: async () => ToolGuardrailFunctionOutputFactory.allow() }
    const t = tool({
      name: 'a',
      description: 'a',
      parameters: { type: 'object' as const, properties: {}, required: [], additionalProperties: false },
      strict: true,
      inputGuardrails: [existing],
      execute: async () => 'ok',
    })
    const [once] = wrapTools([t], { gate })
    expect(once!.inputGuardrails!.map((g) => g.name)).toEqual([GUARDRAIL_NAME, 'mine'])
    const [twice] = wrapTools([once!], { gate })
    expect(twice!.inputGuardrails!.map((g) => g.name)).toEqual([GUARDRAIL_NAME, 'mine'])
    // The input tool object was not mutated.
    expect(t.inputGuardrails!.map((g) => g.name)).toEqual(['mine'])
  })
})

describe('wrapTools: hosted tools', () => {
  it('passes non-MCP hosted tools (server-side, not client-gateable) through unchanged', () => {
    const ws = webSearchTool()
    const [wrapped] = wrapTools([ws], { gate: new FakeGate() })
    expect(wrapped).toBe(ws)
  })

  it('rewrites hostedMcpTool entries to require_approval always + an Intutic on_approval', async () => {
    const gate = new FakeGate('refuse')
    const t = hostedMcpTool({ serverLabel: 'files', serverUrl: 'https://example.invalid' })
    // Confirmed default of the real factory: 'never' — i.e. ungated as built.
    expect(t.providerData.require_approval).toBe('never')

    const [wrapped] = wrapTools([t], { gate })
    const pd = (wrapped as typeof t).providerData as Record<string, unknown>
    expect(pd.require_approval).toBe('always')
    const onApproval = pd.on_approval as (
      ctx: unknown,
      item: OpenAiToolApprovalItemLike,
    ) => Promise<{ approve?: boolean; reason?: string }>
    expect(typeof onApproval).toBe('function')

    // Drive on_approval with a REAL RunToolApprovalItem shaped like the
    // runner's hosted-MCP approval requests (rawItem providerData carries
    // the real tool name + raw JSON arguments).
    const agent = new Agent({ name: 'x' })
    const item = new RunToolApprovalItem(
      {
        type: 'hosted_tool_call',
        name: 'mcp_approval_request',
        providerData: {
          type: 'mcp_approval_request',
          id: 'req_1',
          name: 'mcp_delete',
          arguments: '{"path":"prod.db"}',
          server_label: 'files',
        },
      },
      agent,
    )
    const decision = await onApproval(new RunContext(), item)
    expect(decision).toEqual({ approve: false, reason: '[Intutic Governance] BLOCKED: nope' })
    expect(gate.calls).toEqual([{ toolName: 'mcp_delete', toolInput: { path: 'prod.db' } }])
  })

  it('approves after the gate allows (original require_approval was never), and composes an existing onApproval', async () => {
    const allowGate = new FakeGate('allow')
    const plain = hostedMcpTool({ serverLabel: 'files', serverUrl: 'https://example.invalid' })
    const [wrappedPlain] = wrapTools([plain], { gate: allowGate })
    const onApprovalPlain = (wrappedPlain as typeof plain).providerData.on_approval as (
      ctx: unknown,
      item: unknown,
    ) => Promise<{ approve?: boolean }>

    const agent = new Agent({ name: 'x' })
    const item = new RunToolApprovalItem(
      {
        type: 'hosted_tool_call',
        name: 'mcp_approval_request',
        providerData: {
          type: 'mcp_approval_request',
          id: 'req_1',
          name: 'mcp_read',
          arguments: '{}',
          server_label: 'files',
        },
      },
      agent,
    )
    expect(await onApprovalPlain(new RunContext(), item)).toEqual({ approve: true })

    // With a caller-supplied onApproval, the gate-allow path delegates to it.
    let delegated = false
    const withHandler = hostedMcpTool({
      serverLabel: 'files',
      serverUrl: 'https://example.invalid',
      requireApproval: 'always',
      onApproval: async () => {
        delegated = true
        return { approve: false, reason: 'caller said no' }
      },
    })
    const [wrappedWithHandler] = wrapTools([withHandler], { gate: allowGate })
    const composed = (wrappedWithHandler as typeof withHandler).providerData.on_approval as (
      ctx: unknown,
      item: unknown,
    ) => Promise<{ approve?: boolean; reason?: string }>
    expect(await composed(new RunContext(), item)).toEqual({ approve: false, reason: 'caller said no' })
    expect(delegated).toBe(true)
  })

  it('rejects (block, per the SOP-approval posture) when the original config demanded a human with no resolver', async () => {
    const allowGate = new FakeGate('allow')
    const t = hostedMcpTool({
      serverLabel: 'files',
      serverUrl: 'https://example.invalid',
      requireApproval: 'always',
    })
    const [wrapped] = wrapTools([t], { gate: allowGate })
    const onApproval = (wrapped as typeof t).providerData.on_approval as (
      ctx: unknown,
      item: unknown,
    ) => Promise<{ approve?: boolean; reason?: string }>
    const agent = new Agent({ name: 'x' })
    const item = new RunToolApprovalItem(
      {
        type: 'hosted_tool_call',
        name: 'mcp_approval_request',
        providerData: {
          type: 'mcp_approval_request',
          id: 'req_1',
          name: 'mcp_write',
          arguments: '{}',
          server_label: 'files',
        },
      },
      agent,
    )
    const decision = await onApproval(new RunContext(), item)
    expect(decision.approve).toBe(false)
    expect(decision.reason).toContain('requires human approval')
  })
})

describe('wrapTools: local shell tools', () => {
  const shellImpl = { run: async () => ({ output: [] }) }
  const shellRawItem = (commands: string[]) =>
    ({
      type: 'shell_call',
      callId: 'call_1',
      status: 'in_progress',
      action: { commands },
    }) as const

  it('forces needsApproval and rejects a gate-refused command via onApproval, guarding each command separately', async () => {
    const gate = new FakeGate('refuse')
    const t = shellTool({ shell: shellImpl })
    const [wrapped] = wrapTools([t], { gate })
    expect(wrapped).not.toBe(t)
    expect(await (wrapped as typeof t).needsApproval(new RunContext(), { commands: ['x'] })).toBe(true)

    const agent = new Agent({ name: 'x' })
    const item = new RunToolApprovalItem(shellRawItem(['rm -rf /']), agent)
    const decision = await (wrapped as typeof t).onApproval!(new RunContext(), item)
    expect(decision).toEqual({ approve: false, reason: '[Intutic Governance] BLOCKED: nope' })
    expect(gate.calls).toEqual([{ toolName: 'shell', toolInput: { command: 'rm -rf /' } }])
  })

  it('approves after the gate allows when the original tool needed no approval', async () => {
    const gate = new FakeGate('allow')
    const t = shellTool({ shell: shellImpl }) // needsApproval defaults false
    const [wrapped] = wrapTools([t], { gate })
    const agent = new Agent({ name: 'x' })
    const item = new RunToolApprovalItem(shellRawItem(['ls', 'pwd']), agent)
    const decision = await (wrapped as typeof t).onApproval!(new RunContext(), item)
    expect(decision).toEqual({ approve: true })
    // One guard() per command, not one joined blob.
    expect(gate.calls).toEqual([
      { toolName: 'shell', toolInput: { command: 'ls' } },
      { toolName: 'shell', toolInput: { command: 'pwd' } },
    ])
  })

  it('delegates to an original onApproval after the gate allows', async () => {
    const gate = new FakeGate('allow')
    const t = shellTool({
      shell: shellImpl,
      needsApproval: true,
      onApproval: async () => ({ approve: false, reason: 'caller said no' }),
    })
    const [wrapped] = wrapTools([t], { gate })
    const agent = new Agent({ name: 'x' })
    const item = new RunToolApprovalItem(shellRawItem(['ls']), agent)
    expect(await (wrapped as typeof t).onApproval!(new RunContext(), item)).toEqual({
      approve: false,
      reason: 'caller said no',
    })
  })

  it('leaves the decision unmade (pending interruption) when the original policy demanded a human with no resolver', async () => {
    const gate = new FakeGate('allow')
    const t = shellTool({ shell: shellImpl, needsApproval: true })
    const [wrapped] = wrapTools([t], { gate })
    const agent = new Agent({ name: 'x' })
    const item = new RunToolApprovalItem(shellRawItem(['ls']), agent)
    const decision = await (wrapped as typeof t).onApproval!(new RunContext(), item)
    // Neither approve:true nor approve:false — the runner's
    // resolveToolApproval() falls through to 'pending', preserving the
    // caller's interruption flow (verified mechanism; see openai.ts).
    expect(decision).toEqual({})
  })

  it('fails closed when the approval item carries no recognisable shell action', async () => {
    const gate = new FakeGate('allow')
    const t = shellTool({ shell: shellImpl })
    const [wrapped] = wrapTools([t], { gate })
    const decision = await (wrapped as typeof t).onApproval!(
      new RunContext(),
      { rawItem: { type: 'something_else' } } as unknown as RunToolApprovalItem,
    )
    expect(decision.approve).toBe(false)
    expect(decision.reason).toContain('failing closed')
    expect(gate.calls).toHaveLength(0)
  })
})

describe('wrapTools: computer tools / intuticComputerNeedsApproval', () => {
  it('a gate refusal forces the approval interruption (true); an allowed action defers to the fallback', async () => {
    const refuse = intuticComputerNeedsApproval({ gate: new FakeGate('refuse') })
    expect(await refuse(new RunContext(), { type: 'click', x: 1, y: 2, button: 'left' })).toBe(true)

    const allowGate = new FakeGate('allow')
    const allow = intuticComputerNeedsApproval({ gate: allowGate, fallback: async () => false })
    expect(await allow(new RunContext(), { type: 'type', text: 'hello' })).toBe(false)
    expect(allowGate.calls).toEqual([
      { toolName: 'computer_use_preview', toolInput: { type: 'type', text: 'hello' } },
    ])
  })

  it('fails closed (true → interruption) when the gate crashes', async () => {
    const crash = intuticComputerNeedsApproval({ gate: new FakeGate('crash') })
    expect(await crash(new RunContext(), { type: 'screenshot' })).toBe(true)
  })
})

// ------------------------------------------------------------------------
// REAL runner integration — no API key, no network: a stub Model replays
// canned responses and @openai/agents' actual Runner does everything else.
// ------------------------------------------------------------------------

describe('real @openai/agents runner integration', () => {
  it('a blocked function tool never executes; the BLOCKED message becomes the model-visible tool output', async () => {
    const gate = new FakeGate('refuse')
    let executed = false
    const model = new FakeModel([
      functionCallResponse('delete_everything', { path: 'prod.db' }),
      finalMessageResponse('done'),
    ])
    const agent = wrapAgent(
      new Agent({ name: 'ops', model, tools: [newFunctionTool(() => (executed = true))] }),
      { gate },
    )

    const result = await run(agent, 'wipe it')

    expect(executed).toBe(false)
    expect(gate.calls).toEqual([{ toolName: 'delete_everything', toolInput: { path: 'prod.db' } }])
    // The rejection is what the model sees in place of a tool result.
    const outputs = result.newItems.filter((i) => i.type === 'tool_call_output_item')
    expect(outputs).toHaveLength(1)
    expect(JSON.stringify(outputs[0]!.rawItem)).toContain('[Intutic Governance] BLOCKED: nope')
  })

  it('an allowed function tool executes untouched', async () => {
    const gate = new FakeGate('allow')
    let executed = false
    const model = new FakeModel([
      functionCallResponse('delete_everything', { path: 'scratch.txt' }),
      finalMessageResponse('done'),
    ])
    const agent = wrapAgent(
      new Agent({ name: 'ops', model, tools: [newFunctionTool(() => (executed = true))] }),
      { gate },
    )

    const result = await run(agent, 'go')
    expect(executed).toBe(true)
    expect(result.finalOutput).toBe('done')
    expect(gate.calls).toHaveLength(1)
  })

  it('THE MCP GOTCHA: wrapAgent gates mcpServers-derived tools, which never appear in agent.tools', async () => {
    const gate = new FakeGate('refuse')
    let mcpToolRan = false
    const model = new FakeModel([
      functionCallResponse('mcp_delete', { path: 'prod.db' }),
      finalMessageResponse('done'),
    ])
    const agent = wrapAgent(
      new Agent({
        name: 'ops',
        model,
        tools: [],
        mcpServers: [stubMcpServer(() => (mcpToolRan = true))],
      }),
      { gate },
    )

    // The materialized MCP tool carries the guardrail...
    const materialized = await agent.getAllTools(new RunContext())
    const mcpTool = materialized.find((t) => t.type === 'function' && t.name === 'mcp_delete')
    expect(mcpTool).toBeDefined()
    expect(
      (mcpTool as { inputGuardrails?: Array<{ name: string }> }).inputGuardrails?.map((g) => g.name),
    ).toEqual([GUARDRAIL_NAME])

    // ...and the real runner enforces it: the MCP server's callTool never runs.
    const result = await run(agent, 'wipe it')
    expect(mcpToolRan).toBe(false)
    expect(gate.calls).toEqual([{ toolName: 'mcp_delete', toolInput: { path: 'prod.db' } }])
    const outputs = result.newItems.filter((i) => i.type === 'tool_call_output_item')
    expect(JSON.stringify(outputs[0]!.rawItem)).toContain('[Intutic Governance] BLOCKED: nope')
  })

  it('an allowed MCP tool still reaches the server (wrapping is not a blanket block)', async () => {
    const gate = new FakeGate('allow')
    let mcpToolRan = false
    const model = new FakeModel([
      functionCallResponse('mcp_delete', { path: 'scratch.txt' }),
      finalMessageResponse('done'),
    ])
    const agent = wrapAgent(
      new Agent({
        name: 'ops',
        model,
        tools: [],
        mcpServers: [stubMcpServer(() => (mcpToolRan = true))],
      }),
      { gate },
    )
    await run(agent, 'go')
    expect(mcpToolRan).toBe(true)
  })

  it('wrapAgent is idempotent (wrapping twice gates once)', async () => {
    const gate = new FakeGate('allow')
    const model = new FakeModel([
      functionCallResponse('delete_everything', { path: 'x' }),
      finalMessageResponse('done'),
    ])
    const agent = wrapAgent(
      wrapAgent(new Agent({ name: 'ops', model, tools: [newFunctionTool(() => {})] }), { gate }),
      { gate },
    )
    const tools = await agent.getAllTools(new RunContext())
    const fn = tools.find((t) => t.type === 'function') as { inputGuardrails?: Array<{ name: string }> }
    expect(fn.inputGuardrails?.filter((g) => g.name === GUARDRAIL_NAME)).toHaveLength(1)
    await run(agent, 'go')
    expect(gate.calls).toHaveLength(1)
  })
})

// ------------------------------------------------------------------------
// installOpenAiGate / tracing kill-switch
// ------------------------------------------------------------------------

describe('installOpenAiGate', () => {
  it('installs a process-wide gate and sets the tracing kill-switch env by default', async () => {
    process.env.INTUTIC_SESSION_ID = 'test-session'
    const gate = installOpenAiGate({ enforce: false })
    expect(gate).toBeInstanceOf(Gate)
    expect(process.env.OPENAI_AGENTS_DISABLE_TRACING).toBe('1')
    // installed process-wide: the guardrail picks it up without { gate }.
    await expect(intuticToolGuardrail().run({ toolCall: { name: 'x', arguments: '{}' } })).resolves.toEqual({
      behavior: { type: 'allow' },
    })
  })

  it("leaves tracing untouched with tracingExport: 'keep'", () => {
    delete process.env.OPENAI_AGENTS_DISABLE_TRACING
    installOpenAiGate({ enforce: false, tracingExport: 'keep', sessionId: 's' })
    expect(process.env.OPENAI_AGENTS_DISABLE_TRACING).toBeUndefined()
  })

  it('suppressAgentsTracingExport sets the SDK kill-switch env', () => {
    delete process.env.OPENAI_AGENTS_DISABLE_TRACING
    suppressAgentsTracingExport()
    expect(process.env.OPENAI_AGENTS_DISABLE_TRACING).toBe('1')
  })
})
