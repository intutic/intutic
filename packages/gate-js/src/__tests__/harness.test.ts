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
 *   3. A REAL `HarnessAgent` turn is driven against a fake adapter that
 *      emits a builtin `bash` approval request exactly as the claude-code
 *      bridge does (TD-415), proving the pause, the responder's verdict, and
 *      the continuation through real framework code.
 *
 * No live sandbox is exercised — that needs a Vercel Sandbox deployment this
 * environment does not have (see TD-416/TD-417). Gate decisions come from
 * `FakeGate`-style stubs, per wrapTools.test.ts's pattern.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  HarnessAgentAdapter,
  HarnessAgentPermissionMode,
  HarnessAgentSandboxConfig,
  HarnessAgentToolApprovalConfiguration,
} from '@ai-sdk/harness/agent'
import {
  collectHarnessAgentToolApprovalContinuations,
  HarnessAgent,
  prepareHarnessSandboxTemplate,
} from '@ai-sdk/harness/agent'
import { HARNESS_V1_BUILTIN_TOOLS } from '@ai-sdk/harness'
import type {
  HarnessV1BuiltinToolFiltering,
  HarnessV1NetworkPolicy,
  HarnessV1PromptControl,
  HarnessV1SandboxProvider,
  HarnessV1StartOptions,
  HarnessV1StreamPart,
} from '@ai-sdk/harness'
import type { ActiveTools, ModelMessage, Tool } from 'ai'
import { IntuticGateRefusal } from '../errors.js'
import { Gate, install } from '../gate.js'
import { evaluate, loadSnapshot, SEV_BLOCK, SEV_SHADOW, SEV_WARN } from '../snapshot.js'
import { allFloorFixtures, type FixturePattern } from './fixtures/protectedPathsFixtures.js'
import {
  _internal,
  intuticApprovalResponder,
  intuticSandboxBootstrap,
  intuticStaticApprovals,
  intuticSubmitApprovals,
  recommendedHarnessSettings,
  renderHarnessToolInput,
  type HarnessApprovalRequest,
  type HarnessSessionLike,
  type HarnessToolApprovalContinuation,
} from '../harness.js'
import { rulesText } from './fixtures/rulesFile.js'

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
})

