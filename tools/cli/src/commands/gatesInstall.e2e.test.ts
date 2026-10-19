/**
 * `intutic gates install` end to end, offline, for Claude Code and Cursor: the
 * files it writes next to the user's own, the snapshot the gates verify, the
 * generated gates deciding real tool calls, and `intutic disconnect` putting
 * everything back.
 *
 * The workspace path has a space in it, which the Claude Code hook command
 * must survive. No control plane exists anywhere in this test: `fetch` throws,
 * `runtime.env` names none, and the gates are spawned with no network to use.
 *
 * Writers keep some paths in module-level constants computed from the home
 * directory at import time, so HOME is moved before anything is imported.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

const fake = vi.hoisted(() => {
  const base = `${process.env.TMPDIR || '/tmp'}/intutic-gates-e2e-${process.pid}-${Date.now()}`.replace(/\/+/g, '/')
  process.env.HOME = `${base}/home`
  process.env.USERPROFILE = `${base}/home`
  delete process.env.XDG_CONFIG_HOME
  delete process.env.CODEX_HOME
  delete process.env.PORT
  delete process.env.INTUTIC_PROXY_URL
  delete process.env.INTUTIC_SNAPSHOT_RULES
  return { base, home: `${base}/home`, ws: `${base}/home/code/my project` }
})

import * as fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { DESTRUCTIVE_TIER_SEVERITY, offlineHoldReason, snapshotRulesVerify } from '@intutic/sync-daemon'
import { runGatesInstall } from './gates.js'
import { runDisconnect } from './disconnect.js'

const { base, home, ws } = fake
const hooksDir = join(home, '.intutic', 'hooks')

const USER_CLAUDE_SETTINGS = JSON.stringify(
  {
    permissions: { allow: ['Bash(npm test)'] },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }] },
  },
  null,
  2,
) + '\n'
const USER_CURSOR_HOOKS = JSON.stringify({ version: 1, hooks: { afterFileEdit: [{ command: './format.sh' }] } }, null, 2) + '\n'

async function put(path: string, content: string | object): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n')
}

interface GateRun { code: number | null; stdout: string; stderr: string }

/** Spawned, not spawnSync: a blocking spawn starves Vitest's worker RPC. */
function runGate(script: string, payload: object): Promise<GateRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: ws,
      env: { PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(JSON.stringify(payload))
  })
}

const claudeGate = join(ws, '.intutic', 'hooks', 'claude-code-check.js')
const cursorGate = join(ws, '.intutic', 'hooks', 'cursor-check.js')
const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command }, session_id: 'sess_e2e' })

let fetchSpy: ReturnType<typeof vi.fn>

beforeAll(async () => {
  await fs.mkdir(ws, { recursive: true })
  await put(join(home, '.intutic', 'config.json'), { workspaceRoot: ws, harnesses: ['claude-code', 'cursor'], configVersion: 0, devMode: false })
  await put(join(ws, '.claude', 'settings.json'), USER_CLAUDE_SETTINGS)
  await put(join(home, '.cursor', 'hooks.json'), USER_CURSOR_HOOKS)
  await put(join(ws, '.intutic', 'sops', 'review.md'), '---\nreview_before: Write\n---\n# Review writes\n\nAsk before writing files.\n')
  // A connect from another time left a workspace id, and no key: the local
  // snapshot must still be the one the gates trust.
  await put(join(home, '.intutic', 'env', 'runtime.env'), 'INTUTIC_HOST=\nINTUTIC_API_KEY=\nINTUTIC_WORKSPACE_ID=ws_from_an_old_connect\n')

  fetchSpy = vi.fn(async () => { throw new Error('no network in this test') })
  vi.stubGlobal('fetch', fetchSpy)
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  await runGatesInstall({})
  vi.mocked(console.log).mockRestore()
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await fs.rm(base, { recursive: true, force: true })
})

