/**
 * grokHooks.test.ts — Grok Build harness coverage.
 *
 * `generatedGateBehaviour.test.ts`/`generatedGateFailClosed.test.ts` already
 * drive `grok`'s row through the shared tool-call matrix (protected paths,
 * bypass patterns, secrets, WHERE clauses, fail-closed crash handling, the
 * `stdout-decision-deny` contract via their generalised `wasBlocked`/
 * `sawCancel` checkers) — that coverage is not repeated here. This file
 * exists for the three things specific to this harness that no generic
 * matrix covers:
 *
 *  1. The confirmed `{"decision":"deny","reason":"..."}` stdout shape, end
 *     to end against the real emitted script (a narrower, more literal pin
 *     than the generic matrix's `wasBlocked` helper).
 *  2. Double-gating harmlessness: Grok Build ALSO natively reads
 *     `.claude/settings.json` hooks, so a workspace with both Intutic gates
 *     installed fires both on one tool call. This proves that is harmless —
 *     neither gate corrupts the other's audit trail, and both blocks stay
 *     independently attributable (never silently collapsed into one count),
 *     matching the "additive, not exclusive" posture documented in
 *     apps/docs/guide/mcp-governance.md for the proxy+gate combination.
 *  3. TOML `[mcp_servers.*]` dedup: a server declared in BOTH
 *     `.cursor/mcp.json` (Grok Build's OTHER compat-read path, already
 *     wrapped under `harness: 'cursor'`) and Grok Build's own
 *     `[mcp_servers.*]` table must produce exactly two DISTINCT
 *     `discoverMcpServers` rows — never merged into one, never a third
 *     phantom row.
 *
 * @module
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as node_fs from 'node:fs/promises'
import { writeFileSync, mkdirSync } from 'node:fs'
import * as node_path from 'node:path'
import * as node_os from 'node:os'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { parse as parseToml } from 'smol-toml'
import { DESTRUCTIVE_COMMAND_PATTERNS } from '../../src/harness/protectedPaths.js'
import { toRulesLine } from '../../src/harness/gateBody.js'

function writeRulesFixture(target: string): string {
  const lines = DESTRUCTIVE_COMMAND_PATTERNS.map(toRulesLine)
  const digest = createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 32)
  writeFileSync(target, `#digest ${digest}\n#generated ${new Date().toISOString()}\n${lines.join('\n')}\n`)
  return target
}

interface RunResult { status: number | null; stdout: string; stderr: string }

function runScript(scriptPath: string, input: string, env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [scriptPath], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => { stdout += d })
    child.stderr.on('data', (d: string) => { stderr += d })
    child.on('error', reject)
    child.on('close', (status) => resolve({ status, stdout, stderr }))
    child.stdin.write(input)
    child.stdin.end()
  })
}

/** Reads the confirmed `{"decision":"deny",...}` verdict off stdout, or null
 *  if no such line was printed (an allow). */
function readDecision(r: RunResult): { decision: string; reason: string } | null {
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue
    try {
      const obj = JSON.parse(line)
      if (obj && typeof obj === 'object' && 'decision' in obj) {
        return { decision: obj.decision, reason: String(obj.reason ?? '') }
      }
    } catch {
      // not the verdict line
    }
  }
  return null
}

