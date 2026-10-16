import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLOUD_RELEASED, HOSTED_CONTROL_PLANE_URL, NO_CONTROL_PLANE_MESSAGE } from '@intutic/shared-types'
import { configuredControlPlaneUrl, NoControlPlaneError, resolveControlPlaneUrl } from './paths.js'

describe('resolveControlPlaneUrl', () => {
  const saved = { HOME: process.env.HOME, url: process.env.INTUTIC_CONTROL_PLANE_URL, dev: process.env.INTUTIC_DEV }
  let home: string

  function storeLogin(controlPlaneUrl: string): void {
    mkdirSync(join(home, '.intutic'), { recursive: true })
    writeFileSync(
      join(home, '.intutic', 'credentials.json'),
      JSON.stringify({ apiKey: 'keychain', workspaceId: 'wk_alpha', email: 'dev@example.com', controlPlaneUrl }),
    )
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'intutic-paths-'))
    process.env.HOME = home
    delete process.env.INTUTIC_CONTROL_PLANE_URL
    delete process.env.INTUTIC_DEV
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    for (const [key, value] of [['HOME', saved.HOME], ['INTUTIC_CONTROL_PLANE_URL', saved.url], ['INTUTIC_DEV', saved.dev]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it.runIf(CLOUD_RELEASED)('falls back to the hosted control plane with nothing set', () => {
    expect(resolveControlPlaneUrl()).toBe(HOSTED_CONTROL_PLANE_URL)
  })

  it.runIf(!CLOUD_RELEASED)('has no default before the hosted control plane is released', () => {
    expect(() => resolveControlPlaneUrl()).toThrow(NoControlPlaneError)
    expect(() => resolveControlPlaneUrl()).toThrow(NO_CONTROL_PLANE_MESSAGE)
    expect(configuredControlPlaneUrl()).toBeUndefined()
  })

  it('uses the URL saved by login over the default', () => {
    storeLogin('https://cp.stored.example/')
    expect(resolveControlPlaneUrl()).toBe('https://cp.stored.example')
  })

  it('prefers INTUTIC_CONTROL_PLANE_URL over the saved URL', () => {
    storeLogin('https://cp.stored.example')
    process.env.INTUTIC_CONTROL_PLANE_URL = 'https://cp.env.example'
    expect(resolveControlPlaneUrl()).toBe('https://cp.env.example')
  })

  it('prefers a --control-plane-url flag over the environment', () => {
    process.env.INTUTIC_CONTROL_PLANE_URL = 'https://cp.env.example'
    expect(resolveControlPlaneUrl(false, { flagUrl: 'https://cp.flag.example' })).toBe('https://cp.flag.example')
  })

  it('treats --dev as a flag and INTUTIC_DEV as environment', () => {
    process.env.INTUTIC_CONTROL_PLANE_URL = 'https://cp.env.example'
    expect(resolveControlPlaneUrl(true)).toBe('http://localhost:3001')
    delete process.env.INTUTIC_CONTROL_PLANE_URL
    storeLogin('https://cp.stored.example')
    process.env.INTUTIC_DEV = '1'
    expect(resolveControlPlaneUrl()).toBe('http://localhost:3001')
  })

  it('puts a workspace set up with init --dev behind the environment and ahead of the saved URL', () => {
    storeLogin('https://cp.stored.example')
    writeFileSync(join(home, '.intutic', 'config.json'), JSON.stringify({ harnesses: [], configVersion: 0, devMode: true }))
    expect(resolveControlPlaneUrl()).toBe('http://localhost:3001')
    process.env.INTUTIC_CONTROL_PLANE_URL = 'https://cp.env.example'
    expect(resolveControlPlaneUrl()).toBe('https://cp.env.example')
    expect(resolveControlPlaneUrl(false, { flagUrl: 'https://cp.flag.example' })).toBe('https://cp.flag.example')
  })

  it('skips the saved URL when asked to', () => {
    storeLogin('https://cp.stored.example')
    if (CLOUD_RELEASED) {
      expect(resolveControlPlaneUrl(false, { useStored: false })).toBe(HOSTED_CONTROL_PLANE_URL)
    } else {
      expect(() => resolveControlPlaneUrl(false, { useStored: false })).toThrow(NoControlPlaneError)
    }
    process.env.INTUTIC_CONTROL_PLANE_URL = 'https://cp.env.example'
    expect(resolveControlPlaneUrl(false, { useStored: false })).toBe('https://cp.env.example')
  })
})
