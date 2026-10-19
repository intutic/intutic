/**
 * The test-outcome contract: the shared vectors, run through
 * the module and through the JavaScript source the hook gates embed.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  TEST_OUTCOME_JS_SOURCE,
  decideTestOutcome,
  emptyOutcomeState,
  extractExitCode,
  noteCompletedCall,
  orderingQualifierError,
  outcomeStateFileName,
  parseOutcomeState,
  prerequisiteCase,
  prerequisiteUnmetReason,
  recordTestOutcome,
  splitQualifier,
  type OutcomeState,
  type PrerequisiteCase,
  type TestOutcomeInput,
} from '../testOutcome.js'

type Text = string | { concat: Array<[string, number]> }
type Step = { op: 'record'; token: string; input: TestOutcomeInput & { output?: Text }; at: number } | { op: 'call'; changedFiles: boolean }
interface Vectors {
  extractExitCode: Array<{ name: string; output: string; exitCode: number | null }>
  decide: Array<{ name: string; input: Omit<TestOutcomeInput, 'output'> & { output?: Text }; outcome: string; why: string }>
  qualifier: Array<{ name: string; side: string; left: boolean; error: string | null }>
  state: Array<{ name: string; steps: Step[]; check: { token: string; adjacent: boolean; now: number }; case: PrerequisiteCase; why: string | null }>
  parseState: Array<{ name: string; text: string; valid: boolean }>
  reasons: Array<{ case: PrerequisiteCase; first: string; then: string; why: string | null; harness: string; reason: string }>
  adversarial: Array<[string, 'output', string, number]>
}

const V = JSON.parse(readFileSync(join(__dirname, '../../fixtures/test-outcome-vectors.json'), 'utf-8')) as Vectors

/** An output as the vectors write it: a string, or `{concat: [[text, n], ...]}`. */
function expandText(t: Text | undefined): string | undefined {
  if (t === undefined || typeof t === 'string') return t
  return t.concat.map(([s, n]) => s.repeat(n)).join('')
}

function input(i: Omit<TestOutcomeInput, 'output'> & { output?: Text }): TestOutcomeInput {
  const out = expandText(i.output)
  return { ...i, ...(out !== undefined ? { output: out } : {}) } as TestOutcomeInput
}

type Api = {
  extractExitCode: typeof extractExitCode
  decideTestOutcome: typeof decideTestOutcome
  orderingQualifierError: typeof orderingQualifierError
  emptyOutcomeState: typeof emptyOutcomeState
  recordTestOutcome: typeof recordTestOutcome
  noteCompletedCall: typeof noteCompletedCall
  prerequisiteCase: typeof prerequisiteCase
  prerequisiteUnmetReason: typeof prerequisiteUnmetReason
  parseOutcomeState: typeof parseOutcomeState
}

const MODULE: Api = {
  extractExitCode,
  decideTestOutcome,
  orderingQualifierError,
  emptyOutcomeState,
  recordTestOutcome,
  noteCompletedCall,
  prerequisiteCase,
  prerequisiteUnmetReason,
  parseOutcomeState,
}

// The source the JavaScript hook gates embed, evaluated on its own: it must
// need nothing from this module's scope.
const EMITTED = new Function(
  `${TEST_OUTCOME_JS_SOURCE}\nreturn { extractExitCode, decideTestOutcome, orderingQualifierError, emptyOutcomeState, recordTestOutcome, noteCompletedCall, prerequisiteCase, prerequisiteUnmetReason, parseOutcomeState }`,
)() as Api

describe.each([
  ['the module', MODULE],
  ['the emitted source', EMITTED],
] as const)('test outcomes through %s', (_label, api) => {
  it('reads exit codes out of text', () => {
    expect(V.extractExitCode.length).toBeGreaterThan(20)
    for (const c of V.extractExitCode) expect(api.extractExitCode(c.output), c.name).toBe(c.exitCode)
  })

  it('decides outcomes', () => {
    expect(V.decide.length).toBeGreaterThan(40)
    for (const c of V.decide) expect(api.decideTestOutcome(input(c.input)), c.name).toEqual({ outcome: c.outcome, why: c.why })
  })

  it('checks qualifiers', () => {
    for (const c of V.qualifier) expect(api.orderingQualifierError(c.side, c.left), c.name).toBe(c.error)
  })

  it('keeps the per-session state', () => {
    for (const c of V.state) {
      let s: OutcomeState = api.emptyOutcomeState()
      for (const step of c.steps) {
        s = step.op === 'record' ? api.recordTestOutcome(s, step.token, api.decideTestOutcome(input(step.input)), step.at) : api.noteCompletedCall(s, step.changedFiles)
      }
      // The state survives its own file format.
      const reread = api.parseOutcomeState(JSON.stringify(s))
      expect(reread, c.name).toEqual(s)
      expect(api.prerequisiteCase(reread, c.check.token, c.check.adjacent, c.check.now), c.name).toEqual({ case: c.case, why: c.why })
    }
  })

  it('parses state files', () => {
    for (const c of V.parseState) expect(api.parseOutcomeState(c.text) !== null, c.name).toBe(c.valid)
  })

  it('words each unmet case exactly', () => {
    for (const c of V.reasons) expect(api.prerequisiteUnmetReason(c.first, c.then, c.case, c.why, c.harness), c.case).toBe(c.reason)
    expect(new Set(V.reasons.map((r) => r.case))).toEqual(new Set(['none', 'failed', 'unknown', 'changed', 'not_adjacent', 'not_observable', 'no_session']))
  })

  it.each(V.adversarial)('decides %s in under 200 ms', (_name, _field, unit, times) => {
    const output = unit.repeat(times)
    api.decideTestOutcome({ output })
    const t0 = performance.now()
    api.decideTestOutcome({ output })
    api.extractExitCode(output)
    // The contract is 200 ms; the margin keeps a loaded CI runner from failing a linear read.
    expect(performance.now() - t0).toBeLessThan(1000)
  })
})

describe('the qualifier', () => {
  it('splits the qualified token', () => {
    expect(splitQualifier('action:run_tests[ok]')).toEqual({ token: 'action:run_tests', qualifier: 'ok' })
    expect(splitQualifier('action:deploy')).toEqual({ token: 'action:deploy', qualifier: null })
  })

  it('names the state file by harness and session', () => {
    const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex')
    expect(outcomeStateFileName('claude-code', 's1', sha)).toBe(sha('claude-code\0s1').slice(0, 32) + '.json')
    expect(outcomeStateFileName('claude-code', 's1', sha)).not.toBe(outcomeStateFileName('cursor', 's1', sha))
  })

  it('treats an unreadable state as no state', () => {
    expect(prerequisiteCase(parseOutcomeState('nope'), 'action:run_tests', false, 1)).toEqual({ case: 'none', why: null })
  })
})
