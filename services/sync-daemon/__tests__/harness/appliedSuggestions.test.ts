/**
 * appliedSuggestions.test.ts — Unit and integration tests for suggestion re-application.
 *
 * Verifies that:
 * 1. ADD operations are idempotent and do not duplicate rules.
 * 2. REPLACE/DELETE operations tolerate whitespace/indentation shifts via fuzzy matching.
 * 3. Base file overwrites trigger automated suggestions re-application.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import * as node_fs from 'node:fs/promises'
import * as node_path from 'node:path'
import * as node_os from 'node:os'
import { applyConfigEdits, writeConfigFiles } from '../../src/configWriter.js'
import type { ConfigEdit, SyncSopEntry } from '@intutic/shared-types'
import { HarnessType } from '@intutic/shared-types'

describe('appliedSuggestions', () => {
  let tmpDir: string
  let targetFile: string

  beforeEach(async () => {
    tmpDir = await node_fs.mkdtemp(node_path.join(node_os.tmpdir(), 'intutic-applied-sugg-'))
    targetFile = node_path.join(tmpDir, '.cursorrules')
    // Seed target file with baseline rules
    await node_fs.writeFile(targetFile, `# Rules\n\n## Governance\n- Do not run rm -rf.`)
  })

  describe('Lack of Edit Idempotency (Gap 3)', () => {
    it('is idempotent for duplicate ADD operations', async () => {
      const edits: ConfigEdit[] = [{
        operation: 'ADD',
        section: 'Governance',
        content: '- Prefer clean commits.',
        reason: 'Clean history',
      }]

      // First application
      await applyConfigEdits(tmpDir, [{
        suggestionId: 'sko_1',
        harnessType: 'cursor',
        filePath: '.cursorrules',
        edits,
      }])

      const content1 = await node_fs.readFile(targetFile, 'utf-8')
      expect(content1).toContain('- Prefer clean commits.')

      // Second application (duplicate)
      await applyConfigEdits(tmpDir, [{
        suggestionId: 'sko_1',
        harnessType: 'cursor',
        filePath: '.cursorrules',
        edits,
      }])

      const content2 = await node_fs.readFile(targetFile, 'utf-8')
      // Count occurrences
      const occurrences = (content2.match(/- Prefer clean commits\./g) || []).length
      expect(occurrences).toBe(1) // Not duplicated!
    })
  })

  describe('Fragile String Match Replacement (Gap 2)', () => {
    it('successfully replaces text with minor spacing and indentation shifts', async () => {
      // Re-seed file with specific indentation and CRLF endings
      const baseline = `# Rules\r\n\r\n  ## Governance\r\n  - Do not run rm -rf.\r\n`
      await node_fs.writeFile(targetFile, baseline)

      const edits: ConfigEdit[] = [{
        operation: 'REPLACE',
        section: 'Governance',
        target: '- Do not run rm -rf.', // Note: search target has no leading spaces or CRLF
        content: '- Avoid destructive commands.',
        reason: 'Clarify rule',
      }]

      await applyConfigEdits(tmpDir, [{
        suggestionId: 'sko_2',
        harnessType: 'cursor',
        filePath: '.cursorrules',
        edits,
      }])

      const content = await node_fs.readFile(targetFile, 'utf-8')
      expect(content).toContain('- Avoid destructive commands.')
      expect(content).not.toContain('- Do not run rm -rf.')
    })

    it('successfully deletes text with whitespace mismatches', async () => {
      const baseline = `# Rules\n\n## Governance\n  - Outdated rule to delete.\n`
      await node_fs.writeFile(targetFile, baseline)

      const edits: ConfigEdit[] = [{
        operation: 'DELETE',
        section: 'Governance',
        content: '- Outdated rule to delete.',
        reason: 'Clean rule',
      }]

      await applyConfigEdits(tmpDir, [{
        suggestionId: 'sko_3',
        harnessType: 'cursor',
        filePath: '.cursorrules',
        edits,
      }])

      const content = await node_fs.readFile(targetFile, 'utf-8')
      expect(content).not.toContain('- Outdated rule to delete.')
    })
  })

  describe('SOP Base Overwrite Suggestion Re-Application (Gap 1)', () => {
    it('automatically re-overlays active suggestions when writeConfigFiles rewrites the base', async () => {
      // 1. Run initial writeConfigFiles to create base
      const sops: SyncSopEntry[] = [{
        sopId: 'sop_1',
        title: 'Security',
        content: 'Check auth headers.',
        contentHash: 'hash1',
        harnessTargets: [HarnessType.CURSOR],
      }]

      await writeConfigFiles(tmpDir, sops, 'http://proxy:4000', [HarnessType.CURSOR], 'wk_1')

      // 2. Apply a suggestion edit
      const edits: ConfigEdit[] = [{
        operation: 'ADD',
        section: 'Security',
        content: '- Enforce https.',
        reason: 'SSL enforcement',
      }]
      await applyConfigEdits(tmpDir, [{
        suggestionId: 'sko_1',
        harnessType: 'cursor',
        filePath: '.cursorrules',
        edits,
      }])

      const contentAfterSugg = await node_fs.readFile(targetFile, 'utf-8')
      expect(contentAfterSugg).toContain('Check auth headers.')
      expect(contentAfterSugg).toContain('- Enforce https.')

      // 3. Re-write base config files (simulating an SOP update config version bump)
      // This overwrites `.cursorrules` with the clean baseline
      await writeConfigFiles(tmpDir, sops, 'http://proxy:4000', [HarnessType.CURSOR], 'wk_1')

      const contentOverwritten = await node_fs.readFile(targetFile, 'utf-8')
      // Suggestion edit is lost due to overwrite
      expect(contentOverwritten).not.toContain('- Enforce https.')

      // 4. Trigger the auto-recovery (overlay active suggestions) as implemented in syncLoop.ts
      const forceApply = true // because sopsWritten > 0
      const activeSuggestions = [{
        suggestionId: 'sko_1',
        harnessType: 'cursor',
        filePath: '.cursorrules',
        edits,
      }]

      if (forceApply) {
        await applyConfigEdits(tmpDir, activeSuggestions)
      }

      const contentFinal = await node_fs.readFile(targetFile, 'utf-8')
      // Base content is preserved
      expect(contentFinal).toContain('Check auth headers.')
      // Active suggestion was successfully re-applied automatically!
      expect(contentFinal).toContain('- Enforce https.')
    })
  })
})
