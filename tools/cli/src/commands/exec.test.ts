import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as os from 'node:os'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { buildProxyEnv, resolveSandboxRequirement, openSandboxSession, closeSandboxSession } from './exec.js'
import type { IntuticCredentials } from '@intutic/shared-types'
import type { GraphIdentity } from '../lib/graphIdentity.js'

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

const identity: GraphIdentity = { graphId: 'gr_test', nodeId: 'nd_test', parentId: '', depth: 0 }

describe('openSandboxSession / closeSandboxSession — sandbox-usage telemetry', () => {
  afterEach(() => vi.restoreAllMocks())

  it('opens a SANDBOX-mode session and returns its id', async () => {
    let sentBody: unknown
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      sentBody = JSON.parse(init?.body as string)
      return { ok: true, json: async () => ({ sessionId: 'ses_abc123' }) }
    }) as unknown as typeof fetch)

    const id = await openSandboxSession(creds, identity, 'docker')
    expect(id).toBe('ses_abc123')
    expect(sentBody).toMatchObject({
      workspaceId: 'wk1',
      harnessType: 'sandbox',
      executionMode: 'SANDBOX',
    })
  })

  it('returns null (never throws) when the control plane rejects the request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch)
    expect(await openSandboxSession(creds, identity, 'docker')).toBeNull()
  })

  it('returns null (never throws) when the control plane is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch)
    expect(await openSandboxSession(creds, identity, 'docker')).toBeNull()
  })

  it('closeSandboxSession PATCHes the end endpoint and never throws on failure', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('down') })
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
    await expect(closeSandboxSession(creds, 'ses_abc123')).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/sessions/ses_abc123/end'),
      expect.objectContaining({ method: 'PATCH' }),
    )
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
