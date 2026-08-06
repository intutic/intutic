/**
 * The generated hook scripts must remain valid shell, with nothing left for the
 * TypeScript template engine to eat.
 *
 * Five harness writers emit shell from TypeScript template literals, so `\$`
 * appears throughout — `\$1`, `\${ts}`, `"\$entry"` — to stop the template engine
 * consuming a shell variable at build time. ESLint reports 158 of those as
 * "unnecessary escape", and it is right in the narrow sense: `\$1` and `$1`
 * produce the same character. It is wrong about the risk, because `\${ts}` and
 * `${ts}` do NOT produce the same thing — the second is a TypeScript
 * interpolation that would silently substitute at build time and emit an empty
 * string into a security-relevant script.
 *
 * Nothing guarded that distinction. These files had no test of any kind, so the
 * only signal that a hook script had been broken would have been a developer's
 * agent mysteriously failing to be governed.
 *
 * Assertions, cheapest first:
 *
 *  1. `bash -n` — the script parses. This is what catches a quoting scheme that
 *     has been half-unwound.
 *  2. Shell parameter expansions survive. If a `\$` is dropped from in front of
 *     a `{`, TypeScript substitutes at build time and the variable reference
 *     disappears — while `bash -n` still passes happily.
 *  3. The audit line it writes is parseable JSON with the right field values.
 *     This one is not hypothetical: three of the five writers shipped `\"`
 *     where they needed `\\"`, which emits a bare quote, and bash then ate every
 *     quote in the JSON. `drainHookEvents` skips malformed lines and truncates
 *     the log once they are all malformed, so the governance record was being
 *     destroyed rather than merely delayed. Neither assertion 1 nor the snapshot
 *     would have found it — the broken script parses, and the snapshot would
 *     have recorded the broken bytes as the baseline.
 *  4. Snapshot — the exact bytes. Any deliberate change to a generated script
 *     has to be reviewed as a diff rather than landing invisibly.
 *
 * A second suite at the bottom covers the Claude Code hook, which is JavaScript
 * rather than shell and had no test at all. It shipped referencing a build-time
 * constant it never imported, so it threw ReferenceError before deciding
 * anything — on the harness most people run.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { UNIVERSAL_PROTECTED_PATHS } from '../../src/harness/protectedPaths.js'
import type { HarnessModule } from './gateRegistry.js'

const PROXY_URL = 'http://127.0.0.1:4000'

/**
 * Every writer, with an invocation that lands entirely inside its own root.
 *
 * Note the argument order is NOT uniform: `writeGooseHooks` is
 * `(proxyUrl, workspaceRoot, workspaceId)` and every other writer is
 * `(workspaceRoot, proxyUrl, workspaceId)`. Getting that wrong is silent —
 * the writer happily treats a URL as a directory path and creates `./http:/…`
 * relative to the process cwd, which is how the first version of this file
 * polluted the repo and pinned a snapshot of a script built with a URL as its
 * workspace root. Spelled out here so the next reader does not repeat it.
 */
const WRITERS: Array<{
  name: string
  module: string
  invoke: (mod: HarnessModule, root: string) => Promise<void>
}> = [
  {
    name: 'goose',
    module: '../../src/harness/gooseHooks.js',
    invoke: (m, root) => m.writeGooseHooks(PROXY_URL, root, 'ws_test'),
  },
  {
    name: 'openhands',
    module: '../../src/harness/openhandsHooks.js',
    invoke: (m, root) => m.writeOpenHandsHooks(root, PROXY_URL, 'ws_test'),
  },
  {
    name: 'hermes',
    module: '../../src/harness/hermesHooks.js',
    invoke: (m, root) => m.writeHermesHooks(root, PROXY_URL, 'ws_test'),
  },
  {
    name: 'antigravity',
    module: '../../src/harness/antigravityHooks.js',
    invoke: (m, root) => m.writeAntigravityHooks(root, PROXY_URL, 'ws_test'),
  },
  {
    name: 'pi',
    module: '../../src/harness/piHooks.js',
    invoke: (m, root) => m.writePiHooks(root, PROXY_URL, 'ws_test'),
  },
]

