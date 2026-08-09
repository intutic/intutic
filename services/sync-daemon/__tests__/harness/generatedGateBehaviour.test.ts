/**
 * Does the emitted gate *decide* correctly?
 *
 * A deliberate sibling to `generatedShellIntegrity.test.ts`, which asks a
 * different question — is the emitted text well-formed, and are its bytes
 * pinned. Merging them would make every new fixture churn the byte snapshots,
 * and the two failures want different reactions: a snapshot diff is reviewed, a
 * behaviour failure is fixed.
 *
 * Four things this file exists to catch, all of which have shipped here:
 *
 *  1. **Exit 1.** Every harness treats a non-2 non-zero exit as a hook *error*
 *     and runs the tool anyway. Two defects turned a block into an error exit —
 *     a `ReferenceError` from a build-time constant that was never imported, and
 *     an `INTUITIC_`/`INTUTIC_` transposition that tripped `set -u`. Both look
 *     like enforcement in review. So every case asserts the exit code is 0 or 2
 *     and never anything else, even the cases that expect to be allowed.
 *  2. **A representative instead of a loop.** `.intutic/events` went uncovered
 *     for a year because the old tests checked one protected path and assumed
 *     the rest. Every entry in `UNIVERSAL_PROTECTED_PATHS` is asserted here, by
 *     iteration.
 *  3. **Silent narrowing.** A gate that stops enforcing a family still passes a
 *     test that skips families it does not enforce. So families a gate does not
 *     enforce assert **allow**, and a regression that removes enforcement flips
 *     a row red rather than turning it grey.
 *  4. **False positives.** Every `notMatches` fixture is run too. A guard nobody
 *     has tried to trip wrongly is a guard that will trip wrongly in the field,
 *     and the field's workaround is `chflags nouchg` on the hook.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { GATES, NO_GATE, type GateEntry } from './gateRegistry.js'
import { HarnessType } from '@intutic/shared-types'
import {
  UNIVERSAL_PROTECTED_PATHS,
  GOVERNANCE_BYPASS_PATTERNS,
  DESTRUCTIVE_COMMAND_PATTERNS,
  NORMALISE_CONTRACT,
  type GuardPattern,
} from '../../src/harness/protectedPaths.js'
import { toRulesLine } from '../../src/harness/gateBody.js'
import { createHash } from 'node:crypto'

/**
 * Writes a `.rules` fixture the way the daemon does, digest included.
 *
 * Fixtures used to carry a literal `#digest test`, and every gate enforced the
 * rules regardless — which was the proof that nothing verified it. Now that the
 * gates recompute the digest, a fixture with a fake one is correctly rejected,
 * so the fixture has to be real. That is the point: the test can no longer pass
 * against a snapshot the product would refuse.
 */
function writeRulesFixture(target: string, patterns: readonly GuardPattern[], workspaceId = ''): string {
  const lines = patterns.map(toRulesLine)
  const digest = createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 32)
  writeFileSync(
    target,
    `#digest ${digest}\n` +
      (workspaceId ? `#workspace ${workspaceId}\n` : '') +
      `#generated ${new Date().toISOString()}\n` +
      lines.join('\n') +
      '\n',
  )
  return target
}

const home = mkdtempSync(join(tmpdir(), 'intutic-gate-'))
const roots = new Map<string, string>()

/** A snapshot carrying the destructive tier at `block`, so the dynamic path is
 *  exercised at full strength regardless of what ships by default. */
const snapshotRules = join(home, 'policy-snapshot.rules')

beforeAll(async () => {
  writeRulesFixture(snapshotRules, DESTRUCTIVE_COMMAND_PATTERNS)
  for (const g of GATES) {
    // A root per writer, HOME moved before the dynamic import: `gooseHooks`
    // reads `homedir()` at module scope and `piHooks` at call time, so HOME must
    // be right before the import, not merely before the call.
    const root = join(home, g.name)
    mkdirSync(root, { recursive: true })
    process.env.HOME = root
    process.env.USERPROFILE = root
    try {
      const mod = await import(g.module)
      await g.invoke(mod, root)
    } catch (err) {
      // Recorded, not thrown: a writer that fails to run should fail its own
      // rows with a readable message rather than aborting the whole file.
      roots.set(g.name + ':error', String(err))
    }
    roots.set(g.name, root)
  }
}, 120_000)

afterAll(() => {
  // goose hardens its output with `chflags uchg`, so a plain rm cannot remove it.
  spawnSync('chflags', ['-R', 'nouchg', home])
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    // A leftover temp dir is not worth failing a run over.
  }
})

interface RunResult {
  status: number
  stdout: string
  stderr: string
}

/**
 * Runs a child process **without blocking the event loop**, and that is the
 * whole point.
 *
 * This file drives ~850 subprocesses. Under `spawnSync` every one of them
 * blocked the vitest worker's loop, and consecutive synchronous test bodies
 * yield only microtasks — the poll phase is never reached, so the worker never
 * reads the reply to its `onTaskUpdate` RPC. birpc's timeout is a hardcoded
 * 60s (`DEFAULT_TIMEOUT`, no config knob exists in vitest 3.2.6), and the
 * measured cost of this file is ~54s on an idle machine. So the run failed with
 * `[vitest-worker]: Timeout calling "onTaskUpdate"` — reported *after* every
 * test had already passed, because the pending update promises are only awaited
 * once `runFiles` returns. A green suite that fails the run.
 *
 * Three things this deliberately does not use:
 *
 * - **`execFile` / `execFileSync`** — `execFile` has no `input` option, and every
 *   gate reads stdin to EOF. Without the write they would all hang until the
 *   timeout and die on a signal, which (see below) could read as a uniform allow.
 * - **`promisify(execFile)`** — it *rejects* on any non-zero exit. Exit 2 is the
 *   expected verdict for a block, so the correct outcome would travel the throw
 *   path; a conversion that treats `catch` as failure inverts every block
 *   assertion in this file while still going green on the allow cases.
 * - **A `?? -1` on the exit code** — `spawnSync` reports `status: null` when a
 *   child dies on a signal, and flattening that to a number loses the
 *   distinction. A killed gate must fail loudly and say it was killed, not be
 *   mistaken for a decision.
 */
function runProcess(
  cmd: string,
  args: string[],
  opts: { input?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<RunResult & { signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timer: ReturnType<typeof setTimeout> | undefined

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => { stdout += d })
    child.stderr.on('data', (d: string) => { stderr += d })
    child.on('error', (err) => { if (timer) clearTimeout(timer); reject(err) })
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer)
      // Signal death is surfaced as -1 *plus* the signal, so assertCleanExit can
      // say "killed by SIGKILL" rather than "exited null".
      resolve({ status: code === null ? -1 : code, stdout, stderr, signal })
    })

    if (opts.timeoutMs) timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs)

    // stdin must always be ended, input or not: the gates block on reading it.
    if (opts.input !== undefined) child.stdin.write(opts.input)
    child.stdin.end()
  })
}