describe('gates install, offline', () => {
  it('never reaches for a control plane', () => {
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("registers the Claude Code gate beside the user's own hook, quoted for the space in the path", async () => {
    const settings = JSON.parse(await fs.readFile(join(ws, '.claude', 'settings.json'), 'utf-8'))
    expect(settings.permissions.allow).toEqual(['Bash(npm test)'])
    const commands = settings.hooks.PreToolUse.flatMap((e: { hooks: Array<{ command: string }> }) => e.hooks.map((h) => h.command))
    expect(commands[0]).toBe('echo mine')
    expect(commands).toContain(`node "${claudeGate}"`)
  })

  it('writes the Kitkat skill, so an agent here can read what a refusal means', async () => {
    const skill = await fs.readFile(join(ws, '.agents', 'skills', 'intutic-governance-kitkat', 'SKILL.md'), 'utf-8')
    expect(skill).toContain('PREREQUISITE_UNMET')
  })

  it("registers the Cursor gate beside the user's own hook", async () => {
    const hooks = JSON.parse(await fs.readFile(join(home, '.cursor', 'hooks.json'), 'utf-8'))
    expect(hooks.hooks.afterFileEdit).toEqual([{ command: './format.sh' }])
    expect(JSON.stringify(hooks.hooks.beforeShellExecution)).toContain('cursor-check.js')
  })

  it('writes the rules files from the local SOPs', async () => {
    expect(await fs.readFile(join(ws, '.claude', 'rules', 'intutic-governance.md'), 'utf-8')).toContain('Ask before writing files.')
    expect(await fs.readFile(join(ws, '.cursor', 'rules', 'intutic-governance.mdc'), 'utf-8')).toContain('Ask before writing files.')
  })

  it('writes a snapshot that verifies, names no workspace, and is marked local', async () => {
    const rules = await fs.readFile(join(hooksDir, 'policy-snapshot.rules'), 'utf-8')
    expect(snapshotRulesVerify(rules)).toBe(true)
    expect(rules.split('\n')).toContain('#workspace ')
    expect(rules).toContain('#source local')
    expect(JSON.parse(await fs.readFile(join(hooksDir, 'policy-snapshot.json'), 'utf-8')).source).toBe('local')
  })
})

describe('the generated Claude Code gate, offline', () => {
  it('refuses removing the gates', async () => {
    expect((await runGate(claudeGate, bash('rm -rf ~/.intutic/hooks'))).code).toBe(2)
  })

  it('refuses unlocking its settings file', async () => {
    expect((await runGate(claudeGate, bash('chflags nouchg .claude/settings.json'))).code).toBe(2)
  })

  it('refuses a review_before: tool with the offline reason, and records no hold', async () => {
    const run = await runGate(claudeGate, { tool_name: 'Write', tool_input: { file_path: join(ws, 'notes.txt'), content: 'hi' }, session_id: 'sess_e2e' })
    expect(run.code).toBe(2)
    expect(run.stderr).toContain(offlineHoldReason('Write'))
    expect(existsSync(join(ws, '.intutic', 'events', 'review-requests.jsonl'))).toBe(false)
  })

  it('treats the destructive tier as the snapshot ships it', async () => {
    expect((await runGate(claudeGate, bash('rm -rf /'))).code).toBe(DESTRUCTIVE_TIER_SEVERITY === 'block' ? 2 : 0)
  })

  it('allows an ordinary command', async () => {
    expect((await runGate(claudeGate, bash('ls'))).code).toBe(0)
  })

  it('trusts the snapshot despite a stale workspace id, so MCP calls still run', async () => {
    const run = await runGate(claudeGate, { tool_name: 'mcp__github__create_issue', tool_input: { title: 't' }, session_id: 'sess_e2e' })
    expect(run.code).toBe(0)
    const events = await fs.readFile(join(ws, '.intutic', 'events', 'hook-events.jsonl'), 'utf-8')
    expect(events).not.toContain('snapshot_invalid')
  })
})

describe('the generated Cursor gate, offline', () => {
  it('refuses unlocking a settings file', async () => {
    const run = await runGate(cursorGate, { hook_event_name: 'beforeShellExecution', command: 'chflags nouchg .claude/settings.json' })
    expect(run.code).toBe(2)
  })

  it('allows an ordinary command, saying so', async () => {
    const run = await runGate(cursorGate, { hook_event_name: 'beforeShellExecution', command: 'ls' })
    expect(run.code).toBe(0)
    expect(JSON.parse(run.stdout)).toEqual({ permission: 'allow' })
  })
})

describe('intutic disconnect afterwards', () => {
  let printed = ''
  beforeAll(async () => {
    // No git (the test's own repository is not a workspace here) and no
    // docker (the machine's containers are not this test's).
    const path = process.env.PATH
    process.env.PATH = join(base, 'no-bin')
    const lines: string[] = []
    const capture = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
    const spies = [vi.spyOn(console, 'log').mockImplementation(capture), vi.spyOn(console, 'warn').mockImplementation(capture)]
    try {
      await runDisconnect({})
    } finally {
      process.env.PATH = path
      for (const spy of spies) spy.mockRestore()
      printed = lines.join('\n')
    }
  })

  it('tells no control plane, since there is none, and says how to reinstall', () => {
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(printed).not.toContain('Could not tell the control plane')
    expect(printed).toContain('Run `intutic gates install` to install the gates again.')
  })

  it("puts the user's files back byte for byte", async () => {
    expect(await fs.readFile(join(ws, '.claude', 'settings.json'), 'utf-8')).toBe(USER_CLAUDE_SETTINGS)
    expect(await fs.readFile(join(home, '.cursor', 'hooks.json'), 'utf-8')).toBe(USER_CURSOR_HOOKS)
  })

  it('removes the gates, the rules files, the snapshot and its verified copy', () => {
    for (const file of [
      claudeGate,
      cursorGate,
      join(ws, '.claude', 'rules', 'intutic-governance.md'),
      join(ws, '.cursor', 'rules', 'intutic-governance.mdc'),
      join(ws, '.cursor', 'hooks.json'),
      join(hooksDir, 'policy-snapshot.rules'),
      join(hooksDir, 'policy-snapshot.json'),
      join(hooksDir, 'verified', 'policy-snapshot.rules'),
      join(hooksDir, 'verified', 'policy-snapshot.json'),
      join(ws, '.agents', 'skills', 'intutic-governance-kitkat', 'SKILL.md'),
      join(ws, '.agents', 'skills', 'intutic-rule-author', 'SKILL.md'),
    ]) {
      expect(existsSync(file), file).toBe(false)
    }
    expect(existsSync(join(hooksDir, 'verified'))).toBe(false)
    // The skill directories gates install created for them go too.
    expect(existsSync(join(ws, '.agents'))).toBe(false)
  })

  it("keeps the user's SOPs", () => {
    expect(existsSync(join(ws, '.intutic', 'sops', 'review.md'))).toBe(true)
  })
})
