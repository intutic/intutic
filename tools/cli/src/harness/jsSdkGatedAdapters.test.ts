/**
 * jsSdkGatedAdapters.test.ts — table-driven coverage for the T2 JS/TS
 * SDK-gated framework adapters (mastra.ts, vercelAiSdk.ts), plus dedicated
 * unit coverage for `leadingMajorVersion` and the Vercel AI SDK's
 * version-floor / `@ai-sdk/*`-prefix detection rules, which
 * `sdkGatedAdapters.test.ts`'s Python-manifest table has no equivalent of.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { HarnessType } from '@intutic/shared-types'
import type { IHarnessAdapter } from './types.js'
import { mastraAdapter } from './mastra.js'
import { openaiAgentsAdapter } from './openaiAgents.js'
import { vercelAiSdkAdapter } from './vercelAiSdk.js'
import { aiSdkHarnessAdapter } from './aiSdkHarness.js'
import { aiSdkWorkflowAdapter } from './aiSdkWorkflow.js'
import { leadingMajorVersion } from './jsSdkGatedAdapter.js'
import { ALL_ADAPTERS } from './detector.js'
import { HARNESS_CONFIG_FILES } from './types.js'

const PROXY_URL = 'http://127.0.0.1:4000/v1'

function pkgJson(deps: Record<string, string>): string {
  return JSON.stringify({ name: 'x', version: '0.0.0', dependencies: deps }, null, 2)
}

describe('leadingMajorVersion', () => {
  it.each([
    ['^7.0.68', 7],
    ['~6.1.0', 6],
    ['>=6.0.0', 6],
    ['<7.0.0', 7],
    ['6.0.0', 6],
    ['v6.2.1', 6],
    [' 6.0.0', 6],
    ['*', null],
    ['latest', null],
    ['workspace:*', null],
    ['', null],
  ])('%s -> %s', (range, expected) => {
    expect(leadingMajorVersion(range)).toBe(expected)
  })
})

interface Case {
  name: HarnessType
  adapter: IHarnessAdapter
  /** Dependencies that should trigger detection. */
  positive: Record<string, string>
  /** Dependencies that must NOT trigger detection. */
  negative: Record<string, string>
  /** Substring expected in the generated .env.intutic comment block. */
  importSnippet: string
  /** Substrings expected in the preamble lines. Defaults to the shared
   *  in-process prose; ai-sdk-harness overrides it (envPreamble) because
   *  its tools execute server-side in a sandbox, not "in your own Node.js
   *  process". */
  preambleSnippets?: readonly string[]
}

const CASES: Case[] = [
  {
    name: 'mastra',
    adapter: mastraAdapter,
    positive: { '@mastra/core': '^1.59.0' },
    negative: { fastify: '^5.0.0' },
    importSnippet: "@intutic/gate/mastra'",
  },
  {
    name: 'vercel-ai-sdk',
    adapter: vercelAiSdkAdapter,
    positive: { ai: '^7.0.68', '@ai-sdk/openai': '^4.0.43' },
    negative: { fastify: '^5.0.0' },
    importSnippet: "@intutic/gate/vercel'",
  },
  {
    name: 'ai-sdk-harness',
    adapter: aiSdkHarnessAdapter,
    positive: { '@ai-sdk/harness': '^1.0.75' },
    negative: { fastify: '^5.0.0' },
    importSnippet: "@intutic/gate/harness'",
    preambleSnippets: ['server-side in Vercel Sandbox', 'never crosses this proxy'],
  },
  {
    name: 'ai-sdk-workflow',
    adapter: aiSdkWorkflowAdapter,
    positive: { '@ai-sdk/workflow': '^1.0.69' },
    negative: { fastify: '^5.0.0' },
    importSnippet: "@intutic/gate/workflow'",
  },
]

