/**
 * configReader.test.ts — Unit tests for daemon-side config reader.
 *
 * Tests hash computation, file discovery, and capture throttling.
 * Uses temp filesystem — no network I/O.
 *
 * LLD #51 — Phase A Verification
 *
 * @module
 */

import { describe, it, expect, beforeEach } from 'vitest'
import * as node_fs from 'node:fs/promises'
import * as node_path from 'node:path'
import * as node_os from 'node:os'
import { readHarnessConfigs, shouldCaptureThisIteration } from '../../src/configReader.js'
import type { HarnessType } from '@intutic/shared-types'

describe('Config Reader', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await node_fs.mkdtemp(node_path.join(node_os.tmpdir(), 'intutic-config-reader-'))
  })

  describe('readHarnessConfigs', () => {
    it('reads .cursorrules file and returns correct hash', async () => {
      const content = '# Governance Rules\n\n## No Destructive Commands\nDo not run rm -rf'
      await node_fs.writeFile(node_path.join(tmpDir, '.cursorrules'), content)

      const result = await readHarnessConfigs(tmpDir, ['cursor'] as HarnessType[])

      expect(result).toHaveLength(1)
      expect(result[0].path).toBe('.cursorrules')
      expect(result[0].content).toBe(content)
      expect(result[0].contentHash).toMatch(/^[a-f0-9]{64}$/) // SHA-256
    })

    it('reads CLAUDE.md for claude-code harness', async () => {
      const content = '# Claude Code Rules\nBe concise.'
      await node_fs.writeFile(node_path.join(tmpDir, 'CLAUDE.md'), content)

      const result = await readHarnessConfigs(tmpDir, ['claude-code'] as HarnessType[])

      expect(result).toHaveLength(1)
      expect(result[0].path).toBe('CLAUDE.md')
      expect(result[0].content).toBe(content)
    })

    it('skips harnesses whose config file does not exist', async () => {
      // Don't create any files
      const result = await readHarnessConfigs(tmpDir, ['cursor', 'claude-code'] as HarnessType[])
      expect(result).toHaveLength(0)
    })

    it('reads multiple harness configs simultaneously', async () => {
      await node_fs.writeFile(node_path.join(tmpDir, '.cursorrules'), 'cursor rules')
      await node_fs.writeFile(node_path.join(tmpDir, 'CLAUDE.md'), 'claude rules')

      const result = await readHarnessConfigs(tmpDir, ['cursor', 'claude-code'] as HarnessType[])

      expect(result).toHaveLength(2)
      const paths = result.map(r => r.path)
      expect(paths).toContain('.cursorrules')
      expect(paths).toContain('CLAUDE.md')
    })

    it('produces different hashes for different content', async () => {
      await node_fs.writeFile(node_path.join(tmpDir, '.cursorrules'), 'content A')
      const resultA = await readHarnessConfigs(tmpDir, ['cursor'] as HarnessType[])

      await node_fs.writeFile(node_path.join(tmpDir, '.cursorrules'), 'content B')
      const resultB = await readHarnessConfigs(tmpDir, ['cursor'] as HarnessType[])

      expect(resultA[0].contentHash).not.toBe(resultB[0].contentHash)
    })

    it('returns same hash for identical content', async () => {
      await node_fs.writeFile(node_path.join(tmpDir, '.cursorrules'), 'identical')
      const resultA = await readHarnessConfigs(tmpDir, ['cursor'] as HarnessType[])

      // Re-read same content
      const resultB = await readHarnessConfigs(tmpDir, ['cursor'] as HarnessType[])

      expect(resultA[0].contentHash).toBe(resultB[0].contentHash)
    })
  })

  describe('shouldCaptureThisIteration', () => {
    it('returns true on the 5th iteration (default interval)', () => {
      expect(shouldCaptureThisIteration(5)).toBe(true)
      expect(shouldCaptureThisIteration(10)).toBe(true)
      expect(shouldCaptureThisIteration(15)).toBe(true)
    })

    it('returns false on non-5th iterations', () => {
      expect(shouldCaptureThisIteration(1)).toBe(false)
      expect(shouldCaptureThisIteration(3)).toBe(false)
      expect(shouldCaptureThisIteration(7)).toBe(false)
    })

    it('returns false on iteration 0', () => {
      // First iteration should not capture — wait for interval
      expect(shouldCaptureThisIteration(0)).toBe(false)
    })
  })
})
