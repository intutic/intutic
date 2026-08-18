/**
 * windsurfHooks.test.ts — Cascade-real-payload coverage for the Windsurf
 * writer (correction, 2026-08-18).
 *
 * No dedicated test file existed for this writer before this correction.
 * `generatedGateBehaviour.test.ts`'s windsurf rows already exercise the
 * script against the generic Claude-Code-shaped envelope every harness is
 * driven with (`{tool_name, tool_input: {command}}`) — that coverage stays
 * valid and is not repeated here. This file exists to prove the thing that
 * changed: the script now recognizes Cascade's CONFIRMED real payload shape
 * (`agent_action_name` + `tool_info.*`, not the Cursor-shaped fields this
 * writer targeted before), and `hooks.json` now registers Cascade's real
 * event names (`pre_run_command`/`pre_write_code`/`pre_mcp_tool_use`) in
 * the array-wrapped shape Cascade's schema actually uses — see
 * windsurfHooks.ts's module doc comment for the full correction record and
 * sourcing (docs.devin.ai/desktop/cascade/hooks).
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
 *  the gate's own digest check accepts it. Mirrors
 *  generatedGateBehaviour.test.ts's `writeRulesFixture`. */
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

describe('Windsurf hooks writer — Cascade real payload shape', () => {
  let workspaceRoot: string
  let home: string
  let scriptPath: string
  let auditLog: string
  let snapshotPath: string
  let noSnapshotPath: string
  let env: NodeJS.ProcessEnv
  const prevHome = process.env.HOME

  beforeAll(async () => {
    workspaceRoot = await node_fs.mkdtemp(node_path.join(node_os.tmpdir(), 'intutic-windsurf-ws-'))
    home = await node_fs.mkdtemp(node_path.join(node_os.tmpdir(), 'intutic-windsurf-home-'))
    // windsurfHooks.ts reads os.homedir() at MODULE SCOPE (WINDSURF_USER_DIR),
    // so HOME must be set before the dynamic import, not merely before the
    // call — the same pitfall generatedShellIntegrity.test.ts's own comment
    // documents for gooseHooks/piHooks.
    process.env.HOME = home
    const { writeWindsurfHooks } = await import('../../src/harness/windsurfHooks.js')
    await writeWindsurfHooks(workspaceRoot, 'http://127.0.0.1:4000', 8877, 'ws_test')
    scriptPath = node_path.join(workspaceRoot, '.intutic', 'hooks', 'windsurf-check.js')
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

  it('registers hooks.json under Cascade\'s real event names, array-wrapped, with no failClosed field', async () => {
    const config = JSON.parse(
      await node_fs.readFile(node_path.join(home, '.codeium', 'windsurf', 'hooks.json'), 'utf-8'),
    )
    expect(Object.keys(config.hooks).sort()).toEqual(['pre_mcp_tool_use', 'pre_run_command', 'pre_write_code'])
    for (const entry of Object.values(config.hooks) as unknown[][]) {
      expect(Array.isArray(entry)).toBe(true)
      expect(entry[0]).toMatchObject({ command: expect.stringContaining('windsurf-check.js') })
      expect(entry[0]).not.toHaveProperty('failClosed')
    }
    // Cursor's event names must NOT appear — a stray entry under one would
    // be silently ignored by Cascade (unknown hooks.json keys), but its
    // presence would misleadingly suggest this writer still believes in it.
    expect(config.hooks).not.toHaveProperty('beforeShellExecution')
    expect(config.hooks).not.toHaveProperty('beforeMCPExecution')
    expect(config.hooks).not.toHaveProperty('beforeFileEdit')
  })

  it('blocks pre_run_command reading tool_info.command_line (real Cascade shape, dynamic tier)', async () => {
    const payload = JSON.stringify({
      agent_action_name: 'pre_run_command',
      trajectory_id: 'traj_test',
      tool_info: { command_line: 'rm -rf /', cwd: workspaceRoot },
    })
    const result = await runScript(scriptPath, payload, { ...env, INTUTIC_SNAPSHOT_RULES: snapshotPath })
    expect(result.status).toBe(2)
  })

  it('allows pre_run_command with a benign command_line', async () => {
    const payload = JSON.stringify({
      agent_action_name: 'pre_run_command',
      tool_info: { command_line: 'npm test', cwd: workspaceRoot },
    })
    const result = await runScript(scriptPath, payload, { ...env, INTUTIC_SNAPSHOT_RULES: snapshotPath })
    expect(result.status).toBe(0)
  })

  it('blocks pre_write_code targeting a protected path via tool_info.file_path (floor tier — no snapshot needed)', async () => {
    const payload = JSON.stringify({
      agent_action_name: 'pre_write_code',
      tool_info: {
        file_path: node_path.join(workspaceRoot, '.intutic', 'hooks', 'windsurf-check.js'),
        edits: [{ old_string: 'x', new_string: 'y' }],
      },
    })
    const result = await runScript(scriptPath, payload, { ...env, INTUTIC_SNAPSHOT_RULES: noSnapshotPath })
    expect(result.status).toBe(2)
  })

  it('allows pre_write_code targeting an ordinary file', async () => {
    const payload = JSON.stringify({
      agent_action_name: 'pre_write_code',
      tool_info: { file_path: node_path.join(workspaceRoot, 'src', 'index.ts'), edits: [] },
    })
    const result = await runScript(scriptPath, payload, { ...env, INTUTIC_SNAPSHOT_RULES: noSnapshotPath })
    expect(result.status).toBe(0)
  })

  it('composes mcp__<server>__<tool> from tool_info.mcp_server_name/mcp_tool_name (pre_mcp_tool_use)', async () => {
    await node_fs.rm(auditLog, { force: true })
    const payload = JSON.stringify({
      agent_action_name: 'pre_mcp_tool_use',
      trajectory_id: 'traj_test',
      tool_info: {
        mcp_server_name: 'github',
        mcp_tool_name: 'create_issue',
        mcp_tool_arguments: { owner: 'acme', repo: 'demo', title: 'bug' },
      },
    })
    const result = await runScript(scriptPath, payload, { ...env, INTUTIC_SNAPSHOT_RULES: noSnapshotPath })
    expect(result.status).toBe(0)
    const lines = (await node_fs.readFile(auditLog, 'utf-8')).trim().split('\n').filter(Boolean)
    const allowed = lines.map((l) => JSON.parse(l)).find((e) => e.event === 'tool_allowed')
    expect(allowed?.toolName).toBe('mcp__github__create_issue')
  })

  it('still recognizes the generic Claude-Code-shaped envelope (fallback preserved)', async () => {
    // generatedGateBehaviour.test.ts drives every harness writer with this
    // exact shape — proving it still works here is proving that adding the
    // real Cascade fields did not regress the existing generic coverage.
    const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } })
    const result = await runScript(scriptPath, payload, { ...env, INTUTIC_SNAPSHOT_RULES: snapshotPath })
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
})