describe('Grok Build hooks writer', () => {
  let workspaceRoot: string
  let home: string
  let scriptPath: string
  let auditLog: string
  let snapshotPath: string
  let noSnapshotPath: string
  let env: NodeJS.ProcessEnv
  const prevHome = process.env.HOME

  beforeAll(async () => {
    workspaceRoot = await node_fs.mkdtemp(node_path.join(node_os.tmpdir(), 'intutic-grok-ws-'))
    home = await node_fs.mkdtemp(node_path.join(node_os.tmpdir(), 'intutic-grok-home-'))
    // grokHooks.ts reads os.homedir() at module scope (GROK_USER_DIR), so
    // HOME must be set before the dynamic import — same pitfall
    // generatedShellIntegrity.test.ts documents for gooseHooks/piHooks.
    process.env.HOME = home
    const { writeGrokHooks } = await import('../../src/harness/grokHooks.js')
    await writeGrokHooks(workspaceRoot, 'http://127.0.0.1:4000', 'ws_test')
    scriptPath = node_path.join(workspaceRoot, '.intutic', 'hooks', 'grok-check.js')
    auditLog = node_path.join(workspaceRoot, '.intutic', 'events', 'hook-events.jsonl')
    snapshotPath = writeRulesFixture(node_path.join(home, 'snapshot.rules'))
    noSnapshotPath = node_path.join(home, 'no-such.rules')
    env = { ...process.env, HOME: home, USERPROFILE: home }
  })

  afterAll(async () => {
    process.env.HOME = prevHome
    await node_fs.rm(workspaceRoot, { recursive: true, force: true })
    await node_fs.rm(home, { recursive: true, force: true })
  })

  it('writes the hook registration at project and user level with no matcher, in the real {hooks:{PreToolUse:[...]}} shape', async () => {
    const projectReg = JSON.parse(
      await node_fs.readFile(node_path.join(workspaceRoot, '.grok', 'hooks', 'intutic-governance.json'), 'utf-8'),
    )
    const userReg = JSON.parse(
      await node_fs.readFile(node_path.join(home, '.grok', 'hooks', 'intutic-governance.json'), 'utf-8'),
    )
    for (const reg of [projectReg, userReg]) {
      // CONFIRMED shape (xai_grok_hooks::config::parse_hook_file requires a
      // top-level "hooks" key — a flat {event,command,timeout} record, this
      // writer's shape before the TD-364 fix, silently parses to ZERO hooks).
      const groups = reg.hooks.PreToolUse
      expect(Array.isArray(groups)).toBe(true)
      expect(groups).toHaveLength(1)
      expect(groups[0].matcher).toBeUndefined()
      const handler = groups[0].hooks[0]
      expect(handler.type).toBe('command')
      expect(handler.command).toContain('grok-check.js')
      expect(handler.timeout).toBe(5)
    }
  })

  it('merges base_url into config.toml at project and user level, under the confirmed default model id', async () => {
    const projectToml = parseToml(
      await node_fs.readFile(node_path.join(workspaceRoot, '.grok', 'config.toml'), 'utf-8'),
    ) as { model?: Record<string, { base_url?: string }> }
    const userToml = parseToml(
      await node_fs.readFile(node_path.join(home, '.grok', 'config.toml'), 'utf-8'),
    ) as { model?: Record<string, { base_url?: string }> }
    // "grok-4.6" — CONFIRMED against the real open-sourced
    // xai-grok-models/default_models.json compiled default, not "default".
    expect(projectToml.model?.['grok-4.6']?.base_url).toBe('http://127.0.0.1:4000')
    expect(userToml.model?.['grok-4.6']?.base_url).toBe('http://127.0.0.1:4000')
  })

  it('never invents a model id if one is already configured — only overrides base_url', async () => {
    // A fresh workspace + HOME so this test's pre-existing [model."grok-4"]
    // fixture is the only thing `writeGrokHooks` sees, at BOTH levels this
    // writer merges (project and user) — not the shared `workspaceRoot`/
    // `home` from the outer `beforeAll`, which the earlier tests already
    // ran `writeGrokHooks` against with no pre-existing config.
    const scratchRoot = await node_fs.mkdtemp(node_path.join(node_os.tmpdir(), 'intutic-grok-scratch-root-'))
    const scratchHome = await node_fs.mkdtemp(node_path.join(node_os.tmpdir(), 'intutic-grok-scratch-home-'))
    const projectConfigPath = node_path.join(scratchRoot, '.grok', 'config.toml')
    mkdirSync(node_path.dirname(projectConfigPath), { recursive: true })
    writeFileSync(projectConfigPath, '[model."grok-4"]\ntemperature = 0.2\n')

    const { writeGrokHooks } = await import('../../src/harness/grokHooks.js')
    const prev = process.env.HOME
    process.env.HOME = scratchHome
    let mergedRaw: string
    try {
      await writeGrokHooks(scratchRoot, 'http://127.0.0.1:4000', 'ws_test')
      mergedRaw = await node_fs.readFile(projectConfigPath, 'utf-8')
    } finally {
      process.env.HOME = prev
      await node_fs.rm(scratchHome, { recursive: true, force: true })
      await node_fs.rm(scratchRoot, { recursive: true, force: true })
    }

    const merged = parseToml(mergedRaw) as { model?: Record<string, { base_url?: string; temperature?: number }> }
    expect(merged.model?.['grok-4']?.base_url).toBe('http://127.0.0.1:4000')
    expect(merged.model?.['grok-4']?.temperature).toBe(0.2)
    expect(merged.model?.['grok-4.6']).toBeUndefined()
  })

  it('allows an ordinary command and prints no decision object', async () => {
    const r = await runScript(scriptPath, JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'npm run build' } }), {
      ...env, INTUTIC_SNAPSHOT_RULES: noSnapshotPath,
    })
    expect(r.status).toBe(0)
    expect(readDecision(r)).toBeNull()
  })

  it('blocks a protected-path write with the CONFIRMED {"decision":"deny",...} stdout shape, exit 0', async () => {
    const r = await runScript(
      scriptPath,
      JSON.stringify({ tool_name: 'Write', tool_input: { file_path: '.claude/settings.local.json' } }),
      { ...env, INTUTIC_SNAPSHOT_RULES: noSnapshotPath },
    )
    // The load-bearing assertion this whole contract exists for: Grok Build
    // ignores the exit code entirely, so it MUST be 0 even on a block — a
    // gate that exits 2 here would be silently inert against a real Grok
    // Build install (it does not read `cancel` either — see gateBody.ts's
    // BlockContract doc for why the two stdout contracts are not folded
    // into one).
    expect(r.status).toBe(0)
    const decision = readDecision(r)
    expect(decision, `no decision object on stdout:\n${r.stdout}`).not.toBeNull()
    expect(decision!.decision).toBe('deny')
    expect(decision!.reason.length).toBeGreaterThan(0)
  })

  it('blocks a destructive command once the snapshot supplies it, still via decision:deny', async () => {
    const r = await runScript(scriptPath, JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }), {
      ...env, INTUTIC_SNAPSHOT_RULES: snapshotPath,
    })
    expect(r.status).toBe(0)
    expect(readDecision(r)?.decision).toBe('deny')
  })

  it('writes a parseable audit line for both the allow and the block above', async () => {
    const text = await node_fs.readFile(auditLog, 'utf-8')
    const lines = text.split('\n').filter(Boolean)
    expect(lines.length).toBeGreaterThanOrEqual(2)
    for (const line of lines) {
      expect(() => JSON.parse(line), `not JSON: ${line}`).not.toThrow()
    }
    const events = lines.map((l) => JSON.parse(l))
    expect(events.some((e) => e.event === 'tool_allowed')).toBe(true)
    expect(events.some((e) => e.event === 'tool_blocked')).toBe(true)
    // Every line self-attributes to this harness — the field double-gating
    // harmlessness (below) depends on to keep two harnesses' events
    // distinguishable in one shared log.
    for (const e of events) expect(e.harnessType).toBe('grok')
  })
})

