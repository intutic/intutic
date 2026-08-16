import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

vi.mock('../config/store.js', () => ({
  loadCredentials: vi.fn(async () => ({ apiKey: 'vk_test', workspaceId: 'ws_test' })),
  loadConfig: vi.fn(() => ({ workspaceRoot: workspaceRootRef.value })),
}))
vi.mock('../config/paths.js', () => ({ resolveControlPlaneUrl: vi.fn(() => 'https://api.test.invalid') }))

// vi.mock factories are hoisted above top-level const declarations, so
// anything they close over has to come from vi.hoisted() — including the
// mutable workspaceRoot each test points at its own temp dir.
const { postMock, getMock, workspaceRootRef } = vi.hoisted(() => ({
  postMock: vi.fn(),
  getMock: vi.fn(),
  workspaceRootRef: { value: '' },
}))
vi.mock('../lib/api.js', () => ({ createApiClient: () => ({ post: postMock, get: getMock }) }))

import { createHash } from 'node:crypto'
import { renderSopFile } from '../lib/sopFrontMatter.js'
import { runSopsPush, runSopsPull, runSopsStatus } from './sops.js'

describe('runSopsPush', () => {
  let sopsDir: string
  let exitCode: number | null

  beforeEach(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'intutic-sops-push-'))
    workspaceRootRef.value = root
    sopsDir = path.join(root, '.intutic', 'sops', 'deploy-checklist')
    await fs.mkdir(sopsDir, { recursive: true })

    postMock.mockReset()
    postMock.mockResolvedValue({ ok: true, sopId: 'sop_new' })
    exitCode = null
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCode = code ?? 0
      throw new Error(`process.exit(${code})`)
    }) as never)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(workspaceRootRef.value, { recursive: true, force: true })
  })

  async function push(opts: { org?: boolean } = {}): Promise<void> {
    try {
      await runSopsPush('deploy-checklist', opts)
    } catch (err) {
      if (!(err instanceof Error) || !err.message.startsWith('process.exit(')) throw err
    }
  }

  it('pushes one SOP per file, each with its own declared title/risk_tier/version', async () => {
    await fs.writeFile(
      path.join(sopsDir, 'db.md'),
      '---\ntitle: Database Migrations\nrisk_tier: high\nversion: 3.0.0\n---\nAlways back up first.',
    )
    await fs.writeFile(
      path.join(sopsDir, 'rollout.md'),
      '---\ntitle: Rollout Steps\nrisk_tier: low\n---\nRoll out to 10% first.',
    )

    await push()

    expect(postMock).toHaveBeenCalledTimes(2)
    const [dbCall, rolloutCall] = postMock.mock.calls
    expect(dbCall[1]).toMatchObject({
      title: 'Database Migrations',
      risk_tier: 'HIGH',
      version: '3.0.0',
      markdown_content: 'Always back up first.',
    })
    expect(rolloutCall[1]).toMatchObject({
      title: 'Rollout Steps',
      risk_tier: 'LOW',
    })
    // No version declared for the second file — the field must be omitted
    // entirely so the control plane's own default applies, not silently
    // filled with the first file's value or a hardcoded one.
    expect(rolloutCall[1]).not.toHaveProperty('version')
    expect(exitCode).toBeNull()
  })

  it('a file with no risk_tier: gets MEDIUM, the DB default, never the old hardcoded LOW', async () => {
    await fs.writeFile(path.join(sopsDir, 'plain.md'), 'Just prose, no front matter.')
    await push()
    expect(postMock).toHaveBeenCalledWith('/api/v1/sops', expect.objectContaining({ risk_tier: 'MEDIUM' }))
  })

  it('falls back to a title derived from the file name when nothing declares one', async () => {
    await fs.writeFile(path.join(sopsDir, 'no_frontmatter_here.md'), 'Body only.')
    await push()
    expect(postMock).toHaveBeenCalledWith(
      '/api/v1/sops',
      expect.objectContaining({ title: 'No Frontmatter Here' }),
    )
  })

  it('--org posts to the org-sops endpoint and omits risk_tier when undeclared', async () => {
    postMock.mockResolvedValue({ orgSopId: 'orgsop_1' })
    await fs.writeFile(path.join(sopsDir, 'floor.md'), 'A mandatory floor.')
    await push({ org: true })
    expect(postMock).toHaveBeenCalledWith(
      '/api/v1/workspace/org-sops',
      expect.not.objectContaining({ risk_tier: expect.anything() }),
    )
  })

  it('exits 1 and reports a count when some pushes fail', async () => {
    await fs.writeFile(path.join(sopsDir, 'a.md'), 'A')
    await fs.writeFile(path.join(sopsDir, 'b.md'), 'B')
    postMock.mockResolvedValueOnce({ ok: true, sopId: 'sop_a' }).mockRejectedValueOnce(new Error('network down'))

    await push()

    expect(exitCode).toBe(1)
  })

  it('exits 1 when the named local folder does not exist', async () => {
    try {
      await runSopsPush('does-not-exist', {})
    } catch (err) {
      if (!(err instanceof Error) || !err.message.startsWith('process.exit(')) throw err
    }
    expect(exitCode).toBe(1)
    expect(postMock).not.toHaveBeenCalled()
  })
})

