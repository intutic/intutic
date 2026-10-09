/**
 * `intutic connect` installs every configured harness's gate whether or not
 * any rule set targets it.
 *
 * It used to skip a harness outright when no rule set targeted it, gate
 * included. The gate enforces the built-in protections, the
 * destructive-command tier, group rules and holds, none of which need a rule
 * set, so a workspace with no rule sets had every harness ungoverned. This
 * drives `writeHarnessConfigs` the way connect does, with zero rule sets, for
 * every harness whose gate kind is `hook`, and checks each gate is
 * registered where the harness reads it.
 *
 * Writers keep some paths in module-level constants computed from the home
 * directory at import time, so HOME is moved before anything is imported.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

const fake = vi.hoisted(() => {
  const base = `${process.env.TMPDIR || '/tmp'}/intutic-connect-gates-${process.pid}-${Date.now()}`.replace(/\/+/g, '/')
  process.env.HOME = `${base}/home`
  process.env.USERPROFILE = `${base}/home`
  delete process.env.XDG_CONFIG_HOME
  delete process.env.CODEX_HOME
  delete process.env.DSH_HOME
  delete process.env.PORT
  // Nothing listens on the discard port: the n8n adapter's API calls fail fast.
  process.env.N8N_URL = 'http://127.0.0.1:9'
  return { base, home: `${base}/home`, ws: `${base}/home/code/project` }
})

import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { HarnessType } from '@intutic/shared-types'
import { gateKindForHarness } from '@intutic/sync-daemon'
import { writeHarnessConfigs } from './connect.js'

const { base, home, ws } = fake
const PROXY = 'http://127.0.0.1:4000'

/** Where each harness reads its gate registration, and a string that shows it is Intutic's. */
const GATE_REGISTRATION: Record<string, [file: string, marker: string]> = {
  antigravity: [join(home, '.gemini', 'settings.json'), 'antigravity-check.sh'],
  cline: [join(ws, '.clinerules', 'hooks', 'PreToolUse'), 'Intutic Cline PreToolUse governance gate.'],
  codex: [join(home, '.codex', 'hooks.json'), 'codex-check.js'],
  cursor: [join(home, '.cursor', 'hooks.json'), 'cursor-check.js'],
  dsh: [join(home, '.dsh', 'profiles', 'default', 'cordis.patch.yml'), 'intutic-governance'],
  'github-copilot': [join(ws, '.github', 'hooks', 'intutic-governance.json'), 'github-copilot-check.js'],
  goose: [join(home, '.agents', 'plugins', 'intutic-governance', 'hooks', 'hooks.json'), 'intutic-check.sh'],
  grok: [join(home, '.grok', 'hooks', 'intutic-governance.json'), 'grok-check.js'],
  hermes: [join(home, '.hermes', 'config.yaml'), 'hermes-check.sh'],
  'muse-code': [join(ws, '.muse', 'hooks.json'), 'muse-check.js'],
  n8n: [join(home, '.intutic', 'hooks', 'n8n-governance-hook.js'), 'Intutic'],
  'open-webui': [join(home, '.open-webui', 'intutic-governance-filter.py'), 'Intutic'],
  openclaw: [join(home, '.openclaw', 'openclaw.json'), 'openclaw-check.js'],
  opencode: [join(ws, '.opencode', 'plugins', 'intutic-governance.js'), 'Intutic gate body'],
  openhands: [join(ws, '.openhands', 'hooks.json'), 'openhands-check.sh'],
  pi: [join(home, '.pi', 'hooks.json'), 'pi-check.sh'],
  windsurf: [join(home, '.codeium', 'windsurf', 'hooks.json'), 'windsurf-check.js'],
}

/**
 * Claude Code's gate is installed by connect's own step, with the synced
 * settings the deny rules need, not by its adapter.
 */
const INSTALLED_ELSEWHERE = new Set<string>([HarnessType.CLAUDE_CODE])

const hookGated = Object.values(HarnessType).filter((h) => gateKindForHarness(h) === 'hook' && !INSTALLED_ELSEWHERE.has(h))

describe('connect installs gates with zero rule sets', () => {
  beforeAll(async () => {
    await fs.mkdir(ws, { recursive: true })
    // dsh registers into existing profiles only; a first `dsh --profile` run creates one.
    const profile = join(home, '.dsh', 'profiles', 'default')
    await fs.mkdir(profile, { recursive: true })
    await fs.writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'default', dependencies: {} }))
    await fs.writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
    await writeHarnessConfigs(hookGated, ws, [], PROXY, false)
  })

  afterAll(async () => {
    // The goose writer sets the user-immutable flag on its plugin files.
    if (process.platform === 'darwin') {
      const plugin = join(home, '.agents', 'plugins', 'intutic-governance')
      for (const f of [join(plugin, 'plugin.json'), join(plugin, 'hooks', 'hooks.json'), join(plugin, 'scripts', 'intutic-check.sh')]) {
        await promisify(execFile)('chflags', ['nouchg', f]).catch(() => undefined)
      }
    }
    await fs.rm(base, { recursive: true, force: true })
  })

  it('knows where every hook-gated harness registers its gate', () => {
    // A harness added with a hook gate and missing here fails, rather than
    // passing because nothing checked it.
    expect(hookGated.length).toBeGreaterThan(15)
    expect(Object.keys(GATE_REGISTRATION).sort()).toEqual([...hookGated].sort())
  })

  it.each(Object.entries(GATE_REGISTRATION))('%s: the gate is registered', async (_harness, [file, marker]) => {
    expect(await fs.readFile(file, 'utf-8')).toContain(marker)
  })

  it('writes no rules file when no rule set targets the harness', async () => {
    for (const rules of ['.cursorrules', '.windsurfrules', 'AGENTS.md', join('.github', 'copilot-instructions.md'), join('.clinerules', 'intutic-governance.md')]) {
      await expect(fs.access(join(ws, rules)), rules).rejects.toThrow()
    }
  })
})
