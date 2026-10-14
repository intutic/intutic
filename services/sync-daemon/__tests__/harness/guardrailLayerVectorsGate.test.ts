/**
 * The guardrail layer vectors through the emitted harness gates.
 *
 * Each vector is a set of hook-rule guardrails, the rules `GET /api/v1/sop/rules`
 * serves for them to a member of the vector's role (ENFORCING as `block`,
 * SHADOW as `warn`, in served order; a rule scoped to other roles is not
 * served, which is how the snapshot holds a member to their role's rules —
 * the control plane's `guardrailRoles.test.ts` drives the daemon's real
 * `refreshPolicySnapshot` with each member's key), one tool call and the
 * decision every layer must reach. This file builds one
 * policy snapshot per vector the way the daemon builds one
 * (`buildSnapshotRules` over the served rules, keeping the `sop.guardrail.*`
 * patterns), writes it with a real digest, and drives one node gate and one
 * bash gate over the call: `block` exits 2 naming the rule, `warn` exits 0
 * and records a `tool_flagged` event naming it, `allow` exits 0 and names no
 * rule. A refusal wins over a shadow match wherever it sits in the list.
 *
 * Same discipline as `hookRuleVectorsGate.test.ts`: exit codes are 0 or 2 and
 * never anything else, and the rule id must appear on a block so the verdict
 * is attributable to the rule under test rather than to the static floor.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { GATES, type GateEntry } from './gateRegistry.js'
import { toRulesLine } from '../../src/harness/gateBody.js'
import { buildSnapshotRules, type ResolvedPolicy } from '../../src/lib/policySnapshot.js'
import type { GuardPattern } from '../../src/harness/protectedPaths.js'

const VECTORS_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../../../packages/shared-types/fixtures/guardrail-layer-vectors.json')

interface LayerVector {
  name: string
  served: { hookRules: Array<{ id: string } & Record<string, unknown>> }
  toolCall: { tool: string; toolInput: Record<string, unknown> }
  expected: { decision: 'block' | 'warn' | 'allow'; ruleId: string | null }
}

// A missing or unreadable fixture throws here and fails the file: never a skip.
const vectors: LayerVector[] = (JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as { vectors: LayerVector[] }).vectors

/** One node gate and one bash gate — the two evaluators of the shared gate body. */
const CHOSEN = ['claudeCode', 'openhands'] as const
const gates = CHOSEN.map((n) => GATES.find((g) => g.name === n)).filter((g): g is GateEntry => g !== undefined)

const home = mkdtempSync(join(tmpdir(), 'intutic-layer-vectors-'))
const roots = new Map<string, string>()
/** One `.rules` file per vector, index-aligned with `vectors`. */
const snapshots: string[] = []
/** The guardrail patterns each vector's snapshot ships, index-aligned with `vectors`. */
const shipped: GuardPattern[][] = []

beforeAll(async () => {
  vectors.forEach((v, i) => {
    const all = buildSnapshotRules({
      workspaceId: 'ws_test',
      interventionMode: 'ENFORCE',
      sopRules: v.served.hookRules as unknown as ResolvedPolicy['sopRules'],
      mcpAllowedServers: [],
      sqlDropStrictBlock: false,
    })
    // Only the guardrail rules, so a verdict is attributable to them: the
    // static floor is compiled into the gates already.
    const mine = all.filter((p) => p.id.startsWith('sop.guardrail.'))
    shipped.push(mine)
    const lines = mine.map(toRulesLine)
    const digest = createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 32)
    const target = join(home, `vector-${i}.rules`)
    writeFileSync(target, `#digest ${digest}\n#workspace ws_test\n#generated ${new Date().toISOString()}\n${lines.join('\n')}\n`)
    snapshots.push(target)
  })

  for (const g of gates) {
    const root = join(home, g.name)
    mkdirSync(root, { recursive: true })
    process.env.HOME = root
    process.env.USERPROFILE = root
    try {
      const mod = await import(g.module)
      await g.invoke(mod, root)
    } catch (err) {
      roots.set(`${g.name}:error`, String(err))
    }
    roots.set(g.name, root)
  }
}, 120_000)

afterAll(async () => {
  // Async, never spawnSync: see the note in generatedGateBehaviour.test.ts.
  await new Promise<void>((resolve) => {
    const child = spawn('chflags', ['-R', 'nouchg', home], { stdio: 'ignore' })
    child.on('error', () => resolve())
    child.on('close', () => resolve())
  })
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    // A leftover temp dir is not worth failing a run over.
  }
})

interface RunResult {
  status: number
  stdout: string
  stderr: string
  signal: NodeJS.Signals | null
}

/** Async spawn, never spawnSync: see the note in generatedGateBehaviour.test.ts. */
function runProcess(cmd: string, args: string[], opts: { input: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => { stdout += d })
    child.stderr.on('data', (d: string) => { stderr += d })
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ status: code === null ? -1 : code, stdout, stderr, signal })
    })
    child.stdin.write(opts.input)
    child.stdin.end()
  })
}

