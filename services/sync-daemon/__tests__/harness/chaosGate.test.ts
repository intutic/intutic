/**
 * Fault injection in the emitted hook gates, run for real.
 *
 * `packages/shared-types/fixtures/chaos-gate-vectors.json` holds the cases
 * chaosGate.ts and intutic-clawde's chaos.py decide in-process. Here the
 * gates themselves run them: the Claude Code gate (JavaScript, the source
 * chaosGate.ts emits) and goose's (bash, chaos.py in INTUTIC_PY_LIB), one
 * process per call, with the plan and the events file in their environment as
 * a chaos run's runner sets them. Every vector whose calls governance allows
 * replays end to end; the decisions governance makes itself (a refusal, a
 * hold, a destructive command, an escape hatch) come from a snapshot the real
 * `writePolicySnapshot` wrote. The stdout harnesses' refusal shapes are
 * checked on cline, grok and antigravityCli, and the in-process plugins'
 * (one process, many calls) on OpenClaw and Pi.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync, readdirSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { ChaosEventSchema, encodeChaosPlan, ChaosPlanSchema } from '@intutic/shared-types'
import { GATES, type GateEntry } from './gateRegistry.js'
import { CHAOS_PY_SOURCE } from '../../src/lib/chaosPy.js'
import { writePolicySnapshot, SNAPSHOT_RULES } from '../../src/lib/policySnapshot.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGES = join(HERE, '../../../../packages')

interface VectorCall {
  tool: string
  input?: Record<string, unknown>
  advanceS?: number
  decision: string
  ruleId?: string | null
  destructive: boolean
  policyHit: boolean
  outcome: string
  reason?: string
}
interface Vectors {
  valid: Array<{ name: string; plan: unknown; calls: VectorCall[]; events: Array<Record<string, unknown>> }>
  invalid: Array<{ name: string; plan?: unknown; raw?: string }>
}
const VECTORS = JSON.parse(readFileSync(join(PACKAGES, 'shared-types/fixtures/chaos-gate-vectors.json'), 'utf8')) as Vectors

const CHOSEN = ['claudeCode', 'goose', 'cline', 'grok', 'antigravityCli', 'openclaw', 'pi'] as const
const ENGINES = ['claudeCode', 'goose'] as const
const gate = (name: string): GateEntry => GATES.find((g) => g.name === name)!

const home = mkdtempSync(join(tmpdir(), 'intutic-chaos-gate-'))
const roots = new Map<string, string>()
let snapshot = ''
let caseNo = 0

beforeAll(async () => {
  const dir = join(home, 'snapshot')
  await writePolicySnapshot(
    {
      workspaceId: 'ws_test',
      interventionMode: 'TRANSPARENT',
      sopRules: [{ id: 's_edit', toolPattern: 'Edit', action: 'block', reason: 'no edits' }],
      mcpAllowedServers: [],
      // destructive.sql_drop refuses; the rest of the destructive tier warns.
      sqlDropStrictBlock: true,
    },
    dir,
    ['NotebookEdit'],
  )
  snapshot = join(dir, SNAPSHOT_RULES)
  for (const name of CHOSEN) {
    const g = gate(name)
    const root = join(home, g.name)
    mkdirSync(root, { recursive: true })
    process.env.HOME = root
    process.env.USERPROFILE = root
    await g.invoke(await import(g.module), root)
    roots.set(g.name, root)
  }
}, 120_000)

afterAll(() => {
  spawnSync('chflags', ['-R', 'nouchg', home])
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    // A leftover temp dir is not worth failing a run over.
  }
})

interface Run {
  code: number | null
  stdout: string
  stderr: string
  ms: number
}

/** Async spawn, never spawnSync: see the note in generatedGateBehaviour.test.ts. */
function runGate(name: string, stdin: string, env: Record<string, string | undefined>): Promise<Run> {
  const g = gate(name)
  const root = roots.get(name)!
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const child = spawn(g.runner, [join(root, g.artifact)], {
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        INTUTIC_SNAPSHOT_RULES: join(home, 'absent.rules'),
        INTUTIC_REVIEW_REQUESTS: join(root, 'holds.jsonl'),
        INTUTIC_GUARD_DISABLE: undefined,
        INTUTIC_CHAOS_PLAN: undefined,
        INTUTIC_CHAOS_EVENTS: undefined,
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => (stdout += d))
    child.stderr.on('data', (d: string) => (stderr += d))
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, ms: Date.now() - started })
    })
    child.stdin.end(stdin)
  })
}

