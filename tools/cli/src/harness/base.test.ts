/**
 * The `sop://` pointer comments the docs promise in markdown rules files
 * ("SOP Pointer References"). The control plane sends one per SOP; only the
 * daemon's unused writer used to keep it.
 */
import { describe, it, expect } from 'vitest'
import type { HarnessType, SyncSopEntry } from '@intutic/shared-types'
import { buildMarkdownContent } from './base.js'

function sop(overrides: Partial<SyncSopEntry>): SyncSopEntry {
  return {
    sopId: 'sop_1',
    title: 'Rule One',
    content: 'First rule content.',
    contentHash: 'h1',
    harnessTargets: ['cursor' as HarnessType],
    ...overrides,
  }
}

describe('buildMarkdownContent', () => {
  it('ends each synced SOP with its sop:// pointer', () => {
    const content = buildMarkdownContent(
      [
        sop({ sopRef: '<!-- sop://intutic/sop_1 | Rule One -->' }),
        sop({ sopId: 'sop_2', title: 'Rule Two', content: 'Second rule content.', sopRef: '<!-- sop://intutic/sop_2 | Rule Two -->' }),
      ],
      'http://proxy:4000',
    )
    expect(content).toContain('## Rule One\n\nFirst rule content.\n<!-- sop://intutic/sop_1 | Rule One -->')
    expect(content).toContain('## Rule Two\n\nSecond rule content.\n<!-- sop://intutic/sop_2 | Rule Two -->')
  })

  it('writes no pointer for a SOP without one (local SOPs)', () => {
    const content = buildMarkdownContent([sop({ sopId: 'local:a:b.md' })], 'http://proxy:4000')
    expect(content).toContain('First rule content.')
    expect(content).not.toContain('sop://')
  })
})
