import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { agentcoreAdapter } from './agentcore.js'
import { ALL_ADAPTERS } from './detector.js'
import { HARNESS_CONFIG_FILES } from './types.js'

const PROXY_URL = 'http://127.0.0.1:4000/v1'

describe('agentcore adapter (AWS Bedrock AgentCore Runtime)', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'intutic-agentcore-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  describe('detect', () => {
    it('is not detected in an empty workspace', async () => {
      expect(await agentcoreAdapter.detect(root)).toBe(false)
    })

    it('detects via .bedrock_agentcore.yaml (Python starter toolkit config)', async () => {
      await writeFile(join(root, '.bedrock_agentcore.yaml'), 'name: my-agent\n')
      expect(await agentcoreAdapter.detect(root)).toBe(true)
    })

    it('detects via agentcore/agentcore.json (npm CLI config)', async () => {
      await mkdir(join(root, 'agentcore'), { recursive: true })
      await writeFile(join(root, 'agentcore', 'agentcore.json'), '{}')
      expect(await agentcoreAdapter.detect(root)).toBe(true)
    })

    it('detects via aws-targets.json (npm CLI config)', async () => {
      await writeFile(join(root, 'aws-targets.json'), '{}')
      expect(await agentcoreAdapter.detect(root)).toBe(true)
    })

    it('detects via bedrock-agentcore in pyproject.toml', async () => {
      await writeFile(
        join(root, 'pyproject.toml'),
        '[project]\ndependencies = ["bedrock-agentcore>=1.22.0"]\n',
      )
      expect(await agentcoreAdapter.detect(root)).toBe(true)
    })

    it('detects via bedrock-agentcore-starter-toolkit in requirements.txt', async () => {
      await writeFile(join(root, 'requirements.txt'), 'bedrock-agentcore-starter-toolkit==0.3.11\n')
      expect(await agentcoreAdapter.detect(root)).toBe(true)
    })

    it('detects via bedrock-agentcore in package.json dependencies', async () => {
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({ dependencies: { 'bedrock-agentcore': '^0.4.3' } }),
      )
      expect(await agentcoreAdapter.detect(root)).toBe(true)
    })

    it('detects via @aws/agentcore in package.json devDependencies', async () => {
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({ devDependencies: { '@aws/agentcore': '^0.27.0' } }),
      )
      expect(await agentcoreAdapter.detect(root)).toBe(true)
    })

    it('does not false-positive on an unrelated package.json', async () => {
      await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { react: '^19.0.0' } }))
      expect(await agentcoreAdapter.detect(root)).toBe(false)
    })

    it('does not false-positive on an unrelated pyproject.toml', async () => {
      await writeFile(join(root, 'pyproject.toml'), '[project]\ndependencies = ["fastapi"]\n')
      expect(await agentcoreAdapter.detect(root)).toBe(false)
    })
  })

  describe('writeConfig', () => {
    it('is a no-op — AgentCore Runtime introduces no config format of its own', async () => {
      await writeFile(join(root, '.bedrock_agentcore.yaml'), 'name: my-agent\n')
      const sops = [{ id: 'sop_1', title: 'No secrets in code', content: 'Never commit API keys.' }] as never
      const written = await agentcoreAdapter.writeConfig(root, sops, PROXY_URL)
      expect(written).toBeNull()
    })
  })

  describe('readCurrentHash', () => {
    it('always returns null — no file of its own to hash', async () => {
      expect(await agentcoreAdapter.readCurrentHash(root)).toBeNull()
    })
  })

  describe('registration', () => {
    it('is registered in ALL_ADAPTERS', () => {
      expect(ALL_ADAPTERS.some((a) => a.type === 'agentcore-runtime')).toBe(true)
    })

    it('is registered in HARNESS_CONFIG_FILES with an empty (no-file) entry', () => {
      expect(HARNESS_CONFIG_FILES['agentcore-runtime']).toBe('')
    })
  })
})