describe('runSopsPull', () => {
  let root: string
  let sopsDir: string
  let exitCode: number | null

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'intutic-sops-pull-'))
    workspaceRootRef.value = root
    sopsDir = path.join(root, '.intutic', 'sops')

    getMock.mockReset()
    exitCode = null
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCode = code ?? 0
      throw new Error(`process.exit(${code})`)
    }) as never)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(root, { recursive: true, force: true })
  })

  async function pull(opts: { force?: boolean } = {}): Promise<void> {
    try {
      await runSopsPull(opts)
    } catch (err) {
      if (!(err instanceof Error) || !err.message.startsWith('process.exit(')) throw err
    }
  }

  it('writes a fresh file with front matter and a recorded content_hash', async () => {
    getMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/v1/sops?')) {
        return Promise.resolve({ items: [{ sopId: 'sop_1', title: 'Deploy Checklist' }] })
      }
      return Promise.resolve({
        sopId: 'sop_1',
        title: 'Deploy Checklist',
        riskTier: 'MEDIUM',
        version: '1.0.0',
        markdownContent: 'Run tests before deploying.',
      })
    })

    await pull()

    const written = await fs.readFile(path.join(sopsDir, 'deploy-checklist.md'), 'utf-8')
    expect(written).toContain('title: Deploy Checklist')
    expect(written).toContain('risk_tier: MEDIUM')
    expect(written).toContain('content_hash:')
    expect(written).toContain('Run tests before deploying.')
    expect(exitCode).toBeNull()
  })

  it('refuses to overwrite a hand-edited local file without --force', async () => {
    await fs.mkdir(sopsDir, { recursive: true })
    // A local file pull never wrote — no content_hash at all, so it must be
    // treated as unverifiable rather than silently clobbered.
    await fs.writeFile(path.join(sopsDir, 'deploy-checklist.md'), '# Hand-written\nDo not touch.')

    getMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/v1/sops?')) {
        return Promise.resolve({ items: [{ sopId: 'sop_1', title: 'Deploy Checklist' }] })
      }
      return Promise.resolve({
        sopId: 'sop_1', title: 'Deploy Checklist', riskTier: 'MEDIUM', version: '1.0.0',
        markdownContent: 'New content from the control plane.',
      })
    })

    await pull()

    const stillThere = await fs.readFile(path.join(sopsDir, 'deploy-checklist.md'), 'utf-8')
    expect(stillThere).toContain('Do not touch.')
    expect(stillThere).not.toContain('New content from the control plane.')
  })

  it('--force overwrites a hand-edited file anyway', async () => {
    await fs.mkdir(sopsDir, { recursive: true })
    await fs.writeFile(path.join(sopsDir, 'deploy-checklist.md'), 'Hand-written, no marker.')

    getMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/v1/sops?')) {
        return Promise.resolve({ items: [{ sopId: 'sop_1', title: 'Deploy Checklist' }] })
      }
      return Promise.resolve({
        sopId: 'sop_1', title: 'Deploy Checklist', riskTier: 'MEDIUM', version: '1.0.0',
        markdownContent: 'Forced content.',
      })
    })

    await pull({ force: true })

    const written = await fs.readFile(path.join(sopsDir, 'deploy-checklist.md'), 'utf-8')
    expect(written).toContain('Forced content.')
  })

  it('a file that matches its own recorded content_hash is refreshed without --force', async () => {
    await fs.mkdir(sopsDir, { recursive: true })

    getMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/v1/sops?')) {
        return Promise.resolve({ items: [{ sopId: 'sop_1', title: 'Deploy Checklist' }] })
      }
      return Promise.resolve({
        sopId: 'sop_1', title: 'Deploy Checklist', riskTier: 'MEDIUM', version: '1.0.0',
        markdownContent: 'Version one content.',
      })
    })

    // First pull writes the file, recording its own hash.
    await pull()
    const firstWrite = await fs.readFile(path.join(sopsDir, 'deploy-checklist.md'), 'utf-8')
    expect(firstWrite).toContain('Version one content.')

    // The control plane changed since; the LOCAL file was never touched by
    // hand, so a second pull must succeed even though the body differs from
    // the first pull's — the dirty check is against the local file's own
    // recorded hash, not the control plane's.
    getMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/v1/sops?')) {
        return Promise.resolve({ items: [{ sopId: 'sop_1', title: 'Deploy Checklist' }] })
      }
      return Promise.resolve({
        sopId: 'sop_1', title: 'Deploy Checklist', riskTier: 'MEDIUM', version: '1.0.0',
        markdownContent: 'Version two content, updated upstream.',
      })
    })

    await pull()

    const secondWrite = await fs.readFile(path.join(sopsDir, 'deploy-checklist.md'), 'utf-8')
    expect(secondWrite).toContain('Version two content, updated upstream.')
  })

  it('two SOPs with the same title get distinct file names, not one overwriting the other', async () => {
    getMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/v1/sops?')) {
        return Promise.resolve({
          items: [
            { sopId: 'sop_a', title: 'Onboarding' },
            { sopId: 'sop_b', title: 'Onboarding' },
          ],
        })
      }
      const sopId = url.split('/').pop()
      return Promise.resolve({
        sopId, title: 'Onboarding', riskTier: 'LOW', version: '1.0.0',
        markdownContent: `Content for ${sopId}.`,
      })
    })

    await pull()

    const entries = await fs.readdir(sopsDir)
    expect(entries.filter((e) => e.startsWith('onboarding'))).toHaveLength(2)
  })

  it('reports no SOPs found without writing anything, rather than an error', async () => {
    getMock.mockResolvedValue({ items: [] })
    await pull()
    await expect(fs.readdir(sopsDir)).rejects.toThrow()
  })
})