describe.each(CASES)('$name adapter', ({ name, adapter, positive, negative, importSnippet, preambleSnippets }) => {
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
    it('is not detected in an empty workspace (no package.json)', async () => {
      expect(await adapter.detect(root)).toBe(false)
    })

    it('is not detected when package.json is unparseable', async () => {
      await writeFile(join(root, 'package.json'), '{not json', 'utf-8')
      expect(await adapter.detect(root)).toBe(false)
    })

    it('detects the dependency in package.json', async () => {
      await writeFile(join(root, 'package.json'), pkgJson(positive), 'utf-8')
      expect(await adapter.detect(root)).toBe(true)
    })

    it('ignores package.json without the dependency', async () => {
      await writeFile(join(root, 'package.json'), pkgJson(negative), 'utf-8')
      expect(await adapter.detect(root)).toBe(false)
    })

    it('also detects via devDependencies', async () => {
      const manifest = JSON.stringify({ name: 'x', version: '0.0.0', devDependencies: positive })
      await writeFile(join(root, 'package.json'), manifest, 'utf-8')
      expect(await adapter.detect(root)).toBe(true)
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

    it('points at the SDK gate with npm (not pip) install text, because env vars govern egress but not local tools', async () => {
      await adapter.writeConfig(root, [], PROXY_URL)
      const content = await readFile(join(root, '.env.intutic'), 'utf-8')
      expect(content).toContain('npm install @intutic/gate')
      expect(content).not.toContain('pip install')
      for (const snippet of preambleSnippets ?? ['your own', 'Node.js process']) {
        expect(content).toContain(snippet)
      }
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

describe('openai-agents adapter: dual-ecosystem JS-side detection (Python side covered in sdkGatedAdapters.test.ts)', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'intutic-openai-agents-js-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it.each(['@openai/agents', '@openai/agents-core', '@openai/agents-openai', '@openai/agents-realtime'])(
    'detects %s in package.json',
    async (dep) => {
      await writeFile(join(root, 'package.json'), pkgJson({ [dep]: '^0.16.1' }), 'utf-8')
      expect(await openaiAgentsAdapter.detect(root)).toBe(true)
    },
  )

  it('ignores package.json without any @openai/agents* dependency (plain `openai` is not the Agents SDK)', async () => {
    await writeFile(join(root, 'package.json'), pkgJson({ openai: '^7.5.0' }), 'utf-8')
    expect(await openaiAgentsAdapter.detect(root)).toBe(false)
  })

  it('writes the @intutic/gate/openai pointer for a TypeScript-only workspace', async () => {
    await writeFile(join(root, 'package.json'), pkgJson({ '@openai/agents': '^0.16.1' }), 'utf-8')
    await openaiAgentsAdapter.writeConfig(root, [], PROXY_URL)
    const content = await readFile(join(root, '.env.intutic'), 'utf-8')
    expect(content).toContain('npm install @intutic/gate')
    expect(content).toContain("@intutic/gate/openai'")
    expect(content).not.toContain('pip install')
  })

  it('keeps the Python pointer when both ecosystems are present (see openaiAgents.ts module doc)', async () => {
    await writeFile(join(root, 'package.json'), pkgJson({ '@openai/agents': '^0.16.1' }), 'utf-8')
    await writeFile(join(root, 'requirements.txt'), 'openai-agents==0.20.0\n', 'utf-8')
    await openaiAgentsAdapter.writeConfig(root, [], PROXY_URL)
    const content = await readFile(join(root, '.env.intutic'), 'utf-8')
    expect(content).toContain('pip install intutic-clawde[openai-agents]')
  })
})

describe('vercel-ai-sdk adapter: version floor and @ai-sdk/* prefix rule', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'intutic-vercel-version-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('does not detect ai below major 6, even with an @ai-sdk/* package present', async () => {
    await writeFile(
      join(root, 'package.json'),
      pkgJson({ ai: '^5.2.0', '@ai-sdk/openai': '^1.0.0' }),
      'utf-8',
    )
    expect(await vercelAiSdkAdapter.detect(root)).toBe(false)
  })

  it('does not detect ai>=6 with no @ai-sdk/* provider package at all', async () => {
    await writeFile(join(root, 'package.json'), pkgJson({ ai: '^7.0.68' }), 'utf-8')
    expect(await vercelAiSdkAdapter.detect(root)).toBe(false)
  })

  it('does not detect an unparseable version range (e.g. workspace:*) as satisfying the floor', async () => {
    await writeFile(
      join(root, 'package.json'),
      pkgJson({ ai: 'workspace:*', '@ai-sdk/openai': '^1.0.0' }),
      'utf-8',
    )
    expect(await vercelAiSdkAdapter.detect(root)).toBe(false)
  })

  it('detects ai>=6 plus any @ai-sdk/* package', async () => {
    await writeFile(
      join(root, 'package.json'),
      pkgJson({ ai: '^6.0.0', '@ai-sdk/anthropic': '^1.0.0' }),
      'utf-8',
    )
    expect(await vercelAiSdkAdapter.detect(root)).toBe(true)
  })
})

describe('ai-sdk-harness adapter: any-of-three-families detection rule', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'intutic-aisdk-harness-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it.each([
    ['the framework itself', { '@ai-sdk/harness': '^1.0.75' }],
    ['a harness runtime adapter alone', { '@ai-sdk/harness-claude-code': '^1.0.78' }],
    ['another harness runtime adapter alone', { '@ai-sdk/harness-grok-build': '^1.0.12' }],
    ['a sandbox provider alone', { '@ai-sdk/sandbox-vercel': '^1.0.0' }],
  ])('detects via %s', async (_label, deps) => {
    await writeFile(join(root, 'package.json'), pkgJson(deps), 'utf-8')
    expect(await aiSdkHarnessAdapter.detect(root)).toBe(true)
  })

  it('does not detect via other @ai-sdk/* packages (providers belong to vercel-ai-sdk detection)', async () => {
    await writeFile(
      join(root, 'package.json'),
      pkgJson({ ai: '^7.0.68', '@ai-sdk/openai': '^4.0.43' }),
      'utf-8',
    )
    expect(await aiSdkHarnessAdapter.detect(root)).toBe(false)
  })
})

describe('ai-sdk-workflow adapter: scoped-package-required detection rule', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'intutic-aisdk-workflow-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('does NOT detect the unscoped `workflow` package alone — the bare name is too generic, and the durable runtime without @ai-sdk/workflow has no WorkflowAgent to gate', async () => {
    await writeFile(join(root, 'package.json'), pkgJson({ workflow: '^4.8.3' }), 'utf-8')
    expect(await aiSdkWorkflowAdapter.detect(root)).toBe(false)
  })

  it('detects @ai-sdk/workflow with the runtime alongside', async () => {
    await writeFile(
      join(root, 'package.json'),
      pkgJson({ '@ai-sdk/workflow': '^1.0.69', workflow: '^4.8.3' }),
      'utf-8',
    )
    expect(await aiSdkWorkflowAdapter.detect(root)).toBe(true)
  })
})
