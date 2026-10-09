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
 *   4. TD-408: a REAL `RealtimeSession` (`@openai/agents-realtime`) fed a
 *      `function_call` by a stand-in transport, and the real Runner +
 *      `OpenAIResponsesModel` + `openai` HTTP client routed by
 *      `OPENAI_BASE_URL` to a local `node:http` Responses API stub —
 *      optionally through the built Rust proxy (standalone) when
 *      `<repo>/target/release/intutic-proxy` or `INTUTIC_PROXY_BIN` exists.
 *      Nothing leaves 127.0.0.1.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RealtimeAgent, RealtimeSession } from '@openai/agents-realtime'
import type { RealtimeTransportLayer, TransportToolCallEvent } from '@openai/agents-realtime'
import {
  Agent,
  OpenAIProvider,
  RunContext,
  Runner,
  RunToolApprovalItem,
  ToolGuardrailFunctionOutputFactory,
  Usage,
  computerTool,
  hostedMcpTool,
  run,
  shellTool,
  tool,
  webSearchTool,
} from '@openai/agents'
import type {
  Computer,
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
 intuticTracingExporterOptions } from '../openai.js'
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
    if (this.mode === 'refuse') throw new IntuticGateRefusal('nope', 'SNAPSHOT')
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
    expect(output.outputInfo).toEqual({ code: 'SNAPSHOT', incidentId: undefined })
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
// REAL @openai/agents runner integration — computerTool (TD-407 closer).
//
// computerTool exposes NO inputGuardrails and NO onApproval (see openai.ts's
// module doc + intuticComputerNeedsApproval's doc comment) — its only
// pre-execution hook is needsApproval, so a gate refusal can only force the
// SDK's own approval INTERRUPTION rather than auto-reject with a message.
// This block drives that path end to end with a stub Computer through the
// real Runner (no API key, no network): confirms a gate-refused action
// (a) never reaches the stub Computer's real method, (b) surfaces as
// result.interruptions, and (c) state.reject(...) round-trips — resuming
// the run with the same RunState still never executes the action and lets
// the run complete on the model's next canned response.
// ------------------------------------------------------------------------

function computerCallResponse(callId: string, action: protocol.ComputerUseCallItem['action']): ModelResponse {
  const item: protocol.ComputerUseCallItem = {
    type: 'computer_call',
    callId,
    status: 'completed',
    action,
  }
  return { usage: usage(), output: [item] }
}

/** A minimal stub Computer — every action is a no-op except click, which
 *  records whether it actually ran. */
function stubComputer(onClick: () => void): Computer {
  return {
    environment: 'mac',
    dimensions: [1024, 768],
    async screenshot() {
      return ''
    },
    async click(_x: number, _y: number, _button) {
      onClick()
    },
    async doubleClick() {},
    async scroll() {},
    async type() {},
    async wait() {},
    async move() {},
    async keypress() {},
    async drag() {},
  }
}