/**
 * Runs `fn` over `items` with at most `limit` in flight.
 *
 * Used only for loops that read an **exit code** and nothing else. Two tests in
 * this file assert on the audit log instead, and those stay sequential — a
 * concurrent run could interleave appends, and the resulting failure message
 * would accuse the gate of writing malformed JSON when the harness had
 * scrambled it. (That test also truncates the log first, so it does not depend
 * on this rule being remembered.)
 *
 * Bounded rather than `Promise.all` because a bash gate forks ~35 processes per
 * invocation — one `python3` plus a `grep` per subject per rule — so an
 * unbounded fan-out over 33 fixtures would put a four-figure process count on a
 * CI runner and end up slower than sequential.
 */
async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      await fn(items[i]!)
    }
  })
  await Promise.all(workers)
}

/** How many gate invocations run at once inside one test. */
const GATE_CONCURRENCY = 4

/** Environment a gate runs under, isolated to its own root. */
function gateEnv(g: GateEntry, snapshot?: boolean | string): NodeJS.ProcessEnv {
  const root = roots.get(g.name)!
  return {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    // Point the gate at a known snapshot, or at a path that does not exist so
    // the absent-snapshot path is what runs.
    INTUTIC_SNAPSHOT_RULES:
      typeof snapshot === 'string' ? snapshot : snapshot ? snapshotRules : join(home, 'no-such.rules'),
  }
}

async function runGate(
  g: GateEntry,
  toolInput: Record<string, string>,
  opts: { tool?: string; snapshot?: boolean | string } = {},
): Promise<RunResult & { signal: NodeJS.Signals | null }> {
  const artifact = join(roots.get(g.name)!, g.artifact)
  const payload = JSON.stringify({
    tool_name: opts.tool ?? 'Bash',
    tool_input: toolInput,
    session_id: 'sess_test',
  })
  return runProcess(g.runner, [artifact], {
    input: payload,
    env: gateEnv(g, opts.snapshot),
    timeoutMs: 20_000,
  })
}

/**
 * Every audit line a gate has written, concatenated.
 *
 * Scans for any `.jsonl` under the root rather than naming one file: the writers
 * do not agree on where the log goes — `hook-events.jsonl` for most,
 * `claude-desktop-hook-events.jsonl`, `roo-hook-events.jsonl` and
 * `cline-hook-events.jsonl` for three others, and cline puts it under HOME
 * rather than the workspace.
 */
function auditLogText(g: GateEntry): string {
  const root = roots.get(g.name)!
  const out: string[] = []
  const walk = (dir: string) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.name.endsWith('.jsonl')) out.push(readFileSync(full, 'utf8'))
    }
  }
  walk(root)
  return out.join('\n')
}

/** Reads a verdict out of a run according to the gate's declared contract. */
function wasBlocked(g: GateEntry, r: RunResult): boolean {
  if (g.contract === 'stdout-cancel') {
    for (const line of r.stdout.split('\n')) {
      if (!line.trim()) continue
      try {
        if (JSON.parse(line)?.cancel === true) return true
      } catch {
        // Not every stdout line is the verdict object.
      }
    }
    return false
  }
  return r.status === 2
}

/**
 * The exit code must be 0 or 2 — never 1, and never a signal.
 *
 * This is the assertion that would have caught both historical "the gate is
 * dead" defects, and it applies to allowed calls as much as blocked ones.
 */
function assertCleanExit(
  g: GateEntry,
  r: RunResult & { signal?: NodeJS.Signals | null },
  what: string,
) {
  const allowed = g.contract === 'stdout-cancel' ? [0] : [0, 2]
  // Named explicitly, because "exited -1" is the least useful thing a failing
  // gate test could tell someone. A child killed by a signal means it hung, not
  // that it decided anything.
  const how = r.signal ? `was killed by ${r.signal}` : `exited ${r.status}`
  expect(
    allowed,
    `${g.name}: ${what} ${how}. Only ${allowed.join(' or ')} are decisions — ` +
      `anything else is a hook error and the harness runs the tool anyway.\n` +
      `stderr: ${r.stderr.slice(0, 400)}`,
  ).toContain(r.status)
}

describe('gate registry completeness', () => {
  /**
   * Everything below iterates. An empty list therefore asserts nothing and goes
   * green — which is the failure mode the whole registry exists to prevent,
   * reproduced one level up. These are the floors.
   */
  it('has fixtures and gates to iterate over at all', () => {
    expect(GATES.length, 'the gate registry is empty').toBeGreaterThanOrEqual(13)
    expect(UNIVERSAL_PROTECTED_PATHS.length, 'no protected paths to check').toBeGreaterThanOrEqual(12)
    expect(GOVERNANCE_BYPASS_PATTERNS.length, 'no bypass patterns to check').toBeGreaterThanOrEqual(4)
    expect(DESTRUCTIVE_COMMAND_PATTERNS.length, 'no destructive patterns to check').toBeGreaterThanOrEqual(7)
    // Per-pattern: a rule with no positive fixture is never checked to fire.
    // `assertGuardTableSane` enforces this at module load; asserted here too so
    // the reason is visible where the iteration happens.
    for (const p of [...GOVERNANCE_BYPASS_PATTERNS, ...DESTRUCTIVE_COMMAND_PATTERNS]) {
      expect(p.matches.length, `${p.id} has no matches fixture`).toBeGreaterThanOrEqual(1)
    }
  })

  it('covers every harness writer in src/harness', () => {
    const dir = join(import.meta.dirname, '../../src/harness')
    // Every file, not a filename shape — see the note in harnessProtectedPaths.
    const shared = new Set(['protectedPaths.ts', 'gateBody.ts'])
    const writers = readdirSync(dir).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.d.ts') && !shared.has(f),
    )
    // Not vacuous: an empty `writers` would make `missing` empty and pass.
    expect(writers.length, 'the harness directory scan found nothing').toBeGreaterThan(12)
    const covered = new Set([
      ...GATES.map((g) => g.module.split('/').pop()!.replace(/\.js$/, '.ts')),
      ...NO_GATE.filter((n) => n.file !== null).map((n) => n.file!),
    ])
    const missing = writers.filter((w) => !covered.has(w))
    expect(
      missing,
      `These harness writers are in neither GATES nor NO_GATE. A writer that is ` +
        `in neither is one nobody decided about — add it to the registry, or to ` +
        `NO_GATE with a reason.`,
    ).toEqual([])
  })

  it('accounts for every HarnessType enum member', () => {
    // The file scan above cannot see a harness that has NO writer file at all
    // — codex and github-copilot were invisible to it for exactly that reason.
    // This check is derived from the enum instead: every HarnessType member
    // must be either a GATES row or an explicit NO_GATE row, so the next
    // adapter added without a hook file goes red here until someone decides
    // about it in writing.
    //
    // GATES names are camelCase test ids; enum values are kebab-case
    // (claudeCode → claude-code, openWebui → open-webui).
    const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
    const covered = new Set<string>([
      ...GATES.map((g) => kebab(g.name)),
      ...NO_GATE.flatMap((n) => (n.harness === null ? [] : [n.harness])),
    ])
    const missing = Object.values(HarnessType).filter((h) => !covered.has(h))
    expect(
      missing,
      `These HarnessType members are in neither GATES nor NO_GATE. A harness ` +
        `in neither is one nobody decided about — add a gate row, or a NO_GATE ` +
        `entry (file: null if no writer exists) with a reason.`,
    ).toEqual([])
  })

  it('every gate produced its declared artifact', () => {
    for (const g of GATES) {
      const err = roots.get(g.name + ':error')
      expect(err, `${g.name} writer threw: ${err}`).toBeUndefined()
      const artifact = join(roots.get(g.name)!, g.artifact)
      expect(existsSync(artifact), `${g.name} did not write ${g.artifact}`).toBe(true)
    }
  })

  it('no two writers claim the same artifact path with different content', () => {
    // The double-gate defect (two modules writing one harness's gate) in its
    // structural form. Two writers producing the same relative path means the
    // last one to run wins on a real machine, where every writer shares one HOME.
    const byPath = new Map<string, Array<{ gate: string; bytes: number }>>()
    for (const g of GATES) {
      const full = join(roots.get(g.name)!, g.artifact)
      if (!existsSync(full)) continue
      const list = byPath.get(g.artifact) ?? []
      list.push({ gate: g.name, bytes: statSync(full).size })
      byPath.set(g.artifact, list)
    }
    const collisions = [...byPath.entries()]
      .filter(([, v]) => v.length > 1)
      .map(([p, v]) => `${p} <- ${v.map((x) => `${x.gate}(${x.bytes}b)`).join(', ')}`)
    expect(
      collisions,
      `Two writers emit the same artifact path. On a real install they share a ` +
        `HOME, so one silently overwrites the other and a harness runs another ` +
        `harness's gate.`,
    ).toEqual([])
  })
})