// ------------------------------------------------------------------------
// Structural type checks. Never invoked — a drift in `@ai-sdk/harness`'s
// real continuation/config/settings shapes fails the type-checking pass
// here, not at a caller's compile time.
// ------------------------------------------------------------------------
function _typeCheckOnly(): void {
  // Our continuations must be assignable where continueGenerate/continueStream
  // take them — read off the real method signature, so a rename or reshape
  // of the element type fails here. Since @ai-sdk/harness 1.0.101 that
  // element is a bare `ToolApprovalResponse` (the old
  // `HarnessAgentToolApprovalContinuation` export is gone in 1.0.138);
  // ours still also carries the `{ approvalResponse, toolCall }` members that
  // <= 1.0.100 reads, which the excess fields do not affect.
  type RealContinuations = NonNullable<Parameters<HarnessAgent['continueGenerate']>[0]['toolApprovalContinuations']>
  const ours: HarnessToolApprovalContinuation[] = []
  const real: RealContinuations = ours
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

  // TD-415: settings.inactiveTools must be assignable to the REAL
  // HarnessAgentSettings.inactiveTools field for a tool set that declares a
  // 'bash' builtin (true of every harness this recommendation targets —
  // HARNESS_V1_BUILTIN_TOOL_NAMES includes 'bash'), with no cast.
  const inactive: ActiveTools<{ bash: Tool }> = settings.inactiveTools
  void inactive

  // intuticSandboxBootstrap() must produce a real HarnessAgentSandboxConfig
  // — bootstrapHash/onBootstrap pass straight through with no cast.
  const sandboxConfig: HarnessAgentSandboxConfig = intuticSandboxBootstrap()
  void sandboxConfig
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
        // Top level = the bare ToolApprovalResponse @ai-sdk/harness >= 1.0.101 reads.
        type: 'tool-approval-response',
        approvalId: 'ap_1',
        approved: true,
        // Nested = the { approvalResponse, toolCall } shape <= 1.0.100 reads.
        approvalResponse: { type: 'tool-approval-response', approvalId: 'ap_1', approved: true },
        toolCall: { type: 'tool-call', toolCallId: 'tc_1', toolName: 'read_file', input: { path: 'a.txt' } },
      },
    ])
    expect(gate.calls).toEqual([{ toolName: 'read_file', toolInput: { path: 'a.txt' } }])
  })

  it('each continuation IS its approval response at top level (the >= 1.0.101 contract, keyed by approvalId)', async () => {
    // @ai-sdk/harness@1.0.101 changed toolApprovalContinuations to a bare
    // ToolApprovalResponse[] and matches each by its top-level approvalId; an
    // element without one is ignored and the paused turn never resumes
    // (observed live in uat/evidence/live-verify/harness-docker/).
    const respond = intuticApprovalResponder({ gate: new FakeGate('refuse') })
    const [c] = await respond([
      { approvalId: 'ap_9', toolCallId: 'tc_9', toolName: 'bash', input: { command: 'x' }, providerExecuted: true },
    ])
    const { approvalResponse, toolCall, ...topLevel } = c!
    void toolCall
    expect(topLevel).toEqual(approvalResponse)
    expect(topLevel).toMatchObject({ type: 'tool-approval-response', approvalId: 'ap_9', approved: false, providerExecuted: true })
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
        if (toolName === 'bad') throw new IntuticGateRefusal('nope', 'SNAPSHOT')
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
    // Since 1.0.101 the collector returns the bare `tool-approval-response`
    // part, which is exactly our continuation's top level (and its nested
    // `approvalResponse`, kept for <= 1.0.100).
    const { approvalResponse, toolCall, ...topLevel } = ours[0]!
    void toolCall
    expect(collected[0]).toEqual(approvalResponse)
    expect(collected[0]).toEqual(topLevel)
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
  it("recommends 'allow-edits', deny-all egress, and filtering bash by default — never the framework's own 'allow-all'", () => {
    expect(recommendedHarnessSettings()).toEqual({
      permissionMode: 'allow-edits',
      networkPolicy: { mode: 'deny-all' },
      inactiveTools: ['bash'],
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
      inactiveTools: ['bash'],
    })
  })

  // TD-415: HarnessV1BuiltinToolFiltering CAN drop `bash` at config time —
  // confirmed against real shipped dist for both harnesses TD-417 discusses
  // (@ai-sdk/harness-claude-code@1.0.78: native filtering; @ai-sdk/harness-
  // grok-build@1.0.12, via its pinned @ai-sdk/harness-acp@1.0.13: framework
  // approval-auto-deny). See RecommendedHarnessSettings.inactiveTools's doc
  // comment in harness.ts for the full finding.
  it("recommends omitting bash entirely by default, via inactiveTools: ['bash']", () => {
    expect(recommendedHarnessSettings().inactiveTools).toEqual(['bash'])
  })

  it('omits inactiveTools when filterBash: false — a caller that genuinely needs bash available', () => {
    const settings = recommendedHarnessSettings({ filterBash: false })
    expect(settings.inactiveTools).toBeUndefined()
    expect('inactiveTools' in settings).toBe(false)
  })

  it('the recommended inactiveTools value is a real HarnessV1BuiltinToolFiltering deny list when applied', () => {
    // What HarnessAgent itself computes from inactiveTools (dist/agent/index.js,
    // resolveHarnessAgentToolFiltering) for a single-entry deny — confirms the
    // recommendation composes into the real filtering shape, not just that it
    // typechecks against it.
    const filtering: HarnessV1BuiltinToolFiltering = { mode: 'deny', toolNames: [...(recommendedHarnessSettings().inactiveTools ?? [])] }
    expect(filtering).toEqual({ mode: 'deny', toolNames: ['bash'] })
  })
})

// ------------------------------------------------------------------------
// TD-415: built-in tools DO have a per-call approval pause — driven through
// the REAL HarnessAgent.
//
// `@ai-sdk/harness-claude-code`'s in-sandbox bridge (dist/bridge/index.mjs,
// 1.0.78 and still in 1.0.142) adds `ask` rules via
// `createPermissionSettings` and routes the native `canUseTool` callback
// through `nativeToolRequiresApproval` — `bash`-kind tools (Bash, Monitor)
// under 'allow-edits', edit+bash kinds under 'allow-reads' — emitting a
// providerExecuted `tool-call` plus a `tool-approval-request` and blocking on
// the host's answer. `@ai-sdk/harness/agent` (dist/agent/index.js) turns that
// part into a pending approval with `kind: "builtin"`, pauses the turn
// (`finishForHostInputPause`), and on continuation delivers the decision via
// the adapter control's `submitToolApproval` (`processPendingApprovalContinuation`).
//
// The fake adapter below reproduces exactly that wire behaviour (the bridge
// itself needs a live sandbox); everything between it and the responder is
// the real framework.
// ------------------------------------------------------------------------

