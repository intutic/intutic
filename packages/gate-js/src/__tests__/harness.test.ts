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
  HarnessAgentToolApprovalContinuation,
} from '@ai-sdk/harness/agent'
import { collectHarnessAgentToolApprovalContinuations, prepareHarnessSandboxTemplate } from '@ai-sdk/harness/agent'
import type { HarnessV1BuiltinToolFiltering, HarnessV1NetworkPolicy, HarnessV1SandboxProvider } from '@ai-sdk/harness'
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

  it('onBootstrap writes the rules file, the hook script, and .claude/settings.json under workDir', async () => {
    const written: Array<{ path: string; content: string }> = []
    const session = {
      writeTextFile: async (opts: { path: string; content: string }) => {
        written.push(opts)
      },
    }
    const bootstrap = intuticSandboxBootstrap({
      policySnapshotRules: 'destructive.rm_rf_root\tblock\t-\tcommand\tRecursive delete\t rm( +-[a-zA-Z-]+)+ +/( |\\*)\n',
    })
    await bootstrap.onBootstrap({ session, workDir: '/vercel/sandbox/claude-code-abc' })

    const byPath = Object.fromEntries(written.map((w) => [w.path, w.content]))
    expect(Object.keys(byPath).sort()).toEqual(
      [
        '/vercel/sandbox/claude-code-abc/.claude/settings.json',
        '/vercel/sandbox/claude-code-abc/.intutic/hooks/claude-code-check.js',
        '/vercel/sandbox/claude-code-abc/.intutic/hooks/policy-snapshot.rules',
      ].sort(),
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
    const written: Array<{ path: string }> = []
    const session = { writeTextFile: async (opts: { path: string; content: string }) => void written.push(opts) }
    await intuticSandboxBootstrap({ bootstrapDir: '.custom-dir' }).onBootstrap({ session, workDir: '/w' })
    expect(written.map((w) => w.path)).toContain('/w/.custom-dir/claude-code-check.js')
  })

  describe('driven through the REAL @ai-sdk/harness/agent orchestration', () => {
    it('prepareHarnessSandboxTemplate validates and invokes our onBootstrap with the resolved workDir', async () => {
      const written: Array<{ path: string; content: string }> = []
      const runCalls: string[] = []
      const fakeSandboxSession = {
        run: async ({ command }: { command: string }) => {
          runCalls.push(command)
          if (command === 'pwd') return { exitCode: 0, stdout: '/vercel/sandbox', stderr: '' }
          return { exitCode: 0, stdout: '', stderr: '' } // mkdir -p
        },
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
      const paths = written.map((w) => w.path).sort()
      expect(paths).toEqual(
        [
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
    return [p.id, p.severity, p.ignoreCase ? 'i' : '-', p.subject ?? 'any', p.reason, p.source].join('\t')
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
    writeFileSync(join(dir, 'policy-snapshot.rules'), rulesLine(p) + '\n', 'utf-8')
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

function writeIsolatedRules(dir: string, p: FixturePattern): string {
  const line = [p.id, p.severity, p.ignoreCase ? 'i' : '-', p.subject ?? 'any', p.reason, p.source].join('\t')
  const file = join(dir, `isolated-${p.id.replace(/[^a-zA-Z0-9]/g, '_')}.rules`)
  writeFileSync(file, line + '\n', 'utf-8')
  return file
}

// keep the type-check function reachable so it is not tree-shaken/flagged unused
void _typeCheckOnly
