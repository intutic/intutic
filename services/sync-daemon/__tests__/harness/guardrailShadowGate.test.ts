/**
 * A cited guardrail in SHADOW reaches the developer's machine at severity
 * `warn`, and the emitted gate does exactly what "shadow" promises: it logs
 * `tool_flagged … [sop.guardrail.<id>]` and exits 0 (LLD #71, Wave 4). The
 * same rule after promotion exits 2 with the cited passage on stderr. And the
 * denominator exists: the writer logs `tool_allowed` for every allowed call,
 * the flagged one included, so a shadow period can be measured.
 *
 * One node gate and one bash gate, per-rule snapshots built by
 * `buildSnapshotRules` — the same scaffolding as `hookRuleVectorsGate.test.ts`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { GATES, type GateEntry } from './gateRegistry.js'
import { toRulesLine } from '../../src/harness/gateBody.js'
import { buildSnapshotRules, type ResolvedPolicy } from '../../src/lib/policySnapshot.js'
import type { GuardPattern } from '../../src/harness/protectedPaths.js'

const QUOTE = 'Engineers must never run terraform apply against production without a reviewed plan.'
const SHADOW_RULE: ResolvedPolicy['sopRules'][number] = {
  id: 'guardrail.pgr_shadow',
  toolPattern: '^Bash$',
  argPattern: '(?=[\\s\\S]*terraform\\ apply)',
  action: 'warn',
  reason: `Reviewed plan before terraform apply — policy: "${QUOTE}" (https://wiki.acme.dev/change-policy)`,
  origin: 'guardrail',
}
const ENFORCING_RULE: ResolvedPolicy['sopRules'][number] = {
  ...SHADOW_RULE,
  id: 'guardrail.pgr_enforce',
  action: 'block',
}

const CHOSEN = ['claudeCode', 'openhands'] as const
const gates = CHOSEN.map((n) => GATES.find((g) => g.name === n)).filter((g): g is GateEntry => g !== undefined)

const home = mkdtempSync(join(tmpdir(), 'intutic-shadow-'))
const roots = new Map<string, string>()
const snapshots = new Map<'shadow' | 'enforce', string>()

function writeSnapshot(name: 'shadow' | 'enforce', rule: ResolvedPolicy['sopRules'][number]): GuardPattern[] {
  const all = buildSnapshotRules({ workspaceId: 'ws_test', interventionMode: 'ENFORCE', sopRules: [rule], mcpAllowedServers: [], sqlDropStrictBlock: false })
  const mine = all.filter((p) => p.id === `sop.${rule.id}`)
  const lines = mine.map(toRulesLine)
  const digest = createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 32)
  const target = join(home, `${name}.rules`)
  writeFileSync(target, `#digest ${digest}\n#workspace ws_test\n#generated ${new Date().toISOString()}\n${lines.join('\n')}\n`)
  snapshots.set(name, target)
  return mine
}

let shadowPatterns: GuardPattern[] = []
let enforcePatterns: GuardPattern[] = []

beforeAll(async () => {
  shadowPatterns = writeSnapshot('shadow', SHADOW_RULE)
  enforcePatterns = writeSnapshot('enforce', ENFORCING_RULE)
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

async function runGate(g: GateEntry, snapshot: 'shadow' | 'enforce', tool: string, toolInput: Record<string, unknown>): Promise<RunResult> {
  const root = roots.get(g.name)!
  return runProcess(g.runner, [join(root, g.artifact)], {
    input: JSON.stringify({ tool_name: tool, tool_input: toolInput, session_id: 'sess_shadow' }),
    env: { ...process.env, HOME: root, USERPROFILE: root, INTUTIC_SNAPSHOT_RULES: snapshots.get(snapshot)! },
    timeoutMs: 20_000,
  })
}

/** Every audit line under the gate's root, parsed. */
function auditEvents(g: GateEntry): Array<{ event: string; toolName: string; reason: string }> {
  const out: Array<{ event: string; toolName: string; reason: string }> = []
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
      else if (e.name.endsWith('.jsonl')) {
        for (const line of readFileSync(full, 'utf8').split('\n')) {
          if (!line.trim()) continue
          try {
            out.push(JSON.parse(line))
          } catch {
            // Not every line is an event.
          }
        }
      }
    }
  }
  walk(roots.get(g.name)!)
  return out
}

