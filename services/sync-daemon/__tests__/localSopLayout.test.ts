/**
 * localSopLayout.test.ts — every reader of `.intutic/sops/` in the sync daemon
 * reads both layouts: `*.md` directly in it and `<set>/*.md` one folder down.
 *
 * The proxy read only the flat files and `intutic connect` only the folders,
 * so a SOP placed for one was invisible to the other. The proxy side is pinned
 * in `packages/proxy/src/sops.rs` (`one_folder_down_is_read_beside_the_flat_files`).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { HarnessType } from '@intutic/shared-types'
import { loadLocalSopEntries } from '../src/configWriter.js'
import { localHoldTokensFor } from '../src/syncCycle.js'
import { collectAgentReport } from '../src/agentReporter.js'
import { listSopFiles, listSopSets } from '../src/lib/sopFiles.js'

const HARNESSES = ['claude-code'] as HarnessType[]

describe('local SOP layout', () => {
  let root: string
  let sops: string

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'intutic-sop-layout-'))
    sops = join(root, '.intutic', 'sops')
    await fs.mkdir(join(sops, 'safety', 'deeper'), { recursive: true })
    await fs.mkdir(join(sops, '..data'), { recursive: true })
    await fs.writeFile(join(sops, 'deploy.md'), '---\nreview_before: action:deploy\n---\nAsk before deploying.\n')
    await fs.writeFile(join(sops, 'safety', 'rules.md'), '---\ndeny_tools: WebFetch\n---\nNo fetching.\n')
    await fs.writeFile(join(sops, 'safety', 'deeper', 'too-deep.md'), '- not read\n')
    await fs.writeFile(join(sops, '..data', 'deploy.md'), '- a ConfigMap link target\n')
    await fs.writeFile(join(sops, 'notes.txt'), 'not a SOP\n')
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('lists the flat files and one folder down, as the proxy reads them', async () => {
    const files = await listSopFiles(sops)
    expect(files.map((f) => [f.folder, f.file])).toEqual([
      [null, 'deploy.md'],
      ['safety', 'rules.md'],
    ])
  })

  it('loads a flat SOP for the rules files, not only the folders', async () => {
    const entries = await loadLocalSopEntries(root, HARNESSES)
    expect(entries.map((e) => e.sopId)).toEqual(['local:deploy.md', 'local:safety:rules.md'])
    expect(entries.map((e) => e.title)).toEqual(['Local SOP: deploy.md', 'Local SOP: safety/rules.md'])
  })

  it('compiles a flat SOP\'s review_before into the gate\'s hold tokens', async () => {
    expect(await localHoldTokensFor(root, [], undefined, HARNESSES)).toContain('action:deploy')
  })

  it('narrows folders and the developer\'s own flat files by the session selection, never a workspace SOP copy', async () => {
    await fs.mkdir(join(sops, 'frontend'), { recursive: true })
    await fs.writeFile(join(sops, 'frontend', 'ui.md'), '- Use the design tokens.\n')
    await fs.writeFile(join(sops, 'pulled.md'), '---\nintutic_id: sop_9\n---\nBody.\n')
    await fs.writeFile(join(root, '.intutic', 'session-context.json'), JSON.stringify({ activeLocalSops: ['frontend'] }))
    const entries = await loadLocalSopEntries(root, HARNESSES)
    expect(entries.map((e) => e.sopId)).toEqual(['local:pulled.md', 'local:frontend:ui.md'])
    await fs.writeFile(join(root, '.intutic', 'session-context.json'), JSON.stringify({ activeLocalSops: ['deploy.md'] }))
    expect((await loadLocalSopEntries(root, HARNESSES)).map((e) => e.sopId)).toEqual(['local:deploy.md', 'local:pulled.md'])
  })

  // `/intutic start` without `--sops` pushes an empty list, which the daemon
  // logs as "all"; it dropped every folder and flat file until 2026-10-19.
  it('keeps every rule set when the session selection is empty', async () => {
    await fs.writeFile(join(root, '.intutic', 'session-context.json'), JSON.stringify({ activeLocalSops: [] }))
    expect((await loadLocalSopEntries(root, HARNESSES)).map((e) => e.sopId)).toEqual(['local:deploy.md', 'local:safety:rules.md'])
  })

  // The selection is made from inside the agent's own chat
  // (`/intutic start --sops`), so it must not switch enforcement off: a
  // deselected SOP's review_before still holds.
  it('holds on a deselected SOP\'s review_before', async () => {
    await fs.writeFile(join(sops, 'safety', 'rules.md'), '---\nreview_before: action:db_write\n---\n')
    await fs.writeFile(join(root, '.intutic', 'session-context.json'), JSON.stringify({ activeLocalSops: ['frontend'] }))
    const holds = await localHoldTokensFor(root, [], undefined, HARNESSES)
    expect(holds).toEqual(expect.arrayContaining(['action:deploy', 'action:db_write']))
  })

  // `intutic sops pull` writes every SOP on the control plane, drafts and
  // invalidated ones included; it marks those `intutic_enforced: false`, and
  // a SOP the server does not enforce is not enforced here because it was pulled.
  it('enforces nothing from a pulled SOP the control plane does not enforce', async () => {
    await fs.writeFile(join(sops, 'draft.md'), '---\ntitle: Draft\nintutic_id: sop_d\nintutic_enforced: false\nreview_before: action:release\ndeny_tools: Write\n---\nDraft body.\n')
    expect((await loadLocalSopEntries(root, HARNESSES)).map((e) => e.sopId)).not.toContain('local:draft.md')
    expect(await localHoldTokensFor(root, [], undefined, HARNESSES)).not.toContain('action:release')
    const report = await collectAgentReport({ workspaceRoot: root, harnessType: 'claude-code', configSynced: true, dlpEnabled: false, policyEnforced: false })
    expect(report.facets.sops.find((s) => s.sop_id === 'draft')?.enforced).toBe(false)
    // Only `false` switches a file off; a typo leaves it enforced.
    await fs.writeFile(join(sops, 'draft.md'), '---\nintutic_id: sop_d\nintutic_enforced: flase\nreview_before: action:release\n---\n')
    expect(await localHoldTokensFor(root, [], undefined, HARNESSES)).toContain('action:release')
    // Only at the top level: a nested `intutic_enforced: false` belongs to some
    // other block and leaves the file enforced.
    await fs.writeFile(join(sops, 'draft.md'), '---\nintutic_id: sop_d\nmeta:\n  intutic_enforced: false\nreview_before: action:release\n---\n')
    expect(await localHoldTokensFor(root, [], undefined, HARNESSES)).toContain('action:release')
  })

  it('lists folders, then the developer\'s own flat files, as the selectable rule sets', async () => {
    await fs.writeFile(join(sops, 'guardrail-pgr_1.md'), '---\ndeny_tools: Bash\n---\n')
    await fs.writeFile(join(sops, 'pulled.md'), '---\nintutic_id: sop_9\n---\nBody.\n')
    await fs.writeFile(join(sops, 'a-own.md'), '- mine\n')
    expect(await listSopSets(sops)).toEqual(['safety', 'a-own.md', 'deploy.md'])
    expect(await listSopSets(join(root, 'nowhere'))).toEqual([])
  })

  it('skips guardrails pull files, which a connected machine gets from the control plane', async () => {
    await fs.writeFile(join(sops, 'guardrail-pgr_1.md'), '---\ndeny_tools: Bash\n---\n')
    const entries = await loadLocalSopEntries(root, HARNESSES)
    expect(entries.map((e) => e.sopId)).not.toContain('local:guardrail-pgr_1.md')
  })

  it('skips a pulled copy of a SOP already synced, so the rules file does not hold it twice', async () => {
    await fs.writeFile(join(sops, 'pulled.md'), '---\ntitle: Pulled\nintutic_id: sop_123\n---\nBody.\n')
    const all = await loadLocalSopEntries(root, HARNESSES)
    expect(all.map((e) => e.sopId)).toContain('local:pulled.md')
    const deduped = await loadLocalSopEntries(root, HARNESSES, { skipSopIds: new Set(['sop_123']) })
    expect(deduped.map((e) => e.sopId)).not.toContain('local:pulled.md')
  })

  it('reports an unreadable directory and stays quiet about a missing one', async () => {
    const errors: unknown[] = []
    const onError = (err: unknown) => errors.push(err)
    expect(await loadLocalSopEntries(join(root, 'nowhere'), HARNESSES, { onError })).toEqual([])
    expect(errors).toEqual([])
    await fs.rm(sops, { recursive: true })
    await fs.writeFile(sops, 'a file where the directory should be')
    expect(await loadLocalSopEntries(root, HARNESSES, { onError })).toEqual([])
    expect(errors).toHaveLength(1)
  })

  it('reports the folder SOPs in the agent facets, not only the flat ones', async () => {
    const report = await collectAgentReport({
      workspaceRoot: root,
      harnessType: 'claude-code',
      configSynced: true,
      dlpEnabled: false,
      policyEnforced: false,
    })
    expect(report.facets.sops).toEqual([
      { sop_id: 'deploy', name: 'deploy.md', enforced: false },
      { sop_id: 'safety/rules', name: 'safety/rules.md', enforced: true },
    ])
  })
})
