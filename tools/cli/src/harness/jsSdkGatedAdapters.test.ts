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
import { vercelAiSdkAdapter } from './vercelAiSdk.js'
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
      expect(content).toContain('your own')
      expect(content).toContain('Node.js process')
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
