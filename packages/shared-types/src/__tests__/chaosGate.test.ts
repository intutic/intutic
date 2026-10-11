import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ChaosEventSchema, FAULT_IDS, decodeChaosPlan, encodeChaosPlan, ChaosPlanSchema } from '../chaos.js'
import { CHAOS_GATE_JS_SOURCE, chaosGateCall, chaosGateDecode, type ChaosGateCall } from '../chaosGate.js'

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

const VECTORS = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../fixtures/chaos-gate-vectors.json'), 'utf8'),
) as Vectors

/** base64url of any JSON, valid plan or not. */
function encodeAny(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function rawOf(v: { plan?: unknown; raw?: string }): string {
  return v.raw ?? encodeAny(v.plan)
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

/** Replays a case against a fresh events file: what each call ended as, and the events. */
function replay(raw: string, calls: VectorCall[]) {
  const dir = mkdtempSync(join(tmpdir(), 'chaos-gate-'))
  const events = join(dir, 'events.jsonl')
  const outcomes = calls.map((c) => {
    advanceClock(events, c.advanceS ?? 0)
    // Decoded on every call, as a gate process does.
    const decoded = chaosGateDecode(raw)
    if (!decoded.plan) throw new Error(decoded.error)
    // Any digest of the tool and its input: an identical call has the same one.
    const key = createHash('sha256').update(c.tool + '\0' + JSON.stringify(c.input ?? null)).digest('hex')
    const fault = chaosGateCall(fs, decoded.plan, events, { ...c, key }, new Date().toISOString())
    if (!fault) return { outcome: c.decision }
    return { outcome: fault.kind, reason: fault.reason }
  })
  const lines = readFileSync(events, 'utf8').split('\n').filter(Boolean)
  return { outcomes, lines }
}

describe('chaos gate vectors', () => {
  it.each(VECTORS.valid.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    const plan = ChaosPlanSchema.parse(v.plan)
    const { outcomes, lines } = replay(encodeChaosPlan(plan), v.calls)
    expect(outcomes).toEqual(
      v.calls.map((c) => ({
        outcome: c.outcome,
        ...(c.reason !== undefined ? { reason: c.reason } : {}),
      })),
    )
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>)
    for (const [i, e] of parsed.entries()) {
      expect(ChaosEventSchema.safeParse(e).success, lines[i]).toBe(true)
      expect(e.ts).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
      expect(e.runId).toBe(plan.runId)
      expect(e.component).toBe('gate')
    }
    expect(parsed.map(({ ts: _ts, runId: _r, component: _c, ...rest }) => rest)).toEqual(v.events)
  })

  it.each(VECTORS.invalid.map((v) => [v.name, v] as const))('refuses %s', (_name, v) => {
    const d = chaosGateDecode(rawOf(v))
    expect(d.plan).toBeNull()
    expect(d.error).toMatch(/^INTUTIC_CHAOS_PLAN is not/)
    // The contract's own decoder agrees.
    expect(() => decodeChaosPlan(rawOf(v))).toThrow()
  })

  it('knows every fault the catalog does, and nothing else', () => {
    for (const id of FAULT_IDS) {
      const raw = encodeAny({ v: 1, runId: 'run_catalog', repetition: 0, canary: 'E-INTUTIC-C0FFEE', faults: [{ id }] })
      expect(chaosGateDecode(raw).error, id).toBeNull()
    }
  })

  it('reads padded base64url and the encoder the runner uses', () => {
    const plan = { v: 1, runId: 'run_padding', repetition: 0, canary: 'E-INTUTIC-C0FFEE', faults: [] }
    const unpadded = encodeAny(plan)
    expect(chaosGateDecode(unpadded + '='.repeat((4 - (unpadded.length % 4)) % 4)).error).toBeNull()
    expect(chaosGateDecode(encodeChaosPlan(ChaosPlanSchema.parse(plan))).plan?.runId).toBe('run_padding')
  })

  it('never throws on an events file it cannot write, and still decides', () => {
    const decoded = chaosGateDecode(encodeAny(VECTORS.valid[2]!.plan))
    const events = join(tmpdir(), 'no-such-dir-' + process.pid, 'events.jsonl')
    const fault = chaosGateCall(fs, decoded.plan!, events, { tool: 'Bash', decision: 'allow', destructive: false, policyHit: false }, 'x')
    // The counters live beside the events file, and cannot be kept either: no fault is due.
    expect(fault).toBeNull()
  })

  it('is self-contained source a gate can run', () => {
    const run = new Function(
      'fs',
      'raw',
      'events',
      `${CHAOS_GATE_JS_SOURCE}\nconst d = chaosGateDecode(raw); return chaosGateCall(fs, d.plan, events, { tool: 'Bash', decision: 'allow', destructive: false, policyHit: false }, 'now');`,
    ) as (f: typeof fs, raw: string, events: string) => { reason: string } | null
    const dir = mkdtempSync(join(tmpdir(), 'chaos-gate-src-'))
    const out = run(fs, encodeAny(VECTORS.valid[2]!.plan), join(dir, 'events.jsonl'))
    expect(out?.reason).toBe('tool failed [E-INTUTIC-C0FFEE]')
    expect(CHAOS_GATE_JS_SOURCE).not.toMatch(/\bimport\b|\brequire\(/)
  })
})
