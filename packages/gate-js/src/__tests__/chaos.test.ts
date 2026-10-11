/**
 * A chaos run's faults in the gate SDK, held to the table every gate runs:
 * `packages/shared-types/fixtures/chaos-gate-vectors.json`.
 *
 * The decisions governance makes come first: every vector replays through
 * this package's copy of the chaos functions as the vectors give them, and
 * every vector whose calls governance allows replays end to end through
 * `Gate.guard`, the plan and events file in the environment as a chaos run's
 * runner sets them. Then `Gate.guard`'s own refusals, holds and destructive
 * calls, from a snapshot.
 */
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chaosGateCall, chaosGateDecode, type ChaosGateCall } from '../chaosGate.js'
import { IntuticGateHold, IntuticGateRefusal } from '../errors.js'
import { Gate } from '../gate.js'
import * as snapshotMod from '../snapshot.js'

const FIXTURES = join(__dirname, '../../../shared-types/fixtures')

interface VectorCall extends ChaosGateCall {
  input?: Record<string, unknown>
  advanceS?: number
  outcome: string
  reason?: string
}
interface Vectors {
  valid: Array<{ name: string; plan: unknown; calls: VectorCall[]; events: Array<Record<string, unknown>> }>
  invalid: Array<{ name: string; plan?: unknown; raw?: string }>
}
const VECTORS = JSON.parse(readFileSync(join(FIXTURES, 'chaos-gate-vectors.json'), 'utf-8')) as Vectors

const encode = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
const expected = (c: VectorCall) => ({ outcome: c.outcome, ...(c.reason !== undefined ? { reason: c.reason } : {}) })
const HELD = 'Permission held for approval; retrying this exact call passes once it is approved [E-INTUTIC-C0FFEE]'
const BASE = { v: 1, runId: 'run_gate_sdk', repetition: 1, canary: 'E-INTUTIC-C0FFEE' }

/** Moves the clock forward: every counter file's modification time goes back by `seconds`. */
function advanceClock(events: string, seconds: number): void {
  const dir = events + '.gate-counters'
  if (!seconds || !existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    const t = statSync(join(dir, name)).mtimeMs / 1000 - seconds
    utimesSync(join(dir, name), t, t)
  }
}

/** The events file's lines without `ts`, `runId` and `component`, which are checked here. */
function readEvents(events: string, runId: string): Array<Record<string, unknown>> {
  if (!existsSync(events)) return []
  return readFileSync(events, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const { ts, runId: r, component, ...rest } = JSON.parse(l) as Record<string, unknown>
      expect(ts).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
      expect(r).toBe(runId)
      expect(component).toBe('gate')
      return rest
    })
}

/** A harmless input for each tool the vectors use. */
function benign(tool: string): Record<string, unknown> {
  return tool === 'Bash' ? { command: 'ls -la' } : tool === 'Write' ? { file_path: 'notes.txt', content: 'hello' } : { title: 'x' }
}

let dir: string
const saved = { ...process.env }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'intutic-gate-chaos-'))
  process.env.INTUTIC_SNAPSHOT_RULES = join(dir, 'absent.rules')
  delete process.env.INTUTIC_GUARD_DISABLE
})

afterEach(() => {
  process.env = { ...saved }
  rmSync(dir, { recursive: true, force: true })
})

/** A gate under a chaos run: the plan and a fresh events file in the environment, no client. */
function chaosGate(plan: unknown, raw?: string): { gate: Gate; events: string } {
  const events = join(dir, `events-${Math.random().toString(36).slice(2)}.jsonl`)
  process.env.INTUTIC_CHAOS_PLAN = raw ?? encode(plan)
  process.env.INTUTIC_CHAOS_EVENTS = events
  return { gate: new Gate({ repoRoot: dir, useHookGate: false, useSopRules: false }, null), events }
}

/** What a guarded call ended as, in the vectors' terms. */
async function outcome(gate: Gate, tool: string, input: Record<string, unknown>) {
  try {
    await gate.guard(tool, input)
    return { outcome: 'allow' }
  } catch (err) {
    if (err instanceof IntuticGateHold) return { outcome: 'hold', reason: err.reason, holdId: err.holdId }
    if (err instanceof IntuticGateRefusal) return { outcome: 'deny', reason: err.reason, code: err.code }
    throw err
  }
}

it('carries a byte-identical copy of the shared chaos module', () => {
  expect(readFileSync(join(__dirname, '../chaosGate.ts'), 'utf-8')).toBe(
    readFileSync(join(__dirname, '../../../shared-types/src/chaosGate.ts'), 'utf-8'),
  )
})

