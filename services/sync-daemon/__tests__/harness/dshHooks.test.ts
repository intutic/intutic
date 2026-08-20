/**
 * dshHooks.test.ts — dsh (DeepSeek "dsh", developer preview) harness coverage.
 *
 * `generatedGateBehaviour.test.ts`'s `dsh` row (migrated: false, see
 * gateRegistry.ts's module doc) only asserts the writer produces its declared
 * artifact and does not collide with another writer's path — the actual veto
 * DECISION is covered by `packages/gate-js/src/__tests__/dsh.test.ts`, since
 * dsh's gate is a real checked-in TypeScript Cordis plugin, not a generated
 * shell/JS string this registry's spawn-and-pipe-JSON matrix can exercise.
 *
 * This file covers what IS specific to `dshHooks.ts` — the writer itself:
 *
 *  1. Profile discovery: registers into every EXISTING profile, no-ops (does
 *     not invent one) when `$DSH_HOME/profiles` has none.
 *  2. `cordis.patch.yml` structural merge: preserves unrelated rows and
 *     comments, writes the plugin row in the confirmed `insert:` shape.
 *  3. Idempotency: a second run against unchanged input writes zero bytes
 *     (write-if-changed) — `intutic connect` re-runs this every sync cycle.
 *  4. The profile's `package.json` `@intutic/gate` dependency merge.
 *  5. `settings.yaml`'s `llm-pi-ai.providers.intutic` merge — preserves every
 *     other provider and top-level section.
 *  6. The append-only fallback for a `cordis.patch.yml`/`settings.yaml` that
 *     does not parse as YAML at all.
 *  7. Tamper-restore: `settingsGuard.ts`'s `guardSettingsFile` re-running
 *     `writeDshHooks` after a simulated tamper.
 *
 * @module
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as node_fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import * as node_path from 'node:path'
import * as node_os from 'node:os'
import { parseDocument } from 'yaml'

const PROXY_URL = 'http://127.0.0.1:4000'

async function mkProfile(dshHome: string, name: string, extraPatch = '[]\n'): Promise<string> {
  const dir = node_path.join(dshHome, 'profiles', name)
  await node_fs.mkdir(dir, { recursive: true })
  await node_fs.writeFile(
    node_path.join(dir, 'package.json'),
    JSON.stringify({ name: `${name}-profile`, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }, null, 2),
  )
  await node_fs.writeFile(node_path.join(dir, 'cordis.patch.yml'), extraPatch)
  return dir
}

describe('dsh hooks writer', () => {
  let dshHome: string
  let workspaceRoot: string
  const prevDshHomeEnv = process.env.DSH_HOME

  beforeEach(async () => {
    dshHome = await node_fs.mkdtemp(node_path.join(node_os.tmpdir(), 'intutic-dsh-home-'))
    workspaceRoot = await node_fs.mkdtemp(node_path.join(node_os.tmpdir(), 'intutic-dsh-ws-'))
    // dshHooks.ts reads $DSH_HOME (falling back to ~/.dsh) at CALL time, not
    // module scope — unlike gooseHooks/piHooks's os.homedir() read, so this
    // can be set per-test rather than needing HOME swapped before import.
    process.env.DSH_HOME = dshHome
  })

  afterEach(async () => {
    if (prevDshHomeEnv === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevDshHomeEnv
    await node_fs.rm(dshHome, { recursive: true, force: true })
    await node_fs.rm(workspaceRoot, { recursive: true, force: true })
  })

  it('resolveDshHome reads $DSH_HOME, falling back to ~/.dsh', async () => {
    const { resolveDshHome } = await import('../../src/harness/dshHooks.js')
    expect(resolveDshHome()).toBe(dshHome)
    delete process.env.DSH_HOME
    expect(resolveDshHome()).toBe(node_path.join(node_os.homedir(), '.dsh'))
    process.env.DSH_HOME = dshHome
  })

  it('is a documented no-op when $DSH_HOME/profiles does not exist — never invents a profile', async () => {
    const { writeDshHooks } = await import('../../src/harness/dshHooks.js')
    await writeDshHooks(workspaceRoot, PROXY_URL, 'ws_test')
    expect(existsSync(node_path.join(dshHome, 'profiles'))).toBe(false)
    expect(existsSync(node_path.join(dshHome, 'settings.yaml'))).toBe(false)
  })

  it('merges the plugin row into an EXISTING profile, preserving unrelated rows and comments', async () => {
    const profileDir = await mkProfile(
      dshHome,
      'myproject',
      '# a comment a user wrote\n- insert:\n    - id: timer\n      name: \'@deepseek-ai/cordis-plugin-timer\'\n',
    )
    const { writeDshHooks } = await import('../../src/harness/dshHooks.js')
    await writeDshHooks(workspaceRoot, PROXY_URL, 'ws_test')

    const raw = await node_fs.readFile(node_path.join(profileDir, 'cordis.patch.yml'), 'utf-8')
    expect(raw).toContain('# a comment a user wrote')
    expect(raw).toContain('id: timer')

    const doc = parseDocument(raw)
    const list = doc.toJS() as Array<{ insert?: Array<{ id: string; name: string; config?: Record<string, unknown> }> }>
    const ownRow = list.flatMap((p) => p.insert ?? []).find((r) => r.id === 'intutic-governance')
    expect(ownRow, `no intutic-governance row in:\n${raw}`).toBeDefined()
    expect(ownRow!.name).toBe('@intutic/gate/dsh')
    expect(ownRow!.config).toEqual({ workspaceId: 'ws_test', repoRoot: workspaceRoot })

    // The pre-existing row must still be there, untouched.
    const timerRow = list.flatMap((p) => p.insert ?? []).find((r) => r.id === 'timer')
    expect(timerRow?.name).toBe('@deepseek-ai/cordis-plugin-timer')
  })

  it('registers into EVERY existing profile, not just one', async () => {
    await mkProfile(dshHome, 'alpha')
    await mkProfile(dshHome, 'beta')
    const { writeDshHooks } = await import('../../src/harness/dshHooks.js')
    await writeDshHooks(workspaceRoot, PROXY_URL, 'ws_test')

    for (const name of ['alpha', 'beta']) {
      const raw = await node_fs.readFile(node_path.join(dshHome, 'profiles', name, 'cordis.patch.yml'), 'utf-8')
      expect(raw, `${name} was not registered`).toContain('intutic-governance')
    }
  })

  it('is idempotent — a second run against unchanged input writes zero new bytes (write-if-changed)', async () => {
    const profileDir = await mkProfile(dshHome, 'myproject')
    const { writeDshHooks } = await import('../../src/harness/dshHooks.js')
    await writeDshHooks(workspaceRoot, PROXY_URL, 'ws_test')

    const patchPath = node_path.join(profileDir, 'cordis.patch.yml')
    const settingsPath = node_path.join(dshHome, 'settings.yaml')
    const afterFirst = await node_fs.readFile(patchPath, 'utf-8')
    const settingsAfterFirst = await node_fs.readFile(settingsPath, 'utf-8')
    const statBefore = await node_fs.stat(patchPath)

    // A real filesystem mtime granularity can be coarse; assert on CONTENT
    // equality (the load-bearing claim) rather than relying on mtime alone.
    await writeDshHooks(workspaceRoot, PROXY_URL, 'ws_test')
    const afterSecond = await node_fs.readFile(patchPath, 'utf-8')
    const settingsAfterSecond = await node_fs.readFile(settingsPath, 'utf-8')
    expect(afterSecond).toBe(afterFirst)
    expect(settingsAfterSecond).toBe(settingsAfterFirst)
    const statAfter = await node_fs.stat(patchPath)
    // Same size is the portable half of "nothing was rewritten"; mtime
    // comparison is inherently flaky under fast successive writes on some
    // filesystems, so this is the assertion that actually carries weight.
    expect(statAfter.size).toBe(statBefore.size)
  })

  it('declares @intutic/gate in the profile package.json dependencies, without disturbing other fields', async () => {
    const profileDir = await mkProfile(dshHome, 'myproject')
    const manifestPath = node_path.join(profileDir, 'package.json')
    const before = JSON.parse(await node_fs.readFile(manifestPath, 'utf-8'))
    before.dependencies['some-other-plugin'] = '^1.0.0'
    await node_fs.writeFile(manifestPath, JSON.stringify(before, null, 2))

    const { writeDshHooks } = await import('../../src/harness/dshHooks.js')
    await writeDshHooks(workspaceRoot, PROXY_URL, 'ws_test')

    const after = JSON.parse(await node_fs.readFile(manifestPath, 'utf-8'))
    expect(after.dependencies['@intutic/gate']).toMatch(/^\^0\./)
    expect(after.dependencies['some-other-plugin']).toBe('^1.0.0')
    expect(after.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base'])
  })

  it("merges settings.yaml's llm-pi-ai.providers.intutic route, preserving other providers and sections", async () => {
    await mkProfile(dshHome, 'myproject')
    await node_fs.writeFile(
      node_path.join(dshHome, 'settings.yaml'),
      'someOtherSection:\n  key: value\nllm-pi-ai:\n  providers:\n    openai:\n      apiKeyEnv: OPENAI_API_KEY\n',
    )

    const { writeDshHooks } = await import('../../src/harness/dshHooks.js')
    await writeDshHooks(workspaceRoot, PROXY_URL, 'ws_test')

    const raw = await node_fs.readFile(node_path.join(dshHome, 'settings.yaml'), 'utf-8')
    const doc = parseDocument(raw)
    const settings = doc.toJS() as {
      someOtherSection?: { key?: string }
      'llm-pi-ai'?: { providers?: Record<string, { baseURL?: string; apiKeyEnv?: string }> }
    }
    expect(settings.someOtherSection?.key).toBe('value')
    expect(settings['llm-pi-ai']?.providers?.openai?.apiKeyEnv).toBe('OPENAI_API_KEY')
    expect(settings['llm-pi-ai']?.providers?.intutic?.baseURL).toBe(PROXY_URL)
  })

  it("merges settings.yaml's llm-deepseek.baseURL (dsh's DEFAULT LLM route), preserving other llm-deepseek fields", async () => {
    await mkProfile(dshHome, 'myproject')
    await node_fs.writeFile(
      node_path.join(dshHome, 'settings.yaml'),
      'llm-deepseek:\n  apiKeyEnv: DEEPSEEK_API_KEY\n  thinking: enabled\n',
    )

    const { writeDshHooks } = await import('../../src/harness/dshHooks.js')
    await writeDshHooks(workspaceRoot, PROXY_URL, 'ws_test')

    const raw = await node_fs.readFile(node_path.join(dshHome, 'settings.yaml'), 'utf-8')
    const doc = parseDocument(raw)
    const settings = doc.toJS() as {
      'llm-deepseek'?: { baseURL?: string; apiKeyEnv?: string; thinking?: string }
    }
    // The DEFAULT route's baseURL is redirected through the proxy...
    expect(settings['llm-deepseek']?.baseURL).toBe(PROXY_URL)
    // ...without disturbing the rest of that same section.
    expect(settings['llm-deepseek']?.apiKeyEnv).toBe('DEEPSEEK_API_KEY')
    expect(settings['llm-deepseek']?.thinking).toBe('enabled')
  })

  it('seeds both llm-deepseek and llm-pi-ai sections on a fresh settings.yaml', async () => {
    await mkProfile(dshHome, 'myproject')

    const { writeDshHooks } = await import('../../src/harness/dshHooks.js')
    await writeDshHooks(workspaceRoot, PROXY_URL, 'ws_test')

    const raw = await node_fs.readFile(node_path.join(dshHome, 'settings.yaml'), 'utf-8')
    const doc = parseDocument(raw)
    const settings = doc.toJS() as {
      'llm-deepseek'?: { baseURL?: string }
      'llm-pi-ai'?: { providers?: Record<string, { baseURL?: string }> }
    }
    expect(settings['llm-deepseek']?.baseURL).toBe(PROXY_URL)
    expect(settings['llm-pi-ai']?.providers?.intutic?.baseURL).toBe(PROXY_URL)
  })

  it('falls back to append-only text injection for BOTH llm sections when settings.yaml does not parse as YAML', async () => {
    await mkProfile(dshHome, 'myproject')
    const settingsPath = node_path.join(dshHome, 'settings.yaml')
    const malformed = 'someKey: [unterminated\n'
    await node_fs.writeFile(settingsPath, malformed)

    const { writeDshHooks } = await import('../../src/harness/dshHooks.js')
    await writeDshHooks(workspaceRoot, PROXY_URL, 'ws_test')

    const after = await node_fs.readFile(settingsPath, 'utf-8')
    expect(after).toContain(malformed.trimEnd())
    expect(after).toContain('llm-deepseek:')
    expect(after).toContain('llm-pi-ai:')

    // A second run must not duplicate either block.
    await writeDshHooks(workspaceRoot, PROXY_URL, 'ws_test')
    const afterSecond = await node_fs.readFile(settingsPath, 'utf-8')
    expect(afterSecond.match(/llm-deepseek:/g)?.length).toBe(1)
    expect(afterSecond.match(/llm-pi-ai:/g)?.length).toBe(1)
  })

  it('writes $DSH_HOME/INSTALL.md naming every registered profile and the dsh plugin-add command', async () => {
    await mkProfile(dshHome, 'alpha')
    await mkProfile(dshHome, 'beta')

    const { writeDshHooks } = await import('../../src/harness/dshHooks.js')
    await writeDshHooks(workspaceRoot, PROXY_URL, 'ws_test')

    const installMd = await node_fs.readFile(node_path.join(dshHome, 'INSTALL.md'), 'utf-8')
    expect(installMd).toContain('dsh plugin --profile alpha add @intutic/gate')
    expect(installMd).toContain('dsh plugin --profile beta add @intutic/gate')
  })

  it('INSTALL.md is write-if-changed — a second run against unchanged profiles writes identical bytes', async () => {
    await mkProfile(dshHome, 'myproject')
    const { writeDshHooks } = await import('../../src/harness/dshHooks.js')
    await writeDshHooks(workspaceRoot, PROXY_URL, 'ws_test')

    const installPath = node_path.join(dshHome, 'INSTALL.md')
    const first = await node_fs.readFile(installPath, 'utf-8')
    await writeDshHooks(workspaceRoot, PROXY_URL, 'ws_test')
    const second = await node_fs.readFile(installPath, 'utf-8')
    expect(second).toBe(first)
  })

  it('detectDshCoverageGap: no gap when profiles already exist', async () => {
    await mkProfile(dshHome, 'myproject')
    const { detectDshCoverageGap } = await import('../../src/harness/dshHooks.js')
    const result = await detectDshCoverageGap(dshHome)
    expect(result.gap).toBe(false)
    expect(result.profileCount).toBe(1)
    expect(result.dshDetected).toBe(true)
  })

  it('detectDshCoverageGap: no gap when dsh has never touched this machine at all', async () => {
    const { detectDshCoverageGap } = await import('../../src/harness/dshHooks.js')
    const result = await detectDshCoverageGap(dshHome)
    expect(result.gap).toBe(false)
    expect(result.profileCount).toBe(0)
    expect(result.dshDetected).toBe(false)
  })

  it('detectDshCoverageGap: flags the gap when dsh left settings.yaml but zero profiles exist yet', async () => {
    // No profiles directory at all, but $DSH_HOME/settings.yaml exists —
    // the state right after dsh's own first-run bootstrap but before the
    // user's first `--profile <name>` invocation.
    await node_fs.writeFile(node_path.join(dshHome, 'settings.yaml'), '{}\n')
    const { detectDshCoverageGap } = await import('../../src/harness/dshHooks.js')
    const result = await detectDshCoverageGap(dshHome)
    expect(result.gap).toBe(true)
    expect(result.dshDetected).toBe(true)
    expect(result.profileCount).toBe(0)
  })

  it('falls back to append-only text injection when cordis.patch.yml does not parse as YAML', async () => {
    const profileDir = node_path.join(dshHome, 'profiles', 'broken')
    await node_fs.mkdir(profileDir, { recursive: true })
    await node_fs.writeFile(node_path.join(profileDir, 'package.json'), JSON.stringify({ name: 'broken', dependencies: {} }))
    const malformed = '- insert:\n    - id: timer\n   name: bad-indent\n'
    await node_fs.writeFile(node_path.join(profileDir, 'cordis.patch.yml'), malformed)

    const { writeDshHooks } = await import('../../src/harness/dshHooks.js')
    await writeDshHooks(workspaceRoot, PROXY_URL, 'ws_test')

    const after = await node_fs.readFile(node_path.join(profileDir, 'cordis.patch.yml'), 'utf-8')
    // The original malformed content survives untouched (never parsed, so
    // never "corrected"), and the plugin row is appended after it.
    expect(after.startsWith(malformed.trimEnd()) || after.includes(malformed.trim())).toBe(true)
    expect(after).toContain('intutic-governance')
    expect(after).toContain('@intutic/gate/dsh')
  })

  it('does not duplicate the append-only row on a second run against the same unparseable file', async () => {
    const profileDir = node_path.join(dshHome, 'profiles', 'broken')
    await node_fs.mkdir(profileDir, { recursive: true })
    await node_fs.writeFile(node_path.join(profileDir, 'package.json'), JSON.stringify({ name: 'broken', dependencies: {} }))
    await node_fs.writeFile(node_path.join(profileDir, 'cordis.patch.yml'), '- insert:\n    - id: timer\n   bad: indent\n')

    const { writeDshHooks } = await import('../../src/harness/dshHooks.js')
    await writeDshHooks(workspaceRoot, PROXY_URL, 'ws_test')
    const afterFirst = await node_fs.readFile(node_path.join(profileDir, 'cordis.patch.yml'), 'utf-8')
    await writeDshHooks(workspaceRoot, PROXY_URL, 'ws_test')
    const afterSecond = await node_fs.readFile(node_path.join(profileDir, 'cordis.patch.yml'), 'utf-8')

    expect(afterSecond).toBe(afterFirst)
    expect(afterFirst.match(/intutic-governance/g)?.length).toBe(1)
  })
})

describe('dsh settingsGuard tamper restore', () => {
  let dshHome: string
  let workspaceRoot: string
  const prevDshHomeEnv = process.env.DSH_HOME

  beforeEach(async () => {
    dshHome = await node_fs.mkdtemp(node_path.join(node_os.tmpdir(), 'intutic-dsh-guard-home-'))
    workspaceRoot = await node_fs.mkdtemp(node_path.join(node_os.tmpdir(), 'intutic-dsh-guard-ws-'))
    process.env.DSH_HOME = dshHome
  })

  afterEach(async () => {
    if (prevDshHomeEnv === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevDshHomeEnv
    await node_fs.rm(dshHome, { recursive: true, force: true })
    await node_fs.rm(workspaceRoot, { recursive: true, force: true })
  })

  it('guardSettingsFile restores a profile cordis.patch.yml whose plugin row was deleted', async () => {
    const profileDir = await mkProfile(dshHome, 'myproject')
    const patchPath = node_path.join(profileDir, 'cordis.patch.yml')

    const { writeDshHooks } = await import('../../src/harness/dshHooks.js')
    await writeDshHooks(workspaceRoot, PROXY_URL, 'ws_test')
    expect((await node_fs.readFile(patchPath, 'utf-8')).includes('intutic-governance')).toBe(true)

    // Simulate tamper: an agent (or a user) wipes the row back to empty.
    await node_fs.writeFile(patchPath, '[]\n')
    expect((await node_fs.readFile(patchPath, 'utf-8')).includes('intutic-governance')).toBe(false)

    const { guardSettingsFile } = await import('../../src/watcher/settingsGuard.js')
    const tampered = await guardSettingsFile(patchPath, workspaceRoot, [], PROXY_URL)
    expect(tampered).toBe(true)

    const restored = await node_fs.readFile(patchPath, 'utf-8')
    expect(restored).toContain('intutic-governance')
    expect(restored).toContain('@intutic/gate/dsh')
  })

  it('guardSettingsFile restores settings.yaml whose llm-pi-ai route was deleted', async () => {
    await mkProfile(dshHome, 'myproject')
    const settingsPath = node_path.join(dshHome, 'settings.yaml')

    const { writeDshHooks } = await import('../../src/harness/dshHooks.js')
    await writeDshHooks(workspaceRoot, PROXY_URL, 'ws_test')
    expect((await node_fs.readFile(settingsPath, 'utf-8')).includes('llm-pi-ai')).toBe(true)

    await node_fs.writeFile(settingsPath, 'unrelated: true\n')

    const { guardSettingsFile } = await import('../../src/watcher/settingsGuard.js')
    const tampered = await guardSettingsFile(settingsPath, workspaceRoot, [], PROXY_URL)
    expect(tampered).toBe(true)

    const restored = await node_fs.readFile(settingsPath, 'utf-8')
    expect(restored).toContain('llm-pi-ai')
    // The unrelated content settingsGuard's restore path went through
    // (writeDshHooks -> mergeSettingsYaml) must survive — it re-parses
    // whatever is on disk rather than starting from a blank slate.
    expect(restored).toContain('unrelated: true')
  })

  it('guardSettingsFile restores a deleted profile cordis.patch.yml file entirely', async () => {
    const profileDir = await mkProfile(dshHome, 'myproject')
    const patchPath = node_path.join(profileDir, 'cordis.patch.yml')

    const { writeDshHooks } = await import('../../src/harness/dshHooks.js')
    await writeDshHooks(workspaceRoot, PROXY_URL, 'ws_test')
    await node_fs.rm(patchPath)
    expect(existsSync(patchPath)).toBe(false)

    const { guardSettingsFile } = await import('../../src/watcher/settingsGuard.js')
    const tampered = await guardSettingsFile(patchPath, workspaceRoot, [], PROXY_URL)
    expect(tampered).toBe(true)
    expect(existsSync(patchPath)).toBe(true)
    expect((await node_fs.readFile(patchPath, 'utf-8')).includes('intutic-governance')).toBe(true)
  })

  it('isDshProfilesRoot identifies exactly $DSH_HOME/profiles and nothing else', async () => {
    const { isDshProfilesRoot } = await import('../../src/watcher/settingsGuard.js')
    expect(isDshProfilesRoot(node_path.join(dshHome, 'profiles'))).toBe(true)
    expect(isDshProfilesRoot(node_path.join(dshHome, 'profiles', 'myproject'))).toBe(false)
    expect(isDshProfilesRoot(node_path.join(dshHome, 'settings.yaml'))).toBe(false)
  })

  it('guardSettingsFile registers governance the moment the profiles ROOT directory appears (TD-370 addDir handling)', async () => {
    // This is the event driftWatcher.ts forwards on chokidar's `addDir` for
    // the profiles root specifically (see isDshProfilesRoot) — the profile
    // itself already exists on disk by the time this fires (dsh creates it
    // atomically), so writeDshHooks has something to register into right
    // away, without waiting for an unrelated file change or the next poll.
    const profileDir = await mkProfile(dshHome, 'myproject')
    const profilesRoot = node_path.join(dshHome, 'profiles')

    const { guardSettingsFile } = await import('../../src/watcher/settingsGuard.js')
    const tampered = await guardSettingsFile(profilesRoot, workspaceRoot, [], PROXY_URL)
    expect(tampered).toBe(true)

    const patchPath = node_path.join(profileDir, 'cordis.patch.yml')
    const restored = await node_fs.readFile(patchPath, 'utf-8')
    expect(restored).toContain('intutic-governance')
    const settings = await node_fs.readFile(node_path.join(dshHome, 'settings.yaml'), 'utf-8')
    expect(settings).toContain('llm-deepseek:')
  })

  it('warnIfDshCoverageGap returns false and does not throw when dsh has never touched this machine', async () => {
    const { warnIfDshCoverageGap } = await import('../../src/watcher/settingsGuard.js')
    await expect(warnIfDshCoverageGap()).resolves.toBe(false)
  })

  it('warnIfDshCoverageGap returns true when dsh left settings.yaml but zero profiles exist yet', async () => {
    await node_fs.writeFile(node_path.join(dshHome, 'settings.yaml'), '{}\n')
    const { warnIfDshCoverageGap } = await import('../../src/watcher/settingsGuard.js')
    await expect(warnIfDshCoverageGap()).resolves.toBe(true)
  })

  it('warnIfDshCoverageGap returns false once a profile is registered', async () => {
    await mkProfile(dshHome, 'myproject')
    const { warnIfDshCoverageGap } = await import('../../src/watcher/settingsGuard.js')
    await expect(warnIfDshCoverageGap()).resolves.toBe(false)
  })
})
