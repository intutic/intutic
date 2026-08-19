/**
 * sdkGatedAdapters.test.ts — table-driven coverage for the Wave 1 SDK-gated
 * framework adapters (langchain.ts, crewai.ts, autogen.ts, ag2.ts,
 * googleAdk.ts, openaiAgents.ts, pydanticAi.ts, smolagents.ts).
 *
 * Each is built from `makeSdkGatedAdapter` and shares langgraph.ts's shape
 * exactly (see langgraph.test.ts) — one table here instead of eight
 * near-identical copies of that file, so a bug shared by all eight is a
 * single row's fixture away from being caught, not eight files' worth of
 * drift-prone duplication.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { HarnessType } from '@intutic/shared-types'
import type { IHarnessAdapter } from './types.js'
import { langchainAdapter } from './langchain.js'
import { crewaiAdapter } from './crewai.js'
import { autogenAdapter } from './autogen.js'
import { ag2Adapter } from './ag2.js'
import { googleAdkAdapter } from './googleAdk.js'
import { openaiAgentsAdapter } from './openaiAgents.js'
import { pydanticAiAdapter } from './pydanticAi.js'
import { smolagentsAdapter } from './smolagents.js'
import { strandsAdapter } from './strands.js'
import { ALL_ADAPTERS } from './detector.js'
import { HARNESS_CONFIG_FILES } from './types.js'

const PROXY_URL = 'http://127.0.0.1:4000/v1'

interface Case {
  name: HarnessType
  adapter: IHarnessAdapter
  /** A manifest line that should trigger detection. */
  positive: string
  /** A manifest line that must NOT trigger detection. */
  negative: string
  /** Substring expected in the generated .env.intutic comment block. */
  importSnippet: string
}

const CASES: Case[] = [
  {
    name: 'langchain',
    adapter: langchainAdapter,
    positive: 'langchain==1.3.15\n',
    negative: 'fastapi\nuvicorn\n',
    importSnippet: 'intutic_clawde.gate.adapters.langchain',
  },
  {
    name: 'crewai',
    adapter: crewaiAdapter,
    positive: 'crewai>=1.15.3\n',
    negative: 'fastapi\nuvicorn\n',
    importSnippet: 'intutic_clawde.gate.adapters.crewai',
  },
  {
    name: 'autogen',
    adapter: autogenAdapter,
    positive: 'autogen-agentchat==0.4.0\n',
    negative: 'fastapi\nuvicorn\n',
    importSnippet: 'intutic_clawde.gate.adapters.autogen',
  },
  {
    name: 'ag2',
    adapter: ag2Adapter,
    positive: 'ag2==0.4.0\n',
    // "flag2" contains the substring "ag2" — this exercises the boundary-aware
    // regex (AG2_TOKEN in ag2.ts), not just a plain substring test.
    negative: 'flag2-parser==1.0\n',
    importSnippet: 'intutic_clawde.gate.adapters.ag2',
  },
  {
    name: 'google-adk',
    adapter: googleAdkAdapter,
    positive: 'google-adk>=2.7.1\n',
    negative: 'fastapi\nuvicorn\n',
    importSnippet: 'intutic_clawde.gate.adapters.google_adk',
  },
  {
    name: 'openai-agents',
    adapter: openaiAgentsAdapter,
    positive: 'openai-agents==0.20.0\n',
    negative: 'fastapi\nuvicorn\n',
    importSnippet: 'intutic_clawde.gate.adapters.openai_agents',
  },
  {
    name: 'pydantic-ai',
    adapter: pydanticAiAdapter,
    positive: 'pydantic-ai-slim==1.0\n',
    negative: 'fastapi\nuvicorn\n',
    importSnippet: 'intutic_clawde.gate.adapters.pydantic_ai',
  },
  {
    name: 'smolagents',
    adapter: smolagentsAdapter,
    positive: 'smolagents==1.0\n',
    negative: 'fastapi\nuvicorn\n',
    importSnippet: 'intutic_clawde.gate.adapters.smolagents',
  },
  {
    name: 'strands',
    adapter: strandsAdapter,
    positive: 'strands-agents>=1.52.0\n',
    // A bare "strands" (e.g. an unrelated project name) must NOT trigger —
    // the keyword is the full package name `strands-agents`.
    negative: 'strands==0.1\nfastapi\n',
    importSnippet: 'intutic_clawde.gate.adapters.strands',
  },
]

describe.each(CASES)('$name adapter', ({ name, adapter, positive, negative, importSnippet }) => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), `intutic-${name}-`))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('has the expected type and config file name', () => {
    expect(adapter.type).toBe(name)
    expect(adapter.configFileName).toBe('.env.intutic')
  })

  describe('detect', () => {
    it('is not detected in an empty workspace', async () => {
      expect(await adapter.detect(root)).toBe(false)
    })

    it.each(['pyproject.toml', 'requirements.txt', 'uv.lock'])(
      'detects the dependency in %s',
      async (manifest) => {
        await writeFile(join(root, manifest), positive, 'utf-8')
        expect(await adapter.detect(root)).toBe(true)
      },
    )

    it('ignores manifests without the dependency (and near-miss substrings)', async () => {
      await writeFile(join(root, 'requirements.txt'), negative, 'utf-8')
      expect(await adapter.detect(root)).toBe(false)
    })
  })

  describe('writeConfig', () => {
    it('writes .env.intutic with the proxy base-URL env vars', async () => {
      const written = await adapter.writeConfig(root, [], PROXY_URL)
      expect(written).toBe(join(root, '.env.intutic'))

      const content = await readFile(join(root, '.env.intutic'), 'utf-8')
      expect(content).toContain(`export ANTHROPIC_BASE_URL="${PROXY_URL}"`)
      expect(content).toContain(`export OPENAI_BASE_URL="${PROXY_URL}"`)
      expect(content).toContain(`export INTUTIC_PROXY_URL="${PROXY_URL}"`)
      expect(content).toContain('export INTUTIC_SOP_COUNT=0')
    })

    it('points at the SDK gate, because env vars govern egress but not local tools', async () => {
      await adapter.writeConfig(root, [], PROXY_URL)
      const content = await readFile(join(root, '.env.intutic'), 'utf-8')
      expect(content).toContain('pip install intutic-clawde')
      expect(content).toContain(importSnippet)
    })

    it('is idempotent apart from the sync timestamp', async () => {
      await adapter.writeConfig(root, [], PROXY_URL)
      const first = await readFile(join(root, '.env.intutic'), 'utf-8')
      await adapter.writeConfig(root, [], PROXY_URL)
      const second = await readFile(join(root, '.env.intutic'), 'utf-8')
      const strip = (s: string) => s.replace(/^# Last sync: .*$/m, '')
      expect(strip(second)).toBe(strip(first))
    })
  })

  describe('readCurrentHash', () => {
    it('returns null before a write and a hash after', async () => {
      expect(await adapter.readCurrentHash(root)).toBeNull()
      await adapter.writeConfig(root, [], PROXY_URL)
      expect(await adapter.readCurrentHash(root)).toMatch(/^[0-9a-f]{64}$/)
    })
  })

  describe('registration', () => {
    it('is registered in ALL_ADAPTERS', () => {
      expect(ALL_ADAPTERS.some((a) => a.type === name)).toBe(true)
    })

    it('is registered in HARNESS_CONFIG_FILES with its config file', () => {
      expect(HARNESS_CONFIG_FILES[name]).toBe('.env.intutic')
    })
  })
})
