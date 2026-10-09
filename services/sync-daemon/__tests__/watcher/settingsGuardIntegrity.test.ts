/**
 * settingsGuardIntegrity.test.ts — the policy snapshot's self-heal, and the
 * VS Code settings that can switch off the GitHub Copilot gate.
 *
 * The daemon keeps the last snapshot it wrote, and so verified, beside the
 * live one. A live snapshot changed outside the daemon makes every gate
 * refuse every MCP call (`POLICY_SNAPSHOT_UNVERIFIED`); the settings guard
 * puts the verified copy back at once and reports the tamper through the
 * hook-events log, and the gates allow again. Run end to end: the real
 * writer, the real guard, and one node and one bash gate.
 *
 * HOME is a temp directory, moved before anything is imported: the guard and
 * the snapshot writer resolve the home directory at import time.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { GATES, rerunOnDeadline, type GateEntry } from '../harness/gateRegistry.js'

const PROXY_URL = 'http://127.0.0.1:4000'
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, INTUTIC_WORKSPACE_ID: process.env.INTUTIC_WORKSPACE_ID }

let home: string
let root: string
let snapshotDir: string
let guard: typeof import('../../src/watcher/settingsGuard.js')
let snapshot: typeof import('../../src/lib/policySnapshot.js')

const gates = (['claudeCode', 'openhands'] as const).map((n) => GATES.find((g) => g.name === n)!)

/** The tamper events the guard appended to the workspace's hook-events log. */
async function tamperEvents(): Promise<Array<Record<string, unknown>>> {
  const text = await fs.readFile(path.join(root, '.intutic', 'events', 'hook-events.jsonl'), 'utf8').catch(() => '')
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => e.event === 'config_tamper')
}

function policy(over: Record<string, unknown> = {}) {
  return {
    workspaceId: 'ws_test',
    interventionMode: 'TRANSPARENT',
    sopRules: [{ id: 's_write', toolPattern: 'Write', action: 'block', reason: 'no writes' }],
    mcpAllowedServers: ['github'],
    sqlDropStrictBlock: false,
    ...over,
  }
}

const liveRules = () => path.join(snapshotDir, 'policy-snapshot.rules')
const liveJson = () => path.join(snapshotDir, 'policy-snapshot.json')

/** Rewrites a live snapshot file the way an agent or a person would. */
async function edit(file: string, change: (text: string) => string): Promise<void> {
  const text = await fs.readFile(file, 'utf8')
  await fs.chmod(file, 0o644)
  await fs.writeFile(file, change(text))
}

const widen = (text: string) => text.replace(/^(@mcp_allowlist\t\w+\tgithub)$/m, '$1,newcomer')

interface RunResult { status: number; stderr: string }

/** Async spawn, never spawnSync: see the note in generatedGateBehaviour.test.ts. */
function runGate(g: GateEntry, tool: string): Promise<RunResult> {
  return rerunOnDeadline(() => new Promise((resolve, reject) => {
    const child = spawn(g.runner, [path.join(root, g.artifact)], {
      env: { ...process.env, HOME: home, USERPROFILE: home, INTUTIC_WORKSPACE_ID: 'ws_test' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d: string) => { stderr += d })
    child.stdout.resume()
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ status: code === null ? -1 : code, stderr })
    })
    child.stdin.end(JSON.stringify({ tool_name: tool, tool_input: {}, session_id: 'sess_heal' }))
  }), (r) => r.stderr)
}

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'intutic-guard-integrity-'))
  root = path.join(home, 'project')
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.INTUTIC_WORKSPACE_ID = 'ws_test'
  guard = await import('../../src/watcher/settingsGuard.js')
  snapshot = await import('../../src/lib/policySnapshot.js')
  snapshotDir = snapshot.DEFAULT_SNAPSHOT_DIR
  await fs.mkdir(root, { recursive: true })
  for (const g of gates) {
    const mod = (await import(g.module)) as Record<string, (...a: unknown[]) => Promise<void>>
    await g.invoke(mod, root)
  }
}, 120_000)

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  await fs.rm(home, { recursive: true, force: true })
})

beforeEach(async () => {
  vi.unstubAllGlobals()
  await fs.rm(snapshotDir, { recursive: true, force: true })
  await fs.rm(path.join(root, '.intutic', 'events'), { recursive: true, force: true })
  await snapshot.writePolicySnapshot(policy(), snapshotDir)
})

