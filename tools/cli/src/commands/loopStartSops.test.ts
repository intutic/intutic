/**
 * `intutic loop start --sops` selects local rule sets by option number or
 * name. It listed folders only, so a SOP written as a single file directly in
 * `.intutic/sops/` could not be selected; flat files are now rule sets too,
 * numbered after the folders as `/intutic initialize` numbers them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { rootRef } = vi.hoisted(() => ({ rootRef: { value: '' } }))

vi.mock('../config/store.js', () => ({
  loadCredentials: vi.fn(async () => ({ apiKey: 'vk_test_key', workspaceId: 'ws_test' })),
  loadConfig: vi.fn(() => ({ devMode: false, workspaceRoot: rootRef.value })),
}))
vi.mock('../config/paths.js', () => ({
  resolveControlPlaneUrl: vi.fn(() => 'https://api.test.invalid'),
  getIntuticDir: vi.fn(() => rootRef.value),
}))

import { runLoopStart } from './skill.js'

describe('loop start --sops selects folders and flat files', () => {
  beforeEach(async () => {
    rootRef.value = await fs.mkdtemp(join(tmpdir(), 'intutic-loop-sops-'))
    const sops = join(rootRef.value, '.intutic', 'sops')
    await fs.mkdir(join(sops, 'frontend-rules'), { recursive: true })
    await fs.writeFile(join(sops, 'frontend-rules', 'ui.md'), '- Use the design tokens.\n')
    await fs.writeFile(join(sops, 'deploy.md'), '---\nreview_before: action:deploy\n---\n')
    await fs.writeFile(join(sops, 'pulled.md'), '---\nintutic_id: sop_1\n---\nA workspace SOP copy.\n')
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, loop: { loopRunId: 'lr_1', budgetLimitUsd: '0' } }) })))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    await fs.rm(rootRef.value, { recursive: true, force: true })
  })

  const selected = async () =>
    JSON.parse(await fs.readFile(join(rootRef.value, '.intutic', 'session-context.json'), 'utf-8')).activeLocalSops

  it('selects a flat file by name, with or without .md', async () => {
    await runLoopStart({ name: 'n', sops: 'deploy' })
    expect(await selected()).toEqual(['deploy.md'])
    await runLoopStart({ name: 'n', sops: 'deploy.md,frontend-rules' })
    expect(await selected()).toEqual(['deploy.md', 'frontend-rules'])
  })

  it('numbers folders first, then flat files, and never offers a workspace SOP copy', async () => {
    await runLoopStart({ name: 'n', sops: '1,2,3' })
    expect(await selected()).toEqual(['frontend-rules', 'deploy.md'])
  })
})