for (const g of GATES) {
  describe(`${g.name} gate`, () => {
    if (!g.migrated) {
      it.todo(
        `not yet on the shared evaluator${g.note ? ` — ${g.note}` : ''}`,
      )
      return
    }
    if (g.contract === 'python-raise') {
      // Its unit is a prompt, so the tool-call matrix below does not apply.
      // Covered by the "Open WebUI prompt filter" block at the bottom of this
      // file — a separate shape, not a skipped one.
      it('is covered by its own prompt-filter block, not the tool-call matrix', () => {
        expect(g.runner).toBe('python3')
      })
      return
    }
    if (g.contract === 'js-throw') {
      // Its unit is a whole WORKFLOW — an in-process preExecute module that
      // throws to abort, with no exit code or stdout contract for runGate to
      // read. Covered by the "n8n workflow gate" block at the bottom of this
      // file — a separate shape, not a skipped one.
      it('is covered by its own workflow block, not the tool-call matrix', () => {
        expect(g.runner).toBe('node')
      })
      return
    }

    it('allows an ordinary command', async () => {
      const r = await runGate(g, { command: 'npm run build' })
      assertCleanExit(g, r, 'an ordinary command')
      expect(wasBlocked(g, r), `${g.name} blocked \`npm run build\``).toBe(false)
    })


    // Explicit budget, not the file's 15s default. Each case runs a real gate,
    // and a bash gate forks roughly 35 processes per invocation — one `python3`
    // plus a `grep` per subject per rule. That is ~1s on this machine and far
    // more on a two-core runner, so the three fan-out tests below sit near the
    // default and one of them crossed it in CI at 15.1s while 338 of 339 other
    // tests passed. The assertions are unchanged; only the wall clock is, and
    // the failure mode stays a loud timeout rather than a silent skip.
    const FAN_OUT_TIMEOUT = 120_000

    it('blocks every protected path, by iteration', async () => {
      // A loop, not a representative. `.intutic/events` was protected by 5 of 11
      // harnesses precisely because a representative stood in for the list.
      await mapLimit(UNIVERSAL_PROTECTED_PATHS, GATE_CONCURRENCY, async (p) => {
        const r = await runGate(g, { command: `rm -rf ${p}` })
        assertCleanExit(g, r, `rm of ${p}`)
        expect(wasBlocked(g, r), `${g.name} allowed \`rm -rf ${p}\``).toBe(true)
      })
    }, FAN_OUT_TIMEOUT)

    it('blocks a protected path given as a file argument', async () => {
      const r = await runGate(g, { file_path: '/w/.claude/settings.local.json' }, { tool: 'Write' })
      assertCleanExit(g, r, 'a Write to a protected path')
      expect(wasBlocked(g, r)).toBe(true)
    })

    it('enforces every governance-bypass pattern and spares its counter-examples', async () => {
      const cases = GOVERNANCE_BYPASS_PATTERNS.flatMap((pat) => [
        ...pat.matches.map((m) => ({ pat, m, wantBlock: true })),
        ...pat.notMatches.map((m) => ({ pat, m, wantBlock: false })),
      ])
      await mapLimit(cases, GATE_CONCURRENCY, async ({ pat, m, wantBlock }) => {
        const r = await runGate(g, { command: m })
        assertCleanExit(g, r, `bypass ${pat.id}`)
        expect(
          wasBlocked(g, r),
          wantBlock
            ? `${g.name} allowed ${pat.id}: ${JSON.stringify(m)}`
            : `${g.name} wrongly blocked ${JSON.stringify(m)} via ${pat.id}. A false ` +
              `positive here teaches developers to disable the hook.`,
        ).toBe(wantBlock)
      })
    }, FAN_OUT_TIMEOUT)

    it('guards a foreign harness kill-switch, not only its own', async () => {
      // Each writer used to guard only its own env variable, so eight of nine
      // switches were free under any given harness.
      const r = await runGate(g, { command: 'CLAUDE_CODE_HOOKS=0 PI_PRE_TOOL_HOOK= agent run' })
      assertCleanExit(g, r, 'a foreign kill switch')
      expect(wasBlocked(g, r)).toBe(true)
    })

    it('applies destructive rules only when the snapshot supplies them', async () => {
      const withoutSnap = await runGate(g, { command: 'rm -rf /' })
      assertCleanExit(g, withoutSnap, 'rm -rf / with no snapshot')
      expect(
        wasBlocked(g, withoutSnap),
        `${g.name} blocked from the floor. Destructive patterns ship through the ` +
          `snapshot so they can be retracted in a sync cycle, not a release.`,
      ).toBe(false)

      const withSnap = await runGate(g, { command: 'rm -rf /' }, { snapshot: true })
      assertCleanExit(g, withSnap, 'rm -rf / with a snapshot')
      expect(wasBlocked(g, withSnap)).toBe(true)
    })

    /**
     * Runs on every gate, as everything else here does.
     *
     * This was briefly scoped to one gate per emitter, to cut ~500 subprocesses
     * out of a run that was tripping the vitest worker's RPC timeout. That was
     * the wrong lever: the timeout came from *blocking* the event loop, not from
     * the number of subprocesses, and `runProcess` fixes the cause. Trading away
     * false-positive coverage on nine harnesses to work around a `spawnSync` is
     * how a test file quietly stops testing.
     */
    it('spares the destructive tier’s counter-examples', async () => {
      const cases = DESTRUCTIVE_COMMAND_PATTERNS.flatMap((pat) =>
        pat.notMatches.map((m) => ({ pat, m })),
      )
      await mapLimit(cases, GATE_CONCURRENCY, async ({ pat, m }) => {
        const r = await runGate(g, { command: m }, { snapshot: true })
        assertCleanExit(g, r, `destructive counter-example ${pat.id}`)
        expect(
          wasBlocked(g, r),
          `${g.name} wrongly blocked ${JSON.stringify(m)} via ${pat.id}`,
        ).toBe(false)
      })
    }, FAN_OUT_TIMEOUT)

    it('enforces a WHERE clause against the arguments, not just the tool name', async () => {
      // The end-to-end repair under test: `BLOCK:^shell$ WHERE
      // kubectl\s+apply(?!.*@sha256:)` used to reach every gate as "block the
      // tool unconditionally" — simultaneously failing to enforce the argument
      // condition and refusing `make test`, the exact over-blocking the WHERE
      // grammar was invented to eliminate. The rule must fire only when the
      // argPattern matches JSON.stringify(tool_input).
      const snap = writeRulesFixture(join(home, `where-${g.name}.rules`), [{
        id: 'sop.pin_deploy', source: ' (Bash) ', subject: 'tool', severity: 'block',
        reason: 'Blocked by SOP pin_deploy', rationale: '', matches: [], notMatches: [],
        argPattern: 'kubectl\\s+apply(?!.*@sha256:)',
      }])

      const unpinned = await runGate(g, { command: 'kubectl apply -f deploy.yaml' }, { snapshot: snap })
      assertCleanExit(g, unpinned, 'an unpinned kubectl apply under a WHERE rule')
      expect(wasBlocked(g, unpinned), `${g.name} allowed an unpinned kubectl apply`).toBe(true)

      const pinned = await runGate(
        g,
        { command: 'kubectl apply -f deploy.yaml --image nginx@sha256:0a1b2c' },
        { snapshot: snap },
      )
      assertCleanExit(g, pinned, 'a digest-pinned kubectl apply under a WHERE rule')
      expect(
        wasBlocked(g, pinned),
        `${g.name} blocked a digest-pinned apply — the WHERE clause did not narrow the rule`,
      ).toBe(false)

      const unrelated = await runGate(g, { command: 'make test' }, { snapshot: snap })
      assertCleanExit(g, unrelated, 'make test under a WHERE rule')
      expect(
        wasBlocked(g, unrelated),
        `${g.name} blocked \`make test\` under a WHERE rule — this is the ` +
          `over-blocking the argument condition exists to prevent`,
      ).toBe(false)
    })

    it('still blocks unconditionally on a name-only tool rule (regression pin)', async () => {
      // A rule with no argPattern must behave exactly as before this change.
      const snap = writeRulesFixture(join(home, `nameonly-${g.name}.rules`), [{
        id: 'sop.no_bash', source: ' (Bash) ', subject: 'tool', severity: 'block',
        reason: 'Blocked by SOP no_bash', rationale: '', matches: [], notMatches: [],
      }])
      const r = await runGate(g, { command: 'make test' }, { snapshot: snap })
      assertCleanExit(g, r, 'a name-only tool rule')
      expect(
        wasBlocked(g, r),
        `${g.name}: a rule with no argPattern must keep blocking on the name alone`,
      ).toBe(true)
    })

    it('downgrades an un-compilable argPattern to name-only, loudly', async () => {
      // Fail-safe direction: the clause NARROWS a block, so a broken clause
      // must widen enforcement back to name-only (visible as over-blocking and
      // reported), never drop the rule (fail open) and never kill the gate
      // (exit 1, which every harness reads as allow).
      const snap = writeRulesFixture(join(home, `badarg-${g.name}.rules`), [{
        id: 'sop.bad_arg', source: ' (Bash) ', subject: 'tool', severity: 'block',
        reason: 'Blocked by SOP bad_arg', rationale: '', matches: [], notMatches: [],
        argPattern: '*invalid(',
      }])
      const r = await runGate(g, { command: 'echo hi' }, { snapshot: snap })
      assertCleanExit(g, r, 'a rule whose argPattern does not compile')
      expect(
        wasBlocked(g, r),
        `${g.name}: an un-compilable argPattern must downgrade the rule to name-only, not drop it`,
      ).toBe(true)
      expect(
        auditLogText(g) + r.stdout + r.stderr,
        `${g.name} downgraded a WHERE rule silently — the operator who authored ` +
          `the clause has to hear their narrowed rule is enforcing broad again`,
      ).toMatch(/rule_downgraded/)
    })

    it('parses a v3 rules line with no argPattern column (forward compat pin)', async () => {
      // Written byte-for-byte in the six-column layout the fleet already has on
      // disk — deliberately NOT via toRulesLine, so this pin holds even if the
      // writer changes shape again.
      const line = ['sop.v3_rule', 'block', '-', 'tool', 'Blocked by SOP v3_rule', ' (Bash) '].join('\t')
      const digest = createHash('sha256').update(line).digest('hex').slice(0, 32)
      const snap = join(home, `v3-${g.name}.rules`)
      writeFileSync(snap, `#digest ${digest}\n#generated ${new Date().toISOString()}\n${line}\n`)
      const r = await runGate(g, { command: 'anything at all' }, { snapshot: snap })
      assertCleanExit(g, r, 'a v3-format snapshot')
      expect(wasBlocked(g, r), `${g.name} failed to enforce a v3-format rules line`).toBe(true)
    })

    it('honours the escape hatch for snapshot rules and refuses it for the floor', async () => {
      // The half that must work: a developer wrongly blocked by a new rule can
      // get past it in a way we can see, instead of running `chflags nouchg` on
      // the hook — which is the bypass the floor exists to stop, and which we
      // would never hear about.
      const root = roots.get(g.name)!
      const escapedRes = await runProcess(g.runner, [join(root, g.artifact)], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }),
        env: { ...gateEnv(g, true), INTUTIC_GUARD_DISABLE: '1' },
        timeoutMs: 20_000,
      })
      assertCleanExit(g, escapedRes, 'a snapshot rule with the escape hatch set')
      expect(wasBlocked(g, escapedRes), `${g.name} ignored INTUTIC_GUARD_DISABLE`).toBe(false)
      // The audit log, not stderr: that is where the control plane reads from,
      // and stderr is discarded by every harness.
      expect(
        auditLogText(g) + escapedRes.stderr,
        `${g.name} disabled its guards without saying so — an ungoverned machine ` +
          `has to be visible, or the escape hatch is just a hole`,
      ).toMatch(/guards_disabled/)

      // The half that must NOT work: it is a dynamic-tier switch, never a way
      // to turn the floor off. If one environment variable disarmed everything,
      // it would be the first thing an agent set.
      const floorRes = await runProcess(g.runner, [join(root, g.artifact)], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'chflags nouchg .intutic/hooks/x' } }),
        env: { ...gateEnv(g, true), INTUTIC_GUARD_DISABLE: '1' },
        timeoutMs: 20_000,
      })
      assertCleanExit(g, floorRes, 'a floor rule with the escape hatch set')
      expect(
        wasBlocked(g, floorRes),
        `${g.name}: INTUTIC_GUARD_DISABLE=1 disabled the compiled floor. It must ` +
          `only skip the destructive family.`,
      ).toBe(true)

      // The third pole, and the one the two above cannot see.
      //
      // The switch was implemented as "skip the whole dynamic tier", which also
      // skipped the workspace's own BLOCK: SOP rules — so one environment
      // variable disarmed every customer-authored hard block. The floor stayed
      // up, so both assertions above passed while that was true. A rule the
      // customer asked for is not a guard we are unsure about, and only the
      // latter is what the escape hatch is for.
      const sopSnap = writeRulesFixture(join(home, `sop-${g.name}.rules`), [
        {
          id: 'sop.no_bash', source: ' (Bash) ', subject: 'tool', severity: 'block',
          reason: 'Blocked by SOP no_bash', rationale: '', matches: [], notMatches: [],
        },
      ])
      const sopRes = await runProcess(g.runner, [join(root, g.artifact)], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo hi' } }),
        env: { ...gateEnv(g, sopSnap), INTUTIC_GUARD_DISABLE: '1' },
        timeoutMs: 20_000,
      })
      assertCleanExit(g, sopRes, 'a SOP rule with the escape hatch set')
      expect(
        wasBlocked(g, sopRes),
        `${g.name}: INTUTIC_GUARD_DISABLE=1 skipped a customer BLOCK: SOP rule. ` +
          `The switch exists for the destructive tier we have not yet proven, ` +
          `not for policy the workspace explicitly configured.`,
      ).toBe(true)
    })

    it('refuses a snapshot whose digest does not match its contents', async () => {
      // The check that makes the digest mean something. Before this, `#digest`
      // was parsed and stored and never compared — the fixtures in this very
      // file carried a literal `#digest test` and every gate enforced their
      // rules anyway. An unverified digest is a comment.
      const tampered = join(home, `tampered-${g.name}.rules`)
      const lines = DESTRUCTIVE_COMMAND_PATTERNS.map(toRulesLine)
      writeFileSync(
        tampered,
        // A well-formed digest that is simply not this file's.
        `#digest ${'0'.repeat(32)}\n#generated ${new Date().toISOString()}\n` +
          lines.join('\n') + '\n',
      )
      const r = await runProcess(g.runner, [join(roots.get(g.name)!, g.artifact)], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }),
        env: gateEnv(g, tampered),
        timeoutMs: 20_000,
      })
      assertCleanExit(g, r, 'a snapshot with a bad digest')
      expect(
        wasBlocked(g, r),
        `${g.name} enforced a rule from a snapshot whose digest does not match ` +
          `its contents. Anything that can write the file can then inject rules.`,
      ).toBe(false)
      expect(auditLogText(g), `${g.name} dropped the snapshot silently`).toMatch(/snapshot_invalid/)
    })

    it('is not disarmed by whitespace', async () => {
      // grep is line-oriented and the portable pattern subset has no whitespace
      // class, so normalisation is the only thing standing between a tab and a
      // bypass.
      for (const cmd of ['chflags\tnouchg\t.intutic/hooks/x', 'chflags   nouchg   .intutic/hooks/x']) {
        const r = await runGate(g, { command: cmd })
        assertCleanExit(g, r, 'whitespace-obfuscated bypass')
        expect(wasBlocked(g, r), `${g.name} allowed ${JSON.stringify(cmd)}`).toBe(true)
      }
    })

    it('survives hostile input and still writes a parseable audit line', async () => {
      const logPath = join(roots.get(g.name)!, '.intutic', 'events', 'hook-events.jsonl')

      // Truncate first, so this assertion is about the line THIS run writes.
      // Earlier tests run their fixtures concurrently and append to the same
      // log; if one of those appends ever interleaved, the failure below would
      // read as "the gate wrote malformed JSON" and send someone to the wrong
      // file entirely. Single small O_APPEND writes should not tear — but
      // "should not" is a bad thing to stake a misleading error message on.
      if (existsSync(logPath)) writeFileSync(logPath, '')

      const r = await runGate(
        g,
        { command: 'rm -rf .intutic/hooks', file_path: 'a\tb\u0001c' },
        { tool: 'Wr"ite' },
      )
      assertCleanExit(g, r, 'hostile input')
      expect(wasBlocked(g, r)).toBe(true)

      if (!existsSync(logPath)) return // not every gate writes to the workspace log
      for (const line of readFileSync(logPath, 'utf8').split('\n')) {
        if (!line.trim()) continue
        expect(
          () => JSON.parse(line),
          `${g.name} wrote an audit line that is not JSON. drainHookEvents drops ` +
            `malformed lines and then wipes the log, so this destroys the record ` +
            `of a block rather than delaying it:\n${line.slice(0, 300)}`,
        ).not.toThrow()
      }
    })

    it('still blocks when there is no runtime.env to source', async () => {
      // An unset variable under `set -u` used to kill the gate with exit 1.
      const bare = mkdtempSync(join(tmpdir(), 'intutic-bare-'))
      const artifact = join(roots.get(g.name)!, g.artifact)
      const r = await runProcess(g.runner, [artifact], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'chflags nouchg x' } }),
        env: { ...process.env, HOME: bare, USERPROFILE: bare, INTUTIC_SNAPSHOT_RULES: join(bare, 'none') },
        timeoutMs: 20_000,
      })
      assertCleanExit(g, r, 'a HOME with no runtime.env')
      expect(wasBlocked(g, r)).toBe(true)
      rmSync(bare, { recursive: true, force: true })
    })
  })
}

