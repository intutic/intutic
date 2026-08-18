/**
 * mcpAllowlist.test.ts — the M3 per-server MCP allowlist backstop.
 *
 * Covers the gate-matrix cases `generatedGateBehaviour.test.ts`'s per-writer
 * loop does not: this is a NEW header field (`#mcpservers`), not a new
 * GuardPattern row, so it needs its own fixtures (a `.rules` file with/without
 * the header) and its own payload shapes (Cursor's real flat envelope,
 * Cline's `use_mcp_tool` envelope) rather than the shared `runGate` helper,
 * which always sends a Claude-Code-shaped `{tool_name, tool_input}` envelope.
 *
 * Three harnesses exercised, each for a different fact:
 *  - `claudeCode` — the reference `mcp__<server>__<tool>` shape, and the new
 *    dedicated `mcp__.*` matcher's gate-script half (the config-registration
 *    half is pinned in `claudeCodeHooks.test.ts`).
 *  - `cursor` — the M3 extraction fix, fed Cursor's REAL flat
 *    `beforeMCPExecution` envelope (`tool_name` + top-level `command` +
 *    `hook_event_name`), not the Claude-Code-shaped one.
 *  - `cline` — the `use_mcp_tool` envelope normalization, fed Cline's real
 *    `{tool_name: 'use_mcp_tool', tool_input: {server_name, tool_name}}` shape.
 *
 * @module
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { toRulesLine } from '../../src/harness/gateBody.js'
import type { GuardPattern } from '../../src/harness/protectedPaths.js'

const PROXY_URL = 'http://127.0.0.1:4000'

/**
 * A `.rules` fixture with an OPTIONAL `#mcpservers` header — the shape
 * `writePolicySnapshot` itself produces, reproduced by hand so a test can
 * also construct the states it deliberately never would (a v5 file, i.e. no
 * header at all — see the version-skew describe block below).
 */
function writeMcpRulesFixture(
  target: string,
  opts: {
    sopRules?: readonly GuardPattern[]
    workspaceId?: string
    mcpservers?: { severity: 'block' | 'shadow'; servers: string[] }
  } = {},
): string {
  const lines = (opts.sopRules ?? []).map(toRulesLine)
  // The digest covers rule-body lines only — same computation
  // writePolicySnapshot uses — so the #mcpservers header (outside `lines`)
  // never affects it. That invariant is exercised directly by
  // policySnapshot.test.ts; this fixture just has to match the real
  // computation so the gate's own digest check does not reject it.
  const digest = createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 32)
  const mcpHeader = opts.mcpservers
    ? `#mcpservers ${opts.mcpservers.severity} ${opts.mcpservers.servers.join(',')}\n`
    : ''
  writeFileSync(
    target,
    `#digest ${digest}\n` +
      (opts.workspaceId ? `#workspace ${opts.workspaceId}\n` : '') +
      `#generated ${new Date().toISOString()}\n` +
      mcpHeader +
      lines.join('\n') +
      '\n',
  )
  return target
}

/** A minimal BLOCK SOP-shaped GuardPattern, matching `mcp__<server>__.*`. */
function mcpSopRule(id: string, server: string): GuardPattern {
  return {
    id: `sop.${id}`,
    source: ` (mcp__${server}__.*) `,
    subject: 'tool',
    severity: 'block',
    reason: `Blocked by SOP ${id}`,
    rationale: 'test fixture',
    matches: [`mcp__${server}__anything`],
    notMatches: ['Bash'],
  }
}

interface RunResult {
  status: number
  stdout: string
  stderr: string
}

/**
 * Async subprocess runner — deliberately NOT spawnSync. A vitest worker's
 * synchronous test bodies never yield to the poll phase, so spawnSync here
 * starves the worker's own onTaskUpdate RPC on a run with more than a
 * handful of subprocesses (birpc's hardcoded 60s timeout fires AFTER every
 * test already passed). See generatedGateBehaviour.test.ts's runProcess for
 * the full account; this is the same fix, kept local rather than imported
 * since that file does not export it.
 */