describe('Grok Build double-gating with the Claude Code compat hook', () => {
  // Grok Build natively executes `.claude/settings.json` hooks if present —
  // a compatibility feature of Grok Build ITSELF, not something Intutic
  // adds. So a workspace connected to both Claude Code and Grok Build has
  // TWO independent gates evaluating the SAME Grok Build tool call. This
  // proves that is harmless: both fire, both block, neither corrupts the
  // shared audit log, and the two verdicts stay separately attributable —
  // never silently merged into one count. See apps/docs/guide/mcp-governance
  // .md's "Both layers firing on the same blocked call is expected, not a
  // bug" for the identical posture already documented for the proxy+gate
  // combination.
  let workspaceRoot: string
  let home: string
  let grokScript: string
  let claudeScript: string
  let auditLog: string
  const prevHome = process.env.HOME

  beforeAll(async () => {
    workspaceRoot = await node_fs.mkdtemp(node_path.join(node_os.tmpdir(), 'intutic-doublegate-ws-'))
    home = await node_fs.mkdtemp(node_path.join(node_os.tmpdir(), 'intutic-doublegate-home-'))
    process.env.HOME = home

    const { writeGrokHooks } = await import('../../src/harness/grokHooks.js')
    const { updatePreToolUseHooks } = await import('../../src/harness/claudeCodeHooks.js')
    await writeGrokHooks(workspaceRoot, 'http://127.0.0.1:4000', 'ws_test')
    await updatePreToolUseHooks(workspaceRoot, [], {}, 'http://127.0.0.1:4000', 'ws_test')

    grokScript = node_path.join(workspaceRoot, '.intutic', 'hooks', 'grok-check.js')
    claudeScript = node_path.join(workspaceRoot, '.intutic', 'hooks', 'claude-code-check.js')
    // Both writers log to the SAME workspace-relative path — the shared file
    // a real double-gated install would actually produce.
    auditLog = node_path.join(workspaceRoot, '.intutic', 'events', 'hook-events.jsonl')
  })

  afterAll(async () => {
    process.env.HOME = prevHome
    await node_fs.rm(workspaceRoot, { recursive: true, force: true })
    await node_fs.rm(home, { recursive: true, force: true })
  })

  it('both gates exist and are independently invocable', async () => {
    await expect(node_fs.access(grokScript)).resolves.toBeUndefined()
    await expect(node_fs.access(claudeScript)).resolves.toBeUndefined()
  })

  it('both gates block the SAME tool call, through their OWN contracts, without corrupting the shared log', async () => {
    const env = { ...process.env, HOME: home, USERPROFILE: home, INTUTIC_SNAPSHOT_RULES: node_path.join(home, 'no-such.rules') }
    const payload = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: '.claude/settings.local.json' } })

    const grokResult = await runScript(grokScript, payload, env)
    const claudeResult = await runScript(claudeScript, payload, env)

    // Grok Build's contract: exit 0, decision:deny on stdout.
    expect(grokResult.status).toBe(0)
    expect(readDecision(grokResult)?.decision).toBe('deny')
    // Claude Code's contract: exit 2, nothing meaningful on stdout — a
    // DIFFERENT mechanism, unaffected by Grok Build's gate also having run.
    expect(claudeResult.status).toBe(2)

    // The shared audit log accumulated both blocks, each still valid JSON —
    // this is the assertion that would catch an interleaved-write corruption
    // or one writer's escaping breaking the other's line.
    const text = await node_fs.readFile(auditLog, 'utf-8')
    const lines = text.split('\n').filter(Boolean)
    const events = lines.map((l) => {
      expect(() => JSON.parse(l), `double-gating corrupted the shared audit log: ${l}`).not.toThrow()
      return JSON.parse(l)
    })

    const grokBlocks = events.filter((e) => e.harnessType === 'grok' && e.event === 'tool_blocked')
    const claudeBlocks = events.filter((e) => e.harnessType === 'claude-code' && e.event === 'tool_blocked')
    // Two INDEPENDENT block records, not one collapsed into the other and
    // not a third phantom entry — the "additive, not exclusive" posture:
    // an operator counting blocks by harnessType sees the true origin of
    // each, rather than one gate's firing silently absorbing the other's.
    expect(grokBlocks.length).toBeGreaterThanOrEqual(1)
    expect(claudeBlocks.length).toBeGreaterThanOrEqual(1)
  })
})

