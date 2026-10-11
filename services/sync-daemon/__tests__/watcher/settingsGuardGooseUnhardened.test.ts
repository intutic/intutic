/**
 * settingsGuardGooseUnhardened.test.ts — the Goose plugin where the immutable
 * flag cannot be set.
 *
 * On Linux without root (a CI runner, most containers) hardening the plugin is
 * a no-op, so the guard never sees an immutable file. Its own regeneration
 * must still not read as tampering there; an edit by anyone else still must.
 * The hardener is replaced with one that never makes anything immutable, which
 * is what such a machine does.
 *
 * HOME is a temp directory, moved before anything is imported: the guard and
 * the writers resolve the home directory at import time.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

vi.mock('../../src/harness/gooseHardener.js', () => ({
  hardenGoosePlugin: async () => {},
  unharden: async () => {},
  isImmutable: async () => false,
}))

const PROXY_URL = 'http://127.0.0.1:4000'
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, INTUTIC_WORKSPACE_ID: process.env.INTUTIC_WORKSPACE_ID }

let home: string
let root: string
let guard: typeof import('../../src/watcher/settingsGuard.js')
let goose: typeof import('../../src/harness/gooseHooks.js')

async function pluginFiles(): Promise<string[]> {
  const dir = path.join(home, '.agents', 'plugins', 'intutic-governance')
  const out: string[] = []
  const walk = async (d: string): Promise<void> => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else out.push(p)
    }
  }
  await walk(dir)
  return out.sort()
}

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'intutic-guard-goose-home-'))
  root = path.join(home, 'project')
  await fs.mkdir(root, { recursive: true })
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.INTUTIC_WORKSPACE_ID = 'ws_test'
  guard = await import('../../src/watcher/settingsGuard.js')
  goose = await import('../../src/harness/gooseHooks.js')
  await goose.writeGooseHooks(PROXY_URL, root, 'ws_test')
})

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  await fs.rm(home, { recursive: true, force: true })
})

describe('settings guard: the Goose plugin without the immutable flag', () => {
  it('leaves the daemon’s own regeneration alone', async () => {
    await goose.writeGooseHooks(PROXY_URL, root, 'ws_test')
    const files = await pluginFiles()
    expect(files.length).toBeGreaterThan(0)
    const acted: string[] = []
    for (const file of files) {
      if (await guard.guardSettingsFile(file, root, [], PROXY_URL)) acted.push(path.relative(home, file))
    }
    expect(acted).toEqual([])
  })

  it('still restores a plugin file someone else changed', async () => {
    const [file] = (await pluginFiles()).filter((f) => f.endsWith('plugin.json'))
    const original = await fs.readFile(file, 'utf8')
    await fs.writeFile(file, original.replace(/\}\s*$/, ', "edited": true }'))
    expect(await guard.guardSettingsFile(file, root, [], PROXY_URL)).toBe(true)
    expect(await fs.readFile(file, 'utf8')).toBe(original)
  })
})
