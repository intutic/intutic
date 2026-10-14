/**
 * `intutic init` prints each detected harness's config path. A relative
 * config file lives under the workspace; an absolute one (Claude Desktop's,
 * in the home directory) is printed as is, not appended to the workspace.
 */
import { describe, it, expect } from 'vitest'
import { isAbsolute, join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { HarnessType } from '@intutic/shared-types'
import { detectHarnesses, getAdapter } from './detector.js'

describe('detectHarnesses config paths', () => {
  it('keeps an absolute config path and puts a relative one under the workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'intutic-detector-'))
    try {
      const results = await detectHarnesses(root)
      const desktop = results.find((r) => r.type === HarnessType.CLAUDE_DESKTOP)!
      const desktopFile = getAdapter(HarnessType.CLAUDE_DESKTOP)!.configFileName
      expect(isAbsolute(desktopFile)).toBe(true)
      expect(desktop.configPath).toBe(desktopFile)

      const windsurf = results.find((r) => r.type === HarnessType.WINDSURF)!
      expect(windsurf.configPath).toBe(join(root, getAdapter(HarnessType.WINDSURF)!.configFileName))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