function runProcess(
  cmd: string,
  args: string[],
  opts: { input?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<RunResult> {
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
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({ status: code === null ? -1 : code, stdout, stderr })
    })
    if (opts.timeoutMs) timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs)
    if (opts.input !== undefined) child.stdin.write(opts.input)
    child.stdin.end()
  })
}

const home = mkdtempSync(join(tmpdir(), 'intutic-mcp-gate-'))
const roots = new Map<string, string>()
const realHome = process.env.HOME
const realUserProfile = process.env.USERPROFILE

beforeAll(async () => {
  for (const name of ['claudeCode', 'cursor', 'cline']) {
    const root = join(home, name)
    mkdirSync(root, { recursive: true })
    // cursorHooks ALSO writes a user-level ~/.cursor/hooks.json via
    // os.homedir() at call time — without redirecting HOME first, that write
    // lands on the real developer machine's home directory instead of this
    // test's scratch tree.
    process.env.HOME = root
    process.env.USERPROFILE = root
    if (name === 'claudeCode') {
      const mod = await import('../../src/harness/claudeCodeHooks.js')
      await mod.updatePreToolUseHooks(root, [], {}, PROXY_URL, 'ws_test')
    } else if (name === 'cursor') {
      const mod = await import('../../src/harness/cursorHooks.js')
      await mod.writeCursorHooks(root, PROXY_URL, 'ws_test')
    } else {
      const mod = await import('../../src/harness/clineHooks.js')
      await mod.writeClineHooks(root, PROXY_URL, 'ws_test')
    }
    roots.set(name, root)
  }
  process.env.HOME = realHome
  process.env.USERPROFILE = realUserProfile
}, 60_000)

afterAll(() => {
  process.env.HOME = realHome
  process.env.USERPROFILE = realUserProfile
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    // not worth failing a run over
  }
})

function auditEvents(root: string): Array<Record<string, unknown>> {
  const candidates = [
    join(root, '.intutic', 'events', 'hook-events.jsonl'),
    join(root, '.intutic', 'events', 'cline-hook-events.jsonl'),
  ]
  const out: Array<Record<string, unknown>> = []
  for (const p of candidates) {
    try {
      for (const line of readFileSync(p, 'utf8').trim().split('\n').filter(Boolean)) {
        try { out.push(JSON.parse(line)) } catch { /* skip */ }
      }
    } catch { /* file absent */ }
  }
  return out
}

function clearAudit(root: string) {
  rmSync(join(root, '.intutic', 'events'), { recursive: true, force: true })
  mkdirSync(join(root, '.intutic', 'events'), { recursive: true })
}