/** A call governance lets through, for each tool the vectors use. */
function benign(tool: string): string {
  const input: Record<string, unknown> =
    tool === 'Bash'
      ? { command: 'ls -la' }
      : tool === 'Write'
        ? { file_path: 'notes.txt', content: 'hello' }
        : tool.endsWith('Edit')
          ? { file_path: 'notes.txt', old_string: 'a', new_string: 'b' }
          : { title: 'x' }
  return call(tool, input)
}

const call = (tool: string, input: Record<string, unknown> = {}) =>
  JSON.stringify({ tool_name: tool, tool_input: input, session_id: 'sess_chaos' })

const encode = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')

/** A fresh events path and the environment that names it with a plan. */
function chaosEnv(plan: unknown, extra: Record<string, string> = {}) {
  const dir = join(home, `case-${++caseNo}`)
  mkdirSync(dir, { recursive: true })
  const events = join(dir, 'events.jsonl')
  const raw = typeof plan === 'string' ? plan : encodeChaosPlan(ChaosPlanSchema.parse(plan))
  return { events, env: { INTUTIC_CHAOS_PLAN: raw, INTUTIC_CHAOS_EVENTS: events, ...extra } }
}

function readEvents(events: string): Array<Record<string, unknown>> {
  if (!existsSync(events)) return []
  const lines = readFileSync(events, 'utf8').split('\n').filter(Boolean)
  return lines.map((l) => {
    const e = JSON.parse(l) as Record<string, unknown>
    expect(ChaosEventSchema.safeParse(e).success, l).toBe(true)
    expect(e.ts).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
    expect(e.component).toBe('gate')
    const { ts: _ts, runId: _runId, component: _c, ...rest } = e
    return rest
  })
}

/** Moves the clock forward: every counter file's modification time goes back by `seconds`. */
function advanceClock(events: string, seconds: number): void {
  const dir = events + '.gate-counters'
  if (!seconds || !existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    const t = statSync(join(dir, name)).mtimeMs / 1000 - seconds
    utimesSync(join(dir, name), t, t)
  }
}

const BASE = { v: 1, runId: 'run_gate_e2e', repetition: 1, canary: 'E-INTUTIC-C0FFEE' }
const HELD = 'Permission held for approval; retrying this exact call passes once it is approved [E-INTUTIC-C0FFEE]'

it('emits a byte-identical copy of intutic-clawde’s chaos.py', () => {
  const clawde = readFileSync(join(PACKAGES, 'intutic-clawde/intutic_clawde/gate/chaos.py'), 'utf-8')
  expect(CHAOS_PY_SOURCE).toBe(clawde)
})

// Every vector whose calls governance allows as they are: the decisions
// governance makes itself are driven with a real snapshot below.
const REPLAYABLE = VECTORS.valid.filter((v) =>
  v.calls.every((c) => c.decision === 'allow' && !c.ruleId && !c.destructive && !c.policyHit),
)

