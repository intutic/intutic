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

  async installGate(workspaceRoot: string, proxyUrl: string): Promise<void> {
    const creds = await loadCredentials()
    await writePiHooks(workspaceRoot, proxyUrl, creds?.workspaceId || 'local')
  },

  /** No rules file: the gate is this harness's governance. */
  async writeConfig(): Promise<string | null> {
    return null
  },

  async readCurrentHash(workspaceRoot: string): Promise<string | null> {
    try {
      return await hashFile(join(workspaceRoot, CONFIG_FILE))
    } catch {
      return null
    }
  },
}