describe('policy snapshot self-heal', () => {
  it('watches both live snapshot files', () => {
    expect(guard.isGuardedPath(liveRules(), root)).toBe(true)
    expect(guard.isGuardedPath(liveJson(), root)).toBe(true)
  })

  it('keeps the verified copy the daemon wrote, byte for byte', async () => {
    for (const name of ['policy-snapshot.rules', 'policy-snapshot.json']) {
      expect(await fs.readFile(path.join(snapshotDir, 'verified', name), 'utf8')).toBe(await fs.readFile(path.join(snapshotDir, name), 'utf8'))
    }
  })

  for (const g of gates) {
    it(`${g.name} (${g.runner}): tamper, refused, restored, allowed again`, async () => {
      expect((await runGate(g, 'mcp__github__create_issue')).status, 'the healthy snapshot refused a listed server').toBe(0)

      await edit(liveRules(), widen)
      const refused = await runGate(g, 'mcp__github__create_issue')
      expect(refused.status, `the tampered snapshot admitted a server.\nstderr: ${refused.stderr.slice(0, 400)}`).toBe(2)
      expect(refused.stderr).toContain('[policy_snapshot]')

      const resync = vi.fn(async () => {})
      expect(await guard.guardSettingsFile(liveRules(), root, [], PROXY_URL, undefined, new Set(), resync)).toBe(true)
      expect(resync, 'a verified copy was kept, so there is nothing to fetch').not.toHaveBeenCalled()
      expect(await fs.readFile(liveRules(), 'utf8')).toBe(await fs.readFile(path.join(snapshotDir, 'verified', 'policy-snapshot.rules'), 'utf8'))

      expect((await runGate(g, 'mcp__github__create_issue')).status, 'the restored snapshot still refuses').toBe(0)
      const newcomer = await runGate(g, 'mcp__newcomer__query')
      expect(newcomer.status).toBe(2)
      expect(newcomer.stderr, 'the restored allowlist decides again').toContain('[mcp_allowlist]')

      const events = await tamperEvents()
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ toolName: 'policy_snapshot', workspaceId: 'ws_test', filePath: liveRules() })
      expect(String(events[0]!.reason)).toContain('restored')
    }, 120_000)
  }

  it('restores a deleted snapshot, and an edited JSON beside an intact .rules', async () => {
    await fs.rm(liveRules())
    expect(await guard.guardPolicySnapshot(root, async () => {})).toBe(true)
    expect(snapshot.snapshotRulesVerify(await fs.readFile(liveRules(), 'utf8'))).toBe(true)

    await edit(liveJson(), (t) => t.replace('"mcpAllowedServers": [\n    "github"', '"mcpAllowedServers": [\n    "github",\n    "newcomer"'))
    expect(await guard.guardPolicySnapshot(root, async () => {})).toBe(true)
    expect(JSON.parse(await fs.readFile(liveJson(), 'utf8')).mcpAllowedServers).toEqual(['github'])
    expect(await tamperEvents()).toHaveLength(2)
  })

  it('restores an older valid snapshot copied back in, since only the daemon writes these files', async () => {
    const older = await fs.readFile(liveRules(), 'utf8')
    await snapshot.writePolicySnapshot(policy({ mcpAllowedServers: ['github', 'linear'] }), snapshotDir)
    const newer = await fs.readFile(liveRules(), 'utf8')
    await edit(liveRules(), () => older)
    expect(await guard.guardPolicySnapshot(root, async () => {})).toBe(true)
    expect(await fs.readFile(liveRules(), 'utf8')).toBe(newer)
  })

  it('leaves the daemon\'s own writes alone and reports nothing', async () => {
    await snapshot.writePolicySnapshot(policy({ mcpAllowedServers: ['github', 'linear'] }), snapshotDir)
    expect(await guard.guardSettingsFile(liveRules(), root, [], PROXY_URL)).toBe(false)
    expect(await guard.guardSettingsFile(liveJson(), root, [], PROXY_URL)).toBe(false)
    expect(await tamperEvents()).toEqual([])
  })

  it('fetches a fresh snapshot when there is no verified copy to restore', async () => {
    await fs.rm(path.join(snapshotDir, 'verified'), { recursive: true, force: true })
    await edit(liveRules(), widen)
    const resync = vi.fn(async () => {
      await snapshot.writePolicySnapshot(policy(), snapshotDir)
    })
    expect(await guard.guardSettingsFile(liveRules(), root, [], PROXY_URL, undefined, new Set(), resync)).toBe(true)
    expect(resync).toHaveBeenCalledTimes(1)
    expect(snapshot.snapshotRulesVerify(await fs.readFile(liveRules(), 'utf8'))).toBe(true)
    const events = await tamperEvents()
    expect(events).toHaveLength(1)
    expect(String(events[0]!.reason)).toContain('fresh one was fetched')
  })

  it('rebuilds a refused key\'s snapshot from the verified copy, not an edited JSON', async () => {
    const opts = { controlPlaneUrl: 'https://cp.example', apiKey: 'k', workspaceId: 'ws_test', snapshotDir }
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({
        workspaceId: 'ws_test', interventionMode: 'TRANSPARENT', sopRules: [], allowedServers: ['github'],
        ssoGroupPolicy: { highRiskTools: ['Bash'], requiredGroups: ['sre'] }, principal: { memberId: 'mem_1', ssoGroups: ['sre'] },
      }),
    })) as unknown as typeof fetch)
    await snapshot.refreshPolicySnapshot(opts)
    await edit(liveJson(), (t) => t.replace('"mcpAllowedServers": [\n    "github"', '"mcpAllowedServers": [\n    "github",\n    "newcomer"'))
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch)
    expect(await snapshot.refreshPolicySnapshot(opts)).toBeNull()
    const rules = await fs.readFile(liveRules(), 'utf8')
    expect(rules).toMatch(/^@mcp_allowlist\tblock\tgithub$/m)
    expect(snapshot.snapshotRulesVerify(rules)).toBe(true)
  })
})