describe('TD-415: a builtin bash approval pause, answered by intuticApprovalResponder through the REAL HarnessAgent', () => {
  /** Refuses any call whose command contains `rm -rf` — a per-call verdict
   *  on the arguments, not a per-tool switch. */
  class CommandGate extends Gate {
    calls: Array<{ toolName: string; toolInput: Record<string, unknown> }> = []
    override async guard(toolName: string, toolInput: Record<string, unknown>): Promise<void> {
      this.calls.push({ toolName, toolInput })
      if (String(toolInput['command'] ?? '').includes('rm -rf')) {
        throw new IntuticGateRefusal('recursive delete', 'SNAPSHOT')
      }
    }
  }

  interface FakeBridgeLog {
    startOptions: HarnessV1StartOptions[]
    submittedApprovals: Array<{ approvalId: string; approved: boolean; reason?: string }>
    executedCommands: string[]
  }

  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  }

  /** Mirrors the claude-code bridge's `canUseTool` path for a bash-kind
   *  native tool under a non-'allow-all' mode: emit the providerExecuted
   *  tool-call + tool-approval-request, then wait for the host's decision;
   *  the native tool runs only on `approved: true`. */
  function fakeClaudeCodeLikeAdapter(command: string, log: FakeBridgeLog): HarnessAgentAdapter {
    const approvalId = 'toolu_bash_1'
    let resolveDecision!: (d: { approvalId: string; approved: boolean; reason?: string }) => void
    const decision = new Promise<{ approvalId: string; approved: boolean; reason?: string }>((r) => {
      resolveDecision = r
    })
    const control = (emit: (p: HarnessV1StreamPart) => void, done: Promise<void>): HarnessV1PromptControl => ({
      submitToolResult: async () => {
        throw new Error('no host tool in this test')
      },
      submitToolApproval: async (input) => {
        log.submittedApprovals.push(input)
        resolveDecision(input)
      },
      done,
    })
    return {
      specificationVersion: 'harness-v1',
      harnessId: 'fake-claude-code',
      builtinTools: { bash: HARNESS_V1_BUILTIN_TOOLS.bash },
      supportsBuiltinToolApprovals: true,
      doStart: async (options: HarnessV1StartOptions) => {
        log.startOptions.push(options)
        return {
          sessionId: options.sessionId,
          isResume: false,
          doPromptTurn: async ({ emit }) => {
            emit({ type: 'stream-start' })
            emit({
              type: 'tool-call',
              toolCallId: approvalId,
              toolName: 'bash',
              nativeName: 'Bash',
              input: JSON.stringify({ command }),
              providerExecuted: true,
            })
            emit({ type: 'tool-approval-request', approvalId, toolCallId: approvalId })
            // The bridge's finishApprovalStep: the host side of this turn ends
            // here; the native call stays blocked on requestToolApproval.
            return control(emit, Promise.resolve())
          },
          doContinueTurn: async ({ emit }) => {
            const done = (async () => {
              const d = await decision
              emit({ type: 'stream-start' })
              if (d.approved) {
                log.executedCommands.push(command)
                emit({ type: 'tool-result', toolCallId: approvalId, toolName: 'bash', result: { stdout: 'ok' } })
              }
              // Closes the step that paused (the framework discards this
              // first finish-step after a resumed approval).
              emit({ type: 'finish-step', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage })
              // The model's follow-up step.
              emit({ type: 'text-start', id: 't1' })
              emit({
                type: 'text-delta',
                id: 't1',
                delta: d.approved ? 'Listed the build dir.' : `Bash was denied: ${d.reason ?? ''}`,
              })
              emit({ type: 'text-end', id: 't1' })
              emit({ type: 'finish-step', finishReason: { unified: 'stop', raw: 'end_turn' }, usage })
              emit({ type: 'finish', finishReason: { unified: 'stop', raw: 'end_turn' }, totalUsage: usage })
            })()
            return control(emit, done)
          },
          doCompact: async () => {},
          doSuspendTurn: async () => {
            throw new Error('not exercised')
          },
          doDetach: async () => {
            throw new Error('not exercised')
          },
          doStop: async () => {
            throw new Error('not exercised')
          },
          doDestroy: async () => {},
        }
      },
    }
  }

  function fakeSandboxProvider(): HarnessV1SandboxProvider {
    const session = {
      id: 'fake-sandbox',
      defaultWorkingDirectory: '/sandbox',
      ports: [],
      getPortEndpoint: async () => ({ url: 'ws://unused' }),
      getPortUrl: async () => 'ws://unused',
      run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      stop: async () => {},
      restricted: () => session,
    }
    return {
      specificationVersion: 'harness-sandbox-v1',
      providerId: 'fake-sandbox-provider',
      createSession: async () => session,
    } as unknown as HarnessV1SandboxProvider
  }

  async function runPausedThenAnswered(command: string) {
    const log: FakeBridgeLog = { startOptions: [], submittedApprovals: [], executedCommands: [] }
    const gate = new CommandGate({ enforce: true })
    // The per-call alternative to the default: keep bash ACTIVE (filterBash:
    // false) under 'allow-edits', so every bash call pauses for the gate.
    const { permissionMode } = recommendedHarnessSettings({ filterBash: false })
    const agent = new HarnessAgent({
      harness: fakeClaudeCodeLikeAdapter(command, log),
      sandbox: fakeSandboxProvider(),
      permissionMode,
    })
    const session = await agent.createSession()

    const first = await agent.generate({ session, prompt: 'clean up the build dir' })
    const pending = first.content.flatMap((part) =>
      part.type === 'tool-approval-request'
        ? [
            {
              approvalId: part.approvalId,
              toolCallId: part.toolCall.toolCallId,
              toolName: part.toolCall.toolName,
              input: part.toolCall.input,
              providerExecuted: part.toolCall.providerExecuted,
            } satisfies HarnessApprovalRequest,
          ]
        : [],
    )

    // Nothing was submitted and nothing ran while the turn sat paused.
    const pausedState = {
      finishReason: first.finishReason,
      pending,
      submittedBeforeContinue: [...log.submittedApprovals],
      executedBeforeContinue: [...log.executedCommands],
    }

    const toolApprovalContinuations = await intuticApprovalResponder({ gate })(pending)
    const second = await agent.continueGenerate({ session, toolApprovalContinuations })
    await session.destroy()
    return { log, gate, pausedState, second }
  }

  it("the framework forwards permissionMode 'allow-edits' to the adapter and pauses the turn on the builtin approval request", async () => {
    const { log, pausedState } = await runPausedThenAnswered('ls -la')
    expect(log.startOptions[0]!.permissionMode).toBe('allow-edits')
    expect(log.startOptions[0]!.builtinToolFiltering).toBeUndefined() // bash stays active
    expect(pausedState.finishReason).toBe('tool-calls')
    expect(pausedState.pending).toEqual([
      { approvalId: 'toolu_bash_1', toolCallId: 'toolu_bash_1', toolName: 'bash', input: { command: 'ls -la' }, providerExecuted: true },
    ])
    expect(pausedState.submittedBeforeContinue).toEqual([])
    expect(pausedState.executedBeforeContinue).toEqual([])
  })

  it('DENIES a destructive bash call: the decision reaches the adapter via submitToolApproval and bash never runs', async () => {
    const { log, gate, second } = await runPausedThenAnswered('rm -rf /')
    expect(gate.calls).toEqual([{ toolName: 'bash', toolInput: { command: 'rm -rf /' } }])
    expect(log.submittedApprovals).toEqual([
      { approvalId: 'toolu_bash_1', approved: false, reason: '[Intutic Governance] BLOCKED: recursive delete' },
    ])
    expect(log.executedCommands).toEqual([])
    expect(second.text).toContain('[Intutic Governance] BLOCKED: recursive delete')
    expect(second.finishReason).toBe('stop')
  })

  it('APPROVES a benign bash call: the continuation resumes the turn and the native tool runs', async () => {
    const { log, gate, second } = await runPausedThenAnswered('ls -la')
    expect(gate.calls).toEqual([{ toolName: 'bash', toolInput: { command: 'ls -la' } }])
    expect(log.submittedApprovals).toEqual([{ approvalId: 'toolu_bash_1', approved: true }])
    expect(log.executedCommands).toEqual(['ls -la'])
    expect(second.text).toBe('Listed the build dir.')
    expect(second.finishReason).toBe('stop')
  })
})