function truncateAudit(g: GateEntry): void {
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
      else if (e.name.endsWith('.jsonl')) writeFileSync(full, '')
    }
  }
  walk(roots.get(g.name)!)
}

describe('a cited guardrail through the emitted gates', () => {
  it('the daemon writes a SHADOW guardrail at severity warn and an ENFORCING one at block, both keeping the argument clause', () => {
    expect(gates.map((g) => g.name)).toEqual([...CHOSEN])
    expect(shadowPatterns.map((p) => [p.id, p.severity])).toEqual([['sop.guardrail.pgr_shadow', 'warn']])
    expect(enforcePatterns.map((p) => [p.id, p.severity])).toEqual([['sop.guardrail.pgr_enforce', 'block']])
    expect(shadowPatterns[0]!.argPattern).toBe(SHADOW_RULE.argPattern)
    // The .rules projection carries `warn` in column 2, so a v6 gate reads it as advisory.
    expect(readFileSync(snapshots.get('shadow')!, 'utf8')).toMatch(/^sop\.guardrail\.pgr_shadow\twarn\t/m)
  })

  for (const g of gates) {
    describe(`${g.name} (${g.runner})`, () => {
      it('is a writer that ran', () => {
        expect(roots.get(`${g.name}:error`), `the ${g.name} writer failed`).toBeUndefined()
      })

      it('SHADOW: logs tool_flagged naming the rule, then allows — and the allow is logged too, so the shadow period has a denominator', async () => {
        truncateAudit(g)
        const r = await runGate(g, 'shadow', 'Bash', { command: 'terraform apply -auto-approve' })
        expect(r.status, `exit ${r.status}\nstderr: ${r.stderr.slice(0, 400)}`).toBe(0)
        expect(r.stderr).not.toContain('BLOCKED')
        const events = auditEvents(g)
        const flagged = events.filter((e) => e.event === 'tool_flagged')
        expect(flagged, JSON.stringify(events)).toHaveLength(1)
        expect(flagged[0]!.reason).toContain('[sop.guardrail.pgr_shadow]')
        expect(flagged[0]!.reason).toContain(QUOTE.slice(0, 40))
        expect(flagged[0]!.toolName).toBe('Bash')
        expect(events.filter((e) => e.event === 'tool_allowed'), 'the writer must log the allow for the denominator').toHaveLength(1)
        expect(events.some((e) => e.event === 'tool_blocked')).toBe(false)
      })

      it('SHADOW: a call the rule does not match is allowed with nothing flagged', async () => {
        truncateAudit(g)
        const r = await runGate(g, 'shadow', 'Bash', { command: 'terraform plan' })
        expect(r.status).toBe(0)
        const events = auditEvents(g)
        expect(events.filter((e) => e.event === 'tool_flagged')).toHaveLength(0)
        expect(events.filter((e) => e.event === 'tool_allowed')).toHaveLength(1)
      })

      it('ENFORCING: the same rule exits 2 with the cited passage on stderr and logs tool_blocked', async () => {
        truncateAudit(g)
        const r = await runGate(g, 'enforce', 'Bash', { command: 'terraform apply -auto-approve' })
        expect(r.status, `exit ${r.status}\nstderr: ${r.stderr.slice(0, 400)}`).toBe(2)
        expect(r.stderr).toContain('[Intutic Governance] BLOCKED:')
        expect(r.stderr).toContain(QUOTE.slice(0, 40))
        expect(r.stderr).toContain('[sop.guardrail.pgr_enforce]')
        const events = auditEvents(g)
        expect(events.filter((e) => e.event === 'tool_blocked').map((e) => e.reason)[0]).toContain('[sop.guardrail.pgr_enforce]')
        expect(events.filter((e) => e.event === 'tool_allowed')).toHaveLength(0)
      })
    })
  }
})
