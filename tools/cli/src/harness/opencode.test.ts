import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { opencodeAdapter } from './opencode.js'
import { ALL_ADAPTERS } from './detector.js'
import { HARNESS_CONFIG_FILES } from './types.js'

const PROXY_URL = 'http://127.0.0.1:4000/v1'

describe('opencode adapter', () => {
  let root: string
  let home: string
  const prevHome = process.env.HOME
  const prevUserProfile = process.env.USERPROFILE
  const prevConfigDir = process.env.OPENCODE_CONFIG_DIR
  const prevPath = process.env.PATH

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'intutic-opencode-'))
    home = await mkdtemp(join(tmpdir(), 'intutic-opencode-home-'))
    process.env.HOME = home
    process.env.USERPROFILE = home
    // Detection reads the user-level config dir and PATH; point both at
    // places this test controls so a real OpenCode install on the machine
    // cannot make the negative case pass or fail for the wrong reason.
    process.env.OPENCODE_CONFIG_DIR = join(home, 'no-such-config')
    process.env.PATH = join(home, 'empty-bin')
  })

  afterEach(async () => {
    process.env.HOME = prevHome
    process.env.USERPROFILE = prevUserProfile
    if (prevConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = prevConfigDir
    process.env.PATH = prevPath
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  })

  describe('detect', () => {
    it('is not detected in an empty workspace with no user config and no binary', async () => {
      expect(await opencodeAdapter.detect(root)).toBe(false)
    })

    it('detects a project-local .opencode/ directory', async () => {
      await mkdir(join(root, '.opencode'), { recursive: true })
      expect(await opencodeAdapter.detect(root)).toBe(true)
    })

    it('detects a project opencode.json', async () => {
      await writeFile(join(root, 'opencode.json'), '{}')
      expect(await opencodeAdapter.detect(root)).toBe(true)
    })

    it('detects the user-level config dir ($OPENCODE_CONFIG_DIR)', async () => {
      await mkdir(process.env.OPENCODE_CONFIG_DIR!, { recursive: true })
      expect(await opencodeAdapter.detect(root)).toBe(true)
    })

    it('is not detected by AGENTS.md alone — Muse and Grok read the same file', async () => {
      await writeFile(join(root, 'AGENTS.md'), '# rules')
      expect(await opencodeAdapter.detect(root)).toBe(false)
    })
  })

  describe('writeConfig', () => {
    it('writes AGENTS.md from the shared markdown content builder', async () => {
      const sops = [{ id: 'sop_1', title: 'No secrets in code', content: 'Never commit API keys.' }] as never
      const written = await opencodeAdapter.writeConfig(root, sops, PROXY_URL)
      expect(written).toBe(join(root, 'AGENTS.md'))
      const content = await readFile(join(root, 'AGENTS.md'), 'utf-8')
      expect(content).toContain('No secrets in code')
      expect(content).toContain(PROXY_URL)
    })

    it('skips AGENTS.md with no SOPs, matching every other markdown adapter', async () => {
      await opencodeAdapter.writeConfig(root, [], PROXY_URL)
      await expect(readFile(join(root, 'AGENTS.md'), 'utf-8')).rejects.toThrow()
    })

    it('installs the plugin even with zero SOPs — the plugin is the governance vehicle, not the rules file', async () => {
      await opencodeAdapter.writeConfig(root, [], PROXY_URL)
      const plugin = await readFile(join(root, '.opencode', 'plugins', 'intutic-governance.js'), 'utf-8')
      expect(plugin).toContain("'tool.execute.before'")
      expect(plugin).toContain('Intutic gate body')
    })

    it('does not write opencode.json', async () => {
      await opencodeAdapter.writeConfig(root, [], PROXY_URL)
      await expect(readFile(join(root, 'opencode.json'), 'utf-8')).rejects.toThrow()
    })
  })

  describe('readCurrentHash', () => {
    it('returns null before a write and a hash after', async () => {
      expect(await opencodeAdapter.readCurrentHash(root)).toBeNull()
      const sops = [{ id: 'sop_1', title: 'x', content: 'y' }] as never
      await opencodeAdapter.writeConfig(root, sops, PROXY_URL)
      expect(await opencodeAdapter.readCurrentHash(root)).toMatch(/^[0-9a-f]{64}$/)
    })
  })

  describe('registration', () => {
    it('is registered in ALL_ADAPTERS', () => {
      expect(ALL_ADAPTERS.some((a) => a.type === 'opencode')).toBe(true)
    })

    it('is registered in HARNESS_CONFIG_FILES with its config file', () => {
      expect(HARNESS_CONFIG_FILES['opencode']).toBe('AGENTS.md')
    })
  })
})
