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
 *  5. The `llm-deepseek` egress row in each profile's `cordis.patch.yml`
 *     (dsh 0.2 moved live config out of `$DSH_HOME/settings.yaml`) — sets
 *     only `baseURL` on an existing override row, preserving its other fields.
 *  6. The append-only fallback for a `cordis.patch.yml` that does not parse
 *     as YAML at all.
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
    const afterFirst = await node_fs.readFile(patchPath, 'utf-8')
    const statBefore = await node_fs.stat(patchPath)

    // A real filesystem mtime granularity can be coarse; assert on CONTENT
    // equality (the load-bearing claim) rather than relying on mtime alone.
    await writeDshHooks(workspaceRoot, PROXY_URL, 'ws_test')
    const afterSecond = await node_fs.readFile(patchPath, 'utf-8')
    expect(afterSecond).toBe(afterFirst)
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
    // A range npm can actually satisfy with a `./dsh` export (2.0.0 is the
    // first published version that has one; nothing ever matched ^0.x).
    expect(after.dependencies['@intutic/gate']).toBe('^2.0.0')
    expect(after.dependencies['some-other-plugin']).toBe('^1.0.0')
    expect(after.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base'])
  })

  it('never rewrites an @intutic/gate declaration the profile already has (e.g. the one `dsh plugin add` wrote)', async () => {
    const profileDir = await mkProfile(dshHome, 'myproject')
    const manifestPath = node_path.join(profileDir, 'package.json')
    const before = JSON.parse(await node_fs.readFile(manifestPath, 'utf-8'))
    before.dependencies['@intutic/gate'] = 'file:/opt/local/gate-js'
    await node_fs.writeFile(manifestPath, JSON.stringify(before, null, 2))
    const bytesBefore = await node_fs.readFile(manifestPath, 'utf-8')

    const { writeDshHooks } = await import('../../src/harness/dshHooks.js')
    await writeDshHooks(workspaceRoot, PROXY_URL, 'ws_test')

    expect(await node_fs.readFile(manifestPath, 'utf-8')).toBe(bytesBefore)
  })

  it("appends an llm-deepseek baseURL override row to the profile patch (dsh's DEFAULT route) and writes no settings.yaml", async () => {
    const profileDir = await mkProfile(dshHome, 'myproject')
    const { writeDshHooks } = await import('../../src/harness/dshHooks.js')
    await writeDshHooks(workspaceRoot, PROXY_URL, 'ws_test')

    const raw = await node_fs.readFile(node_path.join(profileDir, 'cordis.patch.yml'), 'utf-8')
    const list = parseDocument(raw).toJS() as Array<Record<string, unknown>>
    const rows = list.filter((r) => r.id === 'llm-deepseek')
    expect(rows, raw).toEqual([{ id: 'llm-deepseek', config: { baseURL: PROXY_URL } }])
    // dsh 0.2 imports-then-renames a harness-home settings.yaml; writing one
    // would re-trigger that import on every boot.
    expect(existsSync(node_path.join(dshHome, 'settings.yaml'))).toBe(false)
  })

  it('sets only baseURL on an EXISTING llm-deepseek override row, preserving its other fields and name assertion', async () => {
    // The shape dsh 0.2's config-editor (and its one-time settings.yaml
    // import) writes — observed live, see uat/evidence/live-verify/dsh-0.2.md.
    const profileDir = await mkProfile(
      dshHome,
      'myproject',
      "- id: llm-deepseek\n  name: '@deepseek-ai/dsh-llm-deepseek-api-key'\n  config:\n    reasoningEffort: max\n    apiKeyEnv: MY_DEEPSEEK_KEY\n    baseURL: https://api.deepseek.com/anthropic\n",
    )
    const { writeDshHooks } = await import('../../src/harness/dshHooks.js')
    await writeDshHooks(workspaceRoot, PROXY_URL, 'ws_test')

    const raw = await node_fs.readFile(node_path.join(profileDir, 'cordis.patch.yml'), 'utf-8')
    const rows = (parseDocument(raw).toJS() as Array<Record<string, unknown>>).filter((r) => r.id === 'llm-deepseek')
    expect(rows).toEqual([
      {
        id: 'llm-deepseek',
        name: '@deepseek-ai/dsh-llm-deepseek-api-key',
        config: { reasoningEffort: 'max', apiKeyEnv: 'MY_DEEPSEEK_KEY', baseURL: PROXY_URL },
      },
    ])
  })

  it('edits the LAST llm-deepseek override (the one the loader applies) and ignores insert-wrapped rows', async () => {
    const profileDir = await mkProfile(
      dshHome,
      'myproject',
      '- id: llm-deepseek\n  config:\n    reasoningEffort: low\n- insert:\n    - id: llm-deepseek-extra\n      name: x\n- id: llm-deepseek\n  config:\n    reasoningEffort: high\n',
    )
    const { writeDshHooks } = await import('../../src/harness/dshHooks.js')
    await writeDshHooks(workspaceRoot, PROXY_URL, 'ws_test')

    const list = parseDocument(await node_fs.readFile(node_path.join(profileDir, 'cordis.patch.yml'), 'utf-8')).toJS() as Array<Record<string, unknown>>
    const rows = list.filter((r) => r.id === 'llm-deepseek')
    expect(rows).toEqual([
      { id: 'llm-deepseek', config: { reasoningEffort: 'low' } },
      { id: 'llm-deepseek', config: { reasoningEffort: 'high', baseURL: PROXY_URL } },
    ])
  })

  it('appends the llm-deepseek row once (append-only fallback) when cordis.patch.yml does not parse', async () => {
    const profileDir = node_path.join(dshHome, 'profiles', 'broken')
    await node_fs.mkdir(profileDir, { recursive: true })
    await node_fs.writeFile(node_path.join(profileDir, 'package.json'), JSON.stringify({ name: 'broken', dependencies: {} }))
    await node_fs.writeFile(node_path.join(profileDir, 'cordis.patch.yml'), '- insert:\n    - id: timer\n   bad: indent\n')

    const { writeDshHooks } = await import('../../src/harness/dshHooks.js')
    await writeDshHooks(workspaceRoot, PROXY_URL, 'ws_test')
    await writeDshHooks(workspaceRoot, PROXY_URL, 'ws_test')

    const after = await node_fs.readFile(node_path.join(profileDir, 'cordis.patch.yml'), 'utf-8')
    expect(after.match(/id: llm-deepseek/g)?.length).toBe(1)
    expect(after).toContain(`baseURL: ${JSON.stringify(PROXY_URL)}`)
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

  it('guardSettingsFile restores a profile cordis.patch.yml whose llm-deepseek egress row was deleted', async () => {
    const profileDir = await mkProfile(dshHome, 'myproject')
    const patchPath = node_path.join(profileDir, 'cordis.patch.yml')

    const { writeDshHooks } = await import('../../src/harness/dshHooks.js')
    await writeDshHooks(workspaceRoot, PROXY_URL, 'ws_test')

    // Tamper: keep the plugin row, drop only the egress override.
    const list = parseDocument(await node_fs.readFile(patchPath, 'utf-8')).toJS() as Array<Record<string, unknown>>
    await node_fs.writeFile(patchPath, JSON.stringify(list.filter((r) => r.id !== 'llm-deepseek')))
    expect(await node_fs.readFile(patchPath, 'utf-8')).not.toContain(PROXY_URL)

    const { guardSettingsFile } = await import('../../src/watcher/settingsGuard.js')
    const tampered = await guardSettingsFile(patchPath, workspaceRoot, [], PROXY_URL)
    expect(tampered).toBe(true)

    const restored = await node_fs.readFile(patchPath, 'utf-8')
    expect(restored).toContain('intutic-governance')
    expect(restored).toContain(PROXY_URL)
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

  it('guardSettingsFile registers governance the moment the profiles ROOT directory appears (addDir handling)', async () => {
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
    expect(restored).toContain('llm-deepseek')
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
