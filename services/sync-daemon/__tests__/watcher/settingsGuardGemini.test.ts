/**
 * settingsGuardGemini.test.ts — the tamper guard covers the files the Gemini
 * CLI and Antigravity gates are registered in.
 *
 * The guard watched the project's `.gemini/settings.json`, which holds rules,
 * while the Gemini CLI gate lives in `~/.gemini/settings.json`: removing the
 * hook there went unnoticed. Antigravity's `~/.gemini/config/hooks.json` is
 * covered the same way. Like every gate file, both are restored whatever the
 * hand-edit setting says.
 *
 * HOME is a temp directory, moved before the guard is imported: it computes
 * its watch list from the home directory at import time.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

const PROXY_URL = 'http://127.0.0.1:4000'
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, INTUTIC_WORKSPACE_ID: process.env.INTUTIC_WORKSPACE_ID }

let home: string
let root: string
let guard: typeof import('../../src/watcher/settingsGuard.js')
let gemini: typeof import('../../src/harness/antigravityHooks.js')
let agy: typeof import('../../src/harness/antigravityCliHooks.js')

const settingsFile = () => path.join(home, '.gemini', 'settings.json')
const hooksFile = () => path.join(home, '.gemini', 'config', 'hooks.json')
const readJson = async (f: string) => JSON.parse(await fs.readFile(f, 'utf-8'))

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'intutic-guard-gemini-home-'))
  root = path.join(home, 'project')
  await fs.mkdir(root, { recursive: true })
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.INTUTIC_WORKSPACE_ID = 'ws_test'
  guard = await import('../../src/watcher/settingsGuard.js')
  gemini = await import('../../src/harness/antigravityHooks.js')
  agy = await import('../../src/harness/antigravityCliHooks.js')
})

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  await fs.rm(home, { recursive: true, force: true })
})

beforeEach(async () => {
  await fs.rm(path.join(home, '.gemini'), { recursive: true, force: true })
  // The user's own settings, with an MCP server named after Intutic: a
  // marker-substring check would call this file intact with the hook gone.
  await fs.mkdir(path.dirname(settingsFile()), { recursive: true })
  await fs.writeFile(settingsFile(), JSON.stringify({ theme: 'dark', mcpServers: { intutic: { command: 'intutic' } } }))
  await gemini.writeAntigravityHooks(root, PROXY_URL, 'ws_test')
  await agy.writeAntigravityCliHooks(root, PROXY_URL, 'ws_test')
})

describe('settings guard: Gemini CLI and Antigravity', () => {
  it('watches the user-level files the gates are registered in', () => {
    const watched = guard.buildProtectedPaths(root)
    expect(watched).toContain(settingsFile())
    expect(watched).toContain(hooksFile())
  })

  it('leaves intact registrations alone', async () => {
    expect(await guard.guardSettingsFile(settingsFile(), root, [], PROXY_URL)).toBe(false)
    expect(await guard.guardSettingsFile(hooksFile(), root, [], PROXY_URL)).toBe(false)
  })

  it('restores a Gemini CLI BeforeTool hook removed by hand, keeping the rest of the file', async () => {
    const doc = await readJson(settingsFile())
    delete doc.hooks
    await fs.writeFile(settingsFile(), JSON.stringify(doc))

    expect(await guard.guardSettingsFile(settingsFile(), root, [], PROXY_URL)).toBe(true)

    const restored = await readJson(settingsFile())
    expect(restored.hooks.BeforeTool[0].hooks[0].command).toContain('antigravity-check.sh')
    expect(restored.theme).toBe('dark')
    expect(restored.mcpServers.intutic).toEqual({ command: 'intutic' })
  })

  it('restores a deleted Gemini CLI settings file', async () => {
    await fs.rm(settingsFile())
    expect(await guard.guardSettingsFile(settingsFile(), root, [], PROXY_URL)).toBe(true)
    expect((await readJson(settingsFile())).hooks.BeforeTool[0].hooks[0].command).toContain('antigravity-check.sh')
  })

  it('restores an Antigravity hook disabled or removed by hand', async () => {
    const doc = await readJson(hooksFile())
    doc[agy.ANTIGRAVITY_HOOK_NAME].enabled = false
    doc.mine = { PreInvocation: [{ command: './remind.sh' }] }
    await fs.writeFile(hooksFile(), JSON.stringify(doc))

    expect(await guard.guardSettingsFile(hooksFile(), root, [], PROXY_URL)).toBe(true)

    const restored = await readJson(hooksFile())
    expect(restored[agy.ANTIGRAVITY_HOOK_NAME].enabled).toBe(true)
    expect(restored.mine).toEqual({ PreInvocation: [{ command: './remind.sh' }] })

    delete restored[agy.ANTIGRAVITY_HOOK_NAME]
    await fs.writeFile(hooksFile(), JSON.stringify(restored))
    expect(await guard.guardSettingsFile(hooksFile(), root, [], PROXY_URL)).toBe(true)
    expect((await readJson(hooksFile()))[agy.ANTIGRAVITY_HOOK_NAME].PreToolUse[0].hooks[0].command).toContain('antigravity-cli-check.js')
  })

  it('restores under record-only too: the gate is not the user\'s config', async () => {
    const doc = await readJson(settingsFile())
    delete doc.hooks
    await fs.writeFile(settingsFile(), JSON.stringify(doc))

    expect(await guard.guardSettingsFile(settingsFile(), root, [], PROXY_URL, { bypassEnforcementTier: 'alert-only' })).toBe(true)
    expect((await readJson(settingsFile())).hooks.BeforeTool[0].hooks[0].command).toContain('antigravity-check.sh')
  })

  it('ignores the files once the harness is disconnected', async () => {
    await fs.rm(hooksFile())
    expect(await guard.guardSettingsFile(hooksFile(), root, [], PROXY_URL, undefined, new Set(['antigravity']))).toBe(false)
    await expect(fs.access(hooksFile())).rejects.toThrow()
  })
})
