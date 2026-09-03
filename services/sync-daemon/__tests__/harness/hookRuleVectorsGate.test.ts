/**
 * The emitted harness gate is the third real matcher for generated hook rules
 * (LLD #71) — and the one that runs on the developer's machine, with no
 * network. This file builds one policy snapshot per authored hook-rule
 * vector the way the daemon builds one (`buildSnapshotRules`, so every
 * vector also has to survive `validateRule`), writes it with a real digest,
 * and drives one node gate and one bash gate over every vector case. The
 * bash gate evaluates the argument pattern with `python3`'s `re`, so a
 * lookahead JavaScript reads one way and Python another goes red here and
 * nowhere else.
 *
 * Same discipline as `generatedGateBehaviour.test.ts`: exit codes are 0 or 2
 * and never anything else, and the rule id must appear in stderr on a block
 * so the verdict is attributable to the rule under test rather than to a
 * static floor that happened to match the same input.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { GATES, type GateEntry } from './gateRegistry.js'
import { toRulesLine } from '../../src/harness/gateBody.js'
import { buildSnapshotRules } from '../../src/lib/policySnapshot.js'
import type { GuardPattern } from '../../src/harness/protectedPaths.js'

const VECTORS_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../../../packages/shared-types/fixtures/hook-rule-vectors.json')

interface HookVector {
  name: string
  citation: { quote: string; sourceUrl: string | null }
  rendered: { toolPattern: string; argPattern?: string; reason: string }
  cases: Array<{ tool: string; toolInput: Record<string, unknown>; fires: boolean }>
}

const vectors: HookVector[] = (JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as { vectors: HookVector[] }).vectors

/** One node gate and one bash gate — the two evaluators of the shared gate body. */
const CHOSEN = ['claudeCode', 'openhands'] as const
const gates = CHOSEN.map((n) => GATES.find((g) => g.name === n)).filter((g): g is GateEntry => g !== undefined)

const home = mkdtempSync(join(tmpdir(), 'intutic-vectors-'))
const roots = new Map<string, string>()
/** One `.rules` file per vector, index-aligned with `vectors`. */
const snapshots: string[] = []
const shipped: GuardPattern[] = []

beforeAll(async () => {
  vectors.forEach((v, i) => {
    const all = buildSnapshotRules({
      workspaceId: 'ws_test',
      interventionMode: 'ENFORCE',
      sopRules: [
        {
          id: `guardrail.pgr_${i}`,
          toolPattern: v.rendered.toolPattern,
          ...(v.rendered.argPattern ? { argPattern: v.rendered.argPattern } : {}),
          action: 'block',
          reason: v.rendered.reason,
        },
      ],
      mcpAllowedServers: [],
      sqlDropStrictBlock: false,
    })
    // One rule per snapshot, and only the rule under test, so a verdict is
    // attributable to that rule alone: two vectors can legitimately match the
    // same input, and the static floor is compiled into the gates already.
    const mine = all.filter((p) => p.id === `sop.guardrail.pgr_${i}`)
    shipped.push(...mine)
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

afterAll(() => {
  spawnSync('chflags', ['-R', 'nouchg', home])
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
    input: JSON.stringify({ tool_name: tool, tool_input: toolInput, session_id: 'sess_vectors' }),
    env: { ...process.env, HOME: root, USERPROFILE: root, INTUTIC_SNAPSHOT_RULES: snapshot },
    timeoutMs: 20_000,
  })
}

async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      await fn(items[i]!)
    }
  })
  await Promise.all(workers)
}

describe('generated hook rules through the emitted gates', () => {
  it("has gates and vectors to iterate over, and every vector survived the daemon's validateRule", () => {
    expect(gates.map((g) => g.name)).toEqual([...CHOSEN])
    expect(gates.map((g) => g.runner).sort()).toEqual(['bash', 'node'])
    expect(gates.every((g) => g.contract === 'exit2' && g.migrated)).toBe(true)
    expect(vectors.length).toBeGreaterThanOrEqual(8)
    expect(shipped.length, 'a vector was rejected by validateRule and silently left out').toBe(vectors.length)
    expect(snapshots.length).toBe(vectors.length)
    for (const p of shipped) expect(p.severity).toBe('block')
    expect(shipped.filter((p) => p.argPattern).length).toBeGreaterThanOrEqual(5)
  })

  for (const g of gates) {
    it(`${g.name} (${g.runner}): decides every vector case as authored, naming the rule on a block`, async () => {
      expect(roots.get(`${g.name}:error`), `the ${g.name} writer failed`).toBeUndefined()
      const cases = vectors.flatMap((v, i) => v.cases.map((c) => ({ v, i, c })))
      await mapLimit(cases, 4, async ({ v, i, c }) => {
        const r = await runGate(g, c.tool, c.toolInput, snapshots[i]!)
        const label = `${g.name}: ${v.name} / ${c.tool} ${JSON.stringify(c.toolInput)}`
        const how = r.signal ? `was killed by ${r.signal}` : `exited ${r.status}`
        expect([0, 2], `${label} ${how} — only 0 or 2 are decisions.\nstderr: ${r.stderr.slice(0, 400)}`).toContain(r.status)
        const id = `[sop.guardrail.pgr_${i}]`
        if (c.fires) {
          expect(r.status, `${label}: expected a block.\nstderr: ${r.stderr.slice(0, 400)}`).toBe(2)
          expect(r.stderr, `${label}: the block did not name the rule`).toContain(id)
          expect(r.stderr, `${label}: the cited passage did not reach stderr`).toContain(v.citation.quote.slice(0, 40))
        } else {
          expect(r.status, `${label}: expected an allow.\nstderr: ${r.stderr.slice(0, 400)}`).toBe(0)
          expect(r.stderr, `${label}: the rule was named on an allowed call`).not.toContain(id)
        }
      })
    }, 180_000)
  }
})