describe('MCP per-server allowlist — claudeCode', () => {
  const root = () => roots.get('claudeCode')!
  const script = () => join(root(), '.intutic', 'hooks', 'claude-code-check.js')
  const snap = () => join(root(), 'snap.rules')

  const run = (toolName: string, snapshotPath: string) =>
    runProcess('node', [script()], {
      input: JSON.stringify({ tool_name: toolName, tool_input: {}, session_id: 's1' }),
      env: { ...process.env, HOME: root(), USERPROFILE: root(), INTUTIC_SNAPSHOT_RULES: snapshotPath },
      timeoutMs: 15_000,
    })

  it('no #mcpservers header (v5-shaped snapshot) — unrestricted, no crash, no false block', async () => {
    writeMcpRulesFixture(snap())
    const r = await run('mcp__anything__whatever', snap())
    expect(r.status, `stderr: ${r.stderr}`).toBe(0)
  })

  it('empty-list-means-unrestricted holds even with other snapshot content present', async () => {
    // A snapshot that carries ordinary SOP rules but no #mcpservers header at
    // all must still leave every MCP server unrestricted — the header's
    // absence, not the snapshot's absence, is what this tests.
    writeMcpRulesFixture(snap(), { sopRules: [mcpSopRule('unrelated', 'other')] })
    const r = await run('mcp__totally_unlisted_server__tool', snap())
    expect(r.status, `stderr: ${r.stderr}`).toBe(0)
  })

  it('server on the list — allowed', async () => {
    writeMcpRulesFixture(snap(), { mcpservers: { severity: 'block', servers: ['github', 'filesystem'] } })
    const r = await run('mcp__github__create_issue', snap())
    expect(r.status, `stderr: ${r.stderr}`).toBe(0)
  })

  it('server not on the list — blocked (exit 2), audit line names the server', async () => {
    writeMcpRulesFixture(snap(), { mcpservers: { severity: 'block', servers: ['github', 'filesystem'] } })
    clearAudit(root())
    const r = await run('mcp__evil_corp__steal_secrets', snap())
    expect(r.status, `stderr: ${r.stderr}`).toBe(2)
    const events = auditEvents(root())
    const blocked = events.find((e) => e.event === 'tool_blocked' && String(e.reason).includes('mcp_allowlist'))
    expect(blocked, `no mcp_allowlist tool_blocked event in ${JSON.stringify(events)}`).toBeDefined()
    expect(String(blocked!.reason)).toContain('evil_corp')
  })

  it('SHADOW severity — event-only, call still allowed', async () => {
    writeMcpRulesFixture(snap(), { mcpservers: { severity: 'shadow', servers: ['github'] } })
    clearAudit(root())
    const r = await run('mcp__evil_corp__steal_secrets', snap())
    expect(r.status, `stderr: ${r.stderr}`).toBe(0)
    const events = auditEvents(root())
    const wouldBlock = events.find(
      (e) => e.event === 'tool_would_block' && String(e.reason).includes('mcp_allowlist'),
    )
    expect(wouldBlock, `no mcp_allowlist tool_would_block event in ${JSON.stringify(events)}`).toBeDefined()
    expect(events.some((e) => e.event === 'tool_blocked')).toBe(false)
  })

  it('a non-mcp tool name is never evaluated against the allowlist', async () => {
    writeMcpRulesFixture(snap(), { mcpservers: { severity: 'block', servers: ['github'] } })
    const r = await run('Bash', snap())
    expect(r.status, `stderr: ${r.stderr}`).toBe(0)
  })

  it('end-to-end: a BLOCK:mcp__github__.*-shaped SOP rule refuses through the gate script', async () => {
    // The config-registration half (the mcp__.* PreToolUse matcher is what
    // routes a real Claude Code MCP call into this script at all) is pinned
    // in claudeCodeHooks.test.ts; this is the script's own decision once a
    // call reaches it.
    writeMcpRulesFixture(snap(), { sopRules: [mcpSopRule('gh_block', 'github')] })
    clearAudit(root())
    const r = await run('mcp__github__create_issue', snap())
    expect(r.status, `stderr: ${r.stderr}`).toBe(2)
    const events = auditEvents(root())
    expect(events.some((e) => e.event === 'tool_blocked' && String(e.reason).includes('sop.gh_block'))).toBe(true)
  })
})

