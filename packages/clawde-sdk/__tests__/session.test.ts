/**
 * The session `chat()` files its calls under: registered once with the
 * working directory's git context, so the control plane can attribute SDK
 * traffic to a repository, branch and commit.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { createServer, Server } from 'http'
import { execFileSync } from 'child_process'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ResolvedContext } from '../src/types'

let context: ResolvedContext = {}
vi.mock('../src/context-resolver', () => ({ resolveContext: async () => context }))

import { ClawdeClient, SDK_HARNESS } from '../src/client'

interface Received {
  method: string
  path: string
  headers: Record<string, string | string[] | undefined>
  body: any
}

const completion = { id: 'c', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }

describe('ClawdeClient session', () => {
  let server: Server
  let url: string
  let received: Received[] = []
  let refuseControlPlane = false
  let repoDir: string
  let commit: string

  beforeAll(async () => {
    repoDir = mkdtempSync(join(tmpdir(), 'clawde-session-'))
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repoDir, stdio: 'pipe' })
    git('init', '-q', '-b', 'feat/retry')
    git('-c', 'user.email=dev@example.com', '-c', 'user.name=dev', 'commit', '-q', '--allow-empty', '-m', 'first')
    git('remote', 'add', 'origin', 'git@github.com:acme/app.git')
    commit = git('rev-parse', 'HEAD').toString().trim()

    await new Promise<void>((resolve) => {
      // One server plays the proxy and the control plane.
      server = createServer((req, res) => {
        let body = ''
        req.on('data', (chunk) => { body += chunk })
        req.on('end', () => {
          received.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body: body ? JSON.parse(body) : undefined })
          const send = (status: number, payload: unknown) => {
            res.writeHead(status, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(payload))
          }
          if (req.url?.startsWith('/api/') && refuseControlPlane) return send(401, { error: 'Unauthorized' })
          if (req.url === '/api/v1/auth/me') return send(200, { workspaceId: 'ws_1', memberId: 'm', email: 'e', role: 'DEVELOPER' })
          if (req.url === '/api/v1/sessions') return send(201, { sessionId: 'ses_sdk' })
          send(200, completion)
        })
      })
      server.listen(0, '127.0.0.1', () => {
        url = `http://127.0.0.1:${(server.address() as any).port}`
        resolve()
      })
    })
  })

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  beforeEach(() => {
    received = []
    refuseControlPlane = false
    context = { workingDirectory: repoDir }
    // A pull request build in CI sets it, and it would name a branch outside a repository.
    vi.stubEnv('GITHUB_HEAD_REF', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  const client = (apiKey = 'vk_test', extra: Record<string, unknown> = {}) =>
    new ClawdeClient({ apiKey, baseUrl: url, controlPlaneUrl: url, ...extra })
  const ask = (c: ClawdeClient) => c.chat({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] })
  const proxyCalls = () => received.filter((r) => r.path === '/v1/chat/completions')

  it('registers one session with the git context and sends it on every call', async () => {
    const c = client()
    await ask(c)
    await ask(c)

    const registered = received.filter((r) => r.path === '/api/v1/sessions')
    expect(registered).toHaveLength(1)
    expect(registered[0].method).toBe('POST')
    expect(registered[0].headers['authorization']).toBe('Bearer vk_test')
    expect(registered[0].body).toEqual({
      workspaceId: 'ws_1',
      harnessType: SDK_HARNESS,
      repoUrl: 'github.com/acme/app',
      branchName: 'feat/retry',
      commitHash: commit,
    })
    expect(proxyCalls().map((r) => r.headers['x-session-id'])).toEqual(['ses_sdk', 'ses_sdk'])
  })

  it('confirms the key even when the context names a workspace, and registers in the key\'s workspace', async () => {
    context = { workingDirectory: repoDir, workspaceId: 'ws_ctx' }
    await ask(client())
    expect(received.filter((r) => r.path.startsWith('/api/')).map((r) => r.path)).toEqual(['/api/v1/auth/me', '/api/v1/sessions'])
    expect(received.find((r) => r.path === '/api/v1/sessions')?.body.workspaceId).toBe('ws_1')
  })

  it('sends the session it was started in as is, and registers nothing', async () => {
    context = { workingDirectory: repoDir, sessionId: 'ses_parent' }
    await ask(client())
    expect(received.filter((r) => r.path.startsWith('/api/'))).toEqual([])
    expect(proxyCalls()[0].headers['x-session-id']).toBe('ses_parent')
  })

  it('never sends a key that is not an Intutic virtual key to the control plane', async () => {
    await ask(client('sk-provider-key'))
    expect(received.filter((r) => r.path.startsWith('/api/'))).toEqual([])
    expect(proxyCalls()[0].headers['x-session-id']).toBeUndefined()
  })

  it('still makes the call when the control plane refuses, and does not ask again', async () => {
    refuseControlPlane = true
    const c = client()
    await ask(c)
    await ask(c)
    expect(received.filter((r) => r.path.startsWith('/api/'))).toHaveLength(1)
    expect(proxyCalls().map((r) => r.headers['x-session-id'])).toEqual([undefined, undefined])
  })

  it('registers nothing outside a repository, or with autoContext off', async () => {
    context = { workingDirectory: mkdtempSync(join(tmpdir(), 'clawde-nogit-')) }
    await ask(client())
    context = { workingDirectory: repoDir }
    await ask(client('vk_test', { autoContext: false }))
    expect(received.filter((r) => r.path.startsWith('/api/'))).toEqual([])
    expect(proxyCalls().map((r) => r.headers['x-session-id'])).toEqual([undefined, undefined])
  })
})
