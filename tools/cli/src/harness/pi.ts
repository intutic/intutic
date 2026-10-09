/**
 * pi.ts — Pi adapter.
 *
 * Detects Pi presence and invokes the sync-daemon hooks compiler
 * to inject Intutic pre-tool use gates.
 *
 * Pi loads `AGENTS.md` from its agent directory and from every directory
 * between where it runs and the filesystem root, so the rule sets go into the
 * workspace's `AGENTS.md` through the shared writer (agentsMd.ts;
 * https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/coding-agent/docs/configuration.md).
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
import { loadCredentials } from '../config/store.js'
import { AGENTS_MD, agentsMdHash, writeAgentsMd } from './agentsMd.js'
import { writePiHooks } from '@intutic/sync-daemon'

const DETECT_FILE = '.pi/hooks.json'

export const piAdapter: IHarnessAdapter = {
  type: HarnessType.PI,
  configFileName: AGENTS_MD,

  async detect(workspaceRoot: string): Promise<boolean> {
    const globalPi = join(homedir(), '.pi')
    const localPi = join(workspaceRoot, DETECT_FILE)
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

  writeConfig(workspaceRoot: string, sops: SyncSopEntry[], proxyUrl: string): Promise<string | null> {
    return writeAgentsMd(workspaceRoot, sops, proxyUrl)
  },

  readCurrentHash(workspaceRoot: string): Promise<string | null> {
    return agentsMdHash(workspaceRoot)
  },
}
