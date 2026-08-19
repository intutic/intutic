/**
 * eve.test.ts — coverage for the eve adapter's COMPOUND detection (the one
 * thing jsSdkGatedAdapters.test.ts's table cannot express: detection needs
 * the `eve` dependency in `package.json` AND the `agent/` directory, and
 * either alone must NOT detect), plus the same writeConfig/registration
 * assertions the table applies to its own cases.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { eveAdapter } from './eve.js'
import { ALL_ADAPTERS } from './detector.js'
import { HARNESS_CONFIG_FILES } from './types.js'

const PROXY_URL = 'http://127.0.0.1:4000/v1'

function pkgJson(deps: Record<string, string>): string {
  return JSON.stringify({ name: 'x', version: '0.0.0', dependencies: deps }, null, 2)
}

describe('eve adapter', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'intutic-eve-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('has the expected type and config file name', () => {
    expect(eveAdapter.type).toBe('eve')
    expect(eveAdapter.configFileName).toBe('.env.intutic')
  })

  describe('compound detection: eve dep AND agent/ directory, never either alone', () => {
    it('is not detected in an empty workspace', async () => {
      expect(await eveAdapter.detect(root)).toBe(false)
    })

    it('is NOT detected with the eve dependency but no agent/ directory', async () => {
      await writeFile(join(root, 'package.json'), pkgJson({ eve: '^0.39.1' }), 'utf-8')
      expect(await eveAdapter.detect(root)).toBe(false)
    })

    it('is NOT detected with an agent/ directory but no eve dependency — agent/ alone is too generic', async () => {
      await writeFile(join(root, 'package.json'), pkgJson({ fastify: '^5.0.0' }), 'utf-8')
      await mkdir(join(root, 'agent'))
      expect(await eveAdapter.detect(root)).toBe(false)
    })

    it('is NOT detected when agent exists but is a FILE, not a directory', async () => {
      await writeFile(join(root, 'package.json'), pkgJson({ eve: '^0.39.1' }), 'utf-8')
      await writeFile(join(root, 'agent'), 'not a directory', 'utf-8')
      expect(await eveAdapter.detect(root)).toBe(false)
    })

    it('is detected with the eve dependency AND an agent/ directory', async () => {
      await writeFile(join(root, 'package.json'), pkgJson({ eve: '^0.39.1' }), 'utf-8')
      await mkdir(join(root, 'agent'))
      expect(await eveAdapter.detect(root)).toBe(true)
    })

    it('also detects via devDependencies', async () => {
      const manifest = JSON.stringify({ name: 'x', version: '0.0.0', devDependencies: { eve: '0.39.1' } })
      await writeFile(join(root, 'package.json'), manifest, 'utf-8')
      await mkdir(join(root, 'agent'))
      expect(await eveAdapter.detect(root)).toBe(true)
    })
  })

  describe('writeConfig', () => {
    it('writes .env.intutic with the proxy vars and the eve-specific pointer comment', async () => {
      const written = await eveAdapter.writeConfig(root, [], PROXY_URL)
      expect(written).toBe(join(root, '.env.intutic'))

      const content = await readFile(join(root, '.env.intutic'), 'utf-8')
      expect(content).toContain(`export INTUTIC_PROXY_URL="${PROXY_URL}"`)
      expect(content).toContain('npm install @intutic/gate')
      expect(content).toContain("@intutic/gate/eve'")
      expect(content).toContain('intuticApproval')
      // The honesty notes this preview integration must carry:
      expect(content).toContain('no agent-level default approval field')
      expect(content).toContain('AI Gateway')
      expect(content).toContain('PREVIEW')
    })
  })

  describe('registration', () => {
    it('is registered in ALL_ADAPTERS', () => {
      expect(ALL_ADAPTERS.some((a) => a.type === 'eve')).toBe(true)
    })

    it('is registered in HARNESS_CONFIG_FILES with its config file', () => {
      expect(HARNESS_CONFIG_FILES['eve']).toBe('.env.intutic')
    })
  })
})