describe('the shared vectors, as the vectors decide', () => {
  it.each(VECTORS.valid.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    const events = join(dir, 'events.jsonl')
    const got = v.calls.map((c) => {
      advanceClock(events, c.advanceS ?? 0)
      const decoded = chaosGateDecode(encode(v.plan))
      if (!decoded.plan) throw new Error(decoded.error)
      const key = createHash('sha256').update(c.tool + '\0' + JSON.stringify(c.input ?? null)).digest('hex')
      const fault = chaosGateCall(fs, decoded.plan, events, { ...c, key }, new Date().toISOString())
      return fault ? { outcome: fault.kind, reason: fault.reason } : { outcome: c.decision }
    })
    expect(got).toEqual(v.calls.map(expected))
    expect(readEvents(events, (v.plan as { runId: string }).runId)).toEqual(v.events)
  })

  it.each(VECTORS.invalid.map((v) => [v.name, v] as const))('refuses %s', (_name, v) => {
    const d = chaosGateDecode(v.raw ?? encode(v.plan))
    expect(d.plan).toBeNull()
    expect(d.error).toMatch(/^INTUTIC_CHAOS_PLAN is not/)
  })
})

// Every vector whose calls governance allows as they are.
const REPLAYABLE = VECTORS.valid.filter((v) =>
  v.calls.every((c) => c.decision === 'allow' && !c.ruleId && !c.destructive && !c.policyHit),
)

