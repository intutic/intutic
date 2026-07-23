/**
 * continue.ts — Continue adapter (proxy URL injection).
 *
 * Detects the Continue AI coding assistant and merges the Intutic
 * proxy URL as apiBase into each model entry in ~/.continue/config.yaml.
 * Continue has no hook system so proxy routing (Vector B) is the only
 * available governance mechanism.
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { access, readdir, readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { HarnessType } from '@intutic/shared-types'
import type { SyncSopEntry } from '@intutic/shared-types'
import type { IHarnessAdapter } from './types.js'
import { hashFile } from '../lib/hash.js'
import { newIso } from '@intutic/id'

const home = homedir()
const CONTINUE_DIR = join(home, '.continue')
const CONFIG_YAML = join(CONTINUE_DIR, 'config.yaml')
const CONFIG_JSON = join(CONTINUE_DIR, 'config.json')

export const continueAdapter: IHarnessAdapter = {
  type: HarnessType.CONTINUE,
  configFileName: CONFIG_YAML,

  async detect(_workspaceRoot: string): Promise<boolean> {
    for (const p of [CONFIG_YAML, CONFIG_JSON]) {
      try { await access(p); return true } catch { /* fall through */ }
    }
    try {
      const entries = await readdir(join(home, '.vscode', 'extensions'))
      return entries.some((e) => e.startsWith('continue.continue-'))
    } catch {
      return false
    }
  },

  async writeConfig(_workspaceRoot: string, _sops: SyncSopEntry[], proxyUrl: string): Promise<string | null> {
    // Merge apiBase into each model entry in config.yaml
    let raw = ''
    try { raw = await readFile(CONFIG_YAML, 'utf-8') } catch { raw = '' }

    // Inject apiBase under each `- name:` model entry.
    // Simple line-based approach that handles the common config.yaml structure.
    const lines = raw.split('\n')
    const result: string[] = []
    let inModels = false

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      result.push(line)

      if (line.trim() === 'models:') { inModels = true; continue }
      if (inModels && line.trim().startsWith('- name:')) {
        // After each model entry start, inject apiBase if not already present
        const next = lines[i + 1] ?? ''
        if (!next.trim().startsWith('apiBase:')) {
          result.push(`  apiBase: "${proxyUrl}"`)
        }
      }
      if (inModels && line.trim() && !line.startsWith(' ') && !line.trim().startsWith('-') && !line.trim().startsWith('models:')) {
        inModels = false
      }
    }

    // If config.yaml is empty or has no models section yet, write a minimal config
    if (!raw.includes('models:')) {
      result.push('# Intutic proxy config (auto-generated)')
      result.push(`# Last sync: ${newIso()}`)
      result.push('models:')
      result.push('  - name: "Intutic Governed Model"')
      result.push(`    apiBase: "${proxyUrl}"`)
    }

    const content = result.join('\n')
    await mkdir(CONTINUE_DIR, { recursive: true })
    const tmp = CONFIG_YAML + '.intutic-tmp'
    await writeFile(tmp, content, 'utf-8')
    await rename(tmp, CONFIG_YAML)
    return CONFIG_YAML
  },

  async readCurrentHash(_workspaceRoot: string): Promise<string | null> {
    try { return await hashFile(CONFIG_YAML) } catch { return null }
  },
}
