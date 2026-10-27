// The CLI reference (apps/docs/reference/cli.md) against the command tree
// cli.ts actually builds: every runnable command has a ``## `intutic …` ``
// section, and every option it takes is named in that section. Commands were
// added without docs, and docs kept options the CLI no longer had; checking
// the registered tree rather than cli.ts's text is what makes this exact.
//
// The control-plane commands register from the optional @intutic/cli-control-plane
// plugin (lib/controlPlanePlugin.ts). Without it, their sections are held to the
// plugin's list of command names instead; with it, to the registered tree like
// every other command.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { Command } from 'commander'
import { CONTROL_PLANE_COMMANDS } from './lib/controlPlanePlugin.js'

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

/** Every command path in the tree, groups included (`guardrails` as well as `guardrails list`). */
function nodes(cmd: Command, prefix: string[] = []): string[][] {
  return cmd.commands.flatMap((sub) => {
    const path = [...prefix, sub.name()]
    return [path, ...nodes(sub, path)]
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

/** A path the plugin provides (`budget set`), or one beneath a command it provides (`guardrails sources list`). */
function isPluginCommand(path: string): boolean {
  return CONTROL_PLANE_COMMANDS.some((name) => path === name || path.startsWith(`${name} `))
}

describe('cli.md matches the registered command tree', async () => {
  const program = await loadProgram()
  const commands = runnable(program).filter(({ path }) => !SHORTCUTS.has(path))
  const all = sections()
  // `login` is the plugin's: registered only when the plugin is installed.
  const withPlugin = program.commands.some((c) => c.name() === 'login')

  it('finds the command tree', () => {
    expect(commands.length).toBeGreaterThan(40)
  })

  // The other direction: a section for a command the CLI no longer has (or
  // never had) documents nothing. tools/scripts/check-feature-surfaces.js
  // reads cli.md's sections as the CLI's command list, which is only true
  // while both directions hold.
  it.each([...all.keys()].map((heading) => [headingPath(heading)]))('`intutic %s` in cli.md is a registered command', (path) => {
    const registered = new Set(nodes(program).map((n) => n.join(' ')))
    // Without the plugin its commands are not registered; their names are the CLI's own list.
    const provided = !withPlugin && isPluginCommand(path)
    expect(registered.has(path) || SHORTCUTS.has(path) || provided, `cli.md documents \`intutic ${path}\`, which cli.ts does not register`).toBe(true)
  })

  // The list a CLI without the plugin answers from has to be the plugin's
  // commands: each name documented, so it cannot name a command that is gone.
  it.each(CONTROL_PLANE_COMMANDS.map((name) => [name]))('the plugin command `intutic %s` has a section in cli.md', (name) => {
    const documented = [...all.keys()].some((heading) => {
      const path = headingPath(heading)
      return path === name || path.startsWith(`${name} `)
    })
    expect(documented || sectionFor(name, all) !== undefined, `CONTROL_PLANE_COMMANDS names \`${name}\`, which cli.md does not document`).toBe(true)
  })

  it('registers a plugin command only from the plugin', () => {
    const registered = nodes(program).map((n) => n.join(' '))
    const own = registered.filter((path) => CONTROL_PLANE_COMMANDS.includes(path))
    // All of them, or none: a CLI half-loaded with the plugin's commands is a broken install.
    expect(own.length === 0 || own.length === CONTROL_PLANE_COMMANDS.length, `registered ${own.length} of ${CONTROL_PLANE_COMMANDS.length} plugin commands`).toBe(true)
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

  // And the reverse, row by row: every flag an Options table lists is one the
  // command takes, spelled as `--help` spells it (`--version <version>`, not
  // `--version <v>`), and a Default cell agrees with a default commander
  // applies. Defaults applied in code (`opts.limit ?? 50`) are not visible
  // here and stay hand-checked.
  it.each([...all].map(([heading, body]) => [headingPath(heading), body] as const))('the Options tables of `intutic %s` match its registered options', (path, body) => {
    const cmd = path.split(' ').reduce<Command | undefined>((at, name) => at?.commands.find((c) => c.name() === name), program)
    if (!cmd) return // reported by the registered-command test above
    // A section that covers its subcommands (`enforce`) lists their options too.
    const covered = [cmd, ...cmd.commands.filter((sub) => body.includes(`\`${sub.name()}\``))]
    const options = covered.flatMap((c) => c.options)
    for (const row of optionRows(body)) {
      const [first, ...rest] = row.cells
      for (const spelled of [...first.matchAll(/`(-[^`]+)`/g)].map((m) => m[1].replace(/\\\|/g, '|'))) {
        const name = spelled.split(/[\s=]/)[0]
        const option = options.find((o) => o.long === name || o.short === name)
        expect(option, `cli.md lists ${spelled} for \`intutic ${path}\`, which it does not take`).toBeDefined()
        if (!option || option.short === name) continue
        expect(spelled, `cli.md spells \`intutic ${path}\`'s option as ${spelled}; --help says ${option.flags}`).toBe(option.flags.replace(/^-\w,\s*/, ''))
        if (option.short) expect(first, `cli.md's row for ${name} on \`intutic ${path}\` omits its short form ${option.short}`).toContain(`\`${option.short}\``)
        const dflt = option.defaultValue as unknown
        if (row.defaultCell !== undefined && (typeof dflt === 'string' || typeof dflt === 'number')) {
          expect(rest[row.defaultCell - 1], `cli.md's Default for ${name} on \`intutic ${path}\` disagrees with the registered default ${dflt}`).toContain(`\`${dflt}\``)
        }
      }
    }
  })
})

/** Rows of every table in `body` whose header starts `| Option |`, with the Default column's index when it has one. */
function optionRows(body: string): Array<{ cells: string[]; defaultCell?: number }> {
  const rows: Array<{ cells: string[]; defaultCell?: number }> = []
  const lines = body.split('\n')
  const cellsOf = (line: string) => line.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim())
  for (let i = 0; i < lines.length; i++) {
    if (!/^\|\s*Option\s*\|/.test(lines[i])) continue
    const header = cellsOf(lines[i])
    const at = header.indexOf('Default')
    const defaultCell = at > 0 ? at : undefined
    for (i += 2; i < lines.length && lines[i].startsWith('|'); i++) rows.push({ cells: cellsOf(lines[i]), defaultCell })
  }
  return rows
}
