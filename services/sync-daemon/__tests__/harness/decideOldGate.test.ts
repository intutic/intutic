/**
 * A 2.9.0 gate reading a 3.0 snapshot refuses what a decide rule covers,
 * through the rule's fallback line, and so does a 3.0 gate that does not
 * evaluate decide rules yet: it decodes the records but keeps every fallback
 * line in force, and refuses exactly as the 2.9.0 gate does.
 *
 * Three 2.9.0 gates read a snapshot this writer compiles: the `@intutic/gate`
 * snapshot reader, the `intutic_clawde` one, and the Claude Code hook gate the
 * 2.9.0 sync daemon rendered. They come from `fixtures/gate-2.9.0`, copied
 * from the v2.9.0 tag rather than installed, so the test needs no network;
 * its manifest names each file's source and git blob id, and the first test
 * holds the copies to them.
 *
 * Both SDK readers in 2.9.0 return at the first shadow or warn rule that
 * matches, so the writer puts fallback lines ahead of every such rule. The
 * destructive tier ships at warn, and the case below runs one of its commands
 * through Bash to prove the fallback line is reached first.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { snapshotRulesVerify, writeLocalPolicySnapshot, type ServedDecideRule } from '../../src/lib/policySnapshot.js'
import { DESTRUCTIVE_COMMAND_PATTERNS } from '../../src/harness/protectedPaths.js'
import { evaluate, loadSnapshot } from '../fixtures/gate-2.9.0/gate-js/snapshot.js'
import { evaluate as evaluateNow, loadSnapshot as loadSnapshotNow } from '../../../../packages/gate-js/src/snapshot.js'
import { CAN_EVALUATE_DECIDE as SDK_EVALUATES_DECIDE } from '../../../../packages/gate-js/src/gate.js'
import { GATE_EVALUATES_DECIDE } from '../../src/harness/gateBody.js'
import { GATES } from './gateRegistry.js'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/gate-2.9.0')
const CLAWDE = join(dirname(fileURLToPath(import.meta.url)), '../../../../packages/intutic-clawde')
const FALLBACK = 'decide-fallback:prod-data-export@6bcd6b021e7d'
const REASON = 'Decide rule prod-data-export (Production data handling): upgrade to Intutic 3.0 to evaluate this rule'
// A destructive-tier command (shipped at warn): a 2.9.0 SDK reader stops at
// the first warn rule that matches, so this proves the fallback line is first.
const DESTRUCTIVE = DESTRUCTIVE_COMMAND_PATTERNS.find((p) => p.matches.length > 0)!.matches[0]!.trim()

function rule(id: string, tools: string[], rollout: 'shadow' | 'enforce'): ServedDecideRule {
  return {
    sopId: 'local:data.md',
    sopTitle: 'Production data handling',
    ruleText: 'Customer data never leaves production except through the approved export job.',
    ir: JSON.stringify({
      id,
      on: 'tool_call',
      tools,
      questions: { exports: { type: 'yes_no', ask: 'Does this command copy customer data out of the production database?' } },
      when: 'exports',
      rollout,
    }),
    pins: [{ modelDigest: 'sha256:5f1c0e2a9b7d', evalRunId: 'eval_local_01', source: 'local' }],
  }
}

const work = mkdtempSync(join(tmpdir(), 'intutic-old-gate-'))
const snapshot = join(work, 'hooks', 'policy-snapshot.rules')

beforeAll(async () => {
  // An enforced rule on Bash (record and fallback line), and a shadow one on
  // Read (a record only: a rule that never refuses needs no fallback).
  await writeLocalPolicySnapshot({
    snapshotDir: join(work, 'hooks'),
    decideRules: [rule('prod-data-export', ['Bash'], 'enforce'), rule('read-check', ['Read'], 'shadow')],
  })
})

function run(cmd: string, args: string[], input: string, env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
    child.on('error', reject)
    child.on('close', (status) => resolve({ status, stdout, stderr }))
    child.stdin.end(input)
  })
}

describe('a 2.9.0 gate on a 3.0 snapshot', () => {
  it('runs the 2.9.0 bytes', () => {
    const manifest = JSON.parse(readFileSync(join(FIXTURE, 'manifest.json'), 'utf8')) as {
      tag: string
      files: Record<string, { blob: string }>
      rendered: Record<string, { blob: string }>
    }
    expect(manifest.tag).toBe('v2.9.0')
    const blob = (buf: Buffer) => createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex')
    const all = { ...manifest.files, ...manifest.rendered }
    expect(Object.keys(all).length).toBe(15)
    for (const [path, { blob: want }] of Object.entries(all)) expect(blob(readFileSync(join(FIXTURE, path))), path).toBe(want)
    expect(readFileSync(join(FIXTURE, 'claude-code-check.js'), 'utf8')).toContain('Intutic gate body v21 — harness: claude-code')
  })

  it('reads a snapshot that verifies and carries format 2, the records and the fallback line', () => {
    const text = readFileSync(snapshot, 'utf8')
    expect(snapshotRulesVerify(text)).toBe(true)
    const lines = text.split('\n').filter((l) => l && !l.startsWith('#'))
    expect(lines[0]).toBe('@format\t2')
    expect(lines.filter((l) => l.startsWith('@decide\t'))).toHaveLength(2)
    expect(lines.filter((l) => l.startsWith('decide-fallback:'))).toEqual([`${FALLBACK}\tblock\t-\ttool\t${REASON}\t (Bash) `])
  })

  it('@intutic/gate 2.9.0 refuses Bash through the fallback line', () => {
    const snap = loadSnapshot('', snapshot)
    expect(snap.state).toBe('ok')
    for (const command of ['ls -la', DESTRUCTIVE]) {
      expect(evaluate('Bash', '', command, snap), command).toEqual({ severity: 'block', reason: `${REASON} [${FALLBACK}]`, ruleId: FALLBACK })
    }
    expect(evaluate('Read', '/tmp/notes.txt', '', snap).severity).toBeNull()
  })

  it('intutic_clawde 2.9.0 refuses Bash through the fallback line', async () => {
    const script = [
      'import json, sys',
      'sys.path.insert(0, sys.argv[1])',
      'from intutic_clawde.gate import snapshot',
      's = snapshot.load_snapshot("", sys.argv[2])',
      'calls = {"ls": ("Bash", "", "ls -la"), "destructive": ("Bash", "", sys.argv[3]), "read": ("Read", "/tmp/notes.txt", "")}',
      'out = {"state": s.state}',
      'for name, (tool, target, command) in calls.items():',
      '    d = snapshot.evaluate(tool, target, command, s)',
      '    out[name] = {"severity": d.severity, "reason": d.reason, "rule_id": d.rule_id}',
      'print(json.dumps(out))',
    ].join('\n')
    // -I: no user site or working-directory imports; -B: no __pycache__ in the fixture.
    const r = await run('python3', ['-I', '-B', '-c', script, FIXTURE, snapshot, DESTRUCTIVE], '', process.env)
    expect(r.status, r.stderr).toBe(0)
    const out = JSON.parse(r.stdout) as Record<string, { severity: string | null; reason: string; rule_id: string } | string>
    const refusal = { severity: 'block', reason: `${REASON} [${FALLBACK}]`, rule_id: FALLBACK }
    expect(out).toMatchObject({ state: 'ok', ls: refusal, destructive: refusal, read: { severity: null } })
  })

  it('the Claude Code gate the 2.9.0 daemon rendered refuses Bash through the fallback line', async () => {
    const root = mkdtempSync(join(work, 'root-'))
    mkdirSync(join(root, '.intutic', 'events'), { recursive: true })
    const gate = join(root, 'claude-code-check.js')
    writeFileSync(gate, readFileSync(join(FIXTURE, 'claude-code-check.js'), 'utf8').split('__INTUTIC_TEST_ROOT__').join(root))
    const env = { ...process.env, HOME: root, USERPROFILE: root, INTUTIC_SNAPSHOT_RULES: snapshot }
    const call = (tool_name: string, tool_input: Record<string, string>) =>
      run('node', [gate], JSON.stringify({ tool_name, tool_input, session_id: 'sess_old_gate' }), env)

    for (const command of ['ls -la', DESTRUCTIVE]) {
      const r = await call('Bash', { command })
      expect(r.status, `${command}: ${r.stderr}`).toBe(2)
      expect(r.stderr).toContain(`${REASON} [${FALLBACK}]`)
    }
    const read = await call('Read', { file_path: '/tmp/notes.txt' })
    expect(read.status, read.stderr).toBe(0)
  })
})

describe('a 3.0 gate that evaluates no decide rule yet, on the same snapshot', () => {
  const refusal = { severity: 'block', reason: `${REASON} [${FALLBACK}]`, ruleId: FALLBACK }

  it('evaluates none: every reader keeps the fallback lines', () => {
    expect(SDK_EVALUATES_DECIDE).toBe(false)
    expect(GATE_EVALUATES_DECIDE).toEqual({ js: false, bash: false, n8n: false })
  })

  it('@intutic/gate decodes the records and still refuses Bash through the fallback line, as 2.9.0 does', () => {
    const snap = loadSnapshotNow('', snapshot)
    expect(snap.state).toBe('ok')
    expect(snap.decideRules.map((r) => r.ref)).toEqual(['local:data.md#prod-data-export', 'local:data.md#read-check'])
    const old = loadSnapshot('', snapshot)
    for (const command of ['ls -la', DESTRUCTIVE]) {
      // This reader's decision carries more fields than 2.9.0's; the ones they share agree.
      expect(evaluateNow('Bash', '', command, snap), command).toMatchObject(refusal)
      expect(evaluateNow('Bash', '', command, snap), command).toMatchObject(evaluate('Bash', '', command, old))
    }
    expect(evaluateNow('Read', '/tmp/notes.txt', '', snap).severity).toBeNull()
  })

  it('intutic_clawde decodes the records and still refuses Bash through the fallback line, as 2.9.0 does', async () => {
    const script = [
      'import json, sys, types',
      // The package's own __init__ imports the HTTP client; the reader needs none of it.
      'for name, sub in (("intutic_clawde", ""), ("intutic_clawde.gate", "/gate")):',
      '    m = types.ModuleType(name); m.__path__ = [sys.argv[1] + "/intutic_clawde" + sub]; sys.modules[name] = m',
      'from intutic_clawde.gate import snapshot',
      's = snapshot.load_snapshot("", sys.argv[2])',
      'calls = {"ls": ("Bash", "", "ls -la"), "destructive": ("Bash", "", sys.argv[3]), "read": ("Read", "/tmp/notes.txt", "")}',
      'out = {"state": s.state, "records": len(s.decide_rules)}',
      'for name, (tool, target, command) in calls.items():',
      '    d = snapshot.evaluate(tool, target, command, s)',
      '    out[name] = {"severity": d.severity, "reason": d.reason, "rule_id": d.rule_id}',
      'print(json.dumps(out))',
    ].join('\n')
    const r = await run('python3', ['-I', '-B', '-c', script, CLAWDE, snapshot, DESTRUCTIVE], '', process.env)
    expect(r.status, r.stderr).toBe(0)
    const out = JSON.parse(r.stdout) as Record<string, unknown>
    const py = { severity: 'block', reason: `${REASON} [${FALLBACK}]`, rule_id: FALLBACK }
    expect(out).toMatchObject({ state: 'ok', records: 2, ls: py, destructive: py, read: { severity: null } })
  })

  for (const name of ['claudeCode', 'openhands'] as const) {
    it(`the ${name} gate this daemon renders refuses Bash through the fallback line, as 2.9.0 does`, async () => {
      const g = GATES.find((x) => x.name === name)!
      const root = mkdtempSync(join(work, `now-${name}-`))
      mkdirSync(join(root, '.intutic', 'events'), { recursive: true })
      const home = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
      // A writer may also touch the user's harness settings: keep them in the root.
      process.env.HOME = root
      process.env.USERPROFILE = root
      try {
        await g.invoke(await import(g.module), root)
      } finally {
        if (home.HOME === undefined) delete process.env.HOME
        else process.env.HOME = home.HOME
        if (home.USERPROFILE === undefined) delete process.env.USERPROFILE
        else process.env.USERPROFILE = home.USERPROFILE
      }
      const env = { ...process.env, HOME: root, USERPROFILE: root, INTUTIC_SNAPSHOT_RULES: snapshot }
      const call = (tool_name: string, tool_input: Record<string, string>) =>
        run(g.runner, [join(root, g.artifact)], JSON.stringify({ tool_name, tool_input, session_id: 'sess_now_gate' }), env)
      for (const command of ['ls -la', DESTRUCTIVE]) {
        const r = await call('Bash', { command })
        expect(r.status, `${command}: ${r.stderr}`).toBe(2)
        expect(r.stderr).toContain(REASON)
        expect(r.stderr).toContain(FALLBACK)
      }
      const read = await call('Read', { file_path: '/tmp/notes.txt' })
      expect(read.status, read.stderr).toBe(0)
    })
  }
})
