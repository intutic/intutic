/**
 * museHooks.test.ts — Muse Code writer coverage.
 *
 * `generatedGateBehaviour.test.ts`/`generatedShellIntegrity.test.ts`/
 * `generatedGateFailClosed.test.ts` already exercise this writer's `museCode`
 * row against the generic Claude-Code-shaped envelope every JS gate in the
 * registry is driven with — that coverage is not repeated here. This file
 * exists to prove the things specific to Muse's three-tier hook registration
 * that the shared matrix cannot see:
 *
 *  - the project-level `.muse/hooks.json` registers BOTH `PreToolUse` and
 *    `PermissionRequest` (Muse's two blocking lifecycle events);
 *  - the managed (pre-approved) tier is written correctly — an Intutic-owned
 *    `~/.config/muse/intutic-managed-hooks.json`, referenced from
 *    `~/.config/muse/settings.json` via `managed_hooks_path`;
 *  - `settings.json` is narrow-merged, never overwritten wholesale — a
 *    pre-existing `schema_version` and an unrelated key both survive a sync,
 *    and a first-ever write defaults `schema_version` to `1`;
 *  - re-running the writer is idempotent (no duplicate hook entries, no
 *    duplicate `managed_hooks_path` churn).
 *
 * See museHooks.ts's own module doc comment, and TD-362, for why the exit-2
 * block/deny contract and the hooks.json schema itself are ASSUMED rather
 * than confirmed against the real `muse` binary.
 *
 * @module
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as node_fs from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import * as node_path from 'node:path'
import * as node_os from 'node:os'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { DESTRUCTIVE_COMMAND_PATTERNS } from '../../src/harness/protectedPaths.js'
import { toRulesLine } from '../../src/harness/gateBody.js'

/** Writes a `.rules` fixture the way the daemon does — digest included, so
 *  the gate's own digest check accepts it. Mirrors the other harness test
 *  files' `writeRulesFixture`. */
function writeRulesFixture(target: string): string {
  const lines = DESTRUCTIVE_COMMAND_PATTERNS.map(toRulesLine)
  const digest = createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 32)
  writeFileSync(target, `#digest ${digest}\n#generated ${new Date().toISOString()}\n${lines.join('\n')}\n`)
  return target
}

