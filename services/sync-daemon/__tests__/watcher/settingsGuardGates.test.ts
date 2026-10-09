/**
 * settingsGuardGates.test.ts — the tamper guard watches every gate file and
 * everything that loads one, and puts each back.
 *
 * Every generated gate is restored by its own writer when it is deleted or
 * replaced, and the configs that name a gate (Codex's and Copilot's hook
 * files, Hermes's and Goose's configs) are restored while the gate is
 * installed. `isGuardedPath` is what the daemon's watcher callback routes on,
 * so a path the guard handles but the callback filtered out never reached it:
 * that was true of Cline's PreToolUse, OpenClaw's config and every dsh
 * profile patch.
 *
 * HOME is a temp directory, moved before anything is imported: the guard and
 * several writers resolve the home directory at import time.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { GATES, type GateEntry } from '../harness/gateRegistry.js'
import { GATE_SURFACES, resolveSurface } from '../harness/gateSurfaces.js'

const PROXY_URL = 'http://127.0.0.1:4000'
const MARKER = 'Intutic gate body'
const saved = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  INTUTIC_WORKSPACE_ID: process.env.INTUTIC_WORKSPACE_ID,
  CODEX_HOME: process.env.CODEX_HOME,
  DSH_HOME: process.env.DSH_HOME,
}

let home: string
let root: string
let guard: typeof import('../../src/watcher/settingsGuard.js')

const guardFile = (file: string) => guard.guardSettingsFile(file, root, [], PROXY_URL)
const exists = (file: string) => fs.access(file).then(() => true, () => false)

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'intutic-guard-gates-home-'))
  root = path.join(home, 'project')
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.INTUTIC_WORKSPACE_ID = 'ws_test'
  delete process.env.CODEX_HOME
  delete process.env.DSH_HOME
  guard = await import('../../src/watcher/settingsGuard.js')
})

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  // The Goose writer sets the immutable flag on its plugin files.
  spawnSync('chflags', ['-R', 'nouchg', home])
  await fs.rm(home, { recursive: true, force: true })
})

beforeEach(async () => {
  spawnSync('chflags', ['-R', 'nouchg', home])
  for (const entry of await fs.readdir(home)) await fs.rm(path.join(home, entry), { recursive: true, force: true })
  await fs.mkdir(root, { recursive: true })
})

describe('settings guard: what it watches', () => {
  it('watches every gate file and every config that loads one', () => {
    const unwatched: string[] = []
    for (const [harness, s] of Object.entries(GATE_SURFACES)) {
      for (const rel of [...s.gate, ...s.loaders]) {
        if (!guard.isGuardedPath(resolveSurface(rel, root, home), root)) unwatched.push(`${harness}: ${rel}`)
      }
    }
    expect(unwatched).toEqual([])
  })

  it("watches this platform's machine-wide Cursor hooks.json", async () => {
    const { systemHooksDirFor } = await import('../../src/harness/cursorHooks.js')
    expect(guard.isGuardedPath(path.join(systemHooksDirFor(process.platform), 'hooks.json'), root)).toBe(true)
  })

  it('no longer watches the files nothing writes: a Cline hooks.json and .roorules', () => {
    const watched = guard.buildProtectedPaths(root)
    expect(watched).not.toContain(path.join(root, '.clinerules', 'hooks', 'hooks.json'))
    expect(watched).not.toContain(path.join(root, '.roorules'))
  })

  it('passes over a path nobody guards', () => {
    expect(guard.isGuardedPath(path.join(root, 'src', 'index.ts'), root)).toBe(false)
    expect(guard.isGuardedPath(path.join(root, '.intutic', 'hooks', 'notes.txt'), root)).toBe(false)
  })
})

/** Goose hardens its plugin (immutable files carry an incident, not a restore); dsh has its own suite. */
const RESTORED = GATES.filter((g) => g.name !== 'goose' && g.name !== 'dsh')

async function install(g: GateEntry): Promise<string> {
  await g.invoke(await import(g.module), root)
  for (const base of [root, home]) {
    const file = path.join(base, g.artifact)
    if (await exists(file)) return file
  }
  throw new Error(`${g.name} wrote no ${g.artifact}`)
}

