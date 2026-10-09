/**
 * hermes.ts — Hermes adapter.
 *
 * Detects Hermes presence and invokes the sync-daemon hooks compiler
 * to inject Intutic pre-tool use gates.
 *
 * Hermes loads the `AGENTS.md` files between the git root and where it runs,
 * unless a `.hermes.md` or `HERMES.md` is found first, which takes their
 * place; the rule sets go into the workspace's `AGENTS.md` through the shared
 * writer (agentsMd.ts;
 * https://github.com/NousResearch/hermes-agent/blob/8ac5c74432d1f217033993c8370e911b2c91b04a/agent/prompt_builder.py).
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
import { writeHermesHooks } from '@intutic/sync-daemon'

const DETECT_FILE = '.hermes/config.yaml'

export const hermesAdapter: IHarnessAdapter = {
  type: HarnessType.HERMES,
  configFileName: AGENTS_MD,

  async detect(workspaceRoot: string): Promise<boolean> {
    const globalHermes = join(homedir(), '.hermes')
    const localHermes = join(workspaceRoot, DETECT_FILE)
    try {
      if (existsSync(globalHermes)) return true
      await access(localHermes)
      return true
    } catch {
      return false
    }
  },

  async installGate(workspaceRoot: string, proxyUrl: string): Promise<void> {
    const creds = await loadCredentials()
    await writeHermesHooks(workspaceRoot, proxyUrl, creds?.workspaceId || 'local')
  },

  writeConfig(workspaceRoot: string, sops: SyncSopEntry[], proxyUrl: string): Promise<string | null> {
    return writeAgentsMd(workspaceRoot, sops, proxyUrl)
  },

  readCurrentHash(workspaceRoot: string): Promise<string | null> {
    return agentsMdHash(workspaceRoot)
  },
}