async function runGate(g: GateEntry, tool: string, toolInput: Record<string, unknown>, snapshot: string): Promise<RunResult> {
  const root = roots.get(g.name)!
  return runProcess(g.runner, [join(root, g.artifact)], {
    input: JSON.stringify({ tool_name: tool, tool_input: toolInput, session_id: 'sess_layer_vectors' }),
    env: { ...process.env, HOME: root, USERPROFILE: root, INTUTIC_SNAPSHOT_RULES: snapshot },
    timeoutMs: 20_000,
  })
}

/** Every hook-event line a gate has written under its root, in any `.jsonl` audit log. */
function hookEventLines(g: GateEntry): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.name.endsWith('.jsonl')) out.push(...readFileSync(full, 'utf8').split('\n').filter((l) => l.trim()))
    }
  }
  walk(roots.get(g.name)!)
  return out
}

/** The `tool_flagged` reasons among `lines`. */
function flaggedReasons(lines: string[]): string[] {
  const out: string[] = []
  for (const l of lines) {
    try {
      const e = JSON.parse(l) as Record<string, unknown>
      if (e['event'] === 'tool_flagged') out.push(String(e['reason'] ?? ''))
    } catch {
      // Not an event line.
    }
  }
  return out
}

describe('guardrail layer vectors through the emitted gates', () => {
  it('has gates and vectors to iterate over, and every served guardrail rule survived the snapshot writer', () => {
    expect(gates.map((g) => g.name)).toEqual([...CHOSEN])
    expect(gates.map((g) => g.runner).sort()).toEqual(['bash', 'node'])
    expect(vectors.length).toBeGreaterThanOrEqual(32)
    // Rules scoped to roles, as served to a member of the vector's role: the
    // control plane serves a member's key only its role's rules, so this layer
    // must decide what it is served — a scoped rule it holds, none it lacks.
    const scoped = vectors.filter((v) => JSON.stringify(v).includes('"roles":'))
    expect(scoped.length, 'role-scoped vectors').toBeGreaterThanOrEqual(8)
    expect(scoped.some((v) => v.expected.decision === 'allow')).toBe(true)
    expect(scoped.some((v) => v.expected.decision === 'block')).toBe(true)
    const decisions = new Set(vectors.map((v) => v.expected.decision))
    for (const d of ['block', 'warn', 'allow']) expect(decisions, d).toContain(d)
    vectors.forEach((v, i) => {
      // In served order, at the severity the action names: block ships block, a
      // shadow guardrail's warn ships warn.
      expect(shipped[i]!.map((p) => [p.id, p.severity]), v.name).toEqual(
        v.served.hookRules.map((r) => [`sop.${r.id}`, r['action']]),
      )
    })
  })

  for (const g of gates) {
    it(`${g.name} (${g.runner}): decides every vector as the layers must`, async () => {
      expect(roots.get(`${g.name}:error`), `the ${g.name} writer failed`).toBeUndefined()
      // One call at a time, so the events a call adds are its own.
      for (const [i, v] of vectors.entries()) {
        const before = hookEventLines(g).length
        const r = await runGate(g, v.toolCall.tool, v.toolCall.toolInput, snapshots[i]!)
        const flagged = flaggedReasons(hookEventLines(g).slice(before))
        const label = `${g.name}: ${v.name}`
        const how = r.signal ? `was killed by ${r.signal}` : `exited ${r.status}`
        expect([0, 2], `${label} ${how} — only 0 or 2 are decisions.\nstderr: ${r.stderr.slice(0, 400)}`).toContain(r.status)
        const { decision, ruleId } = v.expected
        const others = v.served.hookRules.map((rule) => rule.id).filter((id) => id !== ruleId)
        if (decision === 'block') {
          expect(r.status, `${label}: expected a block.\nstderr: ${r.stderr.slice(0, 400)}`).toBe(2)
          expect(r.stderr, `${label}: the block did not name the rule`).toContain(`[sop.${ruleId}]`)
          for (const id of others) expect(r.stderr, `${label}: another rule was named`).not.toContain(`[sop.${id}]`)
        } else {
          expect(r.status, `${label}: expected an allow.\nstderr: ${r.stderr.slice(0, 400)}`).toBe(0)
          for (const id of others) {
            expect(r.stderr, `${label}: a rule was named on an allowed call`).not.toContain(`[sop.${id}]`)
            expect(flagged.join('\n'), `${label}: a rule that should not fire was flagged`).not.toContain(`[sop.${id}]`)
          }
          if (decision === 'warn') {
            expect(flagged.join('\n'), `${label}: no tool_flagged named the shadow rule`).toContain(`[sop.${ruleId}]`)
          }
        }
      }
    }, 180_000)
  }
})
