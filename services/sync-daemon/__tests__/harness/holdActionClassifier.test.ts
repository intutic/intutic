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
import {
  ACTION_CLASSIFIER,
  emitJsActionClassifier,
  emitShellActionClassifier,
} from '../../src/harness/gateBody.js'
import { NORMALISE_CONTRACT, assertPortableEre } from '../../src/harness/protectedPaths.js'

/** Commands a hold must catch, with the tokens they classify to. */
const HELD: ReadonlyArray<readonly [string, string]> = [
  // The plain spellings, still held.
  ['git push origin main', 'action:deploy'],
  ['psql -c "DROP TABLE users"', 'action:db_write'],
  // db_write: what the database reads as a word break.
  ['psql -c "DROP\tTABLE users"', 'action:db_write'],
  ['psql -c "DROP  TABLE users"', 'action:db_write'],
  ['psql -c "DROP\nTABLE users"', 'action:db_write'],
  ['psql -c "DROP/**/TABLE users"', 'action:db_write'],
  ['psql -c "DROP /* why */ TABLE users"', 'action:db_write'],
  ['psql -c "DROP -- why\nTABLE users"', 'action:db_write'],
  ["printf 'DROP\\nTABLE users' | psql", 'action:db_write'],
  ['psql -c "DROP \\\nTABLE users"', 'action:db_write'],
  ['psql -c "INSERT/**/INTO t VALUES (1)"', 'action:db_write'],
  ['psql -c "DELETE\tFROM t"', 'action:db_write'],
  ['psql -c "ALTER/**/TABLE t ADD c int"', 'action:db_write'],
  ['psql -c "UPDATE\tusers SET a = 1"', 'action:db_write'],
  ['psql -c "TRUNCATE/**/events"', 'action:db_write'],
  // deploy / publish / release: what the shell reads as a word break.
  ['kubectl\tapply -f deploy.yaml', 'action:deploy'],
  ['git  push origin main', 'action:deploy'],
  ['git \\\npush origin main', 'action:deploy'],
  ['GIT\tPUSH origin main', 'action:deploy'],
  ['terraform\tapply -auto-approve', 'action:deploy'],
  ['helm  upgrade web ./chart', 'action:deploy'],
  ['gcloud run\tdeploy web', 'action:deploy'],
  ['docker\tpush registry/web:1', 'action:deploy'],
  // A long option between the words is still the same command.
  ['git --no-pager push origin main', 'action:deploy'],
  ['kubectl --context prod apply -f deploy.yaml', 'action:deploy'],
  ['npm\tpublish --access public', 'action:publish'],
  ['docker manifest  push registry/web:1', 'action:publish'],
  ['gh release\tcreate v1.0.0', 'action:release'],
  ['git\ttag v1.0.0', 'action:release'],
  // Two actions in one command are both reported, in needle order.
  ['psql -c "DROP/**/TABLE t" && git\tpush', 'action:deploy action:db_write'],
]

/**
 * Near-misses that must stay unheld. Every one of them names a needle's word
 * without the needle: the classifier is about commands, and a hold on a
 * command nobody is running teaches people to disable the hook.
 *
 * What the classifier deliberately does NOT avoid, because the rule's intent
 * does not allow it: a needle quoted inside some other command
 * (`echo "drop table"`) is held, as it is at the proxy — a text classifier
 * cannot tell quoting from the shell carrying a statement to a client.
 */
const NOT_HELD: readonly string[] = [
  'git status',
  'git log --oneline -5',
  'gitpush',
  'git-push origin',
  'npm run publish-docs',
  'apt-get update',
  'npm update',
  'kubectl get pods',
  'helm list',
  'docker pull nginx',
  'terraform plan',
  'select * from users',
  'echo dropped tables',
  'cat insert_into.sql',
  'git --version; echo push',
]

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
