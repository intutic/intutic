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
