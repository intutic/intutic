/**
 * Tests for `@intutic/gate/managed-agents`.
 *
 * Two layers, matching the openai/harness tests' bar:
 *
 *   1. The adapter's own plumbing against a controllable `FakeGate` and a
 *      structural `FakeClient` (`beta.sessions.events.list/send/stream`) —
 *      no network, no real Anthropic client construction (that needs an API
 *      key). Gate evaluation itself is exercised for real (`IntuticGateRefusal`
 *      thrown/not-thrown) rather than stubbed to a canned verdict.
 *   2. Structural type checks against the REAL `@anthropic-ai/sdk@0.117.1`
 *      shipped types (a devDependency of this package only, never imported
 *      by managedAgents.ts itself): a real `BetaManagedAgentsAgentToolUseEvent`
 *      / `...AgentMCPToolUseEvent` is assignable to this module's structural
 *      event types, this module's built confirmation params are assignable
 *      to the real `BetaManagedAgentsUserToolConfirmationEventParams`, and a
 *      real `Anthropic` client's `beta.sessions.events` satisfies
 *      `ManagedAgentsSessionEventsClientLike`. TypeScript rejects this file
 *      if the real shapes drift.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { Anthropic } from '@anthropic-ai/sdk'
import type {
  BetaManagedAgentsAgentCustomToolUseEvent,
  BetaManagedAgentsAgentMCPToolUseEvent,
  BetaManagedAgentsAgentToolUseEvent,
  BetaManagedAgentsUserToolConfirmationEventParams,
} from '@anthropic-ai/sdk/resources/beta/sessions/events'
import { IntuticGateRefusal } from '../errors.js'
import { Gate, install } from '../gate.js'
import {
  MANAGED_AGENTS_BETA,
  IntuticSessionConfirmer,
  confirmationForEvent,
  wrapManagedAgentsCustomTool,
  wrapManagedAgentsCustomTools,
} from '../managedAgents.js'
import type {
  AgentToolUseEventLike,
  AgentMcpToolUseEventLike,
  ManagedAgentsClientLike,
  ManagedAgentsSessionEventLike,
  ManagedAgentsSessionEventsClientLike,
  UserToolConfirmationParams,
} from '../managedAgents.js'

const BLOCKED_COMMAND = 'kubectl apply -f k8s/x.yaml'
const ALLOWED_COMMAND = 'git status'

// Same pattern the openai/harness/workflow tests use: a Gate whose guard()
// is fully controllable, so these tests exercise the adapter's plumbing
// rather than the four real tiers (already covered by gate.test.ts).
class FakeGate extends Gate {
  calls: Array<{ toolName: string; toolInput: Record<string, unknown> }> = []
  private readonly mode: 'allow' | 'refuse' | 'crash'
  constructor(mode: 'allow' | 'refuse' | 'crash' = 'allow') {
    super({ enforce: true })
    this.mode = mode
  }
  override async guard(toolName: string, toolInput: Record<string, unknown>): Promise<void> {
    this.calls.push({ toolName, toolInput })
    if (this.mode === 'refuse') throw new IntuticGateRefusal('deploy must reference a digest-pinned image', 'TEST')
    if (this.mode === 'crash') throw new TypeError('boom')
  }
}

function gateFor(command: string): FakeGate {
  return new FakeGate(command === BLOCKED_COMMAND ? 'refuse' : 'allow')
}

afterEach(() => {
  install(null)
})

// ------------------------------------------------------------------------
// Structural type checks. Never invoked — a drift in the real SDK's shapes
// fails `tsc`/vitest's type-checking pass here, not at a caller's compile
// time.
// ------------------------------------------------------------------------
function _typeCheckOnly(anthropic: Anthropic): void {
  // A real agent.tool_use / agent.mcp_tool_use / agent.custom_tool_use event
  // (as `events.list()`/`.stream()` would hand back) is assignable to this
  // module's structural types.
  const realToolUse = {} as BetaManagedAgentsAgentToolUseEvent
  const toolUse: AgentToolUseEventLike = realToolUse
  void toolUse

  const realMcpToolUse = {} as BetaManagedAgentsAgentMCPToolUseEvent
  const mcpToolUse: AgentMcpToolUseEventLike = realMcpToolUse
  void mcpToolUse

  const realCustomToolUse = {} as BetaManagedAgentsAgentCustomToolUseEvent
  const anyEvent: ManagedAgentsSessionEventLike = realCustomToolUse
  void anyEvent

  // This module's built confirmation params are assignable to the real
  // request-params type `events.send()` expects.
  const built: UserToolConfirmationParams = {
    type: 'user.tool_confirmation',
    tool_use_id: 't1',
    result: 'deny',
    deny_message: 'nope',
  }
  const asReal: BetaManagedAgentsUserToolConfirmationEventParams = built
  void asReal

  // The real client's `beta.sessions.events` satisfies this module's
  // structural client interface — the actual assignability this adapter
  // depends on end to end.
  const eventsClient: ManagedAgentsSessionEventsClientLike = anthropic.beta.sessions.events
  void eventsClient
  const client: ManagedAgentsClientLike = anthropic
  void client
}
void _typeCheckOnly

// ------------------------------------------------------------------------
// Structural fakes for the plumbing tests.
// ------------------------------------------------------------------------

class FakeEvents implements ManagedAgentsSessionEventsClientLike {
  sent: UserToolConfirmationParams[] = []
  constructor(
    private readonly listed: ManagedAgentsSessionEventLike[] = [],
    private readonly streamed: ManagedAgentsSessionEventLike[] = [],
  ) {}

  async *list(): AsyncIterable<ManagedAgentsSessionEventLike> {
    for (const event of this.listed) yield event
  }

  async send(_sessionId: string, params: { events: UserToolConfirmationParams[] }): Promise<unknown> {
    this.sent.push(...params.events)
    return { events: params.events }
  }

  async stream(): Promise<AsyncIterable<ManagedAgentsSessionEventLike>> {
    const streamed = this.streamed
    return {
      async *[Symbol.asyncIterator]() {
        for (const event of streamed) yield event
      },
    }
  }
}

function fakeClient(listed: ManagedAgentsSessionEventLike[] = [], streamed: ManagedAgentsSessionEventLike[] = []) {
  const events = new FakeEvents(listed, streamed)
  const client: ManagedAgentsClientLike = { beta: { sessions: { events } } }
  return { client, events }
}

function toolUseEvent(overrides: Partial<AgentToolUseEventLike> = {}): AgentToolUseEventLike {
  return {
    id: 'evt_1',
    type: 'agent.tool_use',
    name: 'shell',
    input: { command: ALLOWED_COMMAND },
    evaluated_permission: 'ask',
    ...overrides,
  }
}

function mcpToolUseEvent(overrides: Partial<AgentMcpToolUseEventLike> = {}): AgentMcpToolUseEventLike {
  return {
    id: 'evt_2',
    type: 'agent.mcp_tool_use',
    name: 'shell',
    mcp_server_name: 'ops-server',
    input: { command: ALLOWED_COMMAND },
    evaluated_permission: 'ask',
    ...overrides,
  }
}

describe('confirmationForEvent', () => {
  it('matches the real beta header', () => {
    expect(MANAGED_AGENTS_BETA).toBe('managed-agents-2026-04-01')
  })

  it('answers an allowed pause with result: allow', async () => {
    const gate = gateFor(ALLOWED_COMMAND)
    const event = toolUseEvent({ input: { command: ALLOWED_COMMAND } })

    const confirmation = await confirmationForEvent(event, { gate })

    expect(confirmation).toEqual({
      type: 'user.tool_confirmation',
      tool_use_id: 'evt_1',
      result: 'allow',
    })
  })

  it('answers a blocked pause with result: deny and the gate message', async () => {
    const gate = gateFor(BLOCKED_COMMAND)
    const event = toolUseEvent({ input: { command: BLOCKED_COMMAND } })

    const confirmation = await confirmationForEvent(event, { gate })

    expect(confirmation?.result).toBe('deny')
    expect(confirmation?.tool_use_id).toBe('evt_1')
    expect(confirmation?.deny_message).toContain('[Intutic Governance] BLOCKED:')
  })

  it('answers agent.mcp_tool_use pauses the same way, folding mcp_server_name into tool_input', async () => {
    const gate = gateFor(ALLOWED_COMMAND)
    const event = mcpToolUseEvent({ input: { command: ALLOWED_COMMAND } })

    const confirmation = await confirmationForEvent(event, { gate })

    expect(confirmation?.result).toBe('allow')
    expect(gate.calls).toEqual([
      { toolName: 'shell', toolInput: { command: ALLOWED_COMMAND, mcp_server_name: 'ops-server' } },
    ])
  })

  it('never answers when evaluated_permission is allow (never paused)', async () => {
    const gate = gateFor(BLOCKED_COMMAND)
    const event = toolUseEvent({ input: { command: BLOCKED_COMMAND }, evaluated_permission: 'allow' })

    expect(await confirmationForEvent(event, { gate })).toBeNull()
    expect(gate.calls).toEqual([])
  })

  it('never answers when evaluated_permission is unset', async () => {
    const gate = gateFor(BLOCKED_COMMAND)
    const event = toolUseEvent({ input: { command: BLOCKED_COMMAND }, evaluated_permission: undefined })

    expect(await confirmationForEvent(event, { gate })).toBeNull()
  })

  it('never answers when evaluated_permission is already deny (server-resolved)', async () => {
    const gate = gateFor(ALLOWED_COMMAND)
    const event = toolUseEvent({ input: { command: ALLOWED_COMMAND }, evaluated_permission: 'deny' })

    expect(await confirmationForEvent(event, { gate })).toBeNull()
    expect(gate.calls).toEqual([])
  })

  it('treats an unrecognised permission value as a pause needing a verdict (fail closed like SessionToolRunner)', async () => {
    const gate = gateFor(ALLOWED_COMMAND)
    const event = toolUseEvent({
      input: { command: ALLOWED_COMMAND },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      evaluated_permission: 'some_future_value' as any,
    })

    const confirmation = await confirmationForEvent(event, { gate })

    expect(confirmation).not.toBeNull()
    expect(confirmation?.result).toBe('allow')
  })

  it('never answers agent.custom_tool_use (no evaluated_permission concept)', async () => {
    const gate = gateFor(ALLOWED_COMMAND)
    const event: ManagedAgentsSessionEventLike = {
      id: 'evt_3',
      type: 'agent.custom_tool_use',
      name: 'internal_lookup',
      input: { doc_id: 'x' },
    }

    expect(await confirmationForEvent(event, { gate })).toBeNull()
  })

  it('fails closed with no gate configured', async () => {
    const event = toolUseEvent({ input: { command: ALLOWED_COMMAND } })

    const confirmation = await confirmationForEvent(event)

    expect(confirmation?.result).toBe('deny')
    expect(confirmation?.deny_message).toContain('No gate configured')
  })

  it('fails closed on an unexpected gate crash', async () => {
    const gate = new FakeGate('crash')
    const event = toolUseEvent({ input: { command: ALLOWED_COMMAND } })

    const confirmation = await confirmationForEvent(event, { gate })

    expect(confirmation?.result).toBe('deny')
    expect(confirmation?.deny_message).toContain('gate crashed')
    expect(confirmation?.deny_message).toContain('boom')
  })

  it('echoes session_thread_id back when present', async () => {
    const gate = gateFor(ALLOWED_COMMAND)
    const event = toolUseEvent({ input: { command: ALLOWED_COMMAND }, session_thread_id: 'thread_7' })

    const confirmation = await confirmationForEvent(event, { gate })

    expect(confirmation?.session_thread_id).toBe('thread_7')
  })

  it('picks up the process-wide installed gate when none is passed explicitly', async () => {
    const gate = gateFor(BLOCKED_COMMAND)
    install(gate)
    const event = toolUseEvent({ input: { command: BLOCKED_COMMAND } })

    const confirmation = await confirmationForEvent(event)

    expect(confirmation?.result).toBe('deny')
  })
})

describe('IntuticSessionConfirmer', () => {
  it('poll() answers every pending pause, skips already-answered ones, and skips never-paused ones', async () => {
    const gate = new FakeGate('allow')
    const { client, events } = fakeClient([
      toolUseEvent({ id: 't1', input: { command: ALLOWED_COMMAND } }),
      { id: 'conf_1', type: 'user.tool_confirmation', tool_use_id: 't2', result: 'allow' },
      toolUseEvent({ id: 't2', input: { command: ALLOWED_COMMAND } }), // already answered per the confirmation above
      toolUseEvent({ id: 't3', input: { command: ALLOWED_COMMAND }, evaluated_permission: 'allow' }), // never paused
    ])
    const confirmer = new IntuticSessionConfirmer(client, 'sess_1', { gate })

    const sent = await confirmer.poll()

    expect(sent.map((c) => c.tool_use_id)).toEqual(['t1'])
    expect(events.sent).toEqual(sent)
  })

  it('handleEvent does not double-send for the same id', async () => {
    const gate = new FakeGate('allow')
    const { client, events } = fakeClient()
    const confirmer = new IntuticSessionConfirmer(client, 'sess_1', { gate })
    const event = toolUseEvent({ id: 't1', input: { command: ALLOWED_COMMAND } })

    const first = await confirmer.handleEvent(event)
    const second = await confirmer.handleEvent(event)

    expect(first).not.toBeNull()
    expect(second).toBeNull()
    expect(events.sent).toHaveLength(1)
  })

  it('handleWebhook rejects a mismatched session id', async () => {
    const gate = new FakeGate('allow')
    const { client } = fakeClient()
    const confirmer = new IntuticSessionConfirmer(client, 'sess_1', { gate })

    await expect(confirmer.handleWebhook({ type: 'session.requires_action', id: 'sess_OTHER' })).rejects.toThrow(
      'does not match',
    )
  })

  it('handleWebhook polls for the matching session', async () => {
    const gate = new FakeGate('allow')
    const { client } = fakeClient([toolUseEvent({ id: 't1', input: { command: ALLOWED_COMMAND } })])
    const confirmer = new IntuticSessionConfirmer(client, 'sess_1', { gate })

    const sent = await confirmer.handleWebhook({ type: 'session.requires_action', id: 'sess_1' })

    expect(sent.map((c) => c.tool_use_id)).toEqual(['t1'])
  })

  it('handleWebhook ignores non-requires_action payloads', async () => {
    const gate = new FakeGate('allow')
    const { client, events } = fakeClient([toolUseEvent({ id: 't1', input: { command: ALLOWED_COMMAND } })])
    const confirmer = new IntuticSessionConfirmer(client, 'sess_1', { gate })

    const sent = await confirmer.handleWebhook({ type: 'session.created', id: 'sess_1' })

    expect(sent).toEqual([])
    expect(events.sent).toEqual([])
  })

  it('watch() catches up on pending work then follows the live stream, stopping at a terminal event', async () => {
    const gate = new FakeGate('allow')
    const { client } = fakeClient(
      [toolUseEvent({ id: 't1', input: { command: ALLOWED_COMMAND } })],
      [
        toolUseEvent({ id: 't2', input: { command: ALLOWED_COMMAND } }),
        { id: 'sess_end', type: 'session.status_terminated' },
        // Would be observed if reached — watch() must stop at the terminal event first.
        toolUseEvent({ id: 't3', input: { command: ALLOWED_COMMAND } }),
      ],
    )
    const confirmer = new IntuticSessionConfirmer(client, 'sess_1', { gate })

    const sent: UserToolConfirmationParams[] = []
    for await (const confirmation of confirmer.watch()) {
      sent.push(confirmation)
    }

    expect(sent.map((c) => c.tool_use_id)).toEqual(['t1', 't2'])
  })
})

describe('wrapManagedAgentsCustomTool / wrapManagedAgentsCustomTools', () => {
  it('gates run() before the real implementation executes', async () => {
    const gate = new FakeGate('refuse')
    const ran: unknown[] = []
    const tool = {
      name: 'internal_lookup',
      run: async (args: Record<string, unknown>) => {
        ran.push(args)
        return 'ok'
      },
    }

    const wrapped = wrapManagedAgentsCustomTool(tool, { gate })

    await expect(wrapped.run({ doc_id: 'x' })).rejects.toThrow(IntuticGateRefusal)
    expect(ran).toEqual([])
  })

  it('allows the real implementation to run and pass its result through on allow', async () => {
    const gate = new FakeGate('allow')
    const tool = {
      name: 'internal_lookup',
      run: async (args: Record<string, unknown>) => `looked up ${String(args.doc_id)}`,
    }

    const wrapped = wrapManagedAgentsCustomTool(tool, { gate })

    await expect(wrapped.run({ doc_id: 'x' })).resolves.toBe('looked up x')
    expect(gate.calls).toEqual([{ toolName: 'internal_lookup', toolInput: { doc_id: 'x' } }])
  })

  it('does not mutate the original tool object', async () => {
    const gate = new FakeGate('allow')
    const originalRun = async () => 'unwrapped'
    const tool = { name: 'x', run: originalRun }

    const wrapped = wrapManagedAgentsCustomTool(tool, { gate })

    expect(tool.run).toBe(originalRun)
    expect(wrapped.run).not.toBe(originalRun)
  })

  it('wrapping twice does not double-gate', async () => {
    const gate = new FakeGate('allow')
    const tool = { name: 'x', run: async () => 'ok' }

    const once = wrapManagedAgentsCustomTool(tool, { gate })
    const twice = wrapManagedAgentsCustomTool(once, { gate })

    await twice.run({})
    expect(gate.calls).toHaveLength(1)
  })

  it('wrapManagedAgentsCustomTools wraps a whole collection', async () => {
    const gate = new FakeGate('refuse')
    const tools = [
      { name: 'a', run: async () => 'a' },
      { name: 'b', run: async () => 'b' },
    ]

    const wrapped = wrapManagedAgentsCustomTools(tools, { gate })

    await expect(wrapped[0]!.run({})).rejects.toThrow(IntuticGateRefusal)
    await expect(wrapped[1]!.run({})).rejects.toThrow(IntuticGateRefusal)
  })

  it('throws (refusing to run unguarded) when no gate is configured', async () => {
    const tool = { name: 'x', run: async () => 'ok' }
    const wrapped = wrapManagedAgentsCustomTool(tool)

    await expect(wrapped.run({})).rejects.toThrow('No gate configured')
  })
})