describe.each(ENGINES)('the %s gate', (name) => {
  it('replays the shared vectors one process per call', async () => {
    expect(REPLAYABLE.length).toBeGreaterThanOrEqual(5)
    for (const v of REPLAYABLE) {
      const { events, env } = chaosEnv(v.plan)
      for (const [i, c] of v.calls.entries()) {
        advanceClock(events, c.advanceS ?? 0)
        const out = await runGate(name, c.input ? call(c.tool, c.input) : benign(c.tool), env)
        const label = `${v.name} call ${i}: ${out.stderr.slice(-300)}`
        if (c.outcome === 'allow') {
          expect(out.code, label).toBe(0)
        } else {
          expect(out.code, label).toBe(2)
          expect(out.stderr, label).toContain(c.outcome === 'hold' ? `[Intutic Governance] HELD: ${c.reason}` : c.reason)
        }
      }
      expect(readEvents(events), v.name).toEqual(v.events)
    }
  }, 180_000)

  it('refuses every call under a plan it cannot read, and reports nothing', async () => {
    for (const v of VECTORS.invalid.slice(0, 4)) {
      const { events, env } = chaosEnv(v.raw ?? encode(v.plan))
      const out = await runGate(name, benign('Bash'), env)
      expect(out.code, v.name).toBe(2)
      expect(out.stderr, v.name).toMatch(/BLOCKED: INTUTIC_CHAOS_PLAN is not/)
      expect(readEvents(events), v.name).toEqual([])
    }
  }, 60_000)

  it('refuses a plan with no events file to report to', async () => {
    const out = await runGate(name, benign('Bash'), { INTUTIC_CHAOS_PLAN: encodeChaosPlan(ChaosPlanSchema.parse({ ...BASE, faults: [] })) })
    expect(out.code).toBe(2)
    expect(out.stderr).toContain('INTUTIC_CHAOS_EVENTS is not')
  })

  it('decides as before when the events file cannot be written', async () => {
    const env = {
      INTUTIC_CHAOS_PLAN: encodeChaosPlan(ChaosPlanSchema.parse({ ...BASE, faults: [{ id: 'tool.error' }] })),
      INTUTIC_CHAOS_EVENTS: join(home, 'no-such-dir', 'events.jsonl'),
    }
    const out = await runGate(name, benign('Bash'), env)
    expect(out.code, out.stderr).toBe(0)
    expect(out.stderr).toContain('chaos: could not')
  })

  it('reports governance’s own decisions, and faults only what it allowed', async () => {
    const { events, env } = chaosEnv({ ...BASE, faults: [{ id: 'tool.error', message: 'disk full' }] }, { INTUTIC_SNAPSHOT_RULES: snapshot })
    // A SOP block: refused by governance, never faulted.
    const edit = await runGate(name, call('Edit', { file_path: 'a.txt', old_string: 'a', new_string: 'b' }), env)
    expect(edit.code).toBe(2)
    expect(edit.stderr).toContain('[sop.s_edit]')
    expect(edit.stderr).not.toContain('E-INTUTIC-C0FFEE')
    // A hold.
    const notebook = await runGate(name, call('NotebookEdit', { notebook_path: 'a.ipynb' }), env)
    expect(notebook.code).toBe(2)
    // A destructive command at the warn tier: allowed by governance, then faulted.
    const rm = await runGate(name, call('Bash', { command: 'rm -rf /' }), env)
    expect(rm.code).toBe(2)
    expect(rm.stderr).toContain('disk full [E-INTUTIC-C0FFEE]')
    // A destructive command the workspace refuses.
    const drop = await runGate(name, call('Bash', { command: 'psql -c "DROP TABLE users"' }), env)
    expect(drop.code).toBe(2)
    expect(drop.stderr).toContain('[destructive.sql_drop]')
    // The compiled floor.
    const settings = await runGate(name, call('Write', { file_path: '.claude/settings.json', content: '{}' }), env)
    expect(settings.code).toBe(2)
    const got = readEvents(events)
    const decisions = got.filter((e) => e.type === 'gate_decision')
    expect(decisions.slice(0, 4)).toEqual([
      { type: 'gate_decision', tool: 'Edit', decision: 'deny', ruleId: 'sop.s_edit', destructive: false, policyHit: true },
      { type: 'gate_decision', tool: 'NotebookEdit', decision: 'hold', ruleId: 'sop.local.review_before.NotebookEdit', destructive: false, policyHit: true },
      { type: 'gate_decision', tool: 'Bash', decision: 'allow', ruleId: 'destructive.rm_rf_root', destructive: true, policyHit: false },
      { type: 'gate_decision', tool: 'Bash', decision: 'deny', ruleId: 'destructive.sql_drop', destructive: true, policyHit: true },
    ])
    expect(decisions[4]).toMatchObject({ tool: 'Write', decision: 'deny', destructive: false, policyHit: true })
    expect(String(decisions[4]!.ruleId)).toMatch(/^[a-z_]+\./)
    // The only fault is on the one call governance allowed, its first.
    expect(got.filter((e) => e.type === 'fault_injected')).toEqual([
      { type: 'fault_injected', faultId: 'tool.error', call: 1, target: 'Bash' },
    ])
    expect(got.filter((e) => e.type === 'tool_call')).toEqual([])
  }, 60_000)

  it('sees a destructive command the escape hatch lets through', async () => {
    const { events, env } = chaosEnv({ ...BASE, faults: [] }, { INTUTIC_SNAPSHOT_RULES: snapshot, INTUTIC_GUARD_DISABLE: '1' })
    const out = await runGate(name, call('Bash', { command: 'rm -rf /' }), env)
    expect(out.code, out.stderr).toBe(0)
    expect(readEvents(events)).toEqual([
      { type: 'plan_loaded', faults: 0 },
      { type: 'gate_decision', tool: 'Bash', decision: 'allow', destructive: true, policyHit: false },
      { type: 'tool_call', tool: 'Bash', ok: true },
    ])
  }, 30_000)

  it('holds a delay longer than any hook timeout without waiting, and lets the retry through after it', async () => {
    const { events, env } = chaosEnv({ ...BASE, faults: [{ id: 'permission.deny_or_delay', mode: 'delay', delay_s: 600 }] })
    const held = await runGate(name, benign('Bash'), env)
    expect(held.code, held.stderr).toBe(2)
    expect(held.stderr).toContain(`[Intutic Governance] HELD: ${HELD}`)
    expect(held.ms).toBeLessThan(5_000)
    expect((await runGate(name, benign('Bash'), env)).code).toBe(2)
    advanceClock(events, 600)
    const retry = await runGate(name, benign('Bash'), env)
    expect(retry.code, retry.stderr).toBe(0)
    expect(readEvents(events).map((e) => [e.type, e.ok])).toEqual([
      ['plan_loaded', undefined],
      ['gate_decision', undefined],
      ['fault_injected', undefined],
      ['tool_call', false],
      ['gate_decision', undefined],
      ['tool_call', false],
      ['gate_decision', undefined],
      ['tool_call', true],
    ])
  }, 30_000)
})

