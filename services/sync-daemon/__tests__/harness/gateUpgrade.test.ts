/**
 * gateUpgrade.test.ts — a gate version bump, as every machine meets it.
 *
 * When GATE_VERSION moves, the daemon's next sync regenerates every gate,
 * registration and the policy snapshot over the ones the previous version
 * wrote. Three things must hold:
 *
 * - every gate is replaced with the current version, keeping its mode, and
 *   no temp file is left beside it;
 * - the daemon's own self-protection (the settings guard and the snapshot
 *   self-heal) does not take that regeneration for tampering;
 * - what the person added to the harness settings (their own hooks and
 *   permissions) survives it.
 *
 * The older version is the current one relabelled `v18`: what the guard
 * judges is the files, not what changed between versions. dsh is left out:
 * its gate is a checked-in module, not a generated file.
 *
 * HOME is a temp directory, moved before anything is imported: the guard and
 * several writers resolve the home directory at import time.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { GATES, type HarnessModule } from './gateRegistry.js'
import { GATE_SURFACES, resolveSurface } from './gateSurfaces.js'

const PROXY_URL = 'http://127.0.0.1:4000'
const OLD = 18
const saved = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  INTUTIC_WORKSPACE_ID: process.env.INTUTIC_WORKSPACE_ID,
  CODEX_HOME: process.env.CODEX_HOME,
  DSH_HOME: process.env.DSH_HOME,
}

let home: string
let root: string
let current: number
let guard: typeof import('../../src/watcher/settingsGuard.js')
let snapshot: typeof import('../../src/lib/policySnapshot.js')

const UPGRADED = GATES.filter((g) => g.name !== 'dsh')
const SURFACES = Object.entries(GATE_SURFACES).filter(([harness]) => harness !== 'dsh')

const exists = (file: string) => fs.access(file).then(() => true, () => false)
const modeOf = async (file: string) => (await fs.stat(file)).mode & 0o7777
const count = (text: string, word: string) => text.split(word).length - 1
const unlock = () => spawnSync('chflags', ['-R', 'nouchg', home])

/** Every regenerated file the guard watches, gates first. */
async function surfaceFiles(): Promise<string[]> {
  const files: string[] = []
  for (const [, s] of SURFACES) {
    for (const rel of [...s.gate, ...s.loaders]) {
      const file = resolveSurface(rel, root, home)
      if (!rel.startsWith('/') && (await exists(file))) files.push(file)
    }
  }
  return files
}

async function tamperEvents(): Promise<unknown[]> {
  const text = await fs.readFile(path.join(root, '.intutic', 'events', 'hook-events.jsonl'), 'utf8').catch(() => '')
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => e.event === 'config_tamper')
}

async function runWriters(): Promise<void> {
  for (const g of UPGRADED) await g.invoke((await import(g.module)) as HarnessModule, root)
}

/** The Claude Code settings a person had before the upgrade, the older gate's entry among them. */
const userClaudeSettings = () => ({
  env: { FOO: 'bar' },
  permissions: { allow: ['Bash(npm test)'], deny: ['Read(./.env)'] },
  hooks: {
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: './scripts/my-check.sh' }] },
      { matcher: '.*', hooks: [{ type: 'command', command: `node "${path.join(root, '.intutic', 'hooks', 'claude-code-check.js')}"` }] },
    ],
    PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'npx prettier --write' }] }],
  },
})

/** Gate files as the previous version left them, with the mode each was installed with. */
const before = new Map<string, { text: string; mode: number }>()

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'intutic-gate-upgrade-'))
  root = path.join(home, 'project')
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.INTUTIC_WORKSPACE_ID = 'ws_test'
  delete process.env.CODEX_HOME
  delete process.env.DSH_HOME
  guard = await import('../../src/watcher/settingsGuard.js')
  snapshot = await import('../../src/lib/policySnapshot.js')
  current = (await import('../../src/harness/gateBody.js')).GATE_VERSION
  await fs.mkdir(root, { recursive: true })

  // The previous version's install: every gate, then relabelled as older.
  await runWriters()
  unlock()
  for (const [, s] of SURFACES) {
    for (const rel of s.gate) {
      const file = resolveSurface(rel, root, home)
      const text = await fs.readFile(file, 'utf8')
      const mode = await modeOf(file)
      await fs.chmod(file, 0o644)
      await fs.writeFile(file, text.replaceAll(`v${current}`, `v${OLD}`))
      await fs.chmod(file, mode)
      before.set(file, { text, mode })
    }
  }
  const { hardenGoosePlugin } = await import('../../src/harness/gooseHardener.js')
  await hardenGoosePlugin(path.join(home, '.agents', 'plugins', 'intutic-governance'))
  await fs.writeFile(path.join(root, '.claude', 'settings.json'), JSON.stringify(userClaudeSettings(), null, 2) + '\n')
  await fs.rm(path.join(root, '.intutic', 'events'), { recursive: true, force: true })

  // The upgrade: the new version's normal write path.
  await runWriters()
}, 120_000)

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  unlock()
  await fs.rm(home, { recursive: true, force: true })
})