describe('real @openai/agents runner integration: computerTool (TD-407)', () => {
  it('a gate-refused computer action never runs, surfaces as a pending interruption, and state.reject round-trips', async () => {
    const gate = new FakeGate('refuse')
    let clicked = false
    const model = new FakeModel([
      computerCallResponse('call_1', { type: 'click', x: 10, y: 20, button: 'left' }),
      finalMessageResponse('done'),
    ])
    const rawTool = computerTool({ computer: stubComputer(() => (clicked = true)) })
    const [wrapped] = wrapTools([rawTool], { gate })
    const agent = new Agent({ name: 'ops', model, tools: [wrapped] })

    const result = await run(agent, 'click something')

    // The gate's refusal forced the SDK's own approval interruption — this
    // adapter cannot auto-reject a computer action with a message the way
    // the guardrail path can (module doc / TD-407).
    expect(result.interruptions).toHaveLength(1)
    expect(clicked).toBe(false)
    expect(gate.calls).toEqual([
      { toolName: 'computer_use_preview', toolInput: { type: 'click', x: 10, y: 20, button: 'left' } },
    ])

    const interruption = result.interruptions[0]!
    result.state.reject(interruption, { message: 'blocked by operator' })
    const resumed = await run(agent, result.state)

    // Rejecting round-trips through the real runner: the action still never
    // ran, and the run completes using the model's next canned response.
    expect(clicked).toBe(false)
    expect(resumed.finalOutput).toBe('done')
  })

  it('an allowed computer action executes untouched (wrapping is not a blanket interruption)', async () => {
    const gate = new FakeGate('allow')
    let clicked = false
    const model = new FakeModel([
      computerCallResponse('call_1', { type: 'click', x: 5, y: 5, button: 'left' }),
      finalMessageResponse('done'),
    ])
    const rawTool = computerTool({ computer: stubComputer(() => (clicked = true)) })
    const [wrapped] = wrapTools([rawTool], { gate })
    const agent = new Agent({ name: 'ops', model, tools: [wrapped] })

    const result = await run(agent, 'click something')

    expect(result.interruptions ?? []).toHaveLength(0)
    expect(clicked).toBe(true)
    expect(result.finalOutput).toBe('done')
    expect(gate.calls).toEqual([
      { toolName: 'computer_use_preview', toolInput: { type: 'click', x: 5, y: 5, button: 'left' } },
    ])
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

  it("leaves tracing on with tracingExport: 'intutic' and names the governed endpoint (TD-405)", () => {
    delete process.env.OPENAI_AGENTS_DISABLE_TRACING
    installOpenAiGate({ enforce: false, tracingExport: 'intutic', sessionId: 's' })
    expect(process.env.OPENAI_AGENTS_DISABLE_TRACING).toBeUndefined()
    const opts = intuticTracingExporterOptions({ INTUTIC_CONTROL_PLANE_URL: 'https://api.example.test/', INTUTIC_API_KEY: 'vk_x' })
    expect(opts).toEqual({ endpoint: 'https://api.example.test/api/v1/integrations/openai-agents/traces/ingest', apiKey: 'vk_x' })
    expect(() => intuticTracingExporterOptions({})).toThrow(/INTUTIC_CONTROL_PLANE_URL/)
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

// ------------------------------------------------------------------------
// TD-408 item 2: REAL @openai/agents-realtime RealtimeSession.
//
// The realtime session dispatches tool calls itself (realtimeSession.js:
// `transport.on('function_call')` -> #handleFunctionCall ->
// runToolInputGuardrails -> invokeFunctionTool only on a non-reject). A fake
// RealtimeTransportLayer stands in for the WebSocket/WebRTC connection (no
// API key, no network) and emits a `function_call` exactly as the OpenAI
// transport does; everything after that is the real session.
// ------------------------------------------------------------------------

/** Every non-emitter member of the real transport interface is checked here;
 *  the emitter methods come from node's EventEmitter, whose loose signatures
 *  TypeScript will not match against the SDK's keyed generic ones (hence the
 *  single cast at the RealtimeSession call site). */
class FakeRealtimeTransport
  extends NodeEventEmitter
  implements Omit<RealtimeTransportLayer, 'on' | 'off' | 'emit' | 'once'>
{
  status: RealtimeTransportLayer['status'] = 'disconnected'
  readonly muted = null
  outputs: Array<{ callId: string; output: string; startResponse: boolean }> = []
  private outputWaiters: Array<() => void> = []
  async connect(): Promise<void> {
    this.status = 'connected'
  }
  sendEvent(): void {}
  sendMessage(): void {}
  addImage(): void {}
  sendAudio(): void {}
  updateSessionConfig(): void {}
  close(): void {
    this.status = 'disconnected'
  }
  mute(): void {}
  sendFunctionCallOutput(toolCall: TransportToolCallEvent, output: string, startResponse: boolean): void {
    this.outputs.push({ callId: toolCall.callId, output, startResponse })
    for (const w of this.outputWaiters.splice(0)) w()
  }
  interrupt(): void {}
  resetHistory(): void {}
  sendMcpResponse(): void {}
  /** Resolves once the session has answered a function call. */
  nextOutput(): Promise<void> {
    return new Promise((resolve) => this.outputWaiters.push(resolve))
  }
}

async function driveRealtimeFunctionCall(gate: Gate, args: Record<string, unknown>) {
  let executed = false
  const agent = wrapAgent(
    new RealtimeAgent({ name: 'voice-ops', tools: [newFunctionTool(() => (executed = true))] }),
    { gate },
  )
  const transport = new FakeRealtimeTransport()
  const session = new RealtimeSession(agent, { transport: transport as unknown as RealtimeTransportLayer })
  const errors: unknown[] = []
  session.on('error', (e) => errors.push(e))
  await session.connect({ apiKey: 'unused-by-fake-transport' })

  const answered = transport.nextOutput()
  const event: TransportToolCallEvent = {
    type: 'function_call',
    name: 'delete_everything',
    callId: 'call_rt_1',
    arguments: JSON.stringify(args),
    responseId: 'resp_rt_1',
  }
  transport.emit('function_call', event)
  await answered
  session.close()
  return { executed, outputs: transport.outputs, errors }
}

describe('real @openai/agents-realtime RealtimeSession (TD-408 item 2)', () => {
  it('a gate-refused realtime function_call never executes; the BLOCKED message is sent back as the call output', async () => {
    const gate = new FakeGate('refuse')

    const { executed, outputs, errors } = await driveRealtimeFunctionCall(gate, { path: 'prod.db' })

    expect(errors).toEqual([])
    expect(executed).toBe(false)
    expect(gate.calls).toEqual([{ toolName: 'delete_everything', toolInput: { path: 'prod.db' } }])
    expect(outputs).toHaveLength(1)
    expect(outputs[0]!.callId).toBe('call_rt_1')
    expect(outputs[0]!.output).toContain('[Intutic Governance] BLOCKED: nope')
  })

  it('an allowed realtime function_call executes and its result is sent back', async () => {
    const gate = new FakeGate('allow')

    const { executed, outputs, errors } = await driveRealtimeFunctionCall(gate, { path: 'scratch.txt' })

    expect(errors).toEqual([])
    expect(executed).toBe(true)
    expect(outputs.map((o) => o.output)).toEqual(['deleted'])
  })
})

// ------------------------------------------------------------------------
// TD-408 item 4 (partial): the REAL Runner + REAL OpenAIResponsesModel + the
// real `openai` HTTP client, pointed via OPENAI_BASE_URL (the env-only
// routing openai.ts's module doc describes) at a local node:http stub of the
// Responses API. Optionally through the built Rust proxy in standalone mode
// (INTUTIC_STANDALONE=1, every *_UPSTREAM_URL pointed at the stub) when
// <repo>/target/release/intutic-proxy exists. Nothing leaves 127.0.0.1:
// tracing is disabled on the Runner and the stub records every request.
// ------------------------------------------------------------------------

interface StubRequest {
  path: string
  authorization: string | undefined
  body: { input?: unknown; tools?: unknown }
}

function responsesStubPayload(n: number): Record<string, unknown> {
  const base = {
    id: `resp_stub_${n}`,
    object: 'response',
    created_at: 0,
    status: 'completed',
    model: 'gpt-stub',
    parallel_tool_calls: true,
    tool_choice: 'auto',
    tools: [],
    usage: {
      input_tokens: 1,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 1,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 2,
    },
  }
  if (n === 1) {
    return {
      ...base,
      output: [
        {
          type: 'function_call',
          id: 'fc_stub_1',
          call_id: 'call_stub_1',
          name: 'delete_everything',
          arguments: JSON.stringify({ path: 'prod.db' }),
          status: 'completed',
        },
      ],
    }
  }
  return {
    ...base,
    output: [
      {
        type: 'message',
        id: 'msg_stub_1',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'done', annotations: [] }],
      },
    ],
  }
}

async function startResponsesStub(): Promise<{ url: string; requests: StubRequest[]; close: () => Promise<void> }> {
  const requests: StubRequest[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8')
      let body: StubRequest['body']
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch {
        body = {}
      }
      requests.push({ path: req.url ?? '', authorization: req.headers.authorization, body })
      if (req.method === 'POST' && (req.url ?? '').endsWith('/responses')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(responsesStubPayload(requests.filter((r) => r.path.endsWith('/responses')).length)))
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `stub: no route for ${req.method} ${req.url}` } }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** Runs the real Runner against `baseUrl` (set as OPENAI_BASE_URL, read by
 *  the `openai` client the provider constructs), restoring env afterwards. */
async function runAgainstResponsesEndpoint(baseUrl: string, gate: Gate) {
  const saved = process.env.OPENAI_BASE_URL
  process.env.OPENAI_BASE_URL = `${baseUrl}/v1`
  try {
    let executed = false
    // Test-only placeholder, assembled at runtime; the stub never checks it.
    const apiKey = ['sk', 'test', 'fixture'].join('-')
    const provider = new OpenAIProvider({ apiKey, useResponses: true })
    const agent = wrapAgent(
      new Agent({ name: 'ops', model: 'gpt-stub', tools: [newFunctionTool(() => (executed = true))] }),
      { gate },
    )
    const runner = new Runner({ modelProvider: provider, tracingDisabled: true })
    const result = await runner.run(agent, 'wipe it')
    return { executed, result }
  } finally {
    if (saved === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = saved
  }
}

function functionCallOutputsSent(requests: StubRequest[]): string[] {
  const outputs: string[] = []
  for (const r of requests) {
    const input = Array.isArray(r.body.input) ? (r.body.input as Array<Record<string, unknown>>) : []
    for (const item of input) {
      if (item['type'] === 'function_call_output') outputs.push(JSON.stringify(item['output']))
    }
  }
  return outputs
}

describe('real Runner over HTTP against a local Responses API stub (TD-408)', () => {
  it('a gate-refused tool call from a real /v1/responses round trip never executes; the BLOCKED output goes back on the wire', async () => {
    const stub = await startResponsesStub()
    try {
      const gate = new FakeGate('refuse')
      const { executed, result } = await runAgainstResponsesEndpoint(stub.url, gate)

      expect(executed).toBe(false)
      expect(result.finalOutput).toBe('done')
      expect(gate.calls).toEqual([{ toolName: 'delete_everything', toolInput: { path: 'prod.db' } }])
      // Two real HTTP calls, both to the stub, both carrying the client's key.
      expect(stub.requests.map((r) => r.path)).toEqual(['/v1/responses', '/v1/responses'])
      expect(stub.requests.every((r) => r.authorization?.startsWith('Bearer ') === true)).toBe(true)
      // The tool was declared to the model, and the second request carries the
      // guardrail's rejection as the function_call_output.
      expect(JSON.stringify(stub.requests[0]!.body.tools)).toContain('delete_everything')
      const sent = functionCallOutputsSent(stub.requests)
      expect(sent).toHaveLength(1)
      expect(sent[0]).toContain('[Intutic Governance] BLOCKED: nope')
    } finally {
      await stub.close()
    }
  })

  // The cargo workspace root is the repo root, so the release binary lands in
  // <repo>/target/release. INTUTIC_PROXY_BIN points at one elsewhere (e.g. a
  // worktree without its own cargo build).
  const proxyBinary =
    process.env.INTUTIC_PROXY_BIN ??
    resolvePath(fileURLToPath(new URL('.', import.meta.url)), '../../../../target/release/intutic-proxy')
  const haveProxy = existsSync(proxyBinary)

  describe.skipIf(!haveProxy)('through the built Rust proxy (standalone mode)', () => {
    let proxy: ChildProcess | undefined
    let proxyHome: string | undefined
    let proxyLog = ''

    afterEach(async () => {
      if (proxy && proxy.exitCode === null) {
        const exited = new Promise((resolve) => proxy!.once('exit', resolve))
        proxy.kill('SIGTERM')
        await exited
      }
      proxy = undefined
      if (proxyHome) rmSync(proxyHome, { recursive: true, force: true })
      proxyHome = undefined
    })

    async function freePort(): Promise<number> {
      const s = createServer()
      await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve))
      const { port } = s.address() as AddressInfo
      await new Promise<void>((resolve) => s.close(() => resolve()))
      return port
    }

    async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (proxy?.exitCode !== null && proxy?.exitCode !== undefined) {
          throw new Error(`proxy exited (${proxy.exitCode}) before becoming healthy:\n${proxyLog}`)
        }
        try {
          const res = await fetch(`${url}/health`)
          if (res.ok) return
        } catch {
          // not listening yet
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      throw new Error(`proxy did not become healthy within ${timeoutMs}ms:\n${proxyLog}`)
    }

    it('the blocked call still never executes when the Responses traffic crosses the proxy', async () => {
      const stub = await startResponsesStub()
      try {
        const port = await freePort()
        proxyHome = mkdtempSync(join(tmpdir(), 'intutic-proxy-home-'))
        proxyLog = ''
        // A scrubbed env: standalone (no control plane, no Valkey probe), a
        // throwaway HOME, and EVERY provider upstream pointed at the stub so
        // nothing the proxy forwards can reach a hosted API.
        proxy = spawn(proxyBinary, [], {
          env: {
            PATH: process.env.PATH ?? '',
            HOME: proxyHome,
            PORT: String(port),
            INTUTIC_STANDALONE: '1',
            OPENAI_UPSTREAM_URL: stub.url,
            ANTHROPIC_UPSTREAM_URL: stub.url,
            GEMINI_UPSTREAM_URL: stub.url,
            MISTRAL_UPSTREAM_URL: stub.url,
            OPENROUTER_UPSTREAM_URL: stub.url,
            DEEPSEEK_UPSTREAM_URL: stub.url,
            RUST_LOG: 'warn',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        proxy.stdout?.on('data', (c: Buffer) => (proxyLog += c.toString()))
        proxy.stderr?.on('data', (c: Buffer) => (proxyLog += c.toString()))
        const proxyUrl = `http://127.0.0.1:${port}`
        await waitForHealth(proxyUrl, 15_000)

        const gate = new FakeGate('refuse')
        const { executed, result } = await runAgainstResponsesEndpoint(proxyUrl, gate)

        expect(executed).toBe(false)
        expect(result.finalOutput).toBe('done')
        expect(gate.calls).toEqual([{ toolName: 'delete_everything', toolInput: { path: 'prod.db' } }])
        // The proxy forwarded both turns to the stub (its OPENAI_UPSTREAM_URL).
        expect(stub.requests.filter((r) => r.path.endsWith('/responses'))).toHaveLength(2)
        const sent = functionCallOutputsSent(stub.requests)
        expect(sent).toHaveLength(1)
        expect(sent[0]).toContain('[Intutic Governance] BLOCKED: nope')
      } finally {
        await stub.close()
      }
    }, 30_000)
  })
})