describe('Open WebUI prompt filter', () => {
  const gate = GATES.find((g) => g.contract === 'python-raise')!
  const filter = () => join(roots.get(gate.name)!, gate.artifact)

  /** Drives `Filter().inlet()` with one user turn. Returns true if it refused. */
  async function ask(text: string, snapshot?: string): Promise<{ refused: boolean; stderr: string }> {
    const driver = join(roots.get(gate.name)!, 'drv.py')
    writeFileSync(
      driver,
      [
        'import sys, importlib.util',
        "spec = importlib.util.spec_from_file_location('f', sys.argv[1])",
        'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
        "m.Filter().inlet({'model': 'x', 'messages': [{'role': 'user', 'content': sys.argv[2]}]})",
      ].join('\n'),
    )
    const res = await runProcess('python3', [driver, filter(), text], {
      env: {
        ...process.env,
        HOME: roots.get(gate.name)!,
        INTUTIC_SNAPSHOT_RULES: snapshot ?? join(home, 'no-such.rules'),
      },
      timeoutMs: 20_000,
    })
    return { refused: res.status !== 0, stderr: res.stderr }
  }

  it('is valid Python', async () => {
    const res = await runProcess(
      'python3',
      ['-c', 'import py_compile,sys; py_compile.compile(sys.argv[1], doraise=True)', filter()],
    )
    expect(res.status, `the emitted filter does not compile:\n${res.stderr}`).toBe(0)
  })

  it('allows an ordinary prompt', async () => {
    expect((await ask('summarise this repo for me')).refused).toBe(false)
  })

  it('flags a prompt naming a governance path without refusing it', async () => {
    // The deliberate asymmetry. Under a tool-call harness this is a block; here
    // it is a person asking about a file, and refusing to discuss a path is how
    // a governance tool gets switched off.
    const r = await ask('what lives in .claude/settings.json?')
    expect(r.refused, `blocked a question about a file:\n${r.stderr}`).toBe(false)
  })

  it('refuses when a snapshot rule says block', async () => {
    // The capability that did not exist: inlet() hardcoded tool_allowed and
    // returned the body unconditionally, so there was no path to a refusal at
    // all — indistinguishable from a gate that had simply never fired.
    const snap = join(home, 'owui.rules')
    writeRulesFixture(snap, [{
      id: 'deny.canary', source: 'canary-string', subject: 'command', severity: 'block',
      reason: 'No canary', rationale: '', matches: [], notMatches: [],
    }])
    const r = await ask('here is a canary-string', snap)
    expect(r.refused, 'a block-severity snapshot rule did not refuse').toBe(true)
    expect(r.stderr).toMatch(/BLOCKED/)
  })

  it('still allows when the same rule is advisory', async () => {
    const snap = join(home, 'owui-warn.rules')
    writeRulesFixture(snap, [{
      id: 'deny.canary', source: 'canary-string', subject: 'command', severity: 'warn',
      reason: 'No canary', rationale: '', matches: [], notMatches: [],
    }])
    expect((await ask('here is a canary-string', snap)).refused).toBe(false)
  })

  it('does not match a tool-subject rule against prompt text', async () => {
    // The subject bug: the snapshot reader consumed columns 0,5,2,4,1 and
    // skipped f[3], so a `BLOCK:Bash` rule — subject `tool`, a pattern over
    // tool NAMES — was matched against the PROMPT, and Open WebUI refused any
    // prompt containing the word "Bash". A prompt has no tool name; a rule
    // about tool names has nothing here to apply to.
    const snap = join(home, 'owui-tool.rules')
    writeRulesFixture(snap, [{
      id: 'sop.no_bash', source: ' (Bash) ', subject: 'tool', severity: 'block',
      reason: 'Blocked by SOP no_bash', rationale: '', matches: [], notMatches: [],
    }])
    const r = await ask('how do I use the Bash tool safely?', snap)
    expect(r.refused, `a tool-subject rule refused a prompt:\n${r.stderr}`).toBe(false)
  })

  it('skips WHERE rules entirely — a prompt has no tool arguments', async () => {
    // An argPattern conditions the rule on tool ARGUMENTS. Ignoring the clause
    // here would enforce a rule its author deliberately narrowed more broadly
    // than they wrote it, against text that is not a tool call at all.
    const snap = join(home, 'owui-arg.rules')
    writeRulesFixture(snap, [{
      id: 'sop.pin_deploy', source: 'canary-string', subject: 'command', severity: 'block',
      reason: 'No canary', rationale: '', matches: [], notMatches: [],
      argPattern: 'kubectl',
    }])
    const r = await ask('here is a canary-string', snap)
    expect(r.refused, 'an argPattern rule was applied to a prompt').toBe(false)
  })
})

