import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { museAdapter } from './muse.js'
import { ALL_ADAPTERS } from './detector.js'
import { HARNESS_CONFIG_FILES } from './types.js'

const PROXY_URL = 'http://127.0.0.1:4000/v1'

describe('muse adapter', () => {
  let root: string
  let home: string
  const prevHome = process.env.HOME
  const prevUserProfile = process.env.USERPROFILE

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'intutic-muse-'))
    // museAdapter.writeConfig delegates hook installation to
    // @intutic/sync-daemon's writeMuseHooks, which writes under
    // os.homedir()/.config/muse/ — isolate that to a temp HOME so tests
    // never touch the real machine's config.
    home = await mkdtemp(join(tmpdir(), 'intutic-muse-home-'))
    process.env.HOME = home
    process.env.USERPROFILE = home
  })

  afterEach(async () => {
    process.env.HOME = prevHome
    process.env.USERPROFILE = prevUserProfile
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  })

  describe('detect', () => {
    it('is not detected in an empty workspace (absent .muse dir, absent user settings, absent binary)', async () => {
      // Only reliable in an environment where `muse` genuinely is not on
      // PATH and no prior `~/.config/muse/settings.json` exists — true for
      // this sandbox, since Muse Code is an unreleased beta product.
      expect(await museAdapter.detect(root)).toBe(false)
    })

    it('detects a project-local .muse/ directory', async () => {
      await mkdir(join(root, '.muse'), { recursive: true })
      expect(await museAdapter.detect(root)).toBe(true)
    })
  })

  describe('writeConfig', () => {
    it('writes AGENTS.md from the shared markdown content builder', async () => {
      const sops = [{ id: 'sop_1', title: 'No secrets in code', content: 'Never commit API keys.' }] as never
      const written = await museAdapter.writeConfig(root, sops, PROXY_URL)
      expect(written).toBe(join(root, 'AGENTS.md'))

      const content = await readFile(join(root, 'AGENTS.md'), 'utf-8')
      expect(content).toContain('No secrets in code')
      expect(content).toContain(PROXY_URL)
    })

    it('skips writing AGENTS.md when there are no SOPs, matching every other markdown adapter', async () => {
      await museAdapter.writeConfig(root, [], PROXY_URL)
      await expect(readFile(join(root, 'AGENTS.md'), 'utf-8')).rejects.toThrow()
    })

    it('installs the PreToolUse/PermissionRequest hooks even with zero SOPs — hooks are the governance vehicle, not the rules file', async () => {
      await museAdapter.writeConfig(root, [], PROXY_URL)
      const hooksJson = await readFile(join(root, '.muse', 'hooks.json'), 'utf-8')
      expect(hooksJson).toContain('PreToolUse')
      expect(hooksJson).toContain('PermissionRequest')
    })
  })

  describe('readCurrentHash', () => {
    it('returns null before a write and a hash after', async () => {
      expect(await museAdapter.readCurrentHash(root)).toBeNull()
      const sops = [{ id: 'sop_1', title: 'x', content: 'y' }] as never
      await museAdapter.writeConfig(root, sops, PROXY_URL)
      expect(await museAdapter.readCurrentHash(root)).toMatch(/^[0-9a-f]{64}$/)
    })
  })

  describe('registration', () => {
    it('is registered in ALL_ADAPTERS', () => {
      expect(ALL_ADAPTERS.some((a) => a.type === 'muse-code')).toBe(true)
    })

    it('is registered in HARNESS_CONFIG_FILES with its config file', () => {
      expect(HARNESS_CONFIG_FILES['muse-code']).toBe('AGENTS.md')
    })
  })
})
