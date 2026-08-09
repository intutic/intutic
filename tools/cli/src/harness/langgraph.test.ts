import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { langgraphAdapter } from './langgraph.js'
import { ALL_ADAPTERS } from './detector.js'
import { HARNESS_CONFIG_FILES } from './types.js'

const PROXY_URL = 'http://127.0.0.1:4000/v1'

describe('langgraph adapter', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'intutic-langgraph-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  describe('detect', () => {
    it('is not detected in an empty workspace', async () => {
      expect(await langgraphAdapter.detect(root)).toBe(false)
    })

    it.each(['pyproject.toml', 'requirements.txt', 'uv.lock'])(
      'detects a langgraph dependency in %s',
      async (manifest) => {
        await writeFile(join(root, manifest), 'langgraph==0.2.0\n', 'utf-8')
        expect(await langgraphAdapter.detect(root)).toBe(true)
      },
    )

    it('detects a langchain dependency (LangGraph apps often pin langchain-* only)', async () => {
      await writeFile(join(root, 'requirements.txt'), 'langchain-openai>=0.3\n', 'utf-8')
      expect(await langgraphAdapter.detect(root)).toBe(true)
    })

    it('ignores manifests without a langgraph/langchain dependency', async () => {
      await writeFile(join(root, 'requirements.txt'), 'fastapi\nuvicorn\n', 'utf-8')
      expect(await langgraphAdapter.detect(root)).toBe(false)
    })
  })

  describe('writeConfig', () => {
    it('writes .env.intutic with the proxy base-URL env vars', async () => {
      const written = await langgraphAdapter.writeConfig(root, [], PROXY_URL)
      expect(written).toBe(join(root, '.env.intutic'))

      const content = await readFile(join(root, '.env.intutic'), 'utf-8')
      expect(content).toContain(`export ANTHROPIC_BASE_URL="${PROXY_URL}"`)
      expect(content).toContain(`export OPENAI_BASE_URL="${PROXY_URL}"`)
      expect(content).toContain(`export INTUTIC_PROXY_URL="${PROXY_URL}"`)
      expect(content).toContain('export INTUTIC_SOP_COUNT=0')
    })

    it('points at the SDK gate, because env vars govern egress but not local tools', async () => {
      await langgraphAdapter.writeConfig(root, [], PROXY_URL)
      const content = await readFile(join(root, '.env.intutic'), 'utf-8')
      expect(content).toContain('pip install intutic-clawde')
      expect(content).toContain('from intutic_clawde.gate import guard_tools')
    })

    it('is idempotent apart from the sync timestamp', async () => {
      await langgraphAdapter.writeConfig(root, [], PROXY_URL)
      const first = await readFile(join(root, '.env.intutic'), 'utf-8')
      await langgraphAdapter.writeConfig(root, [], PROXY_URL)
      const second = await readFile(join(root, '.env.intutic'), 'utf-8')
      const strip = (s: string) => s.replace(/^# Last sync: .*$/m, '')
      expect(strip(second)).toBe(strip(first))
    })
  })

  describe('readCurrentHash', () => {
    it('returns null before a write and a hash after', async () => {
      expect(await langgraphAdapter.readCurrentHash(root)).toBeNull()
      await langgraphAdapter.writeConfig(root, [], PROXY_URL)
      expect(await langgraphAdapter.readCurrentHash(root)).toMatch(/^[0-9a-f]{64}$/)
    })
  })

  describe('registration', () => {
    it('is registered in ALL_ADAPTERS', () => {
      expect(ALL_ADAPTERS.some((a) => a.type === 'langgraph')).toBe(true)
    })

    it('is registered in HARNESS_CONFIG_FILES with its config file', () => {
      expect(HARNESS_CONFIG_FILES['langgraph']).toBe('.env.intutic')
    })
  })
})
