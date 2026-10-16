/**
 * `writeHarnessConfigs` with `routing: false` — what `intutic gates install`
 * runs without `--route`: every hook-gated harness gets its gate, and no
 * harness has its LLM traffic pointed at the proxy. Each routing target is
 * seeded with the user's own content, which must come through unchanged (or,
 * where the gate and the routing share a file, without the routing keys).
 *
 * A sibling of connectGates.test.ts rather than a case in it: the writers
 * resolve the home directory at import time, so each sandbox is a file.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

const fake = vi.hoisted(() => {
  const base = `${process.env.TMPDIR || '/tmp'}/intutic-gates-norouting-${process.pid}-${Date.now()}`.replace(/\/+/g, '/')
  process.env.HOME = `${base}/home`
  process.env.USERPROFILE = `${base}/home`
  delete process.env.XDG_CONFIG_HOME
  delete process.env.CODEX_HOME
  delete process.env.DSH_HOME
  delete process.env.PORT
  process.env.N8N_URL = 'http://127.0.0.1:9'
  return { base, home: `${base}/home`, ws: `${base}/home/code/project` }
})

import * as fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { HarnessType } from '@intutic/shared-types'
import type { SyncSopEntry } from '@intutic/shared-types'
import { findGateFile, gateKindForHarness } from '@intutic/sync-daemon'
import { windsurfSettingsPath } from '@intutic/sync-daemon/harness/windsurfHooks'
import { writeHarnessConfigs } from '../harness/writeHarnessConfigs.js'

const { base, home, ws } = fake
const PROXY = 'http://127.0.0.1:4000'

/** Routing targets, seeded with the user's own content. */
const SEEDED: Record<string, string> = {
  [join(home, '.codex', 'config.toml')]: 'model = "o3"\n',
  [join(home, '.continue', 'config.yaml')]: 'models: []\n',
  [join(home, '.openhands', 'config.toml')]: '[llm]\nmodel = "gpt-4o"\n',
  [join(ws, 'config.toml')]: '[llm]\nmodel = "gpt-4o"\n',
  [join(home, '.pi', 'agent', 'models.json')]: '{}\n',
  [windsurfSettingsPath()]: '{\n  "editor.fontSize": 13\n}\n',
}
const GOOSE_CONFIG = join(home, '.config', 'goose', 'config.yaml')
const AIDER_CONFIG = join(ws, '.aider.conf.yml')
const DSH_PATCH = join(home, '.dsh', 'profiles', 'default', 'cordis.patch.yml')

const SOPS: SyncSopEntry[] = [
  { sopId: 'local:a.md', title: 'Local SOP: a.md', content: 'Keep diffs small.', contentHash: '', harnessTargets: [HarnessType.AIDER, HarnessType.OPENHANDS] },
]

async function put(path: string, content: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, content)
}

const hookGated = Object.values(HarnessType).filter((h) => gateKindForHarness(h) === 'hook' && h !== HarnessType.CLAUDE_CODE)
const all = [...hookGated, HarnessType.CONTINUE, HarnessType.AIDER]

describe('writeHarnessConfigs without routing', () => {
  beforeAll(async () => {
    await fs.mkdir(join(ws, '.openhands'), { recursive: true })
    for (const [file, content] of Object.entries(SEEDED)) await put(file, content)
    await put(GOOSE_CONFIG, 'GOOSE_PROVIDER: openai\n')
    await put(AIDER_CONFIG, 'model: gpt-4o\n')
    await put(join(home, '.dsh', 'profiles', 'default', 'package.json'), JSON.stringify({ name: 'default', dependencies: {} }))
    await put(DSH_PATCH, '[]\n')
    await writeHarnessConfigs(all, ws, SOPS, PROXY, false, { routing: false })
  })

  afterAll(async () => {
    if (process.platform === 'darwin') {
      const plugin = join(home, '.agents', 'plugins', 'intutic-governance')
      for (const f of [join(plugin, 'plugin.json'), join(plugin, 'hooks', 'hooks.json'), join(plugin, 'scripts', 'intutic-check.sh')]) {
        await promisify(execFile)('chflags', ['nouchg', f]).catch(() => undefined)
      }
    }
    await fs.rm(base, { recursive: true, force: true })
  })

  it.each(hookGated)('%s: the gate is installed', async (harness) => {
    expect(await findGateFile(harness, ws, home)).not.toBeNull()
  })

  it.each(Object.keys(SEEDED))('%s is left as the user wrote it', async (file) => {
    expect(await fs.readFile(file, 'utf-8')).toBe(SEEDED[file])
  })

  it('registers the goose gate without pointing its providers at the proxy', async () => {
    const text = await fs.readFile(GOOSE_CONFIG, 'utf-8')
    expect(text).toContain('intutic-check.sh')
    expect(text).not.toMatch(/OPENAI_HOST|ANTHROPIC_HOST/)
  })

  it('registers the dsh plugin without an llm route', async () => {
    const text = await fs.readFile(DSH_PATCH, 'utf-8')
    expect(text).toContain('intutic-governance')
    expect(text).not.toContain('baseURL')
  })

  it("lists Aider's rules file without routing its models", async () => {
    const text = await fs.readFile(AIDER_CONFIG, 'utf-8')
    expect(text).toContain('model: gpt-4o')
    expect(text).toContain(join('.intutic', 'aider-sops.md'))
    // The header comment names both keys; neither is set.
    expect(text).not.toMatch(/^openai-api-base:/m)
    expect(text).not.toContain('ANTHROPIC_BASE_URL=')
  })

  it('writes no Grok model routing, and records no proxy URL for disconnect', () => {
    expect(existsSync(join(home, '.grok', 'config.toml'))).toBe(false)
    expect(existsSync(join(ws, '.grok', 'config.toml'))).toBe(false)
    expect(existsSync(join(home, '.intutic', 'originals', 'proxy-urls.json'))).toBe(false)
  })

  it("does not tell Hermes its traffic goes through the proxy", async () => {
    const skill = await fs.readFile(join(home, '.hermes', 'skills', 'intutic-governance', 'SKILL.md'), 'utf-8')
    expect(skill).not.toContain(PROXY)
  })

  it('still writes the OpenHands rules file', async () => {
    expect(await fs.readFile(join(ws, '.openhands', 'microagents', 'intutic-governance.md'), 'utf-8')).toContain('Keep diffs small.')
  })
})
