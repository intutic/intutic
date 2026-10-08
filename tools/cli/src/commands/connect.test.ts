/**
 * resolveProxyAssetName: every value here MUST match a real
 * .github/workflows/publish.yml build-rust-proxy matrix artifact_name, and
 * every one below has a live release asset verified against it (`gh
 * release view` on v1.6.0 through the current release found exactly these
 * five names, mirrored identically in packages/proxy/bin/proxy.js's
 * resolveAssetName). A naming mismatch here means a real installed
 * `intutic connect` 404s on download — this repo shipped exactly that bug
 * (this function requested intutic-proxy-linux-x64 while the matrix's
 * artifact_name was intutic-proxy-linux-amd64, with no Linux arm64 target
 * at all despite every real release having shipped one since v1.6.0).
 */
import { describe, it, expect } from 'vitest'
import { resolveProxyAssetName } from './connect.js'

describe('resolveProxyAssetName', () => {
  const supported: Array<[NodeJS.Platform, string, string]> = [
    ['darwin', 'arm64', 'intutic-proxy-darwin-arm64'],
    ['darwin', 'x64', 'intutic-proxy-darwin-x64'],
    ['linux', 'x64', 'intutic-proxy-linux-x64'],
    ['linux', 'arm64', 'intutic-proxy-linux-arm64'],
    ['win32', 'x64', 'intutic-proxy-win32-x64.exe'],
  ]

  it.each(supported)('resolves %s/%s to %s', (platform, arch, expected) => {
    expect(resolveProxyAssetName(platform, arch)).toBe(expected)
  })

  const unsupported: Array<[NodeJS.Platform, string]> = [
    ['darwin', 'ia32'],
    ['linux', 'ia32'],
    ['win32', 'arm64'],
    ['win32', 'ia32'],
    ['freebsd', 'x64'],
    ['sunos', 'x64'],
  ]

  it.each(unsupported)('returns null for the unsupported combination %s/%s', (platform, arch) => {
    expect(resolveProxyAssetName(platform, arch)).toBeNull()
  })

  it('defaults to the real process.platform/process.arch when called with no arguments', () => {
    expect(resolveProxyAssetName()).toBe(resolveProxyAssetName(process.platform, process.arch))
  })
})

// TD-488: the connect loop used to refresh the policy snapshot once, at
// startup, and never again. The refresh now rides every applySyncConfig
// (each poll and each pushed config_update). A source pin, because
// `connect()` runs a full daemon (WebSocket, watcher, drain timers) that no
// unit test should start; the helper itself is tested in the sync daemon.
describe('connect refreshes the gate caches on every sync (TD-488)', () => {
  it('applySyncConfig calls the shared refresh helper before anything version-gated', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const src = readFileSync(fileURLToPath(new URL('./connect.ts', import.meta.url)), 'utf8')
    expect(src).toMatch(/refreshGateCaches,\s*\n/)
    const body = src.slice(src.indexOf('async function applySyncConfig('))
    const firstAwait = body.indexOf('await refreshGateCachesForConnect()')
    const versionGate = body.indexOf('const configMoved = syncConfig.configVersion > localConfigVersion || force')
    expect(firstAwait).toBeGreaterThan(0)
    expect(versionGate).toBeGreaterThan(0)
    expect(firstAwait, 'the refresh must not sit inside the version-gated block').toBeLessThan(versionGate)
  })
})


// The service runs `connect`. Behaviours that used to live only in a second
// sync loop nothing started now run here; the helpers are tested in the sync
// daemon (syncCycle.test.ts), and these pin that `connect` calls them where
// they have to run.
describe('connect runs the per-cycle sync work the docs promise', () => {
  async function source(): Promise<{ src: string; applyBody: string; pollBody: string }> {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const src = readFileSync(fileURLToPath(new URL('./connect.ts', import.meta.url)), 'utf8')
    const applyStart = src.indexOf('async function applySyncConfig(')
    const applyBody = src.slice(applyStart, src.indexOf('\n  }\n', applyStart))
    const pollBody = src.slice(src.indexOf('// 6. Secondary fallback HTTP poll loop'))
    return { src, applyBody, pollBody }
  }

  it('wraps MCP servers on every cycle, not only when the config version moved', async () => {
    const { applyBody } = await source()
    const gateEnd = applyBody.indexOf('saveConfig({ ...safeConfig, configVersion: localConfigVersion')
    const inject = applyBody.indexOf('await injectMcpServer(')
    expect(gateEnd).toBeGreaterThan(0)
    expect(inject, 'injectMcpServer must sit after the version-gated block').toBeGreaterThan(gateEnd)
  })

  it('applies SkillOpt edits and the decisions log before hashing the rules files', async () => {
    const { applyBody } = await source()
    const hashes = applyBody.indexOf('loadIntegrity(safeConfig.workspaceRoot)')
    for (const call of ['await applySkillOptEdits(', 'await refreshDecisionsDigest(']) {
      const at = applyBody.indexOf(call)
      expect(at, call).toBeGreaterThan(0)
      expect(at, `${call} must run before the integrity hashes`).toBeLessThan(hashes)
    }
    expect(applyBody).toMatch(/reapplyAll: configMoved/)
    expect(applyBody).toMatch(/if \(syncConfig\.settings\?\.decisionsLogEnabled\)/)
  })

  it('write-protects the rules files when the workspace asks for it', async () => {
    const { applyBody } = await source()
    expect(applyBody).toMatch(/bypassEnforcementTier === 'immutable'/)
    expect(applyBody.indexOf('await clearImmutable(file)')).toBeLessThan(applyBody.indexOf('const written = await adapter.writeConfig('))
    expect(applyBody.lastIndexOf('await setImmutable(file)')).toBeGreaterThan(applyBody.indexOf('await refreshDecisionsDigest('))
  })

  it('leaves a hand edit in place under record-only and still reports it', async () => {
    const { src } = await source()
    const branch = src.slice(src.indexOf("if (tier === 'alert-only') {"))
    expect(branch.indexOf("type: 'drift_report'")).toBeGreaterThan(0)
    expect(branch.indexOf('return')).toBeLessThan(branch.indexOf('await applySyncConfig(syncConfig, true)'))
  })

  it('reports agents and skill findings from the poll loop', async () => {
    const { src, pollBody } = await source()
    expect(pollBody).toMatch(/await reportHarnessAgents\(\{[\s\S]*?workspaceRoot: safeConfig\.workspaceRoot/)
    expect(src).toMatch(/await writeBundledSkills\(safeConfig\.workspaceRoot\)/)
  })

  // cli.md: "The CLI never uploads those bodies" (harness config snapshots).
  it('does not upload harness config bodies', async () => {
    const { src } = await source()
    expect(src).not.toMatch(/captureAndUpload|uploadConfigCapture|\/api\/v1\/config\/capture/)
  })
})
