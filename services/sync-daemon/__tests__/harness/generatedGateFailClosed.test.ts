/**
 * Does the emitted gate fail CLOSED when it cannot decide?
 *
 * A sibling to `generatedGateBehaviour.test.ts`, which proves the gates decide
 * correctly on inputs they can read. This file proves the other half of the
 * contract — what happens when the gate crashes, or is handed an envelope it
 * cannot read. The audit that produced GATE_VERSION 5 verified these fail-open
 * edges in the shipped gates:
 *
 *  - **bash family** — the scripts run under `set -euo pipefail`, so any script
 *    bug exited 1, and every harness treats a non-2 non-zero exit as "the hook
 *    errored" and ALLOWS the call. Fixed by SHELL_FAIL_CLOSED (an EXIT trap
 *    that converts any status outside {0, 2} into 2).
 *  - **bash family, malformed stdin** — unparseable JSON degraded to empty
 *    extracted fields, which match no rule: an allow. Fixed by the envelope
 *    refusal in emitShellGate, following the githubCopilotHooks precedent.
 *  - **JS exit2 family** — the stdin handler's catch exits 2, but a crash
 *    OUTSIDE the handler (module-load error, unhandled rejection) exited 1: an
 *    allow. Fixed by emitJsFailClosedPrelude.
 *  - **stdout-cancel family** — those harnesses ignore exit codes entirely; a
 *    crash that printed no cancel object was an allow. The prelude for this
 *    contract prints the cancel JSON before exiting, and the envelope refusal
 *    CANCELS rather than exiting 2 (which cline and roo would never read).
 *  - **n8n** — already closed: the gate refuses by THROWING inside the n8n
 *    process, and an internal fault throws the same way. Verified here rather
 *    than changed.
 *
 * The crashes in this file are INDUCED by injecting one line into a copy of
 * the genuinely emitted script (a nonexistent command for bash, an unhandled
 * `Promise.reject` for JS) — the rest of the bytes are exactly what the writer
 * produced, so the trap/handler being exercised is the real one. Each test
 * name says so.
 *
 * Equally load-bearing: the ALLOW pins. A gate that blocks every call is as
 * broken as one that allows every call, so this file also proves the new
 * guards do not over-trigger — payloads with only a tool name or only a
 * tool_input still pass, and the warn/shadow tiers still allow (the EXIT trap
 * must not turn their deliberate non-blocks into blocks).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { GATES, type GateEntry } from './gateRegistry.js'
import { toRulesLine } from '../../src/harness/gateBody.js'
import type { GuardPattern } from '../../src/harness/protectedPaths.js'

const home = mkdtempSync(join(tmpdir(), 'intutic-failclosed-'))
const roots = new Map<string, string>()

const bashGates = GATES.filter((g) => g.runner === 'bash')
const jsExit2Gates = GATES.filter((g) => g.runner === 'node' && g.contract === 'exit2')
const jsCancelGates = GATES.filter((g) => g.contract === 'stdout-cancel')
const n8nGate = GATES.find((g) => g.contract === 'js-throw')!

/** The gates this file drives — everything with a per-call subprocess, plus n8n. */
const DRIVEN = [...bashGates, ...jsExit2Gates, ...jsCancelGates, n8nGate]

beforeAll(async () => {
  for (const g of DRIVEN) {
    // A root per writer, HOME moved before the dynamic import — gooseHooks
    // reads homedir() at module scope. Same discipline as the behaviour tests.
    const root = join(home, g.name)
    mkdirSync(root, { recursive: true })
    process.env.HOME = root
    process.env.USERPROFILE = root
    const mod = await import(g.module)
    await g.invoke(mod, root)
    roots.set(g.name, root)
  }
}, 120_000)

