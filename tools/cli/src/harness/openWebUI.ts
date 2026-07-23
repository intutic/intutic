/**
 * OpenWebUI adapter — detection-only stub for the OpenWebUI interface.
 *
 * OpenWebUI is a Docker-based service and cannot be reliably detected
 * via filesystem checks. Detection always returns false; the harness
 * can be manually enabled via CLI flags or org config.
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { HarnessType } from '@intutic/shared-types'
import type { IHarnessAdapter } from './types.js'

export const openWebUIAdapter: IHarnessAdapter = {
  type: HarnessType.OPEN_WEBUI,
  configFileName: '',

  async detect(_workspaceRoot: string): Promise<boolean> {
    return false
  },

  async writeConfig(): Promise<string | null> {
    return null
  },

  async readCurrentHash(): Promise<string | null> {
    return null
  },
}