describe('Gate.guard under a chaos run', () => {
  it.each(REPLAYABLE.map((v) => [v.name, v] as const))('replays %s', async (_name, v) => {
    const { gate, events } = chaosGate(v.plan)
    for (const c of v.calls) {
      advanceClock(events, c.advanceS ?? 0)
      const got = await outcome(gate, c.tool, c.input ?? benign(c.tool))
      expect({ outcome: got.outcome, ...(got.reason !== undefined ? { reason: got.reason } : {}) }).toEqual(expected(c))
      // A fault is never a governance code, and a held call has nothing to approve.
      if (got.outcome === 'deny') expect(got.code).toBe('CHAOS_FAULT')
      if (got.outcome === 'hold') expect(got.holdId).toBeUndefined()
    }
    expect(readEvents(events, (v.plan as { runId: string }).runId)).toEqual(v.events)
  })

  it('replays at least the delay, hold and tool.error vectors', () => {
    expect(REPLAYABLE.length).toBeGreaterThanOrEqual(7)
  })

  it('refuses every call under a plan it cannot read, and reports nothing', async () => {
    for (const v of VECTORS.invalid) {
      const { gate, events } = chaosGate(null, v.raw ?? encode(v.plan))
      const got = await outcome(gate, 'Bash', benign('Bash'))
      expect(got.outcome, v.name).toBe('deny')
      expect(got.code, v.name).toBe('CHAOS_FAULT')
      expect(got.reason, v.name).toMatch(/^INTUTIC_CHAOS_PLAN is not/)
      expect(existsSync(events), v.name).toBe(false)
    }
  })

  it('refuses a plan with no events file to report to', async () => {
    process.env.INTUTIC_CHAOS_PLAN = encode({ ...BASE, faults: [] })
    delete process.env.INTUTIC_CHAOS_EVENTS
    const got = await outcome(new Gate({ useHookGate: false, useSopRules: false }, null), 'Bash', benign('Bash'))
    expect(got).toMatchObject({ outcome: 'deny', code: 'CHAOS_FAULT' })
    expect(got.reason).toContain('INTUTIC_CHAOS_EVENTS is not')
  })

  it('changes nothing without a plan', async () => {
    delete process.env.INTUTIC_CHAOS_PLAN
    delete process.env.INTUTIC_CHAOS_EVENTS
    expect(await outcome(new Gate({ useHookGate: false, useSopRules: false }, null), 'Bash', benign('Bash'))).toEqual({ outcome: 'allow' })
  })

  it('throws the hold and the fault with the messages a hook gate prints', async () => {
    const held = chaosGate({ ...BASE, faults: [{ id: 'permission.deny_or_delay', mode: 'delay', delay_s: 600 }] }).gate
    await expect(held.guard('Bash', benign('Bash'))).rejects.toThrow(`[Intutic Governance] HELD: ${HELD}`)
    const failed = chaosGate({ ...BASE, faults: [{ id: 'tool.error', message: 'disk full' }] }).gate
    await expect(failed.guard('Bash', benign('Bash'))).rejects.toThrow('[Intutic Governance] BLOCKED: disk full [E-INTUTIC-C0FFEE]')
  })

  it('reports governance’s own decisions, and faults only what it allowed', async () => {
    const { gate, events } = chaosGate({ ...BASE, faults: [{ id: 'tool.error', message: 'disk full' }] })
    const snap = new snapshotMod.Snapshot()
    snap.state = 'ok'
    snap.rules = [
      { id: 'sop.local.review_before.notebookedit', severity: 'hold', subject: 'tool', reason: 'review notebooks', pattern: /notebookedit/i },
      { id: 'sop.s_edit', severity: 'block', subject: 'tool', reason: 'no edits', pattern: /edit/i },
      { id: 'destructive.sql_drop', severity: 'block', subject: 'command', reason: 'drops a table', pattern: /drop table/i },
      { id: 'destructive.rm_rf_root', severity: 'warn', subject: 'command', reason: 'removes everything', pattern: /rm -rf \// },
    ]
    ;(gate as unknown as { _snapshot: snapshotMod.Snapshot })._snapshot = snap

    expect(await outcome(gate, 'Edit', { file_path: 'a.txt' })).toMatchObject({ outcome: 'deny', code: 'SNAPSHOT' })
    // A hold with no control plane to record it in: held, nothing to approve.
    expect(await outcome(gate, 'NotebookEdit', { notebook_path: 'a.ipynb' })).toMatchObject({ outcome: 'hold', holdId: undefined })
    // A destructive command at the warn tier: allowed by governance, then faulted.
    expect(await outcome(gate, 'Bash', { command: 'rm -rf /' })).toEqual({
      outcome: 'deny',
      reason: 'disk full [E-INTUTIC-C0FFEE]',
      code: 'CHAOS_FAULT',
    })
    expect(await outcome(gate, 'Bash', { command: 'psql -c "DROP TABLE users"' })).toMatchObject({ outcome: 'deny', code: 'SNAPSHOT' })
    // Too large to read: refused before any tier, by no rule.
    expect(await outcome(gate, 'Bash', { command: 'x'.repeat(300 * 1024) })).toMatchObject({ outcome: 'deny', code: 'COMMAND_TOO_LARGE' })

    expect(readEvents(events, BASE.runId)).toEqual([
      { type: 'plan_loaded', faults: 1 },
      { type: 'gate_decision', tool: 'Edit', decision: 'deny', ruleId: 'sop.s_edit', destructive: false, policyHit: true },
      { type: 'gate_decision', tool: 'NotebookEdit', decision: 'hold', ruleId: 'sop.local.review_before.notebookedit', destructive: false, policyHit: true },
      { type: 'gate_decision', tool: 'Bash', decision: 'allow', ruleId: 'destructive.rm_rf_root', destructive: true, policyHit: false },
      { type: 'fault_injected', faultId: 'tool.error', call: 1, target: 'Bash' },
      { type: 'gate_decision', tool: 'Bash', decision: 'deny', ruleId: 'destructive.sql_drop', destructive: true, policyHit: true },
      { type: 'gate_decision', tool: 'Bash', decision: 'deny', destructive: false, policyHit: false },
    ])
  })

  it('sees a destructive command the escape hatch lets through', async () => {
    process.env.INTUTIC_GUARD_DISABLE = '1'
    const { gate, events } = chaosGate({ ...BASE, faults: [] })
    const snap = new snapshotMod.Snapshot()
    snap.state = 'ok'
    snap.rules = [{ id: 'destructive.rm_rf_root', severity: 'block', subject: 'command', reason: 'removes everything', pattern: /rm -rf \// }]
    ;(gate as unknown as { _snapshot: snapshotMod.Snapshot })._snapshot = snap
    expect(await outcome(gate, 'Bash', { command: 'rm -rf /' })).toEqual({ outcome: 'allow' })
    expect(readEvents(events, BASE.runId)).toEqual([
      { type: 'plan_loaded', faults: 0 },
      { type: 'gate_decision', tool: 'Bash', decision: 'allow', destructive: true, policyHit: false },
      { type: 'tool_call', tool: 'Bash', ok: true },
    ])
  })

  it('keys a held call by its tool and its arguments, whatever their order', async () => {
    const { gate, events } = chaosGate({ ...BASE, faults: [{ id: 'permission.deny_or_delay', mode: 'delay', delay_s: 30 }] })
    expect((await outcome(gate, 'Write', { file_path: 'a.txt', content: 'x' })).outcome).toBe('hold')
    advanceClock(events, 30)
    // The same arguments in another order: the held call's retry.
    expect((await outcome(gate, ' write ', { content: 'x', file_path: 'a.txt' })).outcome).toBe('allow')
  })
})