/**
 * Every generated script carries a `# Generated: <ISO>` line, so the raw bytes
 * differ on every run. Normalised rather than stripped: the line's presence is
 * part of the output worth pinning, its value is not.
 */
const normalise = (body: string, root: string) =>
  body
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<TIMESTAMP>')
    // The scripts embed absolute paths built from the workspace root, which is a
    // fresh mkdtemp per run. Normalised for the same reason as the timestamp:
    // that a path is written is worth pinning, which temp directory it names is not.
    .split(root)
    .join('<ROOT>')

/** Collects every shell script under `dir`, keyed by path relative to it. */
function collectShellScripts(dir: string, root = dir, out = new Map<string, string>()) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collectShellScripts(full, root, out)
    else if (statSync(full).isFile()) {
      const body = readFileSync(full, 'utf8')
      // `.sh` by name, or anything carrying a shell shebang.
      if (entry.name.endsWith('.sh') || body.startsWith('#!')) {
        out.set(full.slice(root.length + 1), normalise(body, root))
      }
    }
  }
  return out
}

const home = mkdtempSync(join(tmpdir(), 'intutic-hookgen-'))
const scripts = new Map<string, Map<string, string>>()

describe('generated hook scripts', () => {
  beforeAll(async () => {
    for (const w of WRITERS) {
      // A root per writer, and HOME moved to it before the module loads.
      //
      // Two writers resolve output from HOME rather than from the workspace root
      // they are handed: `gooseHooks` reads `os.homedir()` at *module scope*, and
      // `piHooks` reads it at call time. So HOME has to be correct before the
      // dynamic import, not merely before the call.
      //
      // Collecting from one shared directory made the snapshot cumulative —
      // each writer's block re-recorded whatever earlier writers had left, so
      // goose's script appeared five times and later blocks led with output that
      // was not theirs. A pin that records the wrong file is worse than none,
      // because it still goes green.
      const root = join(home, w.name)
      mkdirSync(root, { recursive: true })
      process.env.HOME = root
      process.env.USERPROFILE = root

      const mod = await import(w.module)
      await w.invoke(mod, root)
      scripts.set(w.name, collectShellScripts(root))
    }
  }, 60_000)

  afterAll(() => {
    // The goose writer hardens what it emits with `chflags uchg` (macOS
    // immutable), so a plain rm cannot remove the tree. Clear the flag first,
    // and never let cleanup fail the run.
    spawnSync('chflags', ['-R', 'nouchg', home])
    try {
      rmSync(home, { recursive: true, force: true })
    } catch {
      // A leftover temp directory is not worth failing a test over.
    }
  })

  it('produced a script for every writer', () => {
    // Without this the whole file is vacuous: an empty map passes every
    // per-script assertion below.
    for (const w of WRITERS) {
      const found = scripts.get(w.name)
      expect(found, `${w.name} wrote nothing`).toBeDefined()
      expect(found!.size, `${w.name} produced no shell script to check`).toBeGreaterThan(0)
    }
  })

  for (const w of WRITERS) {
    describe(w.name, () => {
      it('emits shell that parses', () => {
        for (const [rel, body] of scripts.get(w.name)!) {
          const res = spawnSync('bash', ['-n'], { input: body, encoding: 'utf8' })
          expect(
            res.status,
            `${w.name}:${rel} is not valid shell — bash -n said:\n${res.stderr}`,
          ).toBe(0)
        }
      })

      it('keeps its shell parameter expansions', () => {
        for (const [rel, body] of scripts.get(w.name)!) {
          // A `${VAR}` in the *output* is the correct result: the source writes
          // `\${VAR}`, the template engine emits a literal `${VAR}`, and the
          // shell resolves it at run time. The failure mode is the opposite —
          // drop the `\` and TypeScript substitutes at build time, so the
          // expansion *disappears* from the output, replaced by a value or by
          // nothing at all. `bash -n` cannot see that: the result is still valid
          // shell, it just no longer reads the variable.
          //
          // So this asserts presence, not absence.
          const expansions = [...body.matchAll(/\$\{[^}]*\}/g)].map((m) => m[0])
          expect(
            expansions.length,
            `${w.name}:${rel} has no '\${...}' left. Every one of these scripts reads ` +
              `shell variables, so zero expansions means a '\\$' was dropped before a ` +
              `'{' and TypeScript substituted the reference away at build time.`,
          ).toBeGreaterThan(0)

          // What a build-time substitution of an absent value looks like once it
          // has landed in the file.
          expect(body, `${w.name}:${rel} interpolated an undefined value`).not.toContain('undefined')
          expect(body, `${w.name}:${rel} interpolated an object`).not.toContain('[object Object]')
        }
      })

      it('writes an audit line the daemon can actually parse', () => {
        // The defect this exists for: `\\"` inside a TypeScript template literal
        // is a no-op — it emits a bare `"`. Bash then concatenates the adjacent
        // quoted segments and consumes them, so the "JSON" reaching the audit log
        // has no quotes at all:
        //
        //     {event:tool_blocked,toolName:Write,workspaceId:ws_real,...}
        //
        // `JSON.parse` rejects that. `drainHookEvents` skips malformed lines and
        // then, when *every* line is malformed, truncates the log to empty — so
        // the governance record is not merely unsent, it is destroyed. Three of
        // the five writers shipped this on at least one of their two JSON sites.
        //
        // Neither of the other checks in this file catches it: `bash -n` parses
        // the broken script happily, and the snapshot would have recorded the
        // broken bytes as the baseline.
        //
        // So this runs the writer's own `log_event` and parses what lands.
        const dir = mkdtempSync(join(tmpdir(), `auditline-${w.name}-`))
        try {
          for (const rel of scripts.get(w.name)!.keys()) {
            const real = readFileSync(join(home, w.name, rel), 'utf8')
            const start = real.indexOf('log_event()')
            if (start === -1) continue // not every script logs

            const end = real.indexOf('\n}\n', start)
            const logEvent = real.slice(start, end + 3)
            const out = join(dir, 'events.jsonl')
            const driver = [
              '#!/usr/bin/env bash',
              'INTUTIC_WORKSPACE_ID=ws_real',
              `HOOK_EVENTS_LOG="${out}"`,
              'INTUTIC_API_KEY=""',
              logEvent,
              // Hostile reason, not a benign literal. The first version of this
              // test passed `"protected path"` — plain text with nothing to
              // escape — so it went green against escaping that handled only
              // `\` `"` `\n` `\r`, and missed that JSON forbids every C0
              // control character. A TAB in a filename, which needs no
              // adversary at all, still produced an unparseable line.
              //
              // This drives all four classes at once: a quote that could close
              // the JSON string and forge fields, a backslash, a tab, and a
              // raw 0x01.
              `log_event tool_blocked 'Wr"ite' "$(printf 'bad\\\\path \\"quote\\" \\ttab \\001ctrl')"`,
            ].join('\n')

            const driverPath = join(dir, 'driver.sh')
            writeFileSync(driverPath, driver)
            const run = spawnSync('bash', [driverPath], { encoding: 'utf8' })
            expect(run.status, `${w.name}:${rel} log_event failed: ${run.stderr}`).toBe(0)

            const line = readFileSync(out, 'utf8').trim().split('\n')[0]
            expect(line, `${w.name}:${rel} wrote no audit line`).toBeTruthy()

            let parsed: Record<string, unknown>
            expect(() => {
              parsed = JSON.parse(line!)
            }, `${w.name}:${rel} wrote an unparseable audit line:\n  ${line}`).not.toThrow()

            // Field values too, not just well-formedness: a line can parse and
            // still have lost its variable expansions.
            expect(parsed!.workspaceId).toBe('ws_real')

            // The quote survived as literal text rather than closing the string
            // and opening new keys. A forged field here would mean an agent can
            // write whatever it likes into the governance record by naming a
            // file carefully.
            expect(parsed!.toolName).toBe('Wr"ite')
            expect(Object.keys(parsed!).sort()).toEqual(
              ['event', 'harnessType', 'incidentId', 'reason', 'timestamp', 'toolName', 'workspaceId'].sort(),
            )
            expect(String(parsed!.reason)).toContain('bad\\path')
            expect(String(parsed!.reason)).toContain('"quote"')
          }
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      })

      it('blocks a protected path with exit 2 and an audit line, with no runtime.env', () => {
        // The defect: these scripts declared their credentials as `INTUITIC_*`
        // (note the transposed I) and read them as `INTUTIC_*`. Under
        // `set -euo pipefail`, the first read of the unset correct name is a
        // fatal unbound-variable error — so on any machine without a
        // `~/.intutic/env/runtime.env` to source, the guard printed BLOCKED and
        // then died with exit **1** instead of 2, writing **zero** audit lines.
        //
        // Harnesses treat exit 2 as "blocked" and anything else as a hook that
        // errored, so the protected-path guard was not merely unlogged — it was
        // not enforcing. Three of the five writers shipped this.
        //
        // Deliberately run with HOME pointing at a directory containing no
        // runtime.env, because that is the condition that triggers it.
        const gate = [...scripts.get(w.name)!.keys()].find((rel) =>
          readFileSync(join(home, w.name, rel), 'utf8').includes('INTUTIC_FLOOR='),
        )
        expect(gate, `${w.name} emitted no script containing a protected-path gate`).toBeDefined()

        const scriptPath = join(home, w.name, gate!)
        const auditLog = join(home, w.name, '.intutic', 'events', 'hook-events.jsonl')
        rmSync(auditLog, { force: true })

        const run = spawnSync('bash', [scriptPath], {
          input: JSON.stringify({
            tool_name: 'Write',
            tool_input: { path: '.claude/settings.local.json' },
          }),
          encoding: 'utf8',
          env: { ...process.env, HOME: join(home, w.name) },
        })

        expect(
          run.status,
          `${w.name} did not block a protected path. Exit ${run.status}, wanted 2.\n` +
            `stderr: ${run.stderr}`,
        ).toBe(2)

        const lines = readFileSync(auditLog, 'utf8').trim().split('\n').filter(Boolean)
        // Not `length === 1`: with no runtime.env there is also no policy
        // snapshot, so the gate correctly reports `snapshot_absent` alongside the
        // block. What matters is that the block itself was recorded.
        const events = lines.map((l) => JSON.parse(l))
        expect(
          events.map((e) => e.event),
          `${w.name} blocked but recorded no tool_blocked line`,
        ).toContain('tool_blocked')
      })

      it('protects every path in the shared constant', () => {
        // `UNIVERSAL_PROTECTED_PATHS` exists because eleven harnesses each kept
        // their own list and they disagreed (TD-298). That unification reached
        // the TypeScript constant but not every *generated* script: goose emitted
        // a hand-written seven-entry bash array that omitted
        // `.claude/settings.local.json` — which loads at higher precedence than
        // `settings.json`, so a goose agent could rewrite the override unopposed.
        //
        // A constant that the thing it governs does not read is not a single
        // source of truth, it is a second one.
        const gate = [...scripts.get(w.name)!.keys()].find((rel) =>
          readFileSync(join(home, w.name, rel), 'utf8').includes('INTUTIC_FLOOR='),
        )
        const emitted = readFileSync(join(home, w.name, gate!), 'utf8')

        // Emitted as ERE literals (dots escaped) inside the shared floor table, not
        // as a bare double-quoted bash array.
        const missing = UNIVERSAL_PROTECTED_PATHS.filter(
          (p) => !emitted.includes(p.replace(/\./g, String.raw`\.`)),
        )
        expect(
          missing,
          `${w.name}'s emitted guard omits ${missing.length} path(s) that ` +
            `UNIVERSAL_PROTECTED_PATHS declares. Build the shell array from the ` +
            `constant rather than hand-writing it.`,
        ).toEqual([])
      })

      it('matches the recorded output byte for byte', () => {
        const sorted = [...scripts.get(w.name)!.entries()].sort(([a], [b]) => a.localeCompare(b))
        expect(Object.fromEntries(sorted)).toMatchSnapshot()
      })
    })
  }
})

