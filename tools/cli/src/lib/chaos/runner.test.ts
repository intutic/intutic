import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { decodeChaosPlan, type ChaosPlan, type Experiment } from '@intutic/shared-types'
import { ChaosRefusal, runChaos, SANDBOX_EVENTS_PATH, type ChaosDeps, type ChaosReport } from './runner.js'
import { sandboxSpec, sandboxProxyEnv } from '../../commands/exec.js'
import { buildOciArgs } from '../sandbox/oci.js'

const experiment: Experiment = {
  name: 'demo',
  agent: 'my-agent --go',
  verify: 'npm test',
  repeat: 2,
  faults: [{ id: 'tool.error', message: 'tool failed', after_calls: 0 }],
  probes: [
    { id: 'task_success', weight: 2 },
    { id: 'failure_surfaced', weight: 1 },
  ],
  abort: ['destructive_attempt', { cost_usd_above: 5 }],
}

interface SandboxCall {
  command: string[]
  workdir: string
  env: Record<string, string>
  name: string
  plan: ChaosPlan
}

/** What the fake sandbox does for one agent run: events to write, stdout, exit code. */
type AgentScript = (call: SandboxCall, hostEvents: string, signal?: AbortSignal) => Promise<{ code: number; stdout?: string }>

let tmp: string

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'chaos-runner-test-'))
  // The project as `intutic connect` leaves it: a gate naming its own host
  // path, the Claude Code settings that register it, and a snapshot.
  await fs.mkdir(path.join(tmp, '.intutic', 'hooks'), { recursive: true })
  await fs.writeFile(path.join(tmp, '.intutic', 'hooks', 'claude-code-check.js'), `const LOG = '${tmp}/.intutic/events/hook-events.jsonl'\n`)
  await fs.mkdir(path.join(tmp, '.claude'), { recursive: true })
  await fs.writeFile(path.join(tmp, '.claude', 'settings.json'), JSON.stringify(claudeSettings(tmp), null, 2))
  await fs.mkdir(path.join(tmp, 'home'), { recursive: true })
  await fs.writeFile(path.join(tmp, 'home', 'policy-snapshot.rules'), '#digest x\n')
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

function claudeSettings(root: string) {
  return {
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node ${root}/.intutic/hooks/claude-code-check.js` }] }] },
  }
}

function line(obj: Record<string, unknown>): string {
  return JSON.stringify({ ts: '2026-10-10T00:00:00Z', ...obj }) + '\n'
}

/** Deps with every side effect faked and recorded. */
function fakeDeps(opts: {
  agent?: AgentScript
  verifyCode?: (call: SandboxCall) => number
  status?: string
  healthy?: boolean
  proxyExitsWith?: string
} = {}) {
  const calls = {
    sandbox: [] as SandboxCall[],
    proxyStarts: [] as Array<{ port: number; env: Record<string, string> }>,
    proxyStops: 0,
    worktreeAdds: [] as string[],
    worktreeRemoves: [] as string[],
    readied: 0,
    order: [] as string[],
  }
  let port = 41000
  let hex = 0
  const deps: ChaosDeps = {
    async readySandbox() {
      calls.readied++
      return { name: 'docker' }
    },
    async runInSandbox(args) {
      const plan = decodeChaosPlan(args.env.INTUTIC_CHAOS_PLAN) as ChaosPlan
      const call = { command: args.command, workdir: args.workdir, env: args.env, name: args.name, plan }
      calls.sandbox.push(call)
      const isAgent = args.name.endsWith('-agent')
      calls.order.push(`${isAgent ? 'agent' : 'verify'}:${plan.repetition}:${plan.faults.length ? 'faulted' : 'baseline'}`)
      if (!isAgent) return opts.verifyCode?.(call) ?? 0
      const hostEvents = path.join(args.workdir, '.intutic-chaos', 'events.jsonl')
      const { code, stdout } = await (opts.agent ?? defaultAgent)(call, hostEvents, args.signal)
      if (stdout) args.onStdout(Buffer.from(stdout))
      return code
    },
    sandboxEnv: (p) => ({ ANTHROPIC_BASE_URL: `http://host.docker.internal:${p}`, INTUTIC_SANDBOX_PROXY_HOST: 'host.docker.internal' }),
    startProxy({ port: p, env }) {
      calls.proxyStarts.push({ port: p, env })
      return {
        exited: opts.proxyExitsWith ? Promise.resolve(opts.proxyExitsWith) : new Promise<string>(() => {}),
        async stop() {
          calls.proxyStops++
        },
      }
    },
    proxyHealthy: async () => opts.healthy ?? true,
    freePort: async () => port++,
    git: {
      status: async () => opts.status ?? '',
      async worktreeAdd(_cwd, dir) {
        calls.worktreeAdds.push(dir)
        await fs.mkdir(dir, { recursive: true })
      },
      async worktreeRemove(_cwd, dir) {
        calls.worktreeRemoves.push(dir)
        await fs.rm(dir, { recursive: true, force: true })
      },
    },
    makeTempDir: () => fs.mkdtemp(path.join(tmp, 'rep-')),
    randomHex: (bytes) => (hex++).toString(16).padStart(bytes * 2, '0'),
    echo: () => {},
    log: { info: () => {}, warn: () => {}, dim: () => {} },
  }
  return { deps, calls }
}