describe('MCP per-server allowlist — cursor (real beforeMCPExecution envelope)', () => {
  const root = () => roots.get('cursor')!
  const script = () => join(root(), '.intutic', 'hooks', 'cursor-check.js')
  const snap = () => join(root(), 'snap.rules')

  /**
   * Cursor's REAL flat envelope — confirmed via Cursor's own hooks
   * documentation and a live payload example from a Cursor bug-tracker
   * thread (2026-08): `tool_name` is the bare MCP tool name, `command` (or
   * `url`) is the server identifier, and the event name field is
   * `hook_event_name`. Deliberately NOT the Claude-Code-shaped
   * `{tool_name, tool_input}` envelope `runGate` sends elsewhere — sending
   * that here would not exercise the M3 composition fix at all, since the
   * bug it fixes is specific to Cursor's own field names.
   */
  const run = (toolName: string, server: string, snapshotPath: string) =>
    runProcess('node', [script()], {
      input: JSON.stringify({
        tool_name: toolName,
        command: server,
        hook_event_name: 'beforeMCPExecution',
        session_id: 's1',
      }),
      env: { ...process.env, HOME: root(), USERPROFILE: root(), INTUTIC_SNAPSHOT_RULES: snapshotPath },
      timeoutMs: 15_000,
    })

  it('composes mcp__<server>__<tool> and enforces the allowlist against it', async () => {
    writeMcpRulesFixture(snap(), { mcpservers: { severity: 'block', servers: ['github'] } })
    const allowed = await run('create_issue', 'github', snap())
    expect(allowed.status, `stderr: ${allowed.stderr}`).toBe(0)

    clearAudit(root())
    const blocked = await run('steal_secrets', 'evil_corp', snap())
    expect(blocked.status, `stderr: ${blocked.stderr}`).toBe(2)
    const events = auditEvents(root())
    expect(events.some((e) => e.event === 'tool_blocked' && String(e.reason).includes('mcp_allowlist'))).toBe(true)
  })

  it('a BLOCK:mcp__github__.*-shaped SOP rule refuses a composed Cursor MCP call', async () => {
    writeMcpRulesFixture(snap(), { sopRules: [mcpSopRule('gh_block', 'github')] })
    const r = await run('create_issue', 'github', snap())
    expect(r.status, `stderr: ${r.stderr}`).toBe(2)
  })

  it('a non-MCP hook event (beforeShellExecution) is unaffected by the composition fix', async () => {
    writeMcpRulesFixture(snap(), { mcpservers: { severity: 'block', servers: ['github'] } })
    const r = await runProcess('node', [script()], {
      input: JSON.stringify({ command: 'echo hello', hook_event_name: 'beforeShellExecution', session_id: 's1' }),
      env: { ...process.env, HOME: root(), USERPROFILE: root(), INTUTIC_SNAPSHOT_RULES: snap() },
      timeoutMs: 15_000,
    })
    expect(r.status, `stderr: ${r.stderr}`).toBe(0)
  })
})

describe('MCP per-server allowlist — cline (use_mcp_tool normalization)', () => {
  const root = () => roots.get('cline')!
  const script = () => join(root(), '.cline', 'hooks', 'intutic-check.js')
  const snap = () => join(root(), 'snap.rules')

  /** Cline's real tool-call schema: `use_mcp_tool` with `server_name`/
   *  `tool_name`/`arguments` as separate tool_input fields. */
  const run = (serverName: string, toolName: string, snapshotPath: string) =>
    runProcess('node', [script()], {
      input: JSON.stringify({
        tool_name: 'use_mcp_tool',
        tool_input: { server_name: serverName, tool_name: toolName, arguments: {} },
        session_id: 's1',
      }),
      env: { ...process.env, HOME: root(), USERPROFILE: root(), INTUTIC_SNAPSHOT_RULES: snapshotPath },
      timeoutMs: 15_000,
    })

  const wasCancelled = (stdout: string) =>
    stdout
      .trim()
      .split('\n')
      .some((line) => {
        try { return JSON.parse(line)?.cancel === true } catch { return false }
      })

  it('normalizes into mcp__<server>__<tool> and feeds the per-server allowlist', async () => {
    writeMcpRulesFixture(snap(), { mcpservers: { severity: 'block', servers: ['filesystem'] } })
    const notOnList = await run('github', 'create_issue', snap())
    expect(wasCancelled(notOnList.stdout), `stdout: ${notOnList.stdout}`).toBe(true)

    const onList = await run('filesystem', 'read_file', snap())
    expect(wasCancelled(onList.stdout), `stdout: ${onList.stdout}`).toBe(false)
  })

  it('normalizes into mcp__<server>__<tool> and feeds a workspace SOP rule shaped like mcp__github__.*', async () => {
    // No #mcpservers header — the allowlist itself is unrestricted here, so a
    // block can only come from the SOP rule, proving normalization also
    // reaches ordinary tool-name SOP matching, not just the M3 allowlist.
    writeMcpRulesFixture(snap(), { sopRules: [mcpSopRule('gh_block', 'github')] })
    const r = await run('github', 'create_issue', snap())
    expect(wasCancelled(r.stdout), `stdout: ${r.stdout}`).toBe(true)

    const other = await run('filesystem', 'read_file', snap())
    expect(wasCancelled(other.stdout), `stdout: ${other.stdout}`).toBe(false)
  })

  it('a non-use_mcp_tool call is unaffected by the normalization', async () => {
    writeMcpRulesFixture(snap(), { mcpservers: { severity: 'block', servers: ['filesystem'] } })
    const r = await runProcess('node', [script()], {
      input: JSON.stringify({ tool_name: 'read_file', tool_input: { path: 'README.md' }, session_id: 's1' }),
      env: { ...process.env, HOME: root(), USERPROFILE: root(), INTUTIC_SNAPSHOT_RULES: snap() },
      timeoutMs: 15_000,
    })
    expect(wasCancelled(r.stdout), `stdout: ${r.stdout}`).toBe(false)
  })
})

