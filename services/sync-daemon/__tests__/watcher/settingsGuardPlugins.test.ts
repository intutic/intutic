/**
 * settingsGuardPlugins.test.ts — the tamper guard covers the Pi extension,
 * the OpenClaw plugin, and the OpenClaw config entry that loads it.
 *
 * An agent that deletes or edits either file, or takes the plugin out of
 * `plugins.load.paths`, turns the gate off for the next session. The guard
 * restores them as it restores the OpenCode plugin. OpenClaw rewrites its
 * own config, so that file is guarded only while the plugin is installed.
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
let pi: typeof import('../../src/harness/piHooks.js')
let openclaw: typeof import('../../src/harness/openclawHooks.js')

const extension = () => path.join(home, pi.PI_EXTENSION_FILE)
const plugin = () => path.join(home, openclaw.OPENCLAW_PLUGIN_FILE)
const config = () => path.join(home, '.openclaw', 'openclaw.json')
const readJson = async (f: string) => JSON.parse(await fs.readFile(f, 'utf-8'))

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'intutic-guard-plugins-home-'))
  root = path.join(home, 'project')
  await fs.mkdir(root, { recursive: true })
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.INTUTIC_WORKSPACE_ID = 'ws_test'
  guard = await import('../../src/watcher/settingsGuard.js')
  pi = await import('../../src/harness/piHooks.js')
  openclaw = await import('../../src/harness/openclawHooks.js')
})

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  await fs.rm(home, { recursive: true, force: true })
})

describe('settings guard: Pi extension and OpenClaw plugin', () => {
  beforeEach(async () => {
    for (const dir of ['.pi', '.openclaw', '.intutic']) await fs.rm(path.join(home, dir), { recursive: true, force: true })
  })

  it('watches the extension, the plugin and the OpenClaw config', () => {
    const watched = guard.buildProtectedPaths(root)
    expect(watched).toContain(extension())
    expect(watched).toContain(plugin())
    expect(watched).toContain(config())
  })

  it('leaves intact files alone, and restores a Pi extension that was deleted or edited', async () => {
    await pi.writePiHooks(root, PROXY_URL, 'ws_test')
    expect(await guard.guardSettingsFile(extension(), root, [], PROXY_URL)).toBe(false)

    await fs.writeFile(extension(), 'export default function () {}\n')
    expect(await guard.guardSettingsFile(extension(), root, [], PROXY_URL)).toBe(true)
    expect(await fs.readFile(extension(), 'utf-8')).toContain('Intutic gate body')

    await fs.rm(extension())
    expect(await guard.guardSettingsFile(extension(), root, [], PROXY_URL)).toBe(true)
    expect(await fs.readFile(extension(), 'utf-8')).toContain('Intutic gate body')
  })

  it('restores the OpenClaw plugin, and lists it again when it is taken out of plugins.load.paths', async () => {
    await fs.mkdir(path.dirname(config()), { recursive: true })
    await fs.writeFile(config(), JSON.stringify({ gateway: { port: 18789 } }))
    await openclaw.writeOpenclawHooks(root, PROXY_URL, 'ws_test')
    expect(await guard.guardSettingsFile(config(), root, [], PROXY_URL)).toBe(false)
    expect(await guard.guardSettingsFile(plugin(), root, [], PROXY_URL)).toBe(false)

    const doc = await readJson(config())
    doc.plugins.load.paths = []
    await fs.writeFile(config(), JSON.stringify(doc))
    expect(await guard.guardSettingsFile(config(), root, [], PROXY_URL)).toBe(true)
    expect(await readJson(config())).toEqual({ gateway: { port: 18789 }, plugins: { load: { paths: [plugin()] } } })

    await fs.rm(plugin())
    expect(await guard.guardSettingsFile(plugin(), root, [], PROXY_URL)).toBe(true)
    expect(await fs.readFile(plugin(), 'utf-8')).toContain('Intutic gate body')
  })

  it('leaves an OpenClaw config alone while the plugin is not installed', async () => {
    await fs.mkdir(path.dirname(config()), { recursive: true })
    await fs.writeFile(config(), JSON.stringify({ gateway: { port: 18789 } }))
    expect(await guard.guardSettingsFile(config(), root, [], PROXY_URL)).toBe(false)
    expect(await readJson(config())).toEqual({ gateway: { port: 18789 } })
    await expect(fs.access(plugin())).rejects.toThrow()
  })

  it('restores the OpenCode plugin with its own writer, not the Goose one', async () => {
    // Every one of these files is named intutic-governance; a name match
    // used to route them all to the Goose branch.
    const { writeOpenCodeHooks } = await import('../../src/harness/openCodeHooks.js')
    await writeOpenCodeHooks(root, PROXY_URL, 'ws_test')
    const file = path.join(root, '.opencode', 'plugins', 'intutic-governance.js')
    await fs.writeFile(file, 'export default async () => ({})\n')
    expect(await guard.guardSettingsFile(file, root, [], PROXY_URL)).toBe(true)
    expect(await fs.readFile(file, 'utf-8')).toContain('Intutic gate body')
    await expect(fs.access(path.join(home, '.agents', 'plugins'))).rejects.toThrow()
  })

  it('ignores the files once the harness is disconnected', async () => {
    expect(await guard.guardSettingsFile(extension(), root, [], PROXY_URL, undefined, new Set(['pi']))).toBe(false)
    await expect(fs.access(extension())).rejects.toThrow()
    expect(await guard.guardSettingsFile(plugin(), root, [], PROXY_URL, undefined, new Set(['openclaw']))).toBe(false)
    await expect(fs.access(plugin())).rejects.toThrow()
  })
})