// ------------------------------------------------------------------------
// intuticSandboxBootstrap — TD-417 Half A
// ------------------------------------------------------------------------

describe('intuticSandboxBootstrap', () => {
  it('bootstrapHash is a deterministic sha256 hex digest, and changes with the recipe', () => {
    const a = intuticSandboxBootstrap({ policySnapshotRules: 'x', workspaceId: 'ws_1' })
    const b = intuticSandboxBootstrap({ policySnapshotRules: 'x', workspaceId: 'ws_1' })
    const c = intuticSandboxBootstrap({ policySnapshotRules: 'y', workspaceId: 'ws_1' })
    const d = intuticSandboxBootstrap({ policySnapshotRules: 'x', workspaceId: 'ws_2' })
    expect(a.bootstrapHash).toBe(b.bootstrapHash) // same recipe, same hash
    expect(a.bootstrapHash).toMatch(/^[0-9a-f]{64}$/) // sha256 hex, same convention as snapshot.ts
    expect(a.bootstrapHash).not.toBe(c.bootstrapHash) // rules changed
    expect(a.bootstrapHash).not.toBe(d.bootstrapHash) // workspace changed
  })

  /** Fake sandbox session: records writes, answers `printf "$HOME"`, and
   *  serves `existing` files to readTextFile (null = absent, like the real one). */
  function fakeSession(existing: Record<string, string> = {}, home = '/home/sandbox') {
    const written: Array<{ path: string; content: string }> = []
    return {
      written,
      writeTextFile: async (opts: { path: string; content: string }) => {
        written.push(opts)
      },
      readTextFile: async ({ path }: { path: string }) => existing[path] ?? null,
      run: async ({ command }: { command: string }) =>
        command.includes('$HOME') ? { exitCode: 0, stdout: home, stderr: '' } : { exitCode: 0, stdout: '', stderr: '' },
    }
  }

  it('onBootstrap writes the rules file, the hook script, and .claude/settings.json under workDir', async () => {
    const session = fakeSession()
    const written = session.written
    const bootstrap = intuticSandboxBootstrap({
      policySnapshotRules: 'destructive.rm_rf_root\tblock\t-\tcommand\tRecursive delete\t rm( +-[a-zA-Z-]+)+ +/( |\\*)\n',
    })
    await bootstrap.onBootstrap({ session, workDir: '/vercel/sandbox/claude-code-abc' })

    const byPath = Object.fromEntries(written.map((w) => [w.path, w.content]))
    expect(Object.keys(byPath).sort()).toEqual(
      [
        '/home/sandbox/.claude/settings.json',
        '/vercel/sandbox/claude-code-abc/.claude/settings.json',
        '/vercel/sandbox/claude-code-abc/.intutic/hooks/claude-code-check.js',
        '/vercel/sandbox/claude-code-abc/.intutic/hooks/policy-snapshot.rules',
      ].sort(),
    )
    // The user-level registration is identical to the project-level one.
    expect(JSON.parse(byPath['/home/sandbox/.claude/settings.json']!)).toEqual(
      JSON.parse(byPath['/vercel/sandbox/claude-code-abc/.claude/settings.json']!),
    )
    expect(byPath['/vercel/sandbox/claude-code-abc/.intutic/hooks/policy-snapshot.rules']).toContain(
      'destructive.rm_rf_root',
    )
    const settings = JSON.parse(byPath['/vercel/sandbox/claude-code-abc/.claude/settings.json']!)
    expect(settings.hooks.PreToolUse.map((h: { matcher: string }) => h.matcher)).toEqual([
      'Bash',
      'Edit',
      'Write',
      'MultiEdit',
      'mcp__.*',
    ])
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe(
      'node /vercel/sandbox/claude-code-abc/.intutic/hooks/claude-code-check.js',
    )
  })

  it('respects a custom bootstrapDir', async () => {
    const session = fakeSession()
    await intuticSandboxBootstrap({ bootstrapDir: '.custom-dir' }).onBootstrap({ session, workDir: '/w' })
    expect(session.written.map((w) => w.path)).toContain('/w/.custom-dir/claude-code-check.js')
  })

  it('merges into an existing user settings file instead of overwriting it', async () => {
    const existing = JSON.stringify({ model: 'keep-me', hooks: { PreToolUse: [{ matcher: 'Read', hooks: [] }], Stop: [] } })
    const session = fakeSession({ '/home/sandbox/.claude/settings.json': existing })
    await intuticSandboxBootstrap().onBootstrap({ session, workDir: '/w' })
    const user = JSON.parse(session.written.find((w) => w.path === '/home/sandbox/.claude/settings.json')!.content)
    expect(user.model).toBe('keep-me')
    expect(user.hooks.Stop).toEqual([])
    expect(user.hooks.PreToolUse.map((h: { matcher: string }) => h.matcher)).toEqual([
      'Read',
      'Bash',
      'Edit',
      'Write',
      'MultiEdit',
      'mcp__.*',
    ])
  })

  it('re-running onBootstrap replaces its own user-level entries instead of duplicating them', async () => {
    // @ai-sdk/harness 1.0.138 re-runs onBootstrap on any session without the
    // marker, and a changed bootstrapHash re-runs it on a sandbox that
    // already has our entries.
    const first = fakeSession({
      '/home/sandbox/.claude/settings.json': JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Read', hooks: [] }] } }),
    })
    await intuticSandboxBootstrap().onBootstrap({ session: first, workDir: '/w' })
    const afterFirst = first.written.find((w) => w.path === '/home/sandbox/.claude/settings.json')!.content
    const second = fakeSession({ '/home/sandbox/.claude/settings.json': afterFirst })
    await intuticSandboxBootstrap({ policySnapshotRules: 'changed' }).onBootstrap({ session: second, workDir: '/w' })
    const user = JSON.parse(second.written.find((w) => w.path === '/home/sandbox/.claude/settings.json')!.content)
    expect(user.hooks.PreToolUse.map((h: { matcher: string }) => h.matcher)).toEqual([
      'Read',
      'Bash',
      'Edit',
      'Write',
      'MultiEdit',
      'mcp__.*',
    ])
  })

  it('fails the bootstrap loudly when HOME cannot be resolved or user settings are unparseable', async () => {
    await expect(intuticSandboxBootstrap().onBootstrap({ session: fakeSession({}, ''), workDir: '/w' })).rejects.toThrow(
      /cannot resolve the sandbox HOME/,
    )
    const corrupt = fakeSession({ '/home/sandbox/.claude/settings.json': '{not json' })
    await expect(intuticSandboxBootstrap().onBootstrap({ session: corrupt, workDir: '/w' })).rejects.toThrow(/not valid JSON/)
  })

  describe('driven through the REAL @ai-sdk/harness/agent orchestration', () => {
    it('prepareHarnessSandboxTemplate validates and invokes our onBootstrap with the resolved workDir', async () => {
      const written: Array<{ path: string; content: string }> = []
      const runCalls: string[] = []
      const fakeSandboxSession = {
        run: async ({ command }: { command: string }) => {
          runCalls.push(command)
          if (command === 'pwd') return { exitCode: 0, stdout: '/vercel/sandbox', stderr: '' }
          if (command.includes('$HOME')) return { exitCode: 0, stdout: '/home/vercel-sandbox', stderr: '' }
          return { exitCode: 0, stdout: '', stderr: '' } // mkdir -p
        },
        readTextFile: async () => null,
        writeTextFile: async (opts: { path: string; content: string }) => {
          written.push(opts)
        },
      }

      const fakeProvider = {
        specificationVersion: 'harness-sandbox-v1',
        providerId: 'fake-test-provider',
        createSession: async (options?: {
          onFirstCreate?: (session: unknown, opts: { abortSignal?: AbortSignal }) => Promise<void>
        }) => {
          await options?.onFirstCreate?.(fakeSandboxSession, {})
          // prepareHarnessSandboxTemplate always stops the temporary session
          // it created (finally block in the real source) once bootstrap
          // completes — the real HarnessV1NetworkSandboxSession contract.
          return { id: 'fake-session', stop: async () => {} }
        },
      } as unknown as HarnessV1SandboxProvider

      const fakeHarness = {
        specificationVersion: 'harness-v1',
        harnessId: 'fake-claude-code',
        builtinTools: {},
        doStart: async () => {
          throw new Error('not exercised by this test')
        },
      } as unknown as HarnessAgentAdapter

      const bootstrap = intuticSandboxBootstrap({ policySnapshotRules: 'r' })

      // Real framework function: validates bootstrapHash/onBootstrap pairing
      // (throws if only one is set — HarnessAgent's own
      // validateSandboxBootstrapSettings), computes the recipe identity, and
      // drives our onBootstrap through its real runSandboxBootstrap
      // (resolve pwd, mkdir -p, then call onBootstrap) — not a re-derivation
      // of that machinery.
      await prepareHarnessSandboxTemplate({
        harness: fakeHarness,
        sandboxProvider: fakeProvider,
        sandboxConfig: bootstrap,
      })

      expect(runCalls).toContain('pwd')
      // @ai-sdk/harness 1.0.138 (not 1.0.75) itself writes an empty
      // `~/.ai-sdk-harness/.on-bootstrap/<sha256(bootstrapHash)>.ok` marker
      // after onBootstrap succeeds (so a resumed sandbox can skip a re-run).
      // It is the framework's file, not ours — written last, and only because
      // our onBootstrap returned without throwing.
      const marker = written.at(-1)!
      expect(marker.path).toMatch(/^\/home\/vercel-sandbox\/\.ai-sdk-harness\/\.on-bootstrap\/[0-9a-f]{64}\.ok$/)
      expect(marker.content).toBe('')
      const paths = written
        .slice(0, -1)
        .map((w) => w.path)
        .sort()
      expect(paths).toEqual(
        [
          '/home/vercel-sandbox/.claude/settings.json',
          '/vercel/sandbox/.claude/settings.json',
          '/vercel/sandbox/.intutic/hooks/claude-code-check.js',
          '/vercel/sandbox/.intutic/hooks/policy-snapshot.rules',
        ].sort(),
      )
    })

    it('validateSandboxBootstrapSettings (the real one) rejects onBootstrap without bootstrapHash', async () => {
      const fakeProvider = {
        specificationVersion: 'harness-sandbox-v1',
        providerId: 'fake-test-provider',
        createSession: async () => ({ id: 'unused' }),
      } as unknown as HarnessV1SandboxProvider
      const fakeHarness = {
        specificationVersion: 'harness-v1',
        harnessId: 'fake',
        builtinTools: {},
        doStart: async () => {
          throw new Error('unused')
        },
      } as unknown as HarnessAgentAdapter

      await expect(
        prepareHarnessSandboxTemplate({
          harness: fakeHarness,
          sandboxProvider: fakeProvider,
          // onBootstrap without bootstrapHash — malformed, same as passing
          // only half of intuticSandboxBootstrap()'s return value.
          sandboxConfig: { onBootstrap: async () => {} } as unknown as HarnessAgentSandboxConfig,
        }),
      ).rejects.toThrow(/must be provided together/)
    })
  })
})

