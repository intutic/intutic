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
  redactConfigText,
} from '../../src/configReader.js'
import type { HarnessType } from '@intutic/shared-types'

/** Content included, as with `configBodyUpload` on. */
const BODY = { includeContent: true }

function target(workspaceRoot: string, harnesses: string[], includeContent = false) {
  return {
    controlPlaneUrl: 'http://cp.test',
    apiKey: 'vk_test',
    workspaceId: 'wk_test',
    workspaceRoot,
    harnesses: harnesses as HarnessType[],
    includeContent,
  }
}

describe('Config Reader', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await node_fs.mkdtemp(node_path.join(node_os.tmpdir(), 'intutic-config-reader-'))
  })

  describe('readHarnessConfigs', () => {
    it('reads .goosehints file and returns correct hash', async () => {
      const content = '# Governance Rules\n\n## No Destructive Commands\nDo not run rm -rf'
      await node_fs.writeFile(node_path.join(tmpDir, '.goosehints'), content)

      const result = await readHarnessConfigs(tmpDir, ['goose'] as HarnessType[], BODY)

      expect(result).toHaveLength(1)
      expect(result[0].path).toBe('.goosehints')
      expect(result[0].content).toBe(content)
      expect(result[0].contentHash).toMatch(/^[a-f0-9]{64}$/) // SHA-256
    })

    it('reads AGENTS.md for the codex harness', async () => {
      const content = '# Claude Code Rules\nBe concise.'
      await node_fs.writeFile(node_path.join(tmpDir, 'AGENTS.md'), content)

      const result = await readHarnessConfigs(tmpDir, ['codex'] as HarnessType[], BODY)

      expect(result).toHaveLength(1)
      expect(result[0].path).toBe('AGENTS.md')
      expect(result[0].content).toBe(content)
    })

    it('skips harnesses whose config file does not exist', async () => {
      // Don't create any files
      const result = await readHarnessConfigs(tmpDir, ['goose', 'codex'] as HarnessType[], BODY)
      expect(result).toHaveLength(0)
    })

    it('reads multiple harness configs simultaneously', async () => {
      await node_fs.writeFile(node_path.join(tmpDir, '.goosehints'), 'goose hints')
      await node_fs.writeFile(node_path.join(tmpDir, 'AGENTS.md'), 'agents rules')

      const result = await readHarnessConfigs(tmpDir, ['goose', 'codex'] as HarnessType[], BODY)

      expect(result).toHaveLength(2)
      const paths = result.map(r => r.path)
      expect(paths).toContain('.goosehints')
      expect(paths).toContain('AGENTS.md')
    })

    it('produces different hashes for different content', async () => {
      await node_fs.writeFile(node_path.join(tmpDir, '.goosehints'), 'content A')
      const resultA = await readHarnessConfigs(tmpDir, ['goose'] as HarnessType[], BODY)

      await node_fs.writeFile(node_path.join(tmpDir, '.goosehints'), 'content B')
      const resultB = await readHarnessConfigs(tmpDir, ['goose'] as HarnessType[], BODY)

      expect(resultA[0].contentHash).not.toBe(resultB[0].contentHash)
    })

    it('returns same hash for identical content', async () => {
      await node_fs.writeFile(node_path.join(tmpDir, '.goosehints'), 'identical')
      const resultA = await readHarnessConfigs(tmpDir, ['goose'] as HarnessType[], BODY)

      // Re-read same content
      const resultB = await readHarnessConfigs(tmpDir, ['goose'] as HarnessType[], BODY)

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
      await node_fs.mkdir(node_path.join(tmpDir2, '.intutic'), { recursive: true })
      await node_fs.writeFile(node_path.join(tmpDir2, '.intutic', 'aider-sops.md'), 'v1 rules', 'utf-8')
      const { calls } = stubFetchCapturingCalls()

      await captureAndUpload({
        ...target(tmpDir2, ['aider']),
        governanceInputs: { aider: { mcpProxyActive: true, nativeHookActive: true, llmProxyActive: false, hasRulesFile: true } },
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
      await node_fs.writeFile(node_path.join(tmpDir2, '.goosehints'), 'unchanged content', 'utf-8')
      const { calls } = stubFetchCapturingCalls()

      await captureAndUpload(target(tmpDir2, ['goose']))
      expect(calls.filter((c) => c.url.includes('/governance-coverage/snapshot'))).toHaveLength(1)

      calls.length = 0
      // Second cycle, same content on disk — uploadConfigCapture's
      // content-hash dedup must skip both the config-capture upload AND the
      // governance-coverage snapshot this test exists to pin.
      await captureAndUpload(target(tmpDir2, ['goose']))
      expect(calls.filter((c) => c.url.includes('/config/capture'))).toHaveLength(0)
      expect(calls.filter((c) => c.url.includes('/governance-coverage/snapshot'))).toHaveLength(0)
    })

    it('falls back to hasRulesFile:true and everything else false when no governance inputs are passed', async () => {
      await node_fs.writeFile(node_path.join(tmpDir2, 'AGENTS.md'), 'rules', 'utf-8')
      const { calls } = stubFetchCapturingCalls()

      await captureAndUpload(target(tmpDir2, ['hermes']))

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

  describe('content upload (configBodyUpload)', () => {
    let root: string
    // Assembled at runtime: no contiguous credential-shaped literal in source.
    const anthropicKey = ['sk-ant-', 'api03-', 'A'.repeat(32)].join('')
    const virtualKey = ['vk_', 'a1'.repeat(16)].join('')

    beforeEach(async () => {
      root = await node_fs.mkdtemp(node_path.join(node_os.tmpdir(), 'intutic-capture-body-'))
    })
    afterEach(async () => {
      vi.unstubAllGlobals()
      await node_fs.rm(root, { recursive: true, force: true })
    })

    function stubFetch(): Array<{ url: string; body: any }> {
      const calls: Array<{ url: string; body: any }> = []
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), body: init?.body ? JSON.parse(init.body as string) : null })
        return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' } as Response
      }) as unknown as typeof fetch)
      return calls
    }
    const captures = (calls: Array<{ url: string; body: any }>) => calls.filter((c) => c.url.endsWith('/api/v1/config/capture'))

    it('off: sends path, hash, size and harness, and no content', async () => {
      const text = `# Rules\nKey: ${anthropicKey}\n`
      await node_fs.writeFile(node_path.join(root, 'AGENTS.md'), text)
      const calls = stubFetch()

      await captureAndUpload(target(root, ['opencode'], false))

      const [capture] = captures(calls)
      expect(capture.body.harnessType).toBe('opencode')
      expect(capture.body.files).toEqual([
        { path: 'AGENTS.md', contentHash: expect.stringMatching(/^[0-9a-f]{64}$/), sizeBytes: Buffer.byteLength(text) },
      ])
      expect(JSON.stringify(calls)).not.toContain('# Rules')
    })

    it('on: sends the content with credential-shaped strings redacted', async () => {
      await node_fs.writeFile(
        node_path.join(root, '.goosehints'),
        `# Rules\nUse ${anthropicKey} for tests.\nINTUTIC_KEY=${virtualKey}\nKeep this line.\n`,
      )
      const calls = stubFetch()

      await captureAndUpload(target(root, ['goose'], true))

      const [file] = captures(calls)[0].body.files
      expect(file.content).toContain('Keep this line.')
      expect(file.content).toContain('[redacted]')
      const sent = JSON.stringify(calls)
      expect(sent).not.toContain(anthropicKey)
      expect(sent).not.toContain(virtualKey)
      // The hash is of what was sent, so the server's own hash agrees.
      const { createHash } = await import('node:crypto')
      expect(file.contentHash).toBe(createHash('sha256').update(file.content).digest('hex'))
    })

    it('turning it on uploads the content at the next capture, not the next edit', async () => {
      await node_fs.writeFile(node_path.join(root, '.goosehints'), 'unchanged rules\n')
      const calls = stubFetch()

      await captureAndUpload(target(root, ['goose'], false))
      await captureAndUpload(target(root, ['goose'], false))
      await captureAndUpload(target(root, ['goose'], true))
      await captureAndUpload(target(root, ['goose'], true))

      const sent = captures(calls).map((c) => c.body.files[0])
      expect(sent).toHaveLength(2)
      expect(sent[0].content).toBeUndefined()
      expect(sent[1].content).toBe('unchanged rules\n')
      expect(sent[1].contentHash).toBe(sent[0].contentHash)
    })

    it('redactConfigText removes every shape the secret patterns name', () => {
      const out = redactConfigText(`a ${anthropicKey} b ${virtualKey} c`)
      expect(out).toBe('a [redacted] b [redacted] c')
    })
  })

  // One list of what is captured: HARNESS_FILES. The CLI reference lists the
  // same files, so a harness added there without the docs fails here.
  it('the CLI reference lists exactly the files HARNESS_FILES captures', async () => {
    const { HARNESS_FILES } = await import('../../src/configWriter.js')
    const doc = await node_fs.readFile(node_path.join(__dirname, '../../../../apps/docs/reference/cli.md'), 'utf-8')
    const section = doc.slice(doc.indexOf('### Config content upload'))
    const table = section.slice(section.indexOf('| File | Harnesses |'), section.indexOf('\n---'))
    const listed = new Map<string, string[]>()
    for (const m of table.matchAll(/^\| `([^`]+)` \| (.+) \|$/gm)) {
      listed.set(m[1]!, [...m[2]!.matchAll(/`([^`]+)`/g)].map((h) => h[1]!).sort())
    }
    const captured = new Map<string, string[]>()
    for (const [harness, file] of Object.entries(HARNESS_FILES)) {
      if (file) captured.set(file, [...(captured.get(file) ?? []), harness].sort())
    }
    expect(Object.fromEntries(listed)).toEqual(Object.fromEntries(captured))
  })
})
