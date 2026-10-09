/**
 * The hold classifier: which shell commands a `review_before: action:*` hold
 * catches, in both emitted dialects — the JavaScript the JS gates run and the
 * Python the bash gates' extractor runs (`GATE_PY_LIB`).
 *
 * It matched each needle as a plain substring, so anything that separated two
 * words without being exactly one space dodged the hold. A gap regex fixed
 * that and then took seconds in the JS gates, and a minute in bash, on a few
 * hundred kilobytes of crafted command; both dialects now run the linear
 * phrase matcher, and must agree with each other and with every other
 * classifier on the shared vectors.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ACTION_NEEDLES, GATE_PY_LIB, emitJsActionClassifier } from '../../src/harness/gateBody.js'
import { PHRASES_PY_SOURCE } from '../../src/lib/phrasesPy.js'

/**
 * The vectors every command classifier shares — the proxy's actions.rs,
 * `@intutic/gate`, intutic-clawde and this one — so all of them hold the same
 * spellings. The hold classifier knows four tokens; a vector that classifies
 * only to others (`npm\ttest` is a test run) must classify to none here.
 *
 * Among the near-misses (`notHeld`), each names a needle's word without the
 * needle: a hold on a command nobody is running teaches people to disable the
 * hook. What no classifier avoids, because the rule's intent does not allow
 * it: a needle quoted inside another command (`echo "drop table"`) is held —
 * a text classifier cannot tell quoting from the shell carrying a statement to
 * a client.
 */
const VECTORS = JSON.parse(
  readFileSync(join(__dirname, '../../../../packages/proxy/src/plugins/anomaly/action_vectors.json'), 'utf-8'),
) as { held: Array<[string, string[]]>; notHeld: string[]; adversarial: Array<[string, number]> }
const HOLD_TOKENS = new Set(ACTION_NEEDLES.map(([a]) => a))
const forHold = (tokens: string[]) => tokens.filter((t) => HOLD_TOKENS.has(t)).join(' ')
const HELD: ReadonlyArray<readonly [string, string]> = VECTORS.held
  .map(([c, t]) => [c, forHold(t)] as const)
  .filter(([, t]) => t !== '')
const NOT_HELD: readonly string[] = [...VECTORS.notHeld, ...VECTORS.held.filter(([, t]) => forHold(t) === '').map(([c]) => c)]

/**
 * Runs `GATE_PY_LIB` the way the extractor does and returns, per input, the
 * action string and the milliseconds the classifier took — the best of three
 * runs, measured inside Python, so neither interpreter start-up nor a busy
 * machine is counted against it.
 */
function pythonActions(inputs: ReadonlyArray<readonly [string, string]>): Promise<Array<[string, number]>> {
  const program = [
    'import json, os, sys, time',
    'lib = {}',
    'exec(os.environ["INTUTIC_PY_LIB"], lib)',
    'out = []',
    'for tool, command in json.load(sys.stdin):',
    '    best = None',
    '    for _ in range(3):',
    '        t0 = time.perf_counter()',
    '        a = lib["intutic_actions"](tool, command)',
    '        took = (time.perf_counter() - t0) * 1000',
    '        best = took if best is None else min(best, took)',
    '    out.append([a, best])',
    'print(json.dumps(out))',
  ].join('\n')
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', program], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, INTUTIC_PY_LIB: GATE_PY_LIB },
    })
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => (out += d))
    child.stderr.on('data', (d: string) => (err += d))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`python classifier exited ${code}: ${err}`))
      resolve(JSON.parse(out) as Array<[string, number]>)
    })
    child.stdin.end(JSON.stringify(inputs))
  })
}

const jsActions = new Function(`${emitJsActionClassifier()}\nreturn intuticActions;`)() as (
  tool: string,
  command: string,
) => string

const tokens = (s: string) => s.trim().split(/\s+/).filter(Boolean).join(' ')

const ALL = [...HELD.map(([c]) => c), ...NOT_HELD]
const ADVERSARIAL = VECTORS.adversarial.map(([unit, times]) => unit.repeat(times))
let python: Map<string, string>
let pythonAdversarialMs: number[]
let pythonWrite: string

beforeAll(async () => {
  const out = await pythonActions([
    ...ALL.map((c) => ['Bash', c] as const),
    ...ADVERSARIAL.map((c) => ['Bash', c] as const),
    ['Write', 'git push'] as const,
  ])
  python = new Map(ALL.map((c, i) => [c, out[i]![0]]))
  pythonAdversarialMs = ADVERSARIAL.map((_, i) => out[ALL.length + i]![1])
  pythonWrite = out[out.length - 1]![0]
})

describe('the hold classifier', () => {
  it('reads the shared vectors', () => {
    expect(HELD.length).toBeGreaterThan(20)
    expect(NOT_HELD.length).toBeGreaterThan(10)
    expect(ADVERSARIAL.length).toBeGreaterThan(5)
  })

  it.each(HELD)('holds %j as %s', (command, expected) => {
    expect(tokens(python.get(command)!), 'bash gate (Python)').toBe(expected)
    expect(tokens(jsActions('Bash', command)), 'JS gate').toBe(expected)
  })

  it.each(NOT_HELD)('does not hold %j', (command) => {
    expect(tokens(python.get(command)!), 'bash gate (Python)').toBe('')
    expect(tokens(jsActions('Bash', command)), 'JS gate').toBe('')
  })

  it.each(VECTORS.adversarial.map(([unit, times], i) => [unit, times, i] as const))(
    'classifies %j repeated %i times in under 200 ms in both dialects',
    (_unit, _times, i) => {
      let best = Infinity
      for (let run = 0; run < 3; run++) {
        const t0 = performance.now()
        jsActions('Bash', ADVERSARIAL[i]!)
        best = Math.min(best, performance.now() - t0)
      }
      // The best of three runs: the bound is on the matcher, not on a busy machine.
      expect(best, 'JS gate').toBeLessThan(200)
      expect(pythonAdversarialMs[i], 'bash gate (Python)').toBeLessThan(200)
    },
  )

  it('classifies shell tools only', () => {
    expect(jsActions('Write', 'git push')).toBe(' ')
    expect(pythonWrite).toBe(' ')
  })

  it('emits a byte-identical copy of intutic-clawde’s phrases.py', () => {
    const clawde = readFileSync(join(__dirname, '../../../../packages/intutic-clawde/intutic_clawde/gate/phrases.py'), 'utf-8')
    expect(PHRASES_PY_SOURCE).toBe(clawde)
  })
})