describe('settings guard: gate files', () => {
  it('covers a gate of every harness but the two with their own handling', () => {
    expect(RESTORED.length).toBe(GATES.length - 2)
  })

  for (const g of RESTORED) {
    it(`restores the ${g.name} gate when it is deleted or replaced, and leaves it alone otherwise`, async () => {
      const file = await install(g)
      expect(await guardFile(file), `${g.name}: an intact gate was reported`).toBe(false)

      await fs.rm(file)
      expect(await guardFile(file), `${g.name}: a deleted gate went unnoticed`).toBe(true)
      expect(await fs.readFile(file, 'utf-8')).toContain(MARKER)

      await fs.writeFile(file, '#!/bin/sh\nexit 0\n')
      expect(await guardFile(file), `${g.name}: a replaced gate went unnoticed`).toBe(true)
      expect(await fs.readFile(file, 'utf-8')).toContain(MARKER)
    }, 30_000)
  }

  it('ignores a gate file once its harness is disconnected', async () => {
    const file = await install(GATES.find((g) => g.name === 'codex')!)
    await fs.rm(file)
    expect(await guard.guardSettingsFile(file, root, [], PROXY_URL, undefined, new Set(['codex']))).toBe(false)
    expect(await exists(file)).toBe(false)
  })
})

describe('settings guard: Cline', () => {
  const gate = () => path.join(root, '.clinerules', 'hooks', 'PreToolUse')

  it('makes the gate executable again: Cline skips a hook that is not', async () => {
    await install(GATES.find((g) => g.name === 'cline')!)
    await fs.chmod(gate(), 0o644)
    expect(await guardFile(gate())).toBe(true)
    expect((await fs.stat(gate())).mode & 0o111).not.toBe(0)
  })

  it("leaves a PreToolUse the user wrote alone, edited or deleted", async () => {
    await fs.mkdir(path.dirname(gate()), { recursive: true })
    await fs.writeFile(gate(), '#!/bin/sh\necho mine\n', { mode: 0o755 })
    await install(GATES.find((g) => g.name === 'cline')!).catch(() => undefined)
    expect(await fs.readFile(gate(), 'utf-8')).toBe('#!/bin/sh\necho mine\n')

    await fs.writeFile(gate(), '#!/bin/sh\necho still mine\n')
    expect(await guardFile(gate())).toBe(false)
    expect(await fs.readFile(gate(), 'utf-8')).toBe('#!/bin/sh\necho still mine\n')
    await fs.rm(gate())
    expect(await guardFile(gate())).toBe(false)
    expect(await exists(gate())).toBe(false)
  })
})

describe('settings guard: configs that name the gate', () => {
  it("puts Codex's registration back at both levels, while the gate is installed", async () => {
    await install(GATES.find((g) => g.name === 'codex')!)
    const project = path.join(root, '.codex', 'hooks.json')
    const user = path.join(home, '.codex', 'hooks.json')

    await fs.writeFile(project, JSON.stringify({ hooks: {} }))
    expect(await guardFile(project)).toBe(true)
    expect(await fs.readFile(project, 'utf-8')).toContain('codex-check.js')
    await fs.rm(user)
    expect(await guardFile(user)).toBe(true)
    expect(await fs.readFile(user, 'utf-8')).toContain('codex-check.js')

    // Not installed: the file is the user's own.
    await fs.rm(path.join(root, '.intutic', 'hooks', 'codex-check.js'))
    await fs.writeFile(project, JSON.stringify({ hooks: {} }))
    expect(await guardFile(project)).toBe(false)
    expect(JSON.parse(await fs.readFile(project, 'utf-8'))).toEqual({ hooks: {} })
  })

  it("puts GitHub Copilot's hook files back", async () => {
    await install(GATES.find((g) => g.name === 'githubCopilot')!)
    for (const file of [
      path.join(root, '.github', 'hooks', 'intutic-governance.json'),
      path.join(home, '.copilot', 'hooks', 'intutic-governance.json'),
    ]) {
      await fs.rm(file)
      expect(await guardFile(file), file).toBe(true)
      expect(await fs.readFile(file, 'utf-8')).toContain('github-copilot-check.js')
    }
  })

  it("puts the gate back in Hermes's config, keeping the rest", async () => {
    await install(GATES.find((g) => g.name === 'hermes')!)
    const config = path.join(home, '.hermes', 'config.yaml')
    await fs.writeFile(config, 'model: local\nhooks:\n  pre_tool_call: []\n')
    expect(await guardFile(config)).toBe(true)
    const restored = await fs.readFile(config, 'utf-8')
    expect(restored).toContain('hermes-check.sh')
    expect(restored).toContain('model: local')
  })

  it("puts the gate back in Goose's config", async () => {
    await install(GATES.find((g) => g.name === 'goose')!)
    const config = path.join(home, '.config', 'goose', 'config.yaml')
    await fs.writeFile(config, 'GOOSE_MODEL: local\n')
    expect(await guardFile(config)).toBe(true)
    const restored = await fs.readFile(config, 'utf-8')
    expect(restored).toContain(path.join('.agents', 'plugins', 'intutic-governance', 'scripts', 'intutic-check.sh'))
    expect(restored).toContain('GOOSE_MODEL: local')
  })
})
