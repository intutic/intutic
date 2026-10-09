import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { IntuticGateRefusal } from '../errors.js'
import { Gate } from '../gate.js'
import { ARGUMENTS_SIZE_LIMIT, COMMAND_SIZE_LIMIT, GATE_DEADLINE_MARGIN_MS, HOOK_TIMEOUT_SECONDS } from '../limits.js'
import { evaluate, loadSnapshot, SEV_BLOCK } from '../snapshot.js'
import { expectLinearTime } from './linearTime.js'
import { rulesText } from './fixtures/rulesFile.js'

// Every gate rule this reader can load, decided as the shared vectors say and
// in bounded time. packages/shared-types/fixtures/gate-rule-vectors.json is
// generated from the rule tables in the sync daemon, which runs the same
// cases through the hook gates' JavaScript, Python and grep; intutic-clawde
// runs them through its reader. Port of tests/test_gate_rule_vectors.py.

const FIXTURES = join(__dirname, '../../../shared-types/fixtures')
const SHARED_SEQUENCE = join(__dirname, '../../../shared-types/src/sequence.ts')

interface Call {
  tool: string
  input: Record<string, string>
}
interface Adversarial extends Call {
  name: string
  fill: string
  prefix: string
  unit: string
  suffix: string
  length: number
  held: boolean
}
interface VectorRule {
  id: string
  subject: string
  line: string
  argPattern: boolean
  held: Call[]
  benign: Call[]
  adversarial: Adversarial[]
}
const VECTORS = JSON.parse(readFileSync(join(FIXTURES, 'gate-rule-vectors.json'), 'utf-8')) as {
  limits: { commandBytes: number; argumentsBytes: number; hookTimeoutSeconds: number; deadlineMarginMs: number }
  rules: VectorRule[]
}

/**
 * The rules a `.rules` reader decides on its own: not `content` (the
 * serialized arguments, which this reader has no subject for — those rules
 * live in the hook gates' compiled floor) and not one with an argument
 * condition (which this reader does not read; see snapshot.ts).
 */
const READABLE = VECTORS.rules.filter((v) => v.subject !== 'content' && !v.argPattern)

/** The adversarial text, `length` characters at most; a quarter of that at scale 1. */
function buildText(c: Adversarial, scale: 1 | 4 = 4): string {
  const length = (c.length / 4) * scale
  return c.prefix + c.unit.repeat(Math.floor((length - c.prefix.length - c.suffix.length) / c.unit.length)) + c.suffix
}

const dir = mkdtempSync(join(tmpdir(), 'gate-rule-vectors-'))

function decide(v: VectorRule, call: Call): boolean {
  const path = join(dir, `${v.id}.rules`)
  writeFileSync(path, rulesText([v.line]))
  const snap = loadSnapshot('', path)
  expect(snap.rules.length, `${v.id} did not load`).toBe(1)
  const d = evaluate(call.tool, call.input.file_path ?? '', call.input.command ?? '', snap)
  return d.severity === SEV_BLOCK
}

describe('gate rule vectors', () => {
  it('load every rule a snapshot reader can decide', () => {
    expect(READABLE.length).toBeGreaterThan(30)
  })

  it.each(READABLE.map((v) => [v.id, v] as const))('%s: held, benign and adversarial cases', (_id, v) => {
    for (const [k, call] of v.held.entries()) expect(decide(v, call), `${v.id} held[${k}]`).toBe(true)
    for (const [k, call] of v.benign.entries()) expect(decide(v, call), `${v.id} benign[${k}]`).toBe(false)
    for (const c of v.adversarial) {
      const calls = {
        1: { tool: c.tool, input: { ...c.input, [c.fill]: buildText(c, 1) } },
        4: { tool: c.tool, input: { ...c.input, [c.fill]: buildText(c, 4) } },
      }
      expect(decide(v, calls[4]), `${v.id} adversarial "${c.name}"`).toBe(c.held)
      expectLinearTime(`${v.id} adversarial "${c.name}"`, (scale) => decide(v, calls[scale]))
    }
  })

  it('use the shared limits', () => {
    expect({
      commandBytes: COMMAND_SIZE_LIMIT,
      argumentsBytes: ARGUMENTS_SIZE_LIMIT,
      hookTimeoutSeconds: HOOK_TIMEOUT_SECONDS,
      deadlineMarginMs: GATE_DEADLINE_MARGIN_MS,
    }).toEqual(VECTORS.limits)
  })

  it('run sequence rules with a byte-identical copy of the shared matcher', () => {
    expect(readFileSync(join(__dirname, '../sequence.ts'), 'utf-8')).toBe(readFileSync(SHARED_SEQUENCE, 'utf-8'))
  })
})

describe('the size limit', () => {
  // No snapshot, no control plane: only the size check can refuse.
  const saved = process.env.INTUTIC_SNAPSHOT_RULES
  beforeAll(() => {
    process.env.INTUTIC_SNAPSHOT_RULES = join(dir, 'absent.rules')
  })
  afterAll(() => {
    if (saved === undefined) delete process.env.INTUTIC_SNAPSHOT_RULES
    else process.env.INTUTIC_SNAPSHOT_RULES = saved
  })
  const gate = () => new Gate({ workspaceId: 'ws', enforce: true, useSopRules: false, useHookGate: false })

  it('refuses a command over it as COMMAND_TOO_LARGE, before any tier', async () => {
    const err = await gate()
      .guard('Bash', { command: 'é'.repeat(COMMAND_SIZE_LIMIT / 2 + 1) })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(IntuticGateRefusal)
    expect((err as IntuticGateRefusal).code).toBe('COMMAND_TOO_LARGE')
  })

  it('refuses arguments over it as COMMAND_TOO_LARGE', async () => {
    const err = await gate()
      .guard('Write', { file_path: 'notes.md', content: 'x'.repeat(ARGUMENTS_SIZE_LIMIT) })
      .catch((e: unknown) => e)
    expect((err as IntuticGateRefusal).code).toBe('COMMAND_TOO_LARGE')
  })

  it('evaluates a command at it', async () => {
    await expect(gate().guard('Bash', { command: 'x'.repeat(COMMAND_SIZE_LIMIT) })).resolves.toBeUndefined()
  })
})