describe('n8n workflow gate', () => {
  const gate = GATES.find((g) => g.contract === 'js-throw')!
  const hookFile = () => join(roots.get(gate.name)!, gate.artifact)

  /**
   * Loads the emitted external-hook module the way n8n does — `require()` on
   * the EXTERNAL_HOOK_FILES path — and drives its `workflow.preExecute` with
   * one workflow. Returns whether it refused (threw) and what it said.
   *
   * A `.cjs` driver in a package.json-less temp tree, so both the driver and
   * the hook resolve as CommonJS regardless of this repo's module type — the
   * same resolution an n8n deployment gives the file.
   */
  async function runWorkflow(
    workflow: unknown,
    snapshot?: string,
  ): Promise<{ refused: boolean; stderr: string }> {
    const driver = join(roots.get(gate.name)!, 'wf-drv.cjs')
    writeFileSync(
      driver,
      [
        'const hook = require(process.argv[2]);',
        'const fns = hook && hook.workflow && hook.workflow.preExecute;',
        'if (!Array.isArray(fns) || typeof fns[0] !== "function") {',
        '  console.error("hook module has no workflow.preExecute function");',
        '  process.exit(4);',
        '}',
        'const wf = JSON.parse(process.argv[3]);',
        'Promise.resolve()',
        '  .then(() => fns[0](wf))',
        '  .then(() => process.exit(0),',
        '        (e) => { console.error(String((e && e.message) || e)); process.exit(3); });',
      ].join('\n'),
    )
    const res = await runProcess('node', [driver, hookFile(), JSON.stringify(workflow)], {
      env: {
        ...process.env,
        HOME: roots.get(gate.name)!,
        USERPROFILE: roots.get(gate.name)!,
        INTUTIC_SNAPSHOT_RULES: snapshot ?? join(home, 'no-such.rules'),
      },
      timeoutMs: 20_000,
    })
    // 4 is the driver saying the module shape is wrong; surface that loudly
    // rather than reading it as a refusal.
    expect(res.status, `driver could not load the hook module: ${res.stderr}`).not.toBe(4)
    return { refused: res.status !== 0, stderr: res.stderr }
  }

  const wf = (nodes: unknown[]) => ({ id: 'wf1', name: 'Test Workflow', nodes, connections: {} })
  const commandNode = (command: string, name = 'Run Command') => ({
    name,
    type: 'n8n-nodes-base.executeCommand',
    typeVersion: 1,
    parameters: { command },
  })

  it('allows a clean workflow', async () => {
    const r = await runWorkflow(
      wf([
        { name: 'Set', type: 'n8n-nodes-base.set', parameters: { values: { string: [{ name: 'a', value: 'b' }] } } },
        commandNode('npm run build'),
      ]),
    )
    expect(r.refused, `refused a clean workflow:\n${r.stderr}`).toBe(false)
  })

  it('throws on a node whose parameters hit the compiled floor, naming node and rule', async () => {
    const r = await runWorkflow(wf([commandNode('chflags nouchg .intutic/hooks/x', 'Sneaky Node')]))
    expect(r.refused, 'a governance-bypass command inside a node was allowed').toBe(true)
    expect(r.stderr).toMatch(/\[Intutic Governance\] BLOCKED/)
    expect(r.stderr, 'the refusal must name the offending node').toContain('Sneaky Node')
    expect(r.stderr, 'the refusal must name the rule').toMatch(/\[[a-z]+\.[a-z_.-]+\]/)
  })

  it('throws on every protected path appearing in node parameters, by iteration', async () => {
    // A loop, not a representative — the same discipline as the tool matrix.
    for (const p of UNIVERSAL_PROTECTED_PATHS) {
      const r = await runWorkflow(wf([commandNode(`rm -rf ${p}`)]))
      expect(r.refused, `allowed a node running \`rm -rf ${p}\``).toBe(true)
    }
  }, 120_000)

  it('applies destructive rules only when the snapshot supplies them', async () => {
    const withoutSnap = await runWorkflow(wf([commandNode('rm -rf /')]))
    expect(withoutSnap.refused, 'blocked from the floor — destructive ships via snapshot').toBe(false)
    const withSnap = await runWorkflow(wf([commandNode('rm -rf /')]), snapshotRules)
    expect(withSnap.refused, 'a snapshot destructive rule did not abort the workflow').toBe(true)
  })

  it('matches a tool-subject rule against the node TYPE and enforces its WHERE clause on the parameters', async () => {
    // The n8n mapping under test: tool ≈ node type, and argPattern matches the
    // serialized parameters JSON — the same narrowing the per-tool gates apply
    // to JSON.stringify(tool_input).
    const snap = writeRulesFixture(join(home, 'where-n8n-wf.rules'), [{
      id: 'sop.pin_deploy', source: 'executeCommand', subject: 'tool', severity: 'block',
      reason: 'Blocked by SOP pin_deploy', rationale: '', matches: [], notMatches: [],
      argPattern: 'kubectl\\s+apply(?!.*@sha256:)',
    }])

    const unpinned = await runWorkflow(wf([commandNode('kubectl apply -f deploy.yaml')]), snap)
    expect(unpinned.refused, 'allowed an unpinned kubectl apply node').toBe(true)

    const pinned = await runWorkflow(
      wf([commandNode('kubectl apply -f deploy.yaml --image nginx@sha256:0a1b2c')]),
      snap,
    )
    expect(pinned.refused, 'blocked a digest-pinned apply — the WHERE clause did not narrow the rule').toBe(false)

    const unrelated = await runWorkflow(
      wf([{ name: 'HTTP', type: 'n8n-nodes-base.httpRequest', parameters: { url: 'https://example.com' } }]),
      snap,
    )
    expect(unrelated.refused, 'a WHERE rule on executeCommand aborted a workflow with no such node').toBe(false)
  })

  it('still blocks unconditionally on a name-only node-type rule (regression pin)', async () => {
    const snap = writeRulesFixture(join(home, 'nameonly-n8n-wf.rules'), [{
      id: 'sop.no_exec', source: 'executeCommand', subject: 'tool', severity: 'block',
      reason: 'Blocked by SOP no_exec', rationale: '', matches: [], notMatches: [],
    }])
    const r = await runWorkflow(wf([commandNode('echo hi')]), snap)
    expect(r.refused, 'a rule with no argPattern must keep blocking on the node type alone').toBe(true)
  })

  it('does not match a tool-subject rule against node parameters', async () => {
    // The Open WebUI subject lesson, at workflow granularity: a rule over tool
    // NAMES must not fire because a parameter value merely mentions the name.
    const snap = writeRulesFixture(join(home, 'toolsubj-n8n-wf.rules'), [{
      id: 'sop.no_exec', source: 'executeCommand', subject: 'tool', severity: 'block',
      reason: 'Blocked by SOP no_exec', rationale: '', matches: [], notMatches: [],
    }])
    const r = await runWorkflow(
      wf([{ name: 'Set', type: 'n8n-nodes-base.set', parameters: { note: 'talk about executeCommand here' } }]),
      snap,
    )
    expect(r.refused, 'a tool-subject rule fired on a parameter VALUE naming the type').toBe(false)
  })

  it('writes an audit line for a block', async () => {
    await runWorkflow(wf([commandNode('chflags nouchg .intutic/hooks/x')]))
    expect(
      auditLogText(gate),
      'the workflow gate aborted an execution without recording it — an unrecorded block is invisible to the control plane',
    ).toMatch(/tool_blocked/)
  })

  // ── The LIVE shape, not the documented one ────────────────────────────────
  //
  // Everything above drives the gate with `nodes` as an ARRAY — the shape the
  // external-hooks docs example uses. What `workflow.preExecute` actually
  // receives in a running n8n (probed against the current image with an
  // argument-dumping hook) is a Workflow class instance whose `nodes` is an
  // OBJECT keyed by node name. The first gate handled only the array, walked
  // zero nodes on every real execution, and allowed an offending workflow
  // straight through while this whole file stayed green. These three pins are
  // the regression wall for that live finding.

  it('blocks an offending node when nodes is the live object-keyed shape', async () => {
    const r = await runWorkflow({
      id: 'wf-live',
      name: 'Live Shape',
      nodes: { 'Run Command': commandNode('chflags nouchg .intutic/hooks/x') },
      connections: {},
    })
    expect(r.refused, 'object-keyed nodes were not evaluated — the live n8n shape is unguarded').toBe(true)
    expect(r.stderr).toMatch(/Intutic Governance/)
  })

  it('allows a clean workflow in the live object-keyed shape', async () => {
    const r = await runWorkflow({
      id: 'wf-live-clean',
      name: 'Live Shape Clean',
      nodes: { Set: { name: 'Set', type: 'n8n-nodes-base.set', parameters: { keepOnlySet: false } } },
      connections: {},
    })
    expect(r.refused, `clean object-shape workflow refused: ${r.stderr}`).toBe(false)
  })

  it('blocks against a snapshot the REAL product writer produced', async () => {
    // The fixture writer above pads nothing; writePolicySnapshot space-pads
    // its source patterns. Against a dot-namespaced node type the padded
    // pattern can never match the full type, only its basename — so a live
    // n8n allowed everything while every fixture-driven test here was green.
    // This test closes the writer/fixture divergence by using the product
    // writer itself.
    const { writePolicySnapshot } = await import('../../src/lib/policySnapshot.js')
    const dir = join(home, 'real-writer-n8n')
    await writePolicySnapshot(
      {
        // Must match the id the registry bakes into the hook ('ws_test') — a
        // mismatched snapshot is deliberately treated as foreign and dropped.
        workspaceId: 'ws_test',
        interventionMode: 'enforce',
        sopRules: [{
          id: 'sop.pin_deploy_real',
          toolPattern: '(executeCommand|code)',
          argPattern: 'kubectl\\s+apply(?!.*@sha256:)',
          action: 'block',
          reason: 'deploys must be digest-pinned',
        }],
      },
      dir,
    )
    const snap = join(dir, 'policy-snapshot.rules')
    const bad = await runWorkflow(
      { id: 'w', name: 'RealWriter', nodes: { Deploy: { name: 'Deploy', type: 'n8n-nodes-base.code', parameters: { jsCode: "run('kubectl apply -f x.yaml')" } } }, connections: {} },
      snap,
    )
    expect(bad.refused, 'product-writer snapshot did not block a namespaced node type').toBe(true)
    const ok = await runWorkflow(
      { id: 'w2', name: 'RealWriterOk', nodes: { Deploy: { name: 'Deploy', type: 'n8n-nodes-base.code', parameters: { jsCode: "run('kubectl apply -f x.yaml # img@sha256:abc')" } } }, connections: {} },
      snap,
    )
    expect(ok.refused, `digest-pinned apply refused under product-writer snapshot: ${ok.stderr}`).toBe(false)
  })

  it('refuses a workflow whose nodes it cannot read at all', async () => {
    // Not "allow because we found nothing to check" — an unreadable shape means
    // the gate is blind, and blind must fail closed if n8n changes the
    // contract a second time.
    const r = await runWorkflow({ id: 'wf-alien', name: 'Alien', nodes: 42, connections: {} })
    expect(r.refused, 'an unreadable nodes shape was allowed — the gate fails open on contract change').toBe(true)
    expect(r.stderr).toMatch(/unrecognised workflow shape/)
  })
})