describe('runSopsStatus', () => {
  let root: string
  let sopsDir: string
  let logLines: string[]

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'intutic-sops-status-'))
    workspaceRootRef.value = root
    sopsDir = path.join(root, '.intutic', 'sops')
    await fs.mkdir(sopsDir, { recursive: true })

    getMock.mockReset()
    logLines = []
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`)
    }) as never)
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logLines.push(args.join(' '))
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(root, { recursive: true, force: true })
  })

  async function status(): Promise<void> {
    await runSopsStatus({})
  }

  function output(): string {
    return logLines.join('\n')
  }

  it('a file matching the control plane\'s content hash reports in-sync', async () => {
    const body = 'Run tests before deploying.'
    const hash = createHash('sha256').update(body, 'utf8').digest('hex')
    await fs.writeFile(
      path.join(sopsDir, 'deploy.md'),
      renderSopFile({ title: 'Deploy Checklist', riskTier: 'LOW', version: '1.0.0', body }),
    )
    getMock.mockResolvedValue({ items: [{ sopId: 'sop_1', title: 'Deploy Checklist', contentHash: hash }] })

    await status()

    expect(output()).toContain('in-sync')
  })

  it('a locally-edited pulled file (recorded hash stale) reports local-ahead', async () => {
    // renderSopFile records content_hash for "old body"; we then hand-edit
    // the body without updating the marker, exactly as a human would.
    const rendered = renderSopFile({ title: 'Deploy Checklist', riskTier: 'LOW', version: '1.0.0', body: 'old body' })
    const edited = rendered.replace('old body', 'a human changed this')
    await fs.writeFile(path.join(sopsDir, 'deploy.md'), edited)
    getMock.mockResolvedValue({
      items: [{ sopId: 'sop_1', title: 'Deploy Checklist', contentHash: 'unrelated-remote-hash' }],
    })

    await status()

    expect(output()).toContain('local-ahead')
  })

  it('an untouched pulled file whose control-plane content moved on reports remote-ahead', async () => {
    const body = 'Original pulled content.'
    await fs.writeFile(
      path.join(sopsDir, 'deploy.md'),
      renderSopFile({ title: 'Deploy Checklist', riskTier: 'LOW', version: '1.0.0', body }),
    )
    getMock.mockResolvedValue({
      items: [{ sopId: 'sop_1', title: 'Deploy Checklist', contentHash: 'a-newer-remote-hash' }],
    })

    await status()

    expect(output()).toContain('remote-ahead')
  })

  it('a hand-authored file never pulled, with no matching remote hash, reports diverged', async () => {
    await fs.writeFile(path.join(sopsDir, 'deploy.md'), '# Hand-written\nNo front matter marker.')
    getMock.mockResolvedValue({
      items: [{ sopId: 'sop_1', title: 'Hand-written', contentHash: 'something-else' }],
    })

    await status()

    expect(output()).toContain('diverged')
  })

  it('a local file with no matching title on the control plane reports push-only', async () => {
    await fs.writeFile(path.join(sopsDir, 'orphan.md'), '# Never Pushed\nLocal only.')
    getMock.mockResolvedValue({ items: [] })

    await status()

    expect(output()).toContain('push-only')
  })

  it('reports a directory-not-found message rather than throwing when .intutic/sops is absent', async () => {
    await fs.rm(sopsDir, { recursive: true, force: true })
    await status()
    expect(output()).toContain('No local SOPs directory')
    expect(getMock).not.toHaveBeenCalled()
  })
})