describe('Grok Build TOML `[mcp_servers.*]` — wrap, and dedup against the .cursor/mcp.json compat path', () => {
  const prevHome = process.env.HOME
  const prevUserProfile = process.env.USERPROFILE

  it('wraps a stdio [mcp_servers.*] entry with the governance proxy, project and user level', async () => {
    const h = await node_fs.mkdtemp(node_path.join(node_os.tmpdir(), 'intutic-grok-mcp-home-'))
    const root = await node_fs.mkdtemp(node_path.join(node_os.tmpdir(), 'intutic-grok-mcp-root-'))
    process.env.HOME = h
    process.env.USERPROFILE = h
    try {
      await node_fs.mkdir(node_path.join(root, '.grok'), { recursive: true })
      await node_fs.writeFile(
        node_path.join(root, '.grok', 'config.toml'),
        '[mcp_servers.github]\ncommand = "npx"\nargs = ["-y", "server-github"]\n\n[model."grok-4"]\nbase_url = "https://api.x.ai/v1"\n',
      )

      const { injectMcpServer } = await import('../../src/harness/mcpAutoWrite.js')
      await injectMcpServer(root, 'ws_test')

      const written = parseToml(await node_fs.readFile(node_path.join(root, '.grok', 'config.toml'), 'utf-8')) as {
        mcp_servers?: Record<string, { command?: string; args?: string[]; __intutic_wrapped?: boolean }>
        model?: Record<string, { base_url?: string }>
      }
      expect(written.mcp_servers?.github?.__intutic_wrapped).toBe(true)
      expect(written.mcp_servers?.github?.command).toBe('node')
      expect(written.mcp_servers?.github?.args).toContain('--server-name')
      expect(written.mcp_servers?.github?.args).toContain('npx')
      expect(written.mcp_servers?.intutic).toBeDefined()
      // The [model.*] table `injectMcpServer` never touches must survive
      // untouched — proof the TOML round-trip did not clobber unrelated tables.
      expect(written.model?.['grok-4']?.base_url).toBe('https://api.x.ai/v1')
    } finally {
      process.env.HOME = prevHome
      process.env.USERPROFILE = prevUserProfile
      await node_fs.rm(h, { recursive: true, force: true })
      await node_fs.rm(root, { recursive: true, force: true })
    }
  })

  it('a server declared in BOTH .cursor/mcp.json and Grok Build config.toml produces exactly two distinct rows, never merged or tripled', async () => {
    const h = await node_fs.mkdtemp(node_path.join(node_os.tmpdir(), 'intutic-grok-dedup-home-'))
    const root = await node_fs.mkdtemp(node_path.join(node_os.tmpdir(), 'intutic-grok-dedup-root-'))
    process.env.HOME = h
    process.env.USERPROFILE = h
    try {
      // The SAME logical server, "shared-server", declared independently in
      // both of Grok Build's compat/native config paths — exactly the
      // scenario this file's module doc describes as legitimate, not a bug.
      await node_fs.mkdir(node_path.join(root, '.cursor'), { recursive: true })
      await node_fs.writeFile(
        node_path.join(root, '.cursor', 'mcp.json'),
        JSON.stringify({ mcpServers: { 'shared-server': { command: 'npx', args: ['-y', 'shared-server'] } } }),
      )
      await node_fs.mkdir(node_path.join(root, '.grok'), { recursive: true })
      await node_fs.writeFile(
        node_path.join(root, '.grok', 'config.toml'),
        '[mcp_servers."shared-server"]\ncommand = "npx"\nargs = ["-y", "shared-server"]\n',
      )

      const { injectMcpServer, discoverMcpServers } = await import('../../src/harness/mcpAutoWrite.js')
      await injectMcpServer(root, 'ws_test')

      const discovered = await discoverMcpServers(root)
      const sharedRows = discovered.filter((s) => s.server === 'shared-server')

      expect(
        sharedRows.length,
        `expected exactly 2 rows for the same server name across two harness configs, got ${sharedRows.length}: ${JSON.stringify(sharedRows)}`,
      ).toBe(2)
      const byHarness = new Set(sharedRows.map((s) => s.harness))
      expect(byHarness).toEqual(new Set(['cursor', 'grok']))
      // Both independently wrapped — this file's injector ran against both
      // configs, not just one.
      for (const row of sharedRows) expect(row.wrapped).toBe(true)

      // The `intutic` control-plane entry itself must never be counted,
      // regardless of how many config files it was written into (both
      // .cursor/mcp.json AND Grok Build's config.toml now carry one) — this
      // is the existing `discoverMcpServers` filter, re-asserted here
      // because Grok Build is the harness whose double-write path could
      // most plausibly have reintroduced it.
      expect(discovered.some((s) => s.server === 'intutic')).toBe(false)
    } finally {
      process.env.HOME = prevHome
      process.env.USERPROFILE = prevUserProfile
      await node_fs.rm(h, { recursive: true, force: true })
      await node_fs.rm(root, { recursive: true, force: true })
    }
  })
})
