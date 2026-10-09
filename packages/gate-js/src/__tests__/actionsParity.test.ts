/**
 * The TypeScript copy of the proxy's action vocabulary stays equal to it.
 *
 * The proxy's lists in actions.rs are the source of truth; intutic-clawde's
 * actions.py is held to them by its own test, this one holds actions.ts.
 * Gemini CLI's shell tool, `run_shell_command`, was missing from every copy.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as actions from '../actions.js'

const ACTIONS_RS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../../proxy/src/plugins/anomaly/actions.rs'),
  'utf8',
)

/** The string literals of a `const NAME: &[&str] = &[...]` in the Rust source, comments skipped. */
function rustList(name: string): string[] {
  const m = ACTIONS_RS.match(new RegExp(`const ${name}: &\\[&str\\] =\\s*&\\[([\\s\\S]*?)\\];`))
  expect(m, `${name} not found in actions.rs`).not.toBeNull()
  const body = m![1]!.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')
  return [...body.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]!)
}

describe('parity with the proxy', () => {
  it.each([
    'DEPLOY_PATTERNS',
    'PUBLISH_PATTERNS',
    'RELEASE_PATTERNS',
    'TEST_PATTERNS',
    'HTTP_POST_PATTERNS',
    'DB_WRITE_PATTERNS',
    'SECRET_PATH_FRAGMENTS',
    'PII_PATH_FRAGMENTS',
    'SHELL_TOOLS',
    'READ_TOOLS',
    'FETCH_TOOLS',
  ] as const)('%s matches actions.rs', (name) => {
    expect([...actions[name]]).toEqual(rustList(name))
  })

  it("treats Gemini CLI's run_shell_command as a shell", () => {
    expect(actions.classify('run_shell_command', { command: 'git push origin main' })).toContain('action:deploy')
  })
})