describe(`a v${OLD} → current gate upgrade`, () => {
  it('found an older gate of every harness to replace', () => {
    expect(before.size).toBeGreaterThanOrEqual(SURFACES.length)
    const versioned = [...before.values()].filter((b) => b.text.includes(`v${current}`))
    expect(versioned.length, 'too few gates carry their version for this test to mean anything').toBeGreaterThan(10)
  })

  it('replaces every gate with the current version, in its mode, with no temp file left', async () => {
    const wrong: string[] = []
    for (const [file, b] of before) {
      const text = await fs.readFile(file, 'utf8')
      // Not compared whole: gates carry the time they were generated.
      const labels = (t: string) => [count(t, `v${current}`), count(t, `v${OLD}`)].join('/')
      if (labels(text) !== labels(b.text)) wrong.push(`${file}: version labels ${labels(text)}, current gate ${labels(b.text)}`)
      if ((await modeOf(file)) !== b.mode) wrong.push(`${file}: mode ${(await modeOf(file)).toString(8)}, was ${b.mode.toString(8)}`)
      const temps = (await fs.readdir(path.dirname(file))).filter((n) => n.includes('tmp'))
      if (temps.length > 0) wrong.push(`${file}: left ${temps.join(', ')}`)
    }
    expect(wrong).toEqual([])
  })

  it('is not reported as tampering by the settings guard, for any gate or registration', async () => {
    const reported: string[] = []
    for (const file of await surfaceFiles()) {
      if (await guard.guardSettingsFile(file, root, [], PROXY_URL)) reported.push(path.relative(home, file))
    }
    expect(reported).toEqual([])
    expect(await tamperEvents()).toEqual([])
  })

  it("keeps the person's own Claude Code hooks and permissions, with one Intutic hook entry", async () => {
    const settings = JSON.parse(await fs.readFile(path.join(root, '.claude', 'settings.json'), 'utf8')) as ReturnType<typeof userClaudeSettings>
    const mine = userClaudeSettings()
    expect(settings.env).toEqual(mine.env)
    expect(settings.permissions.allow).toEqual(mine.permissions.allow)
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(mine.permissions.deny))
    expect(settings.hooks.PostToolUse).toEqual(mine.hooks.PostToolUse)
    expect(settings.hooks.PreToolUse).toContainEqual(mine.hooks.PreToolUse[0])
    const ours = settings.hooks.PreToolUse.filter((e) => JSON.stringify(e).includes('claude-code-check.js'))
    expect(ours.length).toBeGreaterThan(0)
    expect(new Set(ours.map((e) => e.matcher)).size, 'an Intutic entry was stacked rather than replaced').toBe(ours.length)
  })
})

describe(`the policy snapshot across a v${OLD} → current upgrade`, () => {
  const policy = (servers: string[]) => ({
    workspaceId: 'ws_test',
    interventionMode: 'TRANSPARENT',
    sopRules: [{ id: 's_write', toolPattern: 'Write', action: 'block', reason: 'no writes' }],
    mcpAllowedServers: servers,
    sqlDropStrictBlock: false,
  })

  it('replaces an older snapshot without the self-heal reporting it', async () => {
    const dir = snapshot.DEFAULT_SNAPSHOT_DIR
    await snapshot.writePolicySnapshot(policy(['github']), dir)
    // As the older daemon left it, live and verified copies alike.
    for (const file of [path.join(dir, 'policy-snapshot.json'), path.join(dir, 'verified', 'policy-snapshot.json')]) {
      const doc = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
      await fs.chmod(file, 0o644)
      await fs.writeFile(file, JSON.stringify({ ...doc, gateVersion: OLD }, null, 2) + '\n')
      await fs.chmod(file, 0o444)
    }
    await fs.rm(path.join(root, '.intutic', 'events'), { recursive: true, force: true })

    await snapshot.writePolicySnapshot(policy(['github', 'linear']), dir)
    expect(JSON.parse(await fs.readFile(path.join(dir, 'policy-snapshot.json'), 'utf8')).gateVersion).toBe(current)
    expect(await modeOf(path.join(dir, 'policy-snapshot.rules'))).toBe(0o444)
    expect((await fs.readdir(dir)).filter((n) => n.includes('tmp'))).toEqual([])
    expect(await guard.guardPolicySnapshot(root, async () => {}, dir)).toBe(false)
    expect(await tamperEvents()).toEqual([])
  })

  it('does not take a refresh in progress for tampering', async () => {
    // The drift watcher runs the self-heal whenever the live snapshot changes,
    // so it can run while the next sync is part way through rewriting it.
    const dir = snapshot.DEFAULT_SNAPSHOT_DIR
    await fs.rm(path.join(root, '.intutic', 'events'), { recursive: true, force: true })
    let writing = true
    const writes = (async () => {
      for (let i = 0; i < 30; i++) await snapshot.writePolicySnapshot(policy(['github', `server${i}`]), dir)
      writing = false
    })()
    const outcomes: string[] = []
    while (writing) outcomes.push(await snapshot.restoreVerifiedSnapshot(dir))
    await writes
    expect(outcomes.length).toBeGreaterThan(0)
    expect(outcomes.filter((o) => o !== 'intact')).toEqual([])
    expect(await guard.guardPolicySnapshot(root, async () => {}, dir)).toBe(false)
  })
})