afterAll(() => {
  // goose hardens its output with `chflags uchg`; clear before removing.
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
  signal: NodeJS.Signals | null
}

/** Non-blocking subprocess runner — see generatedGateBehaviour.test.ts for why
 *  spawnSync is the wrong tool in this suite. The extra stdin error swallow is
 *  for the induced-crash cases: a gate that dies before reading stdin EPIPEs
 *  the write, and an unhandled stream error would fail the test process rather
 *  than the assertion. */
function runProcess(
  cmd: string,
  args: string[],
  opts: { input?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => { stdout += d })
    child.stderr.on('data', (d: string) => { stderr += d })
    child.stdin.on('error', () => { /* EPIPE from a gate that died first — expected here */ })
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ status: code === null ? -1 : code, stdout, stderr, signal })
    })
    if (opts.input !== undefined) child.stdin.write(opts.input)
    child.stdin.end()
  })
}

function gateEnv(g: GateEntry, snapshot?: string): NodeJS.ProcessEnv {
  const root = roots.get(g.name)!
  return {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    INTUTIC_SNAPSHOT_RULES: snapshot ?? join(home, 'no-such.rules'),
  }
}

/** Runs the gate's own emitted artifact with raw stdin bytes. */
function runRaw(g: GateEntry, rawInput: string, snapshot?: string): Promise<RunResult> {
  return runProcess(g.runner, [join(roots.get(g.name)!, g.artifact)], {
    input: rawInput,
    env: gateEnv(g, snapshot),
  })
}

const BENIGN = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'npm run build' } })

/** Same digest-correct fixture writer the behaviour tests use. */
function writeRulesFixture(target: string, patterns: readonly GuardPattern[]): string {
  const lines = patterns.map(toRulesLine)
  const digest = createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 32)
  writeFileSync(
    target,
    `#digest ${digest}\n#generated ${new Date().toISOString()}\n${lines.join('\n')}\n`,
  )
  return target
}

/** Every audit line under a gate's root, concatenated. */
function auditLogText(g: GateEntry): string {
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
  walk(roots.get(g.name)!)
  return out.join('\n')
}

/** True iff stdout carries a {"cancel": true} object on some line. */
function sawCancel(r: RunResult): { cancelled: boolean; reason: string } {
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue
    try {
      const obj = JSON.parse(line)
      if (obj?.cancel === true) {
        return { cancelled: true, reason: String(obj.reason ?? obj.errorMessage ?? '') }
      }
    } catch {
      // Not every stdout line is the verdict object.
    }
  }
  return { cancelled: false, reason: '' }
}

// ─── bash family ──────────────────────────────────────────────────────────────

