/**
 * openhands.ts — OpenHands adapter (full implementation with hooks + llm.base_url).
 *
 * Writes SOP content into config.toml, injects PreToolUse hooks via
 * .openhands/hooks.json, and writes llm.base_url into the [llm] section.
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { join, dirname } from 'node:path'
import { access, writeFile, rename, mkdir } from 'node:fs/promises'
import { HarnessType } from '@intutic/shared-types'
import type { SyncSopEntry } from '@intutic/shared-types'
import type { IHarnessAdapter } from './types.js'
import { hashFile } from '../lib/hash.js'
import { newIso } from '@intutic/id'
import { writeOpenHandsHooks } from '@intutic/sync-daemon/harness/openhandsHooks'

const CONFIG_FILE = 'config.toml'

export const openhandsAdapter: IHarnessAdapter = {
  type: HarnessType.OPENHANDS,
  configFileName: CONFIG_FILE,

  async detect(workspaceRoot: string): Promise<boolean> {
    try {
      await access(join(workspaceRoot, CONFIG_FILE))
      return true
    } catch {
      return false
    }
  },

  async writeConfig(workspaceRoot: string, sops: SyncSopEntry[], proxyUrl: string): Promise<string | null> {
    const filePath = join(workspaceRoot, CONFIG_FILE)
    const tmpPath = filePath + '.intutic-tmp'

    const instructions = sops.length > 0
      ? sops.map((sop) => `## ${sop.title}\n\n${sop.content}`).join('\n\n---\n\n')
      : '# Intutic governance active — no SOP rules configured yet.'

    // TOML — [intutic] section for SOP text + [llm] for proxy base_url
    const toml = [
      '# Intutic Governance Rules (auto-generated)',
      '# DO NOT EDIT — managed by intutic sync daemon',
      `# Last sync: ${newIso()}`,
      '',
      '[intutic]',
      `proxy_url = "${proxyUrl}"`,
      'instructions = """',
      instructions,
      '"""',
      '',
      '[llm]',
      `base_url = "${proxyUrl}"`,
      '',
    ].join('\n')

    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(tmpPath, toml, 'utf-8')
    await rename(tmpPath, filePath)

    // Inject .openhands/hooks.json PreToolUse hook
    await writeOpenHandsHooks(workspaceRoot, proxyUrl)

    return filePath
  },

  async readCurrentHash(workspaceRoot: string): Promise<string | null> {
    try {
      return await hashFile(join(workspaceRoot, CONFIG_FILE))
    } catch {
      return null
    }
  },
}