describe('the stdout harnesses refuse a fault through their own contract', () => {
  const plan = { ...BASE, faults: [{ id: 'permission.deny_or_delay' }] }
  const reason = 'Permission denied by approver [E-INTUTIC-C0FFEE]'

  it('cline: a cancel with no governance code', async () => {
    const out = await runGate('cline', benign('Bash'), chaosEnv(plan).env)
    expect(JSON.parse(out.stdout.trim())).toEqual({ cancel: true, errorMessage: reason, code: null, ruleId: null })
  })

  it('grok: a deny with no governance code', async () => {
    const out = await runGate('grok', benign('Bash'), chaosEnv(plan).env)
    expect(JSON.parse(out.stdout.trim())).toEqual({ decision: 'deny', reason, code: null, ruleId: null })
  })

  it('antigravityCli: the documented fields only', async () => {
    const out = await runGate('antigravityCli', benign('Bash'), chaosEnv(plan).env)
    expect(JSON.parse(out.stdout.trim().split('\n').pop()!)).toEqual({ decision: 'deny', reason })
  })

  const hold = { ...BASE, faults: [{ id: 'permission.deny_or_delay', mode: 'delay', delay_s: 60 }] }

  it('cline: a held call is a cancel with the hold code', async () => {
    const out = await runGate('cline', benign('Bash'), chaosEnv(hold).env)
    expect(JSON.parse(out.stdout.trim())).toEqual({ cancel: true, errorMessage: `[Intutic Governance] HELD: ${HELD}`, code: 'HELD', ruleId: null })
  })

  it('grok: a held call is a deny with the hold code', async () => {
    const out = await runGate('grok', benign('Bash'), chaosEnv(hold).env)
    expect(JSON.parse(out.stdout.trim())).toEqual({ decision: 'deny', reason: `[Intutic Governance] HELD: ${HELD}`, code: 'HELD', ruleId: null })
  })

  it('antigravityCli: a held call names its code in the reason', async () => {
    const out = await runGate('antigravityCli', benign('Bash'), chaosEnv(hold).env)
    expect(JSON.parse(out.stdout.trim().split('\n').pop()!)).toEqual({
      decision: 'deny',
      reason: `[Intutic Governance] HELD: ${HELD} (refusal code HELD)`,
    })
  })

  it('cline: an unreadable plan refuses as a gate failure', async () => {
    const out = await runGate('cline', benign('Bash'), chaosEnv('not a plan!').env)
    const decision = JSON.parse(out.stdout.trim()) as Record<string, unknown>
    expect(decision).toMatchObject({ cancel: true, code: 'GATE_CRASHED', ruleId: null })
    expect(String(decision.errorMessage)).toContain('INTUTIC_CHAOS_PLAN is not')
  })
})