for (const g of bashGates) {
  describe(`${g.name} gate fails closed`, () => {
    it('converts an injected mid-script crash into exit 2, never 1 (runs the real emitted trap)', async () => {
      // The injection point sits inside the emitted gate body, after log_event
      // is defined — one nonexistent command spliced into an otherwise
      // byte-identical copy of the writer's real output. Under
      // `set -euo pipefail` that dies with 127; before SHELL_FAIL_CLOSED the
      // script ended there and the harness read "hook errored — run the tool".
      const original = readFileSync(join(roots.get(g.name)!, g.artifact), 'utf8')
      const marker = 'INTUTIC_SNAPSHOT_DIGEST="none"'
      expect(original, `${g.name}: expected injection marker missing from emitted gate`).toContain(marker)
      const crashed = original.replace(marker, `${marker}\nintutic_test_induced_crash_no_such_command`)
      const crashedPath = join(roots.get(g.name)!, 'induced-crash.sh')
      writeFileSync(crashedPath, crashed)

      const r = await runProcess('bash', [crashedPath], { input: BENIGN, env: gateEnv(g) })
      expect(
        r.status,
        `${g.name}: a mid-script crash must exit 2 (block), not ${r.status} — ` +
          `any other non-zero is a hook error and the harness runs the tool.\nstderr: ${r.stderr}`,
      ).toBe(2)
      expect(r.stderr).toMatch(/gate crashed/)
      expect(r.stderr).toMatch(/failing closed/)
      expect(
        auditLogText(g),
        `${g.name}: the crash block was not recorded — an unrecorded block is invisible to the control plane`,
      ).toMatch(/gate crashed/)
    })

    it('refuses unparseable stdin with exit 2 and a logged tool_blocked', async () => {
      const r = await runRaw(g, 'this is not json {{{')
      expect(
        r.status,
        `${g.name}: malformed stdin must be refused (exit 2), got ${r.status}.\nstderr: ${r.stderr}`,
      ).toBe(2)
      expect(r.stderr).toMatch(/unrecognised PreToolUse payload/)
      expect(auditLogText(g)).toMatch(/unrecognised PreToolUse payload/)
    })

    it('refuses a parsed payload carrying neither a tool name nor a tool_input', async () => {
      const r = await runRaw(g, JSON.stringify({ totally: 'alien', hook_event_name: 'Mystery' }))
      expect(
        r.status,
        `${g.name}: an envelope with no tool call extracts to empty fields, matches no ` +
          `rule, and used to be allowed — it must be refused.\nstderr: ${r.stderr}`,
      ).toBe(2)
      expect(r.stderr).toMatch(/unrecognised PreToolUse payload/)
    })

    it('still allows a payload with only a tool name, and one with only a tool_input (false-positive pins)', async () => {
      // The envelope refusal keys on "neither", not "both": a Read with no
      // arguments and a nameless tool_input are both ordinary traffic.
      for (const payload of [
        JSON.stringify({ tool_name: 'Read' }),
        JSON.stringify({ tool_input: { command: 'npm run build' } }),
        BENIGN,
      ]) {
        const r = await runRaw(g, payload)
        expect(
          r.status,
          `${g.name} refused ${payload} — the envelope guard is over-triggering, ` +
            `which teaches operators to disable the hook.\nstderr: ${r.stderr}`,
        ).toBe(0)
      }
    })

    it('the EXIT trap does not turn the warn and shadow tiers into blocks (allow pins across tiers)', async () => {
      // The trap inspects only the FINAL exit status, so the deliberate
      // non-blocking tiers must still exit 0 — a gate that blocks every call
      // is as broken as one that allows every call.
      const warnSnap = writeRulesFixture(join(home, `warn-${g.name}.rules`), [{
        id: 'sop.warn_curl', source: ' curl ', subject: 'command', severity: 'warn',
        reason: 'Flagged by SOP warn_curl', rationale: '', matches: [], notMatches: [],
      }])
      const warned = await runRaw(g, JSON.stringify({
        tool_name: 'Bash', tool_input: { command: 'curl https://example.com' },
      }), warnSnap)
      expect(warned.status, `${g.name}: a warn-tier rule must allow.\nstderr: ${warned.stderr}`).toBe(0)
      expect(auditLogText(g), `${g.name}: the warn tier stopped recording`).toMatch(/tool_flagged/)

      const shadowSnap = writeRulesFixture(join(home, `shadow-${g.name}.rules`), [{
        id: 'sop.shadow_curl', source: ' curl ', subject: 'command', severity: 'shadow',
        reason: 'Shadowed by SOP shadow_curl', rationale: '', matches: [], notMatches: [],
      }])
      const shadowed = await runRaw(g, JSON.stringify({
        tool_name: 'Bash', tool_input: { command: 'curl https://example.com' },
      }), shadowSnap)
      expect(shadowed.status, `${g.name}: a shadow-tier rule must allow.\nstderr: ${shadowed.stderr}`).toBe(0)
      expect(auditLogText(g), `${g.name}: the shadow tier stopped recording`).toMatch(/tool_would_block/)
    })
  })
}

// ─── JS exit-code family ──────────────────────────────────────────────────────

