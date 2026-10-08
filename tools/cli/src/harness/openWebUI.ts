/**
 * OpenWebUI adapter — writes the Open WebUI governance filter.
 *
 * OpenWebUI is a Docker-based service and cannot be reliably detected
 * via filesystem checks. Detection always returns false; the harness
 * is enabled by listing `open-webui` in the workspace's harnesses.
 *
 * Once enabled, each sync writes `~/.open-webui/intutic-governance-filter.py`
 * (see openWebuiHooks.ts). Open WebUI loads filters only through its admin UI,
 * so an admin pastes that file in as a Function once; this adapter cannot
 * install it into a running instance.
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import { HarnessType } from '@intutic/shared-types'
import type { SyncSopEntry } from '@intutic/shared-types'
import type { IHarnessAdapter } from './types.js'
import { loadCredentials } from '../config/store.js'
import { writeOpenWebuiHooks } from '@intutic/sync-daemon'

export const openWebUIAdapter: IHarnessAdapter = {
  type: HarnessType.OPEN_WEBUI,
  configFileName: '',

  async detect(_workspaceRoot: string): Promise<boolean> {
    return false
  },

  async writeConfig(workspaceRoot: string, _sops: SyncSopEntry[], proxyUrl: string): Promise<string | null> {
    const creds = await loadCredentials()
    await writeOpenWebuiHooks(workspaceRoot, proxyUrl, creds?.workspaceId || 'local')
    return join(homedir(), '.open-webui', 'intutic-governance-filter.py')
  },

  async readCurrentHash(): Promise<string | null> {
    return null
  },
}
