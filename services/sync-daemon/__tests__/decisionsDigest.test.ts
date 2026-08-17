/**
 * Governed decisions log (Phase 6) — the sync-daemon side of the
 * fetch-and-write cycle. Three things this file has to prove:
 *
 * 1. Rendering is a pure function of the digest — the header carries no
 *    wall-clock timestamp, so an unchanged digest renders a byte-identical
 *    file across two cycles.
 * 2. Bounded-section injection is idempotent — installing it twice never
 *    duplicates the marker block, and re-injecting with an unchanged digest
 *    leaves the file byte-identical.
 * 3. `refreshDecisionsDigest` end to end (mocked `fetch`) writes both files
 *    and, run twice with the same server response, produces byte-identical
 *    output on disk both times.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { HarnessType } from '@intutic/shared-types'
import {
  renderDecisionsMarkdown,
  renderBoundedSection,
  injectBoundedSection,
  refreshDecisionsDigest,
  DECISIONS_LOG_RELATIVE_PATH,
  type DecisionsDigestEntry,
} from '../src/lib/decisionsDigest.js'
import { HARNESS_FILES } from '../src/configWriter.js'

const ENTRIES: DecisionsDigestEntry[] = [
  { id: 'decision:1', kind: 'decision', timestamp: '2026-08-17T10:00:00.000Z', summary: 'Decision: rollout approved → approved' },
  { id: 'incident:1', kind: 'incident', timestamp: '2026-08-16T09:00:00.000Z', summary: 'Incident resolved: SCOPE_VIOLATION (HIGH) — RESOLVED' },
]

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('renderDecisionsMarkdown', () => {
  it('is deterministic — identical input renders an identical file across two calls', () => {
    const first = renderDecisionsMarkdown(ENTRIES)
    const second = renderDecisionsMarkdown(ENTRIES)
    expect(first).toBe(second)
    expect(first).toContain('DO NOT EDIT')
    expect(first).toContain('Decision: rollout approved')
  })

  it('renders a placeholder, not an empty body, for zero entries', () => {
    expect(renderDecisionsMarkdown([])).toContain('No governance decisions recorded yet')
  })
})

describe('injectBoundedSection', () => {
  it('appends the section once when no markers are present', () => {
    const section = renderBoundedSection(ENTRIES)
    const result = injectBoundedSection('# CLAUDE.md\n\nSome SOP content\n', section)
    expect(result).toContain('INTUTIC:DECISIONS_LOG:START')
    expect(result).toContain('INTUTIC:DECISIONS_LOG:END')
    expect(result.split('INTUTIC:DECISIONS_LOG:START').length - 1).toBe(1)
  })

  it('replaces in place on re-injection — never duplicates the marker block', () => {
    const section1 = renderBoundedSection(ENTRIES)
    const once = injectBoundedSection('# CLAUDE.md\n\nSOP content\n', section1)

    const newerEntries: DecisionsDigestEntry[] = [
      { id: 'decision:2', kind: 'decision', timestamp: '2026-08-18T00:00:00.000Z', summary: 'Decision: new rule → approved' },
      ...ENTRIES,
    ]
    const section2 = renderBoundedSection(newerEntries)
    const twice = injectBoundedSection(once, section2)

    expect(twice.split('INTUTIC:DECISIONS_LOG:START').length - 1).toBe(1)
    expect(twice).toContain('new rule')
    expect(twice).toContain('SOP content')
  })

  it('re-injecting an UNCHANGED section produces a byte-identical file', () => {
    const section = renderBoundedSection(ENTRIES)
    const once = injectBoundedSection('# CLAUDE.md\n\nSOP content\n', section)
    const twice = injectBoundedSection(once, section)
    expect(twice).toBe(once)
  })
})

describe('refreshDecisionsDigest', () => {
  async function mkWorkspace(): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), 'decisions-digest-'))
  }

  function stubDigestFetch(entries: DecisionsDigestEntry[]) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ workspaceId: 'wk_test', entries }),
      })) as unknown as typeof fetch,
    )
  }

  it('writes .intutic/DECISIONS.md', async () => {
    const dir = await mkWorkspace()
    stubDigestFetch(ENTRIES)

    const result = await refreshDecisionsDigest({
      controlPlaneUrl: 'http://cp.test',
      apiKey: 'vk_test',
      workspaceId: 'wk_test',
      workspaceRoot: dir,
      harnesses: [],
    })
    expect(result?.entriesWritten).toBe(2)

    const content = await fs.readFile(path.join(dir, DECISIONS_LOG_RELATIVE_PATH), 'utf-8')
    expect(content).toContain('rollout approved')

    await fs.rm(dir, { recursive: true, force: true })
  })

  it('injects the bounded section into CLAUDE.md only when claude-code is an active harness', async () => {
    const dir = await mkWorkspace()
    const claudeMdPath = path.join(dir, HARNESS_FILES[HarnessType.CLAUDE_CODE])
    await fs.mkdir(path.dirname(claudeMdPath), { recursive: true })
    await fs.writeFile(claudeMdPath, '# CLAUDE.md\n\nExisting SOP content\n', 'utf-8')

    stubDigestFetch(ENTRIES)
    await refreshDecisionsDigest({
      controlPlaneUrl: 'http://cp.test',
      apiKey: 'vk_test',
      workspaceId: 'wk_test',
      workspaceRoot: dir,
      harnesses: [HarnessType.CLAUDE_CODE],
    })

    const content = await fs.readFile(claudeMdPath, 'utf-8')
    expect(content).toContain('Existing SOP content')
    expect(content).toContain('INTUTIC:DECISIONS_LOG:START')
    expect(content).toContain('rollout approved')

    await fs.rm(dir, { recursive: true, force: true })
  })

  it('does NOT touch CLAUDE.md when claude-code is not an active harness this cycle', async () => {
    const dir = await mkWorkspace()
    const claudeMdPath = path.join(dir, HARNESS_FILES[HarnessType.CLAUDE_CODE])
    await fs.mkdir(path.dirname(claudeMdPath), { recursive: true })
    const original = '# CLAUDE.md\n\nExisting SOP content\n'
    await fs.writeFile(claudeMdPath, original, 'utf-8')

    stubDigestFetch(ENTRIES)
    await refreshDecisionsDigest({
      controlPlaneUrl: 'http://cp.test',
      apiKey: 'vk_test',
      workspaceId: 'wk_test',
      workspaceRoot: dir,
      harnesses: [HarnessType.CURSOR],
    })

    expect(await fs.readFile(claudeMdPath, 'utf-8')).toBe(original)
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('render idempotence: running the fetch-and-write cycle twice with the same digest produces a byte-identical DECISIONS.md and CLAUDE.md', async () => {
    const dir = await mkWorkspace()
    const claudeMdPath = path.join(dir, HARNESS_FILES[HarnessType.CLAUDE_CODE])
    await fs.mkdir(path.dirname(claudeMdPath), { recursive: true })
    await fs.writeFile(claudeMdPath, '# CLAUDE.md\n\nExisting SOP content\n', 'utf-8')

    stubDigestFetch(ENTRIES)
    const opts = {
      controlPlaneUrl: 'http://cp.test',
      apiKey: 'vk_test',
      workspaceId: 'wk_test',
      workspaceRoot: dir,
      harnesses: [HarnessType.CLAUDE_CODE],
    }

    await refreshDecisionsDigest(opts)
    const decisionsAfterFirst = await fs.readFile(path.join(dir, DECISIONS_LOG_RELATIVE_PATH), 'utf-8')
    const claudeMdAfterFirst = await fs.readFile(claudeMdPath, 'utf-8')

    // Second cycle — same server response, same digest.
    stubDigestFetch(ENTRIES)
    await refreshDecisionsDigest(opts)
    const decisionsAfterSecond = await fs.readFile(path.join(dir, DECISIONS_LOG_RELATIVE_PATH), 'utf-8')
    const claudeMdAfterSecond = await fs.readFile(claudeMdPath, 'utf-8')

    expect(decisionsAfterSecond).toBe(decisionsAfterFirst)
    expect(claudeMdAfterSecond).toBe(claudeMdAfterFirst)

    await fs.rm(dir, { recursive: true, force: true })
  })

  it('returns null and writes nothing when the control plane is unreachable', async () => {
    const dir = await mkWorkspace()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch)

    const result = await refreshDecisionsDigest({
      controlPlaneUrl: 'http://cp.test',
      apiKey: 'vk_test',
      workspaceId: 'wk_test',
      workspaceRoot: dir,
      harnesses: [],
    })
    expect(result).toBeNull()
    await expect(fs.readFile(path.join(dir, DECISIONS_LOG_RELATIVE_PATH), 'utf-8')).rejects.toThrow()

    await fs.rm(dir, { recursive: true, force: true })
  })
})