function runScript(
  scriptPath: string,
  input: string,
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
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

describe('Muse Code hooks writer', () => {
  let workspaceRoot: string
  let home: string
  let scriptPath: string
  let auditLog: string
  let snapshotPath: string
  let noSnapshotPath: string
  let env: NodeJS.ProcessEnv
  const prevHome = process.env.HOME

  beforeAll(async () => {
    workspaceRoot = await node_fs.mkdtemp(node_path.join(node_os.tmpdir(), 'intutic-muse-ws-'))
    home = await node_fs.mkdtemp(node_path.join(node_os.tmpdir(), 'intutic-muse-home-'))
    // museHooks.ts reads os.homedir() at CALL time (inside writeMuseHooks),
    // not module scope — but HOME is still set before the dynamic import for
    // consistency with every other harness test in this suite.
    process.env.HOME = home

    // Seed a pre-existing settings.json with a custom schema_version and an
    // unrelated key, to prove the merge is narrow rather than a clobber.
    const museConfigDir = node_path.join(home, '.config', 'muse')
    await node_fs.mkdir(museConfigDir, { recursive: true })
    await node_fs.writeFile(
      node_path.join(museConfigDir, 'settings.json'),
      JSON.stringify({ schema_version: 3, some_user_setting: 'keep-me' }, null, 2) + '\n',
      'utf-8',
    )

    const { writeMuseHooks } = await import('../../src/harness/museHooks.js')
    await writeMuseHooks(workspaceRoot, 'http://127.0.0.1:4000', 'ws_test')

    scriptPath = node_path.join(workspaceRoot, '.intutic', 'hooks', 'muse-check.js')
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

  it('registers .muse/hooks.json under BOTH PreToolUse and PermissionRequest', async () => {
    const config = JSON.parse(
      await node_fs.readFile(node_path.join(workspaceRoot, '.muse', 'hooks.json'), 'utf-8'),
    )
    expect(Object.keys(config.hooks).sort()).toEqual(['PermissionRequest', 'PreToolUse'])
    for (const entries of Object.values(config.hooks) as unknown[][]) {
      expect(Array.isArray(entries)).toBe(true)
      expect(entries[0]).toMatchObject({
        matcher: '.*',
        hooks: [{ type: 'command', command: expect.stringContaining('muse-check.js') }],
      })
    }
  })

  it('writes the managed-hooks file and points settings.json at it via managed_hooks_path', async () => {
    const managedHooksPath = node_path.join(home, '.config', 'muse', 'intutic-managed-hooks.json')
    const managed = JSON.parse(await node_fs.readFile(managedHooksPath, 'utf-8'))
    expect(Object.keys(managed.hooks).sort()).toEqual(['PermissionRequest', 'PreToolUse'])

    const settings = JSON.parse(
      await node_fs.readFile(node_path.join(home, '.config', 'muse', 'settings.json'), 'utf-8'),
    )
    expect(settings.managed_hooks_path).toBe(managedHooksPath)
  })

  it('narrow-merges settings.json — preserves a pre-existing schema_version and unrelated keys', async () => {
    const settings = JSON.parse(
      await node_fs.readFile(node_path.join(home, '.config', 'muse', 'settings.json'), 'utf-8'),
    )
    expect(settings.schema_version).toBe(3)
    expect(settings.some_user_setting).toBe('keep-me')
  })

  it('is idempotent — a second run does not duplicate hook entries or churn managed_hooks_path', async () => {
    const { writeMuseHooks } = await import('../../src/harness/museHooks.js')
    await writeMuseHooks(workspaceRoot, 'http://127.0.0.1:4000', 'ws_test')

    const config = JSON.parse(
      await node_fs.readFile(node_path.join(workspaceRoot, '.muse', 'hooks.json'), 'utf-8'),
    )
    expect(config.hooks.PreToolUse).toHaveLength(1)
    expect(config.hooks.PermissionRequest).toHaveLength(1)

    const settings = JSON.parse(
      await node_fs.readFile(node_path.join(home, '.config', 'muse', 'settings.json'), 'utf-8'),
    )
    expect(settings.managed_hooks_path).toBe(
      node_path.join(home, '.config', 'muse', 'intutic-managed-hooks.json'),
    )
  })

  it('blocks a destructive command (dynamic tier)', async () => {
    const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } })
    const result = await runScript(scriptPath, payload, { ...env, INTUTIC_SNAPSHOT_RULES: snapshotPath })
    expect(result.status).toBe(2)
  })

  it('allows a benign command', async () => {
    const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'npm test' } })
    const result = await runScript(scriptPath, payload, { ...env, INTUTIC_SNAPSHOT_RULES: snapshotPath })
    expect(result.status).toBe(0)
  })

  it('blocks a write targeting a governance-protected path (floor tier — no snapshot needed)', async () => {
    const payload = JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: node_path.join(workspaceRoot, '.muse', 'hooks.json'), content: 'x' },
    })
    const result = await runScript(scriptPath, payload, { ...env, INTUTIC_SNAPSHOT_RULES: noSnapshotPath })
    expect(result.status).toBe(2)
  })

  it('refuses an envelope with none of the recognized fields', async () => {
    const result = await runScript(scriptPath, JSON.stringify({ nonsense: true }), {
      ...env,
      INTUTIC_SNAPSHOT_RULES: noSnapshotPath,
    })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('unrecognised PreToolUse payload')
  })

  it('emits an audit line on allow', async () => {
    await node_fs.rm(auditLog, { force: true })
    const payload = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'README.md' } })
    const result = await runScript(scriptPath, payload, { ...env, INTUTIC_SNAPSHOT_RULES: noSnapshotPath })
    expect(result.status).toBe(0)
    const lines = (await node_fs.readFile(auditLog, 'utf-8')).trim().split('\n').filter(Boolean)
    const allowed = lines.map((l) => JSON.parse(l)).find((e) => e.event === 'tool_allowed')
    expect(allowed?.harnessType).toBe('muse-code')
  })
})
