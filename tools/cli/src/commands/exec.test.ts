import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as os from 'node:os'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { buildProxyEnv, resolveSandboxRequirement } from './exec.js'
import type { IntuticCredentials } from '@intutic/shared-types'

const creds: IntuticCredentials = {
  apiKey: 'vk_test_wk1',
  workspaceId: 'wk1',
  controlPlaneUrl: 'https://cp.example',
  email: 'dev@example.com',
  storedAt: new Date(0).toISOString(),
}

describe('resolveSandboxRequirement', () => {
  let tmpHome: string
  let origHome: string | undefined

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'intutic-home-'))
    await fs.mkdir(path.join(tmpHome, '.intutic'), { recursive: true })
    origHome = process.env.HOME
    process.env.HOME = tmpHome
  })
  afterEach(async () => {
    process.env.HOME = origHome
    vi.restoreAllMocks()
    await fs.rm(tmpHome, { recursive: true, force: true })
  })

  it("returns the control plane's value and caches it", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ settings: { sandboxRequirement: 'require' } }),
    })) as unknown as typeof fetch)

    expect(await resolveSandboxRequirement(creds)).toBe('require')
    // cache written for offline use
    const cached = JSON.parse(await fs.readFile(path.join(tmpHome, '.intutic', 'exec-policy.json'), 'utf-8'))
    expect(cached.sandboxRequirement).toBe('require')
  })

  it('falls back to the cache when the control plane is unreachable', async () => {
    await fs.writeFile(
      path.join(tmpHome, '.intutic', 'exec-policy.json'),
      JSON.stringify({ sandboxRequirement: 'warn' }),
    )
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }) as unknown as typeof fetch)
    expect(await resolveSandboxRequirement(creds)).toBe('warn')
  })

  it('defaults to off with no control plane and no cache (open-core safe)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch)
    expect(await resolveSandboxRequirement(creds)).toBe('off')
  })

  it('coerces an unexpected value to off rather than trusting it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ settings: { sandboxRequirement: 'YOLO' } }),
    })) as unknown as typeof fetch)
    expect(await resolveSandboxRequirement(creds)).toBe('off')
  })
})

describe('Subprocess Exec Env Builder', () => {
  it('correctly maps proxy URLs in dev mode', () => {
    const apiKey = 'intk_test12345'
    const env = buildProxyEnv(apiKey, true)

    expect(env.OPENAI_API_BASE).toBe('http://localhost:4000/v1')
    expect(env.OPENAI_BASE_URL).toBe('http://localhost:4000/v1')
    expect(env.OPENAI_API_BASE_URL).toBe('http://localhost:4000/v1')
    expect(env.OPENAI_HOST).toBe('http://localhost:4000')
    expect(env.ANTHROPIC_BASE_URL).toBe('http://localhost:4000')
    
    expect(env.OPENAI_API_KEY).toBe(apiKey)
    expect(env.ANTHROPIC_API_KEY).toBe(apiKey)
    expect(env.INTUTIC_API_KEY).toBe(apiKey)
  })

  it('correctly maps proxy URLs in production mode', () => {
    const apiKey = 'intk_prod98765'
    const env = buildProxyEnv(apiKey, false)

    expect(env.OPENAI_API_BASE).toBe('http://localhost:4000/v1')
    expect(env.OPENAI_BASE_URL).toBe('http://localhost:4000/v1')
    expect(env.OPENAI_API_BASE_URL).toBe('http://localhost:4000/v1')
    expect(env.OPENAI_HOST).toBe('http://localhost:4000')
    expect(env.ANTHROPIC_BASE_URL).toBe('http://localhost:4000')
    
    expect(env.OPENAI_API_KEY).toBe(apiKey)
    expect(env.ANTHROPIC_API_KEY).toBe(apiKey)
    expect(env.INTUTIC_API_KEY).toBe(apiKey)
  })
})