// ------------------------------------------------------------------------
// Generated sandbox gate-script fidelity: the standalone Node script
// intuticSandboxBootstrap() writes into the sandbox must reach the SAME
// block/allow verdict as this package's own `snapshot.evaluate()` for the
// same rule — proven by actually spawning the generated script, not just
// reading it. Mirrors fidelity.test.ts's method (isolated one-rule .rules
// files against the real protectedPaths.ts fixture table), extended to run
// the script as a child process instead of calling evaluate() directly.
// ------------------------------------------------------------------------

describe('intuticSandboxBootstrap: generated hook script matches snapshot.evaluate()', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'intutic-sandbox-gate-fidelity-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function rulesLine(p: FixturePattern): string {
    return [p.id, p.severity, (p.ignoreCase ? 'i' : '') + (p.sequence ? 's' : '') || '-', p.subject ?? 'any', p.reason, p.source].join('\t')
  }

  /** Builds the stdin JSON envelope Claude Code's real PreToolUse hook sends,
   *  placing `fixture` on whichever field the pattern's subject reads —
   *  mirrors fidelity.test.ts's `evaluateAgainst`. */
  function ctxFor(p: FixturePattern, fixture: string): unknown {
    const subject = p.subject ?? 'any'
    const toolName = subject === 'tool' ? fixture : 'shell'
    const path = subject === 'target' ? fixture : ''
    const command = subject === 'command' || subject === 'any' ? fixture : ''
    return { tool_name: toolName, tool_input: { command, path } }
  }

  function runGeneratedScript(p: FixturePattern, fixture: string): number | null {
    writeFileSync(join(dir, 'policy-snapshot.rules'), rulesText([rulesLine(p)]), 'utf-8')
    const scriptPath = join(dir, 'claude-code-check.js')
    writeFileSync(scriptPath, _internal.renderSandboxGateScript('policy-snapshot.rules'), 'utf-8')
    const result = spawnSync(process.execPath, [scriptPath], {
      input: JSON.stringify(ctxFor(p, fixture)),
      encoding: 'utf-8',
    })
    return result.status
  }

  function severityConst(s: 'block' | 'warn' | 'shadow'): string {
    return s === 'block' ? SEV_BLOCK : s === 'warn' ? SEV_WARN : SEV_SHADOW
  }

  // Every third fixture (covering every id/subject/severity family present)
  // to keep the child-process spawn count reasonable while still exercising
  // real fixtures from every pattern table.
  const fixtures = allFloorFixtures().filter((_, i) => i % 3 === 0)

  it('sampled a non-trivial number of pattern families', () => {
    expect(fixtures.length).toBeGreaterThan(5)
  })

  describe.each(fixtures.map((p) => [p.id, p] as const))('%s', (_id, p) => {
    it('exits 2 (block) or 0 (warn/shadow), agreeing with snapshot.evaluate(), on every `matches` fixture', () => {
      const snap = loadSnapshot('', writeIsolatedRules(dir, p))
      for (const fixture of p.matches) {
        const subject = p.subject ?? 'any'
        const toolName = subject === 'tool' ? fixture : 'shell'
        const target = subject === 'target' ? fixture : ''
        const command = subject === 'command' || subject === 'any' ? fixture : ''
        const decision = evaluate(toolName, target, command, snap)
        expect(decision.severity, `expected ${p.id} to match ${JSON.stringify(fixture)}`).toBe(severityConst(p.severity))

        const exitCode = runGeneratedScript(p, fixture)
        const expectedExit = decision.severity === SEV_BLOCK ? 2 : 0
        expect(exitCode, `generated script exit code for ${p.id} / ${JSON.stringify(fixture)}`).toBe(expectedExit)
      }
    })

    it('exits 0 on every `notMatches` fixture, agreeing with snapshot.evaluate()', () => {
      for (const fixture of p.notMatches) {
        const exitCode = runGeneratedScript(p, fixture)
        expect(exitCode, `generated script exit code for ${p.id} / ${JSON.stringify(fixture)} (notMatches)`).toBe(0)
      }
    })
  })
})

