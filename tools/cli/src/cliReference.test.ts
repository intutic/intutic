// The CLI reference (apps/docs/reference/cli.md) against the command tree
// cli.ts actually builds: every runnable command has a ``## `intutic …` ``
// section, and every option it takes is named in that section. Commands were
// added without docs, and docs kept options the CLI no longer had; checking
// the registered tree rather than cli.ts's text is what makes this exact.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { Command } from 'commander'

const here = dirname(fileURLToPath(import.meta.url))
const reference = readFileSync(resolve(here, '../../../apps/docs/reference/cli.md'), 'utf8')

/** The top-level shortcuts the reference documents under "Global options" instead of a section of their own. */
const SHORTCUTS = new Set(['install-daemon', 'uninstall-daemon'])

async function loadProgram(): Promise<Command> {
  // cli.ts ends in `program.parse()`; capture the tree instead of running it.
  const parse = vi.spyOn(Command.prototype, 'parse').mockReturnThis()
  await import('./cli.js')
  const program = parse.mock.contexts[0] as Command | undefined
  parse.mockRestore()
  if (!program) throw new Error('cli.ts did not call program.parse()')
  return program
}

function runnable(cmd: Command, prefix: string[] = []): Array<{ path: string; cmd: Command }> {
  return cmd.commands.flatMap((sub) => {
    const path = [...prefix, sub.name()]
    return sub.commands.length > 0 ? runnable(sub, path) : [{ path: path.join(' '), cmd: sub }]
  })
}

/** The section text under each ``## `intutic <path>…` `` heading, keyed by the heading's code span. */
function sections(): Map<string, string> {
  const out = new Map<string, string>()
  const parts = reference.split(/^## /m).slice(1)
  for (const part of parts) {
    const heading = /^`intutic ([^`]+)`/.exec(part)
    if (heading) out.set(heading[1], part)
  }
  return out
}

function headingPath(heading: string): string {
  // `loop complete <loop_run_id>` documents the path `loop complete`.
  return heading.split(' ').filter((w) => !/^[<[(]/.test(w)).join(' ')
}

/**
 * The section documenting `path`: its own, or an ancestor's that names it in
 * a table, as ``## `intutic enforce` `` covers apply, remove, status, generate
 * and report in one.
 */
function sectionFor(path: string, all: Map<string, string>): string | undefined {
  const byPath = new Map([...all].map(([heading, body]) => [headingPath(heading), body]))
  const own = byPath.get(path)
  if (own) return own
  const words = path.split(' ')
  for (let n = words.length - 1; n > 0; n--) {
    const ancestor = byPath.get(words.slice(0, n).join(' '))
    if (ancestor?.includes(`\`${words[n]}\``)) return ancestor
  }
  return undefined
}

describe('cli.md matches the registered command tree', async () => {
  const program = await loadProgram()
  const commands = runnable(program).filter(({ path }) => !SHORTCUTS.has(path))
  const all = sections()

  it('finds the command tree', () => {
    expect(commands.length).toBeGreaterThan(50)
  })

  it.each(commands.map(({ path, cmd }) => [path, cmd] as const))('documents `intutic %s` and every option it takes', (path, cmd) => {
    const body = sectionFor(path, all)
    expect(body, `no "## \`intutic ${path}\`" section in cli.md`).toBeDefined()
    for (const option of cmd.options) {
      const flag = (option.long ?? option.short) as string
      // Whole flag only: `--json` must not be satisfied by a `--json-out`.
      const named = new RegExp(`(?<![\\w-])${flag}(?![\\w-])`)
      expect(body, `\`intutic ${path}\` takes ${flag}, which its cli.md section does not name`).toMatch(named)
    }
  })
})