/**
 * The Claude Code hook is JavaScript, not shell, and had no test at all.
 *
 * It generates `.intutic/hooks/claude-code-check.js` from a template literal, and
 * the template contained `...UNIVERSAL_PROTECTED_PATHS,` with no `${}` — so the
 * identifier was written into a script that never imports it. Node threw
 * ReferenceError on the const declaration, before the gate did anything.
 *
 * Claude Code is the harness most people run, and a PreToolUse hook exiting 1
 * is a hook *error*, not a block — so every protected-path write, every
 * shell-bypass attempt and every `review_before` hold went through ungoverned,
 * and the only symptom was a non-zero exit nobody was reading.
 *
 * `bash -n` cannot help here because it is not bash. What catches it is running
 * the thing.
 */
describe('generated Claude Code hook', () => {
  const root = mkdtempSync(join(tmpdir(), 'intutic-cchook-'))
  let scriptPath: string

  beforeAll(async () => {
    process.env.HOME = root
    process.env.USERPROFILE = root
    const mod = await import('../../src/harness/claudeCodeHooks.js')
    await mod.updatePreToolUseHooks(root, [], 'ws_test')
    scriptPath = join(root, '.intutic', 'hooks', 'claude-code-check.js')
  }, 60_000)

  afterAll(() => {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      // Cleanup is not worth failing a test over.
    }
  })

  const run = (input: unknown) =>
    spawnSync('node', [scriptPath], { input: JSON.stringify(input), encoding: 'utf8' })

  it('parses and runs at all', () => {
    const res = run({ tool_name: 'Read', tool_input: { file_path: 'README.md' } })
    expect(
      res.stderr,
      'the hook threw before deciding anything — every guard in it is dead',
    ).not.toMatch(/ReferenceError|SyntaxError|is not defined/)
  })

  it('blocks a protected path with exit 2', () => {
    const res = run({
      tool_name: 'Write',
      tool_input: { file_path: '.claude/settings.local.json' },
    })
    // 2 is the only exit code Claude Code treats as a block. 1 is a hook that
    // errored, which lets the call through.
    expect(res.status, `wanted 2 (block), got ${res.status}. stderr: ${res.stderr}`).toBe(2)
    expect(res.stderr).toMatch(/BLOCKED/)
  })

  it('allows a benign path', () => {
    const res = run({ tool_name: 'Write', tool_input: { file_path: 'src/index.ts' } })
    expect(res.status, `wanted 0 (allow), got ${res.status}. stderr: ${res.stderr}`).toBe(0)
  })

  it('emits every shared protected path as a literal, not an identifier', () => {
    const body = readFileSync(scriptPath, 'utf8')
    const code = body
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'))
      .join('\n')

    expect(
      code.includes('UNIVERSAL_PROTECTED_PATHS'),
      'the constant name reached the generated script as code. It is a ' +
        'build-time value and must be interpolated, not referenced.',
    ).toBe(false)

    // Emitted as ERE literals inside `new RegExp(...)` by harness/gateBody.ts,
    // so the dots are escaped. Checking for the bare path would pass only by
    // accident and fail here for the right reason.
    const missing = UNIVERSAL_PROTECTED_PATHS.filter(
      (p) => !body.includes(JSON.stringify(p.replace(/\./g, String.raw`\.`))),
    )
    expect(missing, `generated hook omits ${missing.length} shared protected path(s)`).toEqual([])
  })
})