describe('pattern portability', () => {
  /**
   * The load-bearing assertion of the whole design.
   *
   * Five gates evaluate these patterns with `grep -E` and eight with JavaScript
   * `RegExp`. A pattern that means different things to the two engines enforces
   * in one language and silently enforces nothing in the other — which is what
   * `cursorHooks` and `windsurfHooks` shipped for a year, using `\s+`.
   *
   * Known limit, stated rather than implied: this proves agreement for *the grep
   * on the machine running the test*. It says nothing about busybox grep in a
   * customer's Alpine image. That is why `assertPortableEre` forbids `\s`, `\b`
   * and `\t` outright even though the local grep happens to accept them —
   * agreement here is not the same as portability, and only the ban gives that.
   */
  const all = [...GOVERNANCE_BYPASS_PATTERNS, ...DESTRUCTIVE_COMMAND_PATTERNS]

  /** Evaluates a pattern with Python's `re`, the third engine in play. */
  async function pythonMatches(source: string, ignoreCase: boolean, subject: string): Promise<boolean> {
    const res = await runProcess('python3', [
      '-c',
      'import re,sys\n' +
        'flags = re.IGNORECASE if sys.argv[3] == "i" else 0\n' +
        'sys.exit(0 if re.search(sys.argv[1], sys.argv[2], flags) else 1)',
      source,
      subject,
      ignoreCase ? 'i' : '-',
    ])
    return res.status === 0
  }

  /** Evaluates a pattern with `grep -E`, the engine the five bash gates use. */
  async function grepMatches(source: string, ignoreCase: boolean, subject: string): Promise<boolean> {
    const res = await runProcess('grep', [ignoreCase ? '-qiE' : '-qE', '--', source], { input: subject })
    return res.status === 0
  }

  for (const pat of all) {
    it(`${pat.id} means the same thing to grep, JavaScript and Python`, async () => {
      const re = new RegExp(pat.source, pat.ignoreCase ? 'i' : '')
      const cases: Array<[string, boolean]> = [
        ...pat.matches.map((m) => [m, true] as [string, boolean]),
        ...pat.notMatches.map((m) => [m, false] as [string, boolean]),
      ]
      for (const [raw, expected] of cases) {
        const subject = NORMALISE_CONTRACT.js(raw)
        const js = re.test(subject)
        const grepMatched = await grepMatches(pat.source, pat.ignoreCase === true, subject)
        const py = await pythonMatches(pat.source, pat.ignoreCase === true, subject)

        expect(js, `JS disagreed with the declared expectation for ${JSON.stringify(raw)}`).toBe(expected)
        expect(
          grepMatched,
          `grep -E disagreed with JavaScript for ${pat.id} on ${JSON.stringify(raw)}. ` +
            `The five bash gates and the seven JS gates would enforce differently.`,
        ).toBe(js)
        expect(
          py,
          `Python re disagreed with JavaScript for ${pat.id} on ${JSON.stringify(raw)}. ` +
            `The Open WebUI filter would enforce differently from every other gate.`,
        ).toBe(js)
      }
    })
  }

  /**
   * The three normalisers must agree, and the check has to be empirical.
   *
   * The JS half is now structural — the emitted gate embeds
   * `NORMALISE_CONTRACT.jsSource`, built from the same expression string the
   * in-process `js` is compiled from, so they are the same characters. Python is
   * a separate implementation and can only be checked by running it.
   *
   * The inputs are the two that were already divergent before this was unified:
   * a null/undefined command (one side produced `" undefined "`), and Unicode
   * whitespace, which JS `\s` and Python `str.split()` both collapse.
   */
  it('the JS and Python normalisers agree, including on the cases that had drifted', async () => {
    const cases = ['rm\u00a0-rf /', 'a\u3000b', 'a\tb', '  spaced  out  ', '', 'plain']
    const script = [
      'import sys, json, re',
      NORMALISE_CONTRACT.pySource,
      'print(json.dumps([_intutic_normalise(x) for x in json.loads(sys.argv[1])]))',
    ].join('\n')
    const res = await runProcess('python3', ['-c', script, JSON.stringify(cases)])
    expect(res.status, `python normaliser failed: ${res.stderr}`).toBe(0)
    const fromPython = JSON.parse(res.stdout) as string[]
    const fromJs = cases.map((c) => NORMALISE_CONTRACT.js(c))
    expect(fromPython, 'the Python gate normalises differently from the JS gates').toEqual(fromJs)
  })

  it('normalises a nullish command the same way in both engines', async () => {
    // `String(undefined)` is `"undefined"` — a six-letter word that a pattern
    // could match. Both sides must produce empty.
    expect(NORMALISE_CONTRACT.js(undefined)).toBe('  ')
    expect(NORMALISE_CONTRACT.js(null)).toBe('  ')
    const script = [
      'import sys, re',
      NORMALISE_CONTRACT.pySource,
      'sys.stdout.write(_intutic_normalise(None))',
    ].join('\n')
    const res = await runProcess('python3', ['-c', script])
    expect(res.stdout).toBe('  ')
  })

  it('requires a false-positive contract on every pattern', () => {
    for (const pat of all) {
      expect(
        pat.notMatches.length,
        `${pat.id} has fewer than three notMatches. The cheapest way to write a ` +
          `guard that never fires wrongly is to never think about when it would.`,
      ).toBeGreaterThanOrEqual(3)
    }
  })
})