describe('version skew — GATE_VERSION 5 -> 6 (M3)', () => {
  const root = () => roots.get('claudeCode')!
  const script = () => join(root(), '.intutic', 'hooks', 'claude-code-check.js')
  const snap = () => join(root(), 'skew.rules')

  const run = (toolName: string, snapshotPath: string) =>
    runProcess('node', [script()], {
      input: JSON.stringify({ tool_name: toolName, tool_input: {}, session_id: 's1' }),
      env: { ...process.env, HOME: root(), USERPROFILE: root(), INTUTIC_SNAPSHOT_RULES: snapshotPath },
      timeoutMs: 15_000,
    })

  it('a v6 gate reading a v5-generated snapshot (no #mcpservers header) behaves as unrestricted', async () => {
    // Realistic v5 output: no header line at all. `writeMcpRulesFixture` with
    // no `mcpservers` option produces exactly this shape.
    writeMcpRulesFixture(snap(), { sopRules: [mcpSopRule('unrelated', 'other')] })
    const r = await run('mcp__anything__whatever', snap())
    expect(r.status, `stderr: ${r.stderr}`).toBe(0)
  })

  it('what a v5 gate would have seen: stripping the #mcpservers header from a real v6 snapshot leaves it behaviorally identical to the no-header case', async () => {
    // There is no old v5 binary left in this codebase to literally run
    // against a v6-generated file — this is the realistic proxy the task
    // calls for instead: take a snapshot a REAL v6 `writePolicySnapshot` call
    // produced (not hand-rolled), delete only the `#mcpservers` line — the
    // one thing a v5 gate's header-parsing loop would not recognise and
    // would fall through to its generic `#`-comment case, exactly as the v6
    // loop still does for any header it does not know either — and confirm
    // the v6 gate itself now reads that file exactly as it read the
    // never-had-a-header case above. That equivalence IS what "a v5 gate
    // ignores the unknown header and degrades to v5 behaviour" rests on: the
    // header line is genuinely inert once it is not there to parse.
    const { writePolicySnapshot } = await import('../../src/lib/policySnapshot.js')
    const dir = mkdtempSync(join(tmpdir(), 'intutic-skew-real-'))
    try {
      await writePolicySnapshot(
        { workspaceId: 'ws_test', interventionMode: 'ENFORCE', sopRules: [], mcpAllowedServers: ['github'] },
        dir,
      )
      const real = readFileSync(join(dir, 'policy-snapshot.rules'), 'utf8')
      expect(real).toContain('#mcpservers block github')
      const stripped = real
        .split('\n')
        .filter((l) => !l.startsWith('#mcpservers '))
        .join('\n')
      const strippedPath = join(dir, 'stripped.rules')
      writeFileSync(strippedPath, stripped)

      const r = await run('mcp__evil_corp__steal_secrets', strippedPath)
      expect(r.status, `stderr: ${r.stderr}`).toBe(0) // NOT blocked — the header is gone
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