describe('intuticSandboxBootstrap: generated hook script and hold rules', () => {
  // The sandbox has no route to the control plane, so a hold cannot be
  // recorded or approved there. It used to fall through to an exit 0, letting
  // the call a workspace asked to review run unreviewed.
  it('refuses a call a hold rule matches, and lets others through', () => {
    const dir = mkdtempSync(join(tmpdir(), 'intutic-sandbox-gate-hold-'))
    try {
      writeFileSync(
        join(dir, 'policy-snapshot.rules'),
        rulesText([['sop.local.review_before.Deploy', 'hold', 'i', 'tool', 'Held for human review: Deploy', ' (Deploy) '].join('\t')]),
        'utf-8',
      )
      const scriptPath = join(dir, 'claude-code-check.js')
      writeFileSync(scriptPath, _internal.renderSandboxGateScript('policy-snapshot.rules'), 'utf-8')
      const run = (toolName: string) =>
        spawnSync(process.execPath, [scriptPath], {
          input: JSON.stringify({ tool_name: toolName, tool_input: {} }),
          encoding: 'utf-8',
        })
      const held = run('Deploy')
      expect(held.status).toBe(2)
      expect(held.stderr).toContain('HELD for approval: Held for human review: Deploy [sop.local.review_before.Deploy]')
      expect(run('Read').status).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

function writeIsolatedRules(dir: string, p: FixturePattern): string {
  const line = [p.id, p.severity, (p.ignoreCase ? 'i' : '') + (p.sequence ? 's' : '') || '-', p.subject ?? 'any', p.reason, p.source].join('\t')
  const file = join(dir, `isolated-${p.id.replace(/[^a-zA-Z0-9]/g, '_')}.rules`)
  writeFileSync(file, rulesText([line]), 'utf-8')
  return file
}

// keep the type-check function reachable so it is not tree-shaken/flagged unused
void _typeCheckOnly