describe('VS Code settings that switch off the GitHub Copilot gate', () => {
  const workspaceSettings = () => path.join(root, '.vscode', 'settings.json')
  const userSettings = () =>
    process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'Code', 'User', 'settings.json')
      : path.join(home, '.config', 'Code', 'User', 'settings.json')
  const copilotGate = () => path.join(root, '.intutic', 'hooks', 'github-copilot-check.js')

  async function write(file: string, text: string): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, text)
  }

  beforeEach(async () => {
    await fs.rm(path.join(root, '.vscode'), { recursive: true, force: true })
    await fs.rm(path.join(home, 'Library'), { recursive: true, force: true })
    await fs.rm(path.join(home, '.config'), { recursive: true, force: true })
    await write(copilotGate(), '// Intutic gate body\n')
  })

  it('sets chat.useHooks back in the workspace settings, keeping the rest of the file and its comments', async () => {
    const text = '{\n  // my editor\n  "editor.tabSize": 2,\n  "chat.useHooks": false, /* off */\n}\n'
    await write(workspaceSettings(), text)
    expect(await guard.guardSettingsFile(workspaceSettings(), root, [], PROXY_URL)).toBe(true)
    expect(await fs.readFile(workspaceSettings(), 'utf8')).toBe(text.replace('"chat.useHooks": false', '"chat.useHooks": true'))
    const events = await tamperEvents()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ toolName: 'vscode_settings', harnessType: 'github-copilot', filePath: workspaceSettings() })
  })

  it('sets back only the user-settings locations that drop the gate', async () => {
    const text = JSON.stringify({ 'chat.hookFilesLocations': { '~/.copilot/hooks': false, '.claude/settings.json': false, 'tools/hooks': true } }, null, 2)
    await write(userSettings(), text)
    expect(await guard.guardSettingsFile(userSettings(), root, [], PROXY_URL)).toBe(true)
    expect(JSON.parse(await fs.readFile(userSettings(), 'utf8'))['chat.hookFilesLocations']).toEqual({
      '~/.copilot/hooks': true, '.claude/settings.json': false, 'tools/hooks': true,
    })
  })

  it('leaves settings that keep the gate on alone, and reports nothing', async () => {
    await write(workspaceSettings(), '{ "chat.useHooks": true, "chat.hookFilesLocations": { "tools/hooks": false } }')
    expect(await guard.guardSettingsFile(workspaceSettings(), root, [], PROXY_URL)).toBe(false)
    expect(await tamperEvents()).toEqual([])
  })

  it('does nothing while the Copilot gate is not installed, or Copilot was disconnected', async () => {
    const text = '{ "chat.useHooks": false }'
    await write(workspaceSettings(), text)
    expect(await guard.guardSettingsFile(workspaceSettings(), root, [], PROXY_URL, undefined, new Set(['github-copilot']))).toBe(false)
    await fs.rm(copilotGate())
    expect(await guard.guardSettingsFile(workspaceSettings(), root, [], PROXY_URL)).toBe(false)
    expect(await fs.readFile(workspaceSettings(), 'utf8')).toBe(text)
  })
})
