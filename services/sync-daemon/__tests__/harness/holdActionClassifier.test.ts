/**
 * The hold classifier: which shell commands a `review_before: action:*` hold
 * catches, in both emitted dialects.
 *
 * It matched each needle as a plain substring, so anything that separated two
 * words without being exactly one space dodged the hold — `DROP/**\/TABLE`, a
 * `--` comment, an escaped `\n`, a line continuation, and in the JS gates
 * (which read the raw command) a tab or a doubled space. Each row below runs
 * through the emitted bash AND the emitted JS classifier, and the two must
 * agree, since every harness runs one or the other.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ACTION_CLASSIFIER,
  emitJsActionClassifier,
  emitShellActionClassifier,
} from '../../src/harness/gateBody.js'
import { NORMALISE_CONTRACT, assertPortableEre } from '../../src/harness/protectedPaths.js'

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
) as { held: Array<[string, string[]]>; notHeld: string[] }
const HOLD_TOKENS = new Set(ACTION_CLASSIFIER.map(([a]) => a))
const forHold = (tokens: string[]) => tokens.filter((t) => HOLD_TOKENS.has(t)).join(' ')
const HELD: ReadonlyArray<readonly [string, string]> = VECTORS.held
  .map(([c, t]) => [c, forHold(t)] as const)
  .filter(([, t]) => t !== '')
const NOT_HELD: readonly string[] = [...VECTORS.notHeld, ...VECTORS.held.filter(([, t]) => forHold(t) === '').map(([c]) => c)]

/** Runs every command through the emitted bash classifier in one process. */
function bashActions(commands: readonly string[]): Promise<string[]> {
  const script = [
    'set -euo pipefail',
    NORMALISE_CONTRACT.shell,
    emitShellActionClassifier(),
    'for c in "$@"; do intutic_actions Bash "$c"; printf "\\0"; done',
  ].join('\n')
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', script, 'classifier', ...commands], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => (out += d))
    child.stderr.on('data', (d: string) => (err += d))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`bash classifier exited ${code}: ${err}`))
      resolve(out.split('\0').slice(0, commands.length))
    })
  })
}

const jsActions = new Function(
  `${NORMALISE_CONTRACT.jsSource}\n${emitJsActionClassifier()}\nreturn intuticActions;`,
)() as (tool: string, command: string) => string

const tokens = (s: string) => s.trim().split(/\s+/).filter(Boolean).join(' ')

const ALL = [...HELD.map(([c]) => c), ...NOT_HELD]
let bash: Map<string, string>

beforeAll(async () => {
  const out = await bashActions(ALL)
  bash = new Map(ALL.map((c, i) => [c, out[i]!]))
})

describe('the hold classifier', () => {
  it('reads the shared vectors', () => {
    expect(HELD.length).toBeGreaterThan(20)
    expect(NOT_HELD.length).toBeGreaterThan(10)
  })

  it('ships patterns every gate dialect reads alike', () => {
    expect(ACTION_CLASSIFIER.map(([a]) => a)).toEqual(['action:deploy', 'action:publish', 'action:release', 'action:db_write'])
    for (const [action, source] of ACTION_CLASSIFIER) {
      expect(() => assertPortableEre(source, action)).not.toThrow()
    }
  })

  it.each(HELD)('holds %j as %s', (command, expected) => {
    expect(tokens(bash.get(command)!), 'bash gate').toBe(expected)
    expect(tokens(jsActions('Bash', command)), 'JS gate').toBe(expected)
  })

  it.each(NOT_HELD)('does not hold %j', (command) => {
    expect(tokens(bash.get(command)!), 'bash gate').toBe('')
    expect(tokens(jsActions('Bash', command)), 'JS gate').toBe('')
  })

  it('classifies shell tools only', async () => {
    expect(jsActions('Write', 'git push')).toBe(' ')
    const out = await new Promise<string>((resolve, reject) => {
      const script = `${NORMALISE_CONTRACT.shell}\n${emitShellActionClassifier()}\nintutic_actions Write 'git push'`
      const child = spawn('bash', ['-c', script], { stdio: ['ignore', 'pipe', 'inherit'] })
      let o = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (d: string) => (o += d))
      child.on('error', reject)
      child.on('close', () => resolve(o))
    })
    expect(out).toBe(' ')
  })
})
