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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as node_fs from 'node:fs/promises'
import * as node_path from 'node:path'
import * as node_os from 'node:os'
import {
  readHarnessConfigs,
  shouldCaptureThisIteration,
  captureAndUpload,
  reportGovernanceCoverageSnapshot,
} from '../../src/configReader.js'
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

  describe('reportGovernanceCoverageSnapshot', () => {
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('POSTs the four enforcement inputs to /governance-coverage/snapshot', async () => {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        status: 201,
        json: async () => ({ ok: true }),
        text: async () => '',
      }))
      vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

      await reportGovernanceCoverageSnapshot(
        'http://cp.test',
        'vk_test',
        'wk_test',
        'claude-code' as HarnessType,
        { mcpProxyActive: true, nativeHookActive: false, llmProxyActive: true, hasRulesFile: true },
      )

      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; headers: Record<string, string>; body: string }]
      expect(url).toBe('http://cp.test/api/v1/governance-coverage/snapshot')
      expect(init.method).toBe('POST')
      expect(init.headers.authorization).toBe('Bearer vk_test')
      expect(JSON.parse(init.body as string)).toEqual({
        workspaceId: 'wk_test',
        harnessType: 'claude-code',
        mcpProxyActive: true,
        nativeHookActive: false,
        llmProxyActive: true,
        hasRulesFile: true,
      })
    })

    it('does not throw when the control plane rejects the snapshot', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: false,
          status: 500,
          text: async () => 'internal error',
        })) as unknown as typeof fetch,
      )

      await expect(
        reportGovernanceCoverageSnapshot('http://cp.test', 'vk_test', 'wk_test', 'cursor' as HarnessType, {
          mcpProxyActive: false,
          nativeHookActive: false,
          llmProxyActive: false,
          hasRulesFile: true,
        }),
      ).resolves.toBeUndefined()
    })

    it('does not throw on a network error', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch)

      await expect(
        reportGovernanceCoverageSnapshot('http://cp.test', 'vk_test', 'wk_test', 'windsurf' as HarnessType, {
          mcpProxyActive: false,
          nativeHookActive: false,
          llmProxyActive: false,
          hasRulesFile: true,
        }),
      ).resolves.toBeUndefined()
    })
  })

  describe('captureAndUpload — governance-coverage snapshot firing', () => {
    let tmpDir2: string

    beforeEach(async () => {
      tmpDir2 = await node_fs.mkdtemp(node_path.join(node_os.tmpdir(), 'intutic-capture-upload-'))
    })
    afterEach(async () => {
      vi.unstubAllGlobals()
      await node_fs.rm(tmpDir2, { recursive: true, force: true })
    })

    /** Every request this test's fetch stub has seen, in order. */
    function stubFetchCapturingCalls(): { calls: Array<{ url: string; body: unknown }> } {
      const state = { calls: [] as Array<{ url: string; body: unknown }> }
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input)
          state.calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : null })
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true }),
            text: async () => '',
          } as Response
        }) as unknown as typeof fetch,
      )
      return state
    }

    it('fires one governance-coverage snapshot for a harness whose rules file changed, using the passed-in inputs', async () => {
      // Distinct harness (not used by any other test in this file) so the
      // module-level content-hash cache in configReader.ts cannot leak state
      // in from an earlier test.
      await node_fs.writeFile(node_path.join(tmpDir2, '.aider.conf.yml'), 'v1 rules', 'utf-8')
      const { calls } = stubFetchCapturingCalls()

      await captureAndUpload('http://cp.test', 'vk_test', 'wk_test', tmpDir2, ['aider'] as HarnessType[], {
        aider: { mcpProxyActive: true, nativeHookActive: true, llmProxyActive: false, hasRulesFile: true },
      })

      const captureCalls = calls.filter((c) => c.url.includes('/config/capture'))
      const snapshotCalls = calls.filter((c) => c.url.includes('/governance-coverage/snapshot'))
      expect(captureCalls).toHaveLength(1)
      expect(snapshotCalls).toHaveLength(1)
      expect(snapshotCalls[0].body).toMatchObject({
        harnessType: 'aider',
        mcpProxyActive: true,
        nativeHookActive: true,
        llmProxyActive: false,
        hasRulesFile: true,
      })
    })

    it('does not fire a second snapshot on a later cycle when the file content is unchanged', async () => {
      await node_fs.writeFile(node_path.join(tmpDir2, '.roorules'), 'unchanged content', 'utf-8')
      const { calls } = stubFetchCapturingCalls()

      await captureAndUpload('http://cp.test', 'vk_test', 'wk_test', tmpDir2, ['roo-code'] as HarnessType[])
      expect(calls.filter((c) => c.url.includes('/governance-coverage/snapshot'))).toHaveLength(1)

      calls.length = 0
      // Second cycle, same content on disk — uploadConfigCapture's
      // content-hash dedup must skip both the config-capture upload AND the
      // governance-coverage snapshot this test exists to pin.
      await captureAndUpload('http://cp.test', 'vk_test', 'wk_test', tmpDir2, ['roo-code'] as HarnessType[])
      expect(calls.filter((c) => c.url.includes('/config/capture'))).toHaveLength(0)
      expect(calls.filter((c) => c.url.includes('/governance-coverage/snapshot'))).toHaveLength(0)
    })

    it('falls back to hasRulesFile:true and everything else false when no governance inputs are passed', async () => {
      await node_fs.mkdir(node_path.join(tmpDir2, '.hermes'), { recursive: true })
      await node_fs.writeFile(node_path.join(tmpDir2, '.hermes', 'config.yaml'), 'rules', 'utf-8')
      const { calls } = stubFetchCapturingCalls()

      await captureAndUpload('http://cp.test', 'vk_test', 'wk_test', tmpDir2, ['hermes'] as HarnessType[])

      const snapshotCalls = calls.filter((c) => c.url.includes('/governance-coverage/snapshot'))
      expect(snapshotCalls).toHaveLength(1)
      expect(snapshotCalls[0].body).toMatchObject({
        harnessType: 'hermes',
        mcpProxyActive: false,
        nativeHookActive: false,
        llmProxyActive: false,
        hasRulesFile: true,
      })
    })
  })
})