for (const g of jsExit2Gates) {
  describe(`${g.name} gate fails closed`, () => {
    it('exits 2 on garbage stdin (regression pin on the handler catch)', async () => {
      const r = await runRaw(g, 'garbage not json <<<')
      expect(
        r.status,
        `${g.name}: unparseable stdin must exit 2, got ${r.status}.\nstderr: ${r.stderr}`,
      ).toBe(2)
    })

    it('exits 2 on a parsed payload carrying neither a tool name nor a tool_input', async () => {
      const r = await runRaw(g, JSON.stringify({ totally: 'alien' }))
      expect(
        r.status,
        `${g.name}: an envelope with no tool call extracts to empty fields, matches no ` +
          `rule, and used to be allowed — it must be refused.\nstderr: ${r.stderr}`,
      ).toBe(2)
      expect(r.stderr).toMatch(/unrecognised PreToolUse payload/)
    })

    it('an unhandled rejection injected after the prelude exits 2, not 1 (runs the real emitted handler)', async () => {
      // One `Promise.reject` spliced into an otherwise byte-identical copy of
      // the emitted gate, directly after handler installation. Node's default
      // for an unhandled rejection is a crash with exit 1 — an allow to every
      // exit-code harness. The prelude's handler must turn it into exit 2.
      const original = readFileSync(join(roots.get(g.name)!, g.artifact), 'utf8')
      const marker = "process.on('unhandledRejection', _intuticCrash);"
      expect(original, `${g.name}: fail-closed prelude missing from emitted gate`).toContain(marker)
      const crashed = original.replace(marker, `${marker}\nPromise.reject(new Error('induced module crash'));`)
      const crashedPath = join(roots.get(g.name)!, 'induced-crash.js')
      writeFileSync(crashedPath, crashed)

      const r = await runProcess('node', [crashedPath], { input: BENIGN, env: gateEnv(g) })
      expect(
        r.status,
        `${g.name}: a crash outside the stdin handler must exit 2 (block), got ${r.status} — ` +
          `exit 1 is a hook error and the harness runs the tool.\nstderr: ${r.stderr}`,
      ).toBe(2)
      expect(r.stderr).toMatch(/gate crashed — failing closed/)
      expect(r.stderr).toContain('induced module crash')
    })

    it('still allows ordinary and partial envelopes (false-positive pins)', async () => {
      for (const payload of [
        BENIGN,
        JSON.stringify({ tool_name: 'Read' }),
        JSON.stringify({ tool_input: { command: 'npm run build' } }),
      ]) {
        const r = await runRaw(g, payload)
        expect(
          r.status,
          `${g.name} refused ${payload} — the envelope guard is over-triggering.\nstderr: ${r.stderr}`,
        ).toBe(0)
      }
    })
  })
}

// ─── JS stdout-cancel family ──────────────────────────────────────────────────

