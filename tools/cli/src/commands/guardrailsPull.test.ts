/**
 * `intutic guardrails pull` (LLD #71, Wave 9): the served projection becomes
 * flat `guardrail-<id>.md` files whose single fence still holds the
 * enforcing keys and `mode: shadow` beside the pull marker — read back both
 * by `parseSopFile` (the CLI's own dirty check) and by the TypeScript mirror
 * of the proxy's front-matter parser, which is the assertion that matters.
 * Ordinary SOPs in the same response are ignored, a hand-edited file is left
 * alone without --force, a file the server stopped serving is reported and
 * pruned only when unmodified.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'

vi.mock('../config/store.js', () => ({
  loadCredentials: vi.fn(async () => ({ apiKey: 'vk_test', workspaceId: 'ws_test' })),
  loadConfig: vi.fn(() => ({ workspaceRoot: workspaceRootRef.value })),
}))
vi.mock('../config/paths.js', () => ({ resolveControlPlaneUrl: vi.fn(() => 'https://api.test.invalid') }))

const { getMock, workspaceRootRef } = vi.hoisted(() => ({
  getMock: vi.fn(),
  workspaceRootRef: { value: '' },
}))
vi.mock('../lib/api.js', () => ({
  createApiClient: () => ({ get: getMock }),
}))

import { renderGuardrailSopFile, splitFrontMatter, parseFrontMatterEnforcing, isEnforceableFrontMatter } from '@intutic/shared-types'
import { parseSopFile } from '../lib/sopFrontMatter.js'
import { runGuardrailsPull } from './guardrails.js'

const projected = (id: string, lines: string, shadow: boolean) => ({
  title: `GUARDRAIL:${id} ${lines.split('\n')[0]}`,
  markdownContent: renderGuardrailSopFile({
    lines,
    title: 'Engineering handbook',
    body: '> Agents do not fetch external web pages.\n\nProjected from the cited policy passage above (LLD #71); the front-matter keys are what the proxy enforces.',
    sourceUrl: 'https://wiki.acme.dev/handbook',
    cite: 'a'.repeat(64),
    shadow,
  }),
  scope: 'workspace',
})

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

describe('runGuardrailsPull', () => {
  let root: string
  let sopsDir: string
  let exitCode: number | null
  let logs: string[]

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'intutic-guardrails-pull-'))
    workspaceRootRef.value = root
    sopsDir = path.join(root, '.intutic', 'sops')
    getMock.mockReset()
    exitCode = null
    logs = []
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCode = code ?? 0
      throw new Error(`process.exit(${code})`)
    }) as never)
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(' '))
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(root, { recursive: true, force: true })
  })

  const serve = (sops: unknown[]) => getMock.mockResolvedValue({ workspaceId: 'ws_test', sops })

  async function pull(opts: { force?: boolean; prune?: boolean; json?: boolean } = {}): Promise<Record<string, string[]> | null> {
    logs = []
    try {
      await runGuardrailsPull(opts)
    } catch (err) {
      if (!(err instanceof Error) || !err.message.startsWith('process.exit(')) throw err
    }
    if (!opts.json) return null
    return JSON.parse(logs.at(-1) ?? '{}') as Record<string, string[]>
  }

  it('writes one flat file per served guardrail whose single fence keeps the enforcing keys, the mode and the marker; ordinary SOPs are ignored', async () => {
    serve([
      { title: 'Deploy checklist', markdownContent: '# Deploy\n\nRun tests.', scope: 'workspace' },
      projected('pgr_shadow1', 'deny_tools: WebFetch', true),
      projected('pgr_live001', 'max_calls: action:deploy 3', false),
    ])
    const out = await pull({ json: true })
    expect(out!.written.sort()).toEqual(['guardrail-pgr_live001', 'guardrail-pgr_shadow1'])
    expect(getMock).toHaveBeenCalledWith('/api/v1/workspace/sops-policy')
    expect(await fs.readdir(sopsDir)).toEqual(['guardrail-pgr_live001.md', 'guardrail-pgr_shadow1.md'])

    const file = await fs.readFile(path.join(sopsDir, 'guardrail-pgr_shadow1.md'), 'utf-8')
    expect(file.match(/^---$/gm), 'exactly one fence — a second one is body prose to the proxy').toHaveLength(2)
    const { front } = splitFrontMatter(file)
    expect(front).toContain('deny_tools: WebFetch')
    expect(front).toContain('mode: shadow')
    expect(front).toContain('source: https://wiki.acme.dev/handbook')
    expect(front).toMatch(/content_hash: [0-9a-f]{64}/)
    const enforcing = parseFrontMatterEnforcing(front)
    expect(enforcing.mode).toBe('shadow')
    expect(isEnforceableFrontMatter(enforcing), 'the proxy would still enforce this file').toBe(true)
    const parsed = parseSopFile(file)
    expect(parsed.contentHash).toBe(sha(parsed.body))
    expect(parsed.title).toBe('Engineering handbook')

    const live = await fs.readFile(path.join(sopsDir, 'guardrail-pgr_live001.md'), 'utf-8')
    expect(splitFrontMatter(live).front).not.toContain('mode: shadow')
    expect(parseFrontMatterEnforcing(splitFrontMatter(live).front).mode).toBe('enforce')
  })

  it('a second pull leaves an unchanged file unchanged, refuses a hand-edited one without --force, and overwrites it with --force', async () => {
    serve([projected('pgr_edit01', 'deny_tools: WebFetch', true)])
    await pull({ json: true })
    const filePath = path.join(sopsDir, 'guardrail-pgr_edit01.md')
    const pristine = await fs.readFile(filePath, 'utf-8')

    const again = await pull({ json: true })
    expect(again!.unchanged).toEqual(['guardrail-pgr_edit01'])
    expect(again!.written).toEqual([])

    await fs.writeFile(filePath, pristine.replace('Agents do not fetch', 'Agents may fetch'), 'utf-8')
    const refused = await pull({ json: true })
    expect(refused!.skipped).toEqual(['guardrail-pgr_edit01'])
    expect(await fs.readFile(filePath, 'utf-8')).toContain('Agents may fetch')

    const forced = await pull({ json: true, force: true })
    expect(forced!.written).toEqual(['guardrail-pgr_edit01'])
    expect(await fs.readFile(filePath, 'utf-8')).toBe(pristine)
    expect(exitCode).toBeNull()
  })

  it('reports a file the server no longer serves, prunes it only with --prune, and never prunes a modified one', async () => {
    serve([projected('pgr_keep01', 'deny_tools: WebFetch', true), projected('pgr_gone01', 'deny_tools: Bash', true), projected('pgr_gone02', 'deny_tools: Write', true)])
    await pull({ json: true })
    const gone2 = path.join(sopsDir, 'guardrail-pgr_gone02.md')
    await fs.writeFile(gone2, (await fs.readFile(gone2, 'utf-8')).replace('Agents do not', 'Humans do not'), 'utf-8')

    serve([projected('pgr_keep01', 'deny_tools: WebFetch', true)])
    const reported = await pull({ json: true })
    expect(reported!.stale.sort()).toEqual(['guardrail-pgr_gone01', 'guardrail-pgr_gone02'])
    expect(reported!.pruned).toEqual([])
    expect((await fs.readdir(sopsDir)).sort()).toEqual(['guardrail-pgr_gone01.md', 'guardrail-pgr_gone02.md', 'guardrail-pgr_keep01.md'])

    const pruned = await pull({ json: true, prune: true })
    expect(pruned!.pruned).toEqual(['guardrail-pgr_gone01'])
    expect(pruned!.stale).toEqual(['guardrail-pgr_gone02'])
    expect((await fs.readdir(sopsDir)).sort()).toEqual(['guardrail-pgr_gone02.md', 'guardrail-pgr_keep01.md'])
  })

  it('exits 1 when the policy cannot be fetched, writing nothing', async () => {
    getMock.mockRejectedValue(new Error('boom'))
    await pull()
    expect(exitCode).toBe(1)
    await expect(fs.readdir(sopsDir)).rejects.toBeTruthy()
  })
})