/** An agent whose injectors all report in and which surfaces the failure. */
const defaultAgent: AgentScript = async (call, hostEvents) => {
  const runId = call.plan.runId
  let text = line({ runId, component: 'gate', type: 'plan_loaded', faults: call.plan.faults.length })
  text += line({ runId, component: 'proxy', type: 'llm_usage', model: 'm', inputTokens: 1, outputTokens: 1, costUsd: 0.1 })
  if (call.plan.faults.length) text += line({ runId, component: 'gate', type: 'fault_injected', faultId: 'tool.error', call: 1, target: 'Bash' })
  text += 'not json\n'
  await fs.appendFile(hostEvents, text)
  return { code: 0, stdout: call.plan.faults.length ? `Bash failed: tool failed [${call.plan.canary}]\n` : 'done\n' }
}

function run(deps: ChaosDeps, over: Partial<Parameters<typeof runChaos>[0]> = {}): Promise<ChaosReport> {
  return runChaos(
    {
      experiment,
      cwd: tmp,
      image: 'img',
      outPath: path.join(tmp, 'out', 'report.json'),
      keep: false,
      pollMs: 10,
      healthTimeoutMs: 300,
      snapshotRules: path.join(tmp, 'home', 'policy-snapshot.rules'),
      ...over,
    },
    deps,
  )
}

