/**
 * `intutic sops pull` → edit → `intutic sops push` against a stateful fake of
 * the control plane's SOP routes, which follows `updateSop`'s rules: a DRAFT
 * is edited in place, an approved SOP forks a DRAFT successor (the approved
 * one keeps enforcing), and a stale `version_counter` is a 409.
 *
 * Push used to create a new SOP for every file it read, so a pulled, edited
 * SOP came back as a duplicate.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { stripVTControlCharacters } from 'node:util'

const { server, workspaceRootRef } = vi.hoisted(() => ({
  server: {
    rows: new Map<string, {
      sopId: string
      title: string
      riskTier: string | null
      version: string
      markdownContent: string
      lifecycleState: string
      versionCounter: number
      isActive: boolean
      priorVersionId: string | null
    }>(),
    seq: 0,
    refuseWeaken: false,
    conflictOnPut: false,
    puts: [] as Array<{ sopId: string; body: Record<string, unknown> }>,
  },
  workspaceRootRef: { value: '' },
}))

vi.mock('../config/store.js', () => ({
  loadCredentials: vi.fn(async () => ({ apiKey: 'vk_test', workspaceId: 'ws_test' })),
  loadConfig: vi.fn(() => ({ workspaceRoot: workspaceRootRef.value })),
}))
vi.mock('../config/paths.js', () => ({ resolveControlPlaneUrl: vi.fn(() => 'https://api.test.invalid') }))

vi.mock('../lib/api.js', () => {
  const hash = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
  const idOf = (url: string) => decodeURIComponent(url.split('?')[0]!.split('/').pop()!)
  const detail = (url: string) => {
    const row = server.rows.get(idOf(url))
    return row ? { status: 200, body: { ...row, contentHash: hash(row.markdownContent) } } : { status: 404, body: { error: 'SOP not found' } }
  }
  return {
    createApiClient: () => ({
      async get(url: string) {
        if (url.startsWith('/api/v1/sops?')) {
          const items = [...server.rows.values()].filter((r) => r.isActive).map((r) => ({ ...r, contentHash: hash(r.markdownContent) }))
          return { items, total: items.length }
        }
        const res = detail(url)
        if (res.status !== 200) throw new Error(`GET ${url} failed (404)`)
        return res.body
      },
      async getWithStatus(url: string) {
        return detail(url)
      },
      async post(url: string, body: Record<string, unknown>) {
        if (url === '/api/v1/sops/git-drift-report') return { ok: true }
        const sopId = `sp_new${++server.seq}`
        server.rows.set(sopId, {
          sopId,
          title: String(body.title),
          riskTier: String(body.risk_tier),
          version: String(body.version ?? '1.0.0'),
          markdownContent: String(body.markdown_content),
          lifecycleState: 'DRAFT',
          versionCounter: 1,
          isActive: true,
          priorVersionId: null,
        })
        return { ok: true, sopId }
      },
      async putWithStatus(url: string, body: Record<string, unknown>) {
        const row = server.rows.get(idOf(url))
        server.puts.push({ sopId: idOf(url), body })
        if (!row) return { status: 404, body: { error: 'SOP not found' } }
        if (server.conflictOnPut || (body.version_counter !== undefined && body.version_counter !== row.versionCounter)) {
          return { status: 409, body: { error: 'CONCURRENCY_CONFLICT: SOP has been updated by another user. Please reload.' } }
        }
        if (server.refuseWeaken) {
          return {
            status: 403,
            body: { error: 'WEAKEN_REQUIRES_OWNER', message: 'WEAKEN_REQUIRES_OWNER: Removes a prohibition. Only an Owner can make this change.' },
          }
        }
        if (row.lifecycleState !== 'DRAFT') {
          const sopId = `sp_fork${++server.seq}`
          const [maj, min, patch] = row.version.split('.')
          const forked = {
            ...row,
            sopId,
            title: String(body.title ?? row.title),
            markdownContent: String(body.markdown_content ?? row.markdownContent),
            version: String(body.version ?? `${maj}.${min}.${Number(patch) + 1}`),
            lifecycleState: 'DRAFT',
            versionCounter: 1,
            priorVersionId: row.sopId,
          }
          server.rows.set(sopId, forked)
          return { status: 200, body: { sop: forked } }
        }
        const updated = {
          ...row,
          title: String(body.title ?? row.title),
          markdownContent: String(body.markdown_content ?? row.markdownContent),
          riskTier: body.risk_tier === undefined ? row.riskTier : String(body.risk_tier),
          version: String(body.version ?? row.version),
          versionCounter: row.versionCounter + 1,
        }
        server.rows.set(row.sopId, updated)
        return { status: 200, body: { sop: updated } }
      },
    }),
  }
})

import { runSopsPull, runSopsPush, runSopsStatus } from './sops.js'
import { parseSopFile } from '../lib/sopFrontMatter.js'
import { markedNotEnforced } from '@intutic/sync-daemon'

let root: string
let sopsDir: string
let exitCode: number | null
let out: string[]

function seed(sopId: string, over: Partial<{ title: string; riskTier: string | null; markdownContent: string; lifecycleState: string; versionCounter: number }> = {}) {
  server.rows.set(sopId, {
    sopId,
    title: 'Deploy Checklist',
    riskTier: 'HIGH',
    version: '1.0.0',
    markdownContent: 'Run the tests before deploying.',
    lifecycleState: 'DRAFT',
    versionCounter: 1,
    isActive: true,
    priorVersionId: null,
    ...over,
  })
}

async function run(fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith('process.exit(')) throw err
  }
}

const printed = () => stripVTControlCharacters(out.join('\n'))
const file = (name = 'deploy-checklist.md') => path.join(sopsDir, name)
const read = (p = file()) => fs.readFile(p, 'utf-8')
async function edit(p: string, from: string, to: string) {
  await fs.writeFile(p, (await read(p)).replace(from, to))
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'intutic-sops-sync-'))
  workspaceRootRef.value = root
  sopsDir = path.join(root, '.intutic', 'sops')
  server.rows.clear()
  server.seq = 0
  server.refuseWeaken = false
  server.conflictOnPut = false
  server.puts = []
  exitCode = null
  out = []
  const push = (...args: unknown[]) => out.push(args.map(String).join(' '))
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code ?? 0
    throw new Error(`process.exit(${code})`)
  }) as never)
  vi.spyOn(console, 'log').mockImplementation(push)
  vi.spyOn(console, 'error').mockImplementation(push)
  vi.spyOn(console, 'warn').mockImplementation(push)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(root, { recursive: true, force: true })
})

describe('sops pull records the SOP each file came from', () => {
  it('writes intutic_id and intutic_revision into the front matter', async () => {
    seed('sp_1', { versionCounter: 4 })
    await run(() => runSopsPull({}))
    const parsed = parseSopFile(await read())
    expect(parsed.intuticId).toBe('sp_1')
    expect(parsed.revision).toBe(4)
  })
})

// Pull writes every active SOP, drafts and SOPs in shadow included. A local
// copy must enforce exactly what the control plane enforces, so each file
// records whether the server enforces its SOP and every local reader skips
// one marked `intutic_enforced: false`.
describe('sops pull records whether the control plane enforces each SOP', () => {
  const enforcedOf = async (p = file()) => (await read(p)).match(/^intutic_enforced: (\w+)$/m)?.[1]

  it('marks a VALIDATED SOP enforced and every other state not', async () => {
    seed('sp_v', { title: 'Validated', lifecycleState: 'VALIDATED' })
    seed('sp_d', { title: 'Draft', lifecycleState: 'DRAFT' })
    seed('sp_h', { title: 'Shadowed', lifecycleState: 'HYPOTHESIZED' })
    seed('sp_i', { title: 'Invalidated', lifecycleState: 'INVALIDATED' })
    await run(() => runSopsPull({}))
    expect(await enforcedOf(file('validated.md'))).toBe('true')
    for (const name of ['draft.md', 'shadowed.md', 'invalidated.md']) expect(await enforcedOf(file(name)), name).toBe('false')
    expect(markedNotEnforced(await read(file('draft.md')))).toBe(true)
  })

  it('follows a state change on the next pull, even over a local edit', async () => {
    seed('sp_1', { lifecycleState: 'VALIDATED' })
    await run(() => runSopsPull({}))
    expect(await enforcedOf()).toBe('true')
    await edit(file(), 'Run the tests before deploying.', 'Local edit.')
    server.rows.set('sp_1', { ...server.rows.get('sp_1')!, lifecycleState: 'INVALIDATED' })

    await run(() => runSopsPull({}))
    expect(await enforcedOf()).toBe('false')
    expect(await read()).toContain('Local edit.')
    expect(printed()).toContain('refusing to overwrite')
  })

  it('marks a file whose SOP is no longer active, keeping its body', async () => {
    seed('sp_1', { lifecycleState: 'VALIDATED' })
    await run(() => runSopsPull({}))
    server.rows.set('sp_1', { ...server.rows.get('sp_1')!, isActive: false })

    await run(() => runSopsPull({}))
    expect(await enforcedOf()).toBe('false')
    expect(parseSopFile(await read()).body).toBe('Run the tests before deploying.')
  })
})

// A SOP written without a tier (the SOP health check writes none) has a null
// riskTier. Pull wrote `risk_tier: null` into the file, which is not a tier.
describe('a SOP with no risk tier', () => {
  it('pulls without a risk_tier key, and pull → status → edit → push keeps it untiered', async () => {
    seed('sp_1', { riskTier: null })
    await run(() => runSopsPull({}))
    expect(await read()).not.toMatch(/^risk_tier:/m)
    expect(parseSopFile(await read()).riskTier).toBeNull()

    await run(() => runSopsStatus({}))
    expect(printed()).toContain('1 in sync, 0 locally modified, 0 behind, 0 diverged')

    await edit(file(), 'Run the tests before deploying.', 'Run the tests and the linters before deploying.')
    await run(() => runSopsPush('deploy-checklist', {}))
    expect(exitCode).toBeNull()
    expect(server.puts[0]!.body).not.toHaveProperty('risk_tier')
    expect(server.rows.get('sp_1')!.riskTier).toBeNull()
    expect(await read()).not.toMatch(/^risk_tier:/m)
  })

  it('a pull over a file whose SOP lost its tier on the server removes the key', async () => {
    seed('sp_1')
    await run(() => runSopsPull({}))
    expect(await read()).toMatch(/^risk_tier: HIGH$/m)
    server.rows.set('sp_1', { ...server.rows.get('sp_1')!, riskTier: null, versionCounter: 2 })

    await run(() => runSopsPull({}))
    expect(await read()).not.toMatch(/^risk_tier:/m)
    expect(parseSopFile(await read()).revision).toBe(2)
  })
})

describe('sops push updates the SOP a file records', () => {
  it('pull → edit → push updates the same SOP in place, with no duplicate', async () => {
    seed('sp_1')
    await run(() => runSopsPull({}))
    await edit(file(), 'Run the tests before deploying.', 'Run the tests and the linters before deploying.')

    await run(() => runSopsPush('deploy-checklist', {}))

    expect(exitCode).toBeNull()
    expect([...server.rows.keys()]).toEqual(['sp_1'])
    expect(server.rows.get('sp_1')!.markdownContent).toBe('Run the tests and the linters before deploying.')
    expect(server.puts[0]!.body.version_counter).toBe(1)
    const parsed = parseSopFile(await read())
    expect(parsed.intuticId).toBe('sp_1')
    expect(parsed.revision).toBe(2)
    expect(printed()).toContain('updated "Deploy Checklist" in place')
  })

  it('an approved SOP gets a DRAFT successor; the approved one keeps enforcing and is not pulled back as a second file', async () => {
    seed('sp_1', { lifecycleState: 'VALIDATED' })
    await run(() => runSopsPull({}))
    await edit(file(), 'Run the tests before deploying.', 'Run the tests and get a review before deploying.')

    await run(() => runSopsPush('deploy-checklist', {}))

    expect(exitCode).toBeNull()
    const approved = server.rows.get('sp_1')!
    expect(approved.lifecycleState).toBe('VALIDATED')
    expect(approved.isActive).toBe(true)
    expect(approved.markdownContent).toBe('Run the tests before deploying.')
    const drafts = [...server.rows.values()].filter((r) => r.priorVersionId === 'sp_1')
    expect(drafts).toHaveLength(1)
    expect(drafts[0]!.lifecycleState).toBe('DRAFT')
    const parsed = parseSopFile(await read())
    expect(parsed.intuticId).toBe(drafts[0]!.sopId)
    expect(parsed.revision).toBe(1)
    expect(printed()).toContain('keeps enforcing until the draft is promoted')

    // A second push of the same file edits that draft, and a pull does not
    // write the approved version back as a second file.
    await edit(file(), 'get a review', 'get two reviews')
    await run(() => runSopsPush('deploy-checklist', {}))
    expect([...server.rows.values()].filter((r) => r.priorVersionId === 'sp_1')).toHaveLength(1)
    await run(() => runSopsPull({}))
    expect((await fs.readdir(sopsDir)).sort()).toEqual(['deploy-checklist.md'])
    expect(exitCode).toBeNull()
  })

  it('refuses when the SOP changed on the server since the pull, and --force overwrites it', async () => {
    seed('sp_1')
    await run(() => runSopsPull({}))
    // Someone else edits it on the server.
    server.rows.set('sp_1', { ...server.rows.get('sp_1')!, markdownContent: 'Server-side edit.', versionCounter: 2 })
    await edit(file(), 'Run the tests before deploying.', 'Local edit.')

    await run(() => runSopsPush('deploy-checklist', {}))
    expect(exitCode).toBe(1)
    expect(printed()).toContain('changed on the server since you pulled it')
    expect(printed()).toContain('--force')
    expect(server.rows.get('sp_1')!.markdownContent).toBe('Server-side edit.')

    exitCode = null
    await run(() => runSopsPush('deploy-checklist', { force: true }))
    expect(exitCode).toBeNull()
    expect(server.rows.get('sp_1')!.markdownContent).toBe('Local edit.')
    expect(parseSopFile(await read()).revision).toBe(3)
  })

  it('surfaces the server\'s 409 when the SOP changes between the read and the write', async () => {
    seed('sp_1')
    await run(() => runSopsPull({}))
    await edit(file(), 'Run the tests before deploying.', 'Local edit.')
    server.conflictOnPut = true

    await run(() => runSopsPush('deploy-checklist', {}))
    expect(exitCode).toBe(1)
    expect(printed()).toContain('CONCURRENCY_CONFLICT')
  })

  it('surfaces a 403 with the server\'s detail (WEAKEN needs an Owner)', async () => {
    seed('sp_1')
    await run(() => runSopsPull({}))
    await edit(file(), 'Run the tests before deploying.', 'Deploy when ready.')
    server.refuseWeaken = true

    await run(() => runSopsPush('deploy-checklist', {}))
    expect(exitCode).toBe(1)
    expect(printed()).toContain('Only an Owner can make this change.')
    expect(server.rows.get('sp_1')!.markdownContent).toBe('Run the tests before deploying.')
  })

  it('refuses to fork a second DRAFT of an approved SOP that already has one', async () => {
    seed('sp_1', { lifecycleState: 'VALIDATED' })
    await run(() => runSopsPull({}))
    // A teammate already forked a draft from the dashboard.
    server.rows.set('sp_draft', { ...server.rows.get('sp_1')!, sopId: 'sp_draft', lifecycleState: 'DRAFT', priorVersionId: 'sp_1' })
    await edit(file(), 'Run the tests before deploying.', 'Local edit.')

    await run(() => runSopsPush('deploy-checklist', {}))
    expect(exitCode).toBe(1)
    expect(printed()).toContain('already has a newer DRAFT version on the server (sp_draft)')
    expect(server.puts).toHaveLength(0)
  })

  it('an unchanged file is a no-op', async () => {
    seed('sp_1')
    await run(() => runSopsPull({}))
    await run(() => runSopsPush('deploy-checklist', {}))
    expect(exitCode).toBeNull()
    expect(server.puts).toHaveLength(0)
    expect(printed()).toContain('up to date')
  })

  it('a new file creates a SOP and records its id, so the next push updates it', async () => {
    await fs.mkdir(sopsDir, { recursive: true })
    await fs.writeFile(file('rollout.md'), '---\ntitle: Rollout Steps\nrisk_tier: low\ndeny_tools: [force_push]\n---\nRoll out to 10% first.\n')

    await run(() => runSopsPush('rollout', {}))
    expect(exitCode).toBeNull()
    const created = [...server.rows.values()]
    expect(created).toHaveLength(1)
    const written = await read(file('rollout.md'))
    const parsed = parseSopFile(written)
    expect(parsed.intuticId).toBe(created[0]!.sopId)
    expect(parsed.revision).toBe(1)
    // The enforcing key the proxy reads is kept.
    expect(written).toContain('deny_tools: [force_push]')

    await edit(file('rollout.md'), '10%', '5%')
    await run(() => runSopsPush('rollout', {}))
    expect(server.rows.size).toBe(1)
    expect(created[0]!.sopId).toBe([...server.rows.keys()][0])
    expect(server.rows.get(created[0]!.sopId)!.markdownContent).toBe('Roll out to 5% first.')
  })

  it('a file whose SOP was deleted on the server is refused, and --create makes a new one', async () => {
    await fs.mkdir(sopsDir, { recursive: true })
    await fs.writeFile(file('gone.md'), '---\ntitle: Gone\nintutic_id: sp_gone\nintutic_revision: 3\n---\nBody.\n')

    await run(() => runSopsPush('gone', {}))
    expect(exitCode).toBe(1)
    expect(printed()).toContain('no longer on the control plane')
    expect(printed()).toContain('--create')
    expect(server.rows.size).toBe(0)

    exitCode = null
    await run(() => runSopsPush('gone', { create: true }))
    expect(exitCode).toBeNull()
    expect(server.rows.size).toBe(1)
    expect(parseSopFile(await read(file('gone.md'))).intuticId).toBe([...server.rows.keys()][0])
  })

  it('the folder layout behaves the same, and pull refreshes the folder file in place', async () => {
    seed('sp_1')
    const folder = path.join(sopsDir, 'checklists')
    await fs.mkdir(folder, { recursive: true })
    const p = path.join(folder, 'deploy.md')
    await fs.writeFile(
      p,
      '---\ntitle: Deploy Checklist\nrisk_tier: HIGH\ndeny_tools: [deploy_prod]\nintutic_id: sp_1\nintutic_revision: 1\n---\nRun the tests before deploying.\n',
    )

    // Push of the unchanged folder is a no-op; an edit updates sp_1 in place.
    await run(() => runSopsPush('checklists', {}))
    expect(server.puts).toHaveLength(0)
    await edit(p, 'Run the tests', 'Run every test')
    await run(() => runSopsPush('checklists', {}))
    expect(exitCode).toBeNull()
    expect(server.rows.size).toBe(1)
    expect(server.rows.get('sp_1')!.markdownContent).toBe('Run every test before deploying.')

    // The server moves on; pull lands in the folder file, not a new flat one,
    // and keeps the enforcing key.
    server.rows.set('sp_1', { ...server.rows.get('sp_1')!, markdownContent: 'Run every test twice.', versionCounter: 3 })
    await run(() => runSopsPull({}))
    expect((await fs.readdir(sopsDir)).sort()).toEqual(['checklists'])
    const pulled = await read(p)
    expect(pulled).toContain('Run every test twice.')
    expect(pulled).toContain('deny_tools: [deploy_prod]')
    expect(parseSopFile(pulled).revision).toBe(3)
  })

  it('reports each file and exits 1 when any of several fails', async () => {
    seed('sp_1')
    const folder = path.join(sopsDir, 'mixed')
    await fs.mkdir(folder, { recursive: true })
    await fs.writeFile(path.join(folder, 'a.md'), '---\ntitle: Deploy Checklist\nintutic_id: sp_1\nintutic_revision: 9\n---\nStale edit.\n')
    await fs.writeFile(path.join(folder, 'b.md'), '---\ntitle: Brand New\n---\nNew guideline.\n')

    await run(() => runSopsPush('mixed', {}))
    expect(exitCode).toBe(1)
    expect(printed()).toContain('a.md: "Deploy Checklist" changed on the server')
    expect(printed()).toContain('b.md → new workspace SOP "Brand New"')
    expect(printed()).toContain('1 created, 0 updated, 0 new DRAFT version(s), 0 up to date, 1 failed')
  })
})

describe('sops status reads the same record', () => {
  it('matches by intutic_id, not title, and reports a file edited on both sides as diverged', async () => {
    seed('sp_1')
    await run(() => runSopsPull({}))
    // Renamed on the server, edited on both sides.
    server.rows.set('sp_1', { ...server.rows.get('sp_1')!, title: 'Renamed', markdownContent: 'Server edit.', versionCounter: 2 })
    await edit(file(), 'Run the tests before deploying.', 'Local edit.')

    await run(() => runSopsStatus({}))
    expect(printed()).toContain('deploy-checklist.md: diverged')
    expect(printed()).toContain('0 push-only')
  })
})