describe('the in-process plugins keep one record per call', () => {
  /**
   * Loads the plugin as its host does and makes each call in turn, in one
   * process: what each returned, as a block reason or null.
   */
  async function runPlugin(name: 'openclaw' | 'pi', calls: Array<{ tool: string; args: unknown; derivedPaths?: string[] }>, env: Record<string, string>) {
    const g = gate(name)
    const root = roots.get(name)!
    const driver = join(root, 'chaos-drv.mjs')
    writeFileSync(
      driver,
      [
        "import { pathToFileURL } from 'node:url';",
        "import { createRequire } from 'node:module';",
        'const [file, host] = process.argv.slice(2);',
        "let stdin = ''; for await (const chunk of process.stdin) stdin += chunk;",
        'let handler;',
        "if (host === 'pi') {",
        '  const factory = (await import(pathToFileURL(file).href)).default;',
        "  await factory({ on(name, fn) { if (name === 'tool_call') handler = fn; } });",
        '} else {',
        "  createRequire(import.meta.url)(file).register({ on(name, fn) { if (name === 'before_tool_call') handler = fn; } });",
        '}',
        'const out = [];',
        'for (const c of JSON.parse(stdin)) {',
        "  const res = host === 'pi'",
        "    ? await handler({ type: 'tool_call', toolName: c.tool, toolCallId: 'call_1', input: c.args }, { cwd: process.cwd(), hasUI: false, sessionManager: { getSessionId: () => 'sess_test' } })",
        "    : await handler({ toolName: c.tool, params: c.args, toolCallId: 'call_1', runId: 'run_1', ...(c.derivedPaths ? { derivedPaths: c.derivedPaths } : {}) }, { agentId: 'main', sessionKey: 'k', sessionId: 'sess_test', runId: 'run_1' });",
        '  out.push(res && res.block ? String(res.reason || res.blockReason) : null);',
        '}',
        'process.stdout.write(JSON.stringify(out));',
      ].join('\n'),
    )
    const started = Date.now()
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn('node', [driver, join(root, g.artifact), name], {
        env: { ...process.env, HOME: root, USERPROFILE: root, INTUTIC_SNAPSHOT_RULES: join(home, 'absent.rules'), ...env },
        stdio: ['pipe', 'pipe', 'inherit'],
      })
      let stdout = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (d: string) => (stdout += d))
      child.on('error', reject)
      child.on('close', () => resolve(stdout))
      child.stdin.end(JSON.stringify(calls))
    })
    return { results: JSON.parse(out) as Array<string | null>, ms: Date.now() - started }
  }

  it('openclaw: an apply_patch over two files is one call, reported and faulted once', async () => {
    const { events, env } = chaosEnv({ ...BASE, faults: [{ id: 'tool.error', match: { tool: 'apply_patch' }, times: 1 }] })
    const { results } = await runPlugin(
      'openclaw',
      [
        { tool: 'apply_patch', args: { input: '*** Begin Patch' }, derivedPaths: ['src/a.ts', 'src/b.ts'] },
        { tool: 'apply_patch', args: { input: '*** Begin Patch' }, derivedPaths: ['src/a.ts', 'src/b.ts'] },
        { tool: 'exec', args: { command: 'ls' } },
      ],
      env,
    )
    expect(results).toEqual(['[Intutic Governance] tool failed [E-INTUTIC-C0FFEE]', null, null])
    expect(readEvents(events)).toEqual([
      { type: 'plan_loaded', faults: 1 },
      { type: 'gate_decision', tool: 'apply_patch', decision: 'allow', destructive: false, policyHit: false },
      { type: 'fault_injected', faultId: 'tool.error', call: 1, target: 'apply_patch' },
      { type: 'gate_decision', tool: 'apply_patch', decision: 'allow', destructive: false, policyHit: false },
      { type: 'tool_call', tool: 'apply_patch', ok: true },
      { type: 'gate_decision', tool: 'exec', decision: 'allow', destructive: false, policyHit: false },
      { type: 'tool_call', tool: 'exec', ok: true },
    ])
  }, 30_000)

  it('pi: a refusal by governance, then a held call whose retry is denied', async () => {
    const { events, env } = chaosEnv({ ...BASE, faults: [{ id: 'permission.deny_or_delay', mode: 'hold_then_deny' }] })
    const { results } = await runPlugin(
      'pi',
      [
        { tool: 'write', args: { path: '.claude/settings.json', content: '{}' } },
        { tool: 'bash', args: { command: 'ls' } },
        { tool: 'bash', args: { command: 'ls' } },
      ],
      env,
    )
    expect(results[0]).toMatch(/^\[Intutic Governance\] BLOCKED/)
    expect(results[1]).toBe(`[Intutic Governance] HELD: ${HELD}`)
    expect(results[2]).toBe('[Intutic Governance] Permission held for approval, then denied by approver [E-INTUTIC-C0FFEE]')
    const got = readEvents(events)
    expect(got.map((e) => [e.type, e.tool ?? e.target, e.decision ?? e.ok])).toEqual([
      ['plan_loaded', undefined, undefined],
      ['gate_decision', 'write', 'deny'],
      ['gate_decision', 'bash', 'allow'],
      ['fault_injected', 'bash', undefined],
      ['tool_call', 'bash', false],
      ['gate_decision', 'bash', 'allow'],
    ])
    expect(got[1]!.policyHit).toBe(true)
  }, 30_000)
})
