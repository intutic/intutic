/**
 * pi.ts — Pi adapter.
 *
 * Detects Pi presence and invokes the sync-daemon hooks compiler
 * to inject Intutic pre-tool use gates.
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { join } from 'node:path'
import { access } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { HarnessType } from '@intutic/shared-types'
import type { SyncSopEntry } from '@intutic/shared-types'
import type { IHarnessAdapter } from './types.js'
import { hashFile } from '../lib/hash.js'
import { loadCredentials } from '../config/store.js'
import { writePiHooks } from '@intutic/sync-daemon'

const CONFIG_FILE = '.pi/hooks.json'

export const piAdapter: IHarnessAdapter = {
  type: HarnessType.PI,
  configFileName: CONFIG_FILE,

  async detect(workspaceRoot: string): Promise<boolean> {
    const globalPi = join(homedir(), '.pi')
    const localPi = join(workspaceRoot, CONFIG_FILE)
    try {
      if (existsSync(globalPi)) return true
      await access(localPi)
      return true
    } catch {
      return false
    }
  },

  async writeConfig(workspaceRoot: string, _sops: SyncSopEntry[], proxyUrl: string): Promise<string | null> {
    const filePath = join(workspaceRoot, CONFIG_FILE)
    const creds = await loadCredentials()
    const workspaceId = creds?.workspaceId || 'local'
    await writePiHooks(workspaceRoot, proxyUrl, workspaceId)
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