for (const g of jsCancelGates) {
  describe(`${g.name} gate fails closed`, () => {
    it('prints a cancel object on garbage stdin (this harness ignores exit codes)', async () => {
      const r = await runRaw(g, 'garbage not json <<<')
      const v = sawCancel(r)
      expect(
        v.cancelled,
        `${g.name}: unparseable stdin printed no cancel object — exit codes mean ` +
          `nothing to this harness, so no cancel IS an allow.\nstdout: ${r.stdout}`,
      ).toBe(true)
    })

    it('prints a cancel object for a payload carrying neither a tool name nor a tool_input', async () => {
      const r = await runRaw(g, JSON.stringify({ totally: 'alien' }))
      const v = sawCancel(r)
      expect(v.cancelled, `${g.name}: an unreadable envelope must CANCEL.\nstdout: ${r.stdout}`).toBe(true)
      expect(v.reason).toMatch(/unrecognised PreToolUse payload/)
    })

    it('an unhandled rejection injected after the prelude prints the cancel JSON (runs the real emitted handler)', async () => {
      const original = readFileSync(join(roots.get(g.name)!, g.artifact), 'utf8')
      const marker = "process.on('unhandledRejection', _intuticCrash);"
      expect(original, `${g.name}: fail-closed prelude missing from emitted gate`).toContain(marker)
      const crashed = original.replace(marker, `${marker}\nPromise.reject(new Error('induced module crash'));`)
      const crashedPath = join(roots.get(g.name)!, 'induced-crash.js')
      writeFileSync(crashedPath, crashed)

      const r = await runProcess('node', [crashedPath], { input: BENIGN, env: gateEnv(g) })
      const v = sawCancel(r)
      expect(
        v.cancelled,
        `${g.name}: a crash printed no cancel object. This harness never reads the ` +
          `exit code, so a crash without the cancel JSON is an allow.\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
      ).toBe(true)
      expect(v.reason).toMatch(/gate crashed — failing closed/)
    })

    it('still allows ordinary and partial envelopes, printing no cancel (false-positive pins)', async () => {
      for (const payload of [
        BENIGN,
        JSON.stringify({ tool_name: 'Read' }),
        JSON.stringify({ tool_input: { command: 'npm run build' } }),
      ]) {
        const r = await runRaw(g, payload)
        expect(
          sawCancel(r).cancelled,
          `${g.name} cancelled ${payload} — the envelope guard is over-triggering.\nstdout: ${r.stdout}`,
        ).toBe(false)
      }
    })
  })
}

// ─── every JS gate: the prelude is genuinely first ────────────────────────────

describe('fail-closed prelude placement', () => {
  for (const g of [...jsExit2Gates, ...jsCancelGates]) {
    it(`${g.name}: crash handlers are installed before the first require in the emitted body`, () => {
      // Placement is the guarantee: a handler installed after the requires
      // cannot see a require that fails. (A SyntaxError in the file itself is
      // uncoverable by any handler — that residue is pinned by the tests above
      // actually executing every emitted gate.)
      const body = readFileSync(join(roots.get(g.name)!, g.artifact), 'utf8')
      const install = body.indexOf("process.on('uncaughtException'")
      const firstRequire = body.indexOf('require(')
      expect(install, `${g.name}: no uncaughtException handler in the emitted gate`).toBeGreaterThanOrEqual(0)
      expect(firstRequire, `${g.name}: emitted gate has no require at all?`).toBeGreaterThanOrEqual(0)
      expect(
        install,
        `${g.name}: the crash handlers are installed AFTER the first require — a ` +
          `module-load failure would still exit 1 and the harness would allow the call.`,
      ).toBeLessThan(firstRequire)
    })
  }
})

// ─── n8n: throw semantics verified, not changed ───────────────────────────────

describe('n8n workflow gate failure posture', () => {
  it('an internal fault inside the gate aborts the execution — throw IS the fail-closed contract', async () => {
    // The one family whose crash posture was already closed. preExecute runs
    // in-process and refuses by throwing; a fault inside the evaluator throws
    // the same way and n8n aborts the execution identically. Induced with a
    // workflow object whose `nodes` accessor throws — the first property the
    // gate touches after naming the workflow.
    const root = roots.get(n8nGate.name)!
    const driver = join(root, 'fault-drv.cjs')
    writeFileSync(
      driver,
      [
        'const hook = require(process.argv[2]);',
        'const fns = hook && hook.workflow && hook.workflow.preExecute;',
        'if (!Array.isArray(fns) || typeof fns[0] !== "function") { console.error("no preExecute"); process.exit(4); }',
        'const wf = { name: "wf", get nodes() { throw new Error("induced internal fault"); } };',
        'Promise.resolve()',
        '  .then(() => fns[0](wf))',
        '  .then(() => process.exit(0),',
        '        (e) => { console.error(String((e && e.message) || e)); process.exit(3); });',
      ].join('\n'),
    )
    const r = await runProcess('node', [driver, join(root, n8nGate.artifact)], {
      env: { ...process.env, HOME: root, USERPROFILE: root, INTUTIC_SNAPSHOT_RULES: join(home, 'no-such.rules') },
    })
    expect(r.status, 'driver could not load the hook module').not.toBe(4)
    expect(
      r.status,
      `an internal fault did NOT abort the execution — the n8n gate would have ` +
        `run the workflow it could not evaluate.\nstderr: ${r.stderr}`,
    ).toBe(3)
    expect(r.stderr).toContain('induced internal fault')
  })

  it('keeps the no-try/catch posture in the emitted module (documented, pinned in the body)', () => {
    // Verified during the v5 audit and deliberately unchanged: wrapping the
    // gate call in a swallowing try/catch is the one edit that would silently
    // reopen this family. The emitted module states the posture next to the
    // call; this pin fails if either the statement or the bare call goes.
    const body = readFileSync(join(roots.get(n8nGate.name)!, n8nGate.artifact), 'utf8')
    expect(body).toContain('No try/catch around the gate')
    expect(body).toContain('intuticGateWorkflow(workflow, logEvent, _intuticWsId);')
    // No process-level exit handlers either: this module runs INSIDE the n8n
    // server, and a prelude that exits the process would kill the server.
    expect(
      body.includes("process.on('uncaughtException'"),
      'the n8n module must not install process-level exit handlers — it runs in the n8n server process',
    ).toBe(false)
  })
})