describe('runChaos', () => {
  it('runs the baseline repetitions first, then the faulted ones, agent then verify', async () => {
    const { deps, calls } = fakeDeps()
    const report = await run(deps)
    expect(calls.order).toEqual([
      'agent:0:baseline', 'verify:0:baseline',
      'agent:1:baseline', 'verify:1:baseline',
      'agent:2:faulted', 'verify:2:faulted',
      'agent:3:faulted', 'verify:3:faulted',
    ])
    expect(report.verdict).toEqual({ kind: 'scored', score: 100, probes: report.probes })
    expect(report.repetitions.map((r) => r.baseline)).toEqual([true, true, false, false])
    // Each repetition gets its own run id and canary.
    expect(new Set(report.repetitions.map((r) => r.runId)).size).toBe(4)
    expect(new Set(report.repetitions.map((r) => r.canary)).size).toBe(4)
    expect(report.repetitions[0].canary).toMatch(/^E-INTUTIC-[0-9A-F]{8}$/)
  })

  it('starts a dedicated proxy per repetition with the plan and the host events path, and stops it', async () => {
    const { deps, calls } = fakeDeps()
    await run(deps)
    expect(calls.proxyStarts.map((p) => p.port)).toEqual([41000, 41001, 41002, 41003])
    expect(calls.proxyStops).toBe(4)
    for (const [i, start] of calls.proxyStarts.entries()) {
      expect(start.env.PORT).toBe(String(start.port))
      expect(start.env.INTUTIC_CHAOS_EVENTS).toBe(path.join(calls.worktreeAdds[i], '.intutic-chaos', 'events.jsonl'))
      expect(decodeChaosPlan(start.env.INTUTIC_CHAOS_PLAN)?.repetition).toBe(i)
    }
  })

  it('hands the sandbox the plan, the in-sandbox events path and that repetition\'s proxy', async () => {
    const { deps, calls } = fakeDeps()
    await run(deps)
    for (const call of calls.sandbox) {
      const rep = call.plan.repetition
      expect(call.command[0]).toBe('sh')
      expect(call.command[1]).toBe('-c')
      expect(call.workdir).toBe(calls.worktreeAdds[rep])
      expect(call.env.INTUTIC_CHAOS_EVENTS).toBe(SANDBOX_EVENTS_PATH)
      expect(call.env.INTUTIC_PROXY_URL).toBe(`http://host.docker.internal:${41000 + rep}`)
      expect(call.env.INTUTIC_CHAOS_PLAN).toBe(calls.proxyStarts[rep].env.INTUTIC_CHAOS_PLAN)
    }
  })

  it('passes the chaos env into the container by name only', () => {
    const env = {
      ...sandboxProxyEnv(null, { graphId: 'g', nodeId: 'n', parentId: '', depth: 0 }, '41000', []).env,
      INTUTIC_CHAOS_PLAN: 'eyJzZWNyZXQiOnRydWV9',
      INTUTIC_CHAOS_EVENTS: SANDBOX_EVENTS_PATH,
    }
    const spec = sandboxSpec(['sh', '-c', 'agent'], '/w', env, { kind: 'oci', image: 'img', memory: '2g', cpus: '2', pidsLimit: 512, allow: [] }, { tty: false, name: 'c1' })
    const argv = buildOciArgs('docker', spec)
    expect(argv).toEqual(expect.arrayContaining(['--env', 'INTUTIC_CHAOS_PLAN', 'INTUTIC_CHAOS_EVENTS', '--name', 'c1']))
    expect(argv.join(' ')).not.toContain('eyJzZWNyZXQiOnRydWV9')
    expect(argv.join(' ')).not.toContain(SANDBOX_EVENTS_PATH)
  })

  it('removes each worktree and keeps the events and agent output next to the report', async () => {
    const { deps, calls } = fakeDeps()
    const report = await run(deps)
    expect(calls.worktreeRemoves).toEqual(calls.worktreeAdds)
    const rep = report.repetitions[2]
    expect(rep.workspace).toBeUndefined()
    expect(await fs.readFile(rep.agentOutPath, 'utf-8')).toContain(rep.canary)
    expect(await fs.readFile(rep.eventsPath, 'utf-8')).toContain('fault_injected')
    const written = JSON.parse(await fs.readFile(path.join(tmp, 'out', 'report.json'), 'utf-8')) as ChaosReport
    expect(written.verdict.kind).toBe('scored')
    expect(written.malformedEvents).toBe(4)
    expect(written.warnings).toContain('4 malformed event lines ignored')
  })

  // The sandbox user is another uid on a Linux host: whatever it creates in
  // the events directory must stay removable by the runner.
  it('makes the events file and the gates\' counter directory writable for the sandbox user', async () => {
    const modes: number[] = []
    const { deps } = fakeDeps({
      agent: async (_call, hostEvents) => {
        modes.push((await fs.stat(hostEvents)).mode & 0o777, (await fs.stat(`${hostEvents}.gate-counters`)).mode & 0o777)
        return { code: 0 }
      },
    })
    await run(deps, { experiment: { ...experiment, repeat: 1 } })
    expect(modes).toEqual([0o666, 0o777, 0o666, 0o777])
  })

  it('keeps the worktrees with --keep', async () => {
    const { deps, calls } = fakeDeps()
    const report = await run(deps, { keep: true })
    expect(calls.worktreeRemoves).toEqual([])
    expect(report.repetitions.map((r) => r.workspace)).toEqual(calls.worktreeAdds)
  })

  it('refuses a dirty working tree before touching the sandbox', async () => {
    const { deps, calls } = fakeDeps({ status: ' M src/a.ts\n' })
    await expect(run(deps)).rejects.toBeInstanceOf(ChaosRefusal)
    expect(calls.readied).toBe(0)
    expect(calls.worktreeAdds).toEqual([])
  })

  it('refuses when the sandbox is unavailable, before any repetition', async () => {
    const { deps, calls } = fakeDeps()
    deps.readySandbox = async () => {
      throw new Error("Sandbox backend 'docker' is not available")
    }
    await expect(run(deps)).rejects.toThrow(/not available/)
    expect(calls.worktreeAdds).toEqual([])
  })

  it('fails the repetition and stops the proxy when it never becomes healthy', async () => {
    const { deps, calls } = fakeDeps({ healthy: false })
    const report = await run(deps)
    expect(calls.sandbox).toEqual([])
    expect(calls.proxyStops).toBe(1)
    expect(calls.worktreeRemoves).toHaveLength(1)
    expect(report.repetitions).toHaveLength(1)
    expect(report.repetitions[0].error).toMatch(/never became healthy on port 41000/)
    expect(report.verdict.kind).toBe('aborted')
  })

  it('fails the repetition when the proxy exits before becoming healthy', async () => {
    const { deps, calls } = fakeDeps({ healthy: false, proxyExitsWith: 'exit code 1' })
    const report = await run(deps)
    expect(report.repetitions[0].error).toBe('the proxy exited before becoming healthy (exit code 1)')
    expect(calls.proxyStops).toBe(1)
  })

  it('is invalid, and skips the faulted repetitions, when the baseline fails verify', async () => {
    const { deps, calls } = fakeDeps({ verifyCode: (c) => (c.plan.repetition === 1 ? 1 : 0) })
    const report = await run(deps)
    expect(calls.order).toEqual(['agent:0:baseline', 'verify:0:baseline', 'agent:1:baseline', 'verify:1:baseline'])
    expect(report.verdict).toEqual({ kind: 'invalid', reason: 'the task fails without faults: baseline repetition 1 verify exited 1' })
    expect(report.warnings).toContain('faulted repetitions skipped: a baseline repetition failed verify')
  })

  it('aborts on a destructive attempt while the agent runs, records it and does not resume', async () => {
    const agent: AgentScript = async (call, hostEvents, signal) => {
      if (!call.plan.faults.length) return defaultAgent(call, hostEvents, signal)
      await fs.appendFile(
        hostEvents,
        line({ runId: call.plan.runId, component: 'gate', type: 'gate_decision', tool: 'Bash', decision: 'deny', destructive: true, policyHit: true }),
      )
      // Runs until the runner stops the sandbox.
      await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }))
      return { code: 137 }
    }
    const { deps, calls } = fakeDeps({ agent })
    const report = await run(deps)
    expect(calls.order).toEqual(['agent:0:baseline', 'verify:0:baseline', 'agent:1:baseline', 'verify:1:baseline', 'agent:2:faulted'])
    const aborted = report.repetitions[2]
    expect(aborted.aborted).toMatch(/^destructive_attempt/)
    expect(aborted.verifyExitCode).toBeNull()
    expect(await fs.readFile(aborted.eventsPath, 'utf-8')).toMatch(/"component":"runner","type":"abort"/)
    expect(report.verdict.kind).toBe('aborted')
    if (report.verdict.kind === 'aborted') expect(report.verdict.reason).toMatch(/^repetition 2: destructive_attempt/)
    expect(calls.proxyStops).toBe(3)
  })

  it('warns when the injecting component never loaded the plan and the fault never fired', async () => {
    const agent: AgentScript = async (call, hostEvents) => {
      await fs.appendFile(hostEvents, line({ runId: call.plan.runId, component: 'proxy', type: 'plan_loaded', faults: 1 }))
      return { code: 0 }
    }
    const { deps } = fakeDeps({ agent })
    const report = await run(deps)
    expect(report.warnings).toEqual([
      'tool.error: gate or mcp-proxy never reported plan_loaded in repetitions 2, 3, so the fault could not fire there',
      'tool.error: never injected (no fault_injected event in any faulted repetition); its probes measure nothing',
    ])
    // failure_surfaced was not evaluated: nothing was injected.
    expect(report.probes.find((p) => p.id === 'failure_surfaced')?.evaluated).toBe(0)
  })

  it('carries the gates, hook settings and snapshot into each worktree, pointed at /work', async () => {
    const seen: Array<{ settings: string; gate: string; snapshot: string; env: Record<string, string> }> = []
    const agent: AgentScript = async (call, hostEvents) => {
      seen.push({
        settings: await fs.readFile(path.join(call.workdir, '.claude', 'settings.json'), 'utf-8'),
        gate: await fs.readFile(path.join(call.workdir, '.intutic', 'hooks', 'claude-code-check.js'), 'utf-8'),
        snapshot: await fs.readFile(path.join(call.workdir, '.intutic-chaos', 'policy', 'policy-snapshot.rules'), 'utf-8'),
        env: call.env,
      })
      return defaultAgent(call, hostEvents)
    }
    const info: string[] = []
    const { deps } = fakeDeps({ agent })
    deps.log.info = (m) => info.push(m)
    const report = await run(deps)

    expect(seen).toHaveLength(4)
    for (const s of seen) {
      expect(JSON.parse(s.settings)).toEqual(claudeSettings('/work'))
      expect(s.gate).toBe(`const LOG = '/work/.intutic/events/hook-events.jsonl'\n`)
      expect(s.snapshot).toBe('#digest x\n')
      expect(s.env.INTUTIC_SNAPSHOT_RULES).toBe('/work/.intutic-chaos/policy/policy-snapshot.rules')
      expect(s.env.INTUTIC_APPROVED_BYPASSES).toBeUndefined()
    }
    // Said once, naming what was rewritten.
    expect(info.filter((m) => m.startsWith('Rewrote host paths'))).toEqual([
      'Rewrote host paths to /work in each repetition\'s copy of: .claude/settings.json, .intutic/hooks/claude-code-check.js',
    ])
    // Only defaultAgent's own junk lines: nothing about the gates.
    expect(report.warnings).toEqual(['4 malformed event lines ignored'])
    // The project itself is untouched.
    expect(JSON.parse(await fs.readFile(path.join(tmp, '.claude', 'settings.json'), 'utf-8'))).toEqual(claudeSettings(tmp))
  })

  it('warns when the project has no generated gates', async () => {
    await fs.rm(path.join(tmp, '.intutic'), { recursive: true })
    const { deps } = fakeDeps()
    const report = await run(deps)
    expect(report.warnings.filter((w) => !/malformed/.test(w))).toEqual([expect.stringMatching(/^no generated gates in .*\.intutic\/hooks \(has `intutic connect` run/)])
  })

  it('warns when the gates have no snapshot to read', async () => {
    const { deps } = fakeDeps()
    const report = await run(deps, { snapshotRules: path.join(tmp, 'nowhere.rules') })
    expect(report.warnings.filter((w) => !/malformed/.test(w))).toEqual([expect.stringMatching(/^no policy snapshot at .*nowhere\.rules/)])
  })
})
