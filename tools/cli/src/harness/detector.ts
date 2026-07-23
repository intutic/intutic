/**
 * Harness detector — auto-detect which AI harnesses are present.
 *
 * Instantiates all 14 adapters and checks each for presence in
 * the workspace. Returns a DetectedHarness array for reporting.
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * LLD #8 — Sync Daemon / CLI
 * @module
 */

import type { DetectedHarness } from '@intutic/shared-types'
import type { IHarnessAdapter } from './types.js'
import { cursorAdapter } from './cursor.js'
import { claudeCodeAdapter } from './claudeCode.js'
import { antigravityAdapter } from './antigravity.js'
import { windsurfAdapter } from './windsurf.js'
import { aiderAdapter } from './aider.js'
import { openhandsAdapter } from './openhands.js'
import { codexAdapter } from './codex.js'
import { n8nAdapter } from './n8n.js'
import { clineAdapter } from './cline.js'
import { rooCodeAdapter } from './rooCode.js'
import { continueAdapter } from './continue.js'
import { claudeDesktopAdapter } from './claudeDesktop.js'
import { gooseAdapter } from './goose.js'
import { openWebUIAdapter } from './openWebUI.js'
import { openclawAdapter } from './openclaw.js'
import { piAdapter } from './pi.js'
import { hermesAdapter } from './hermes.js'
import { githubCopilotAdapter } from './githubCopilot.js'
import { join } from 'node:path'

/** All registered harness adapters. */
export const ALL_ADAPTERS: IHarnessAdapter[] = [
  cursorAdapter,
  claudeCodeAdapter,
  antigravityAdapter,
  windsurfAdapter,
  aiderAdapter,
  openhandsAdapter,
  codexAdapter,
  n8nAdapter,
  clineAdapter,
  rooCodeAdapter,
  continueAdapter,
  claudeDesktopAdapter,
  gooseAdapter,
  openWebUIAdapter,
  openclawAdapter,
  piAdapter,
  hermesAdapter,
  githubCopilotAdapter,
]

/**
 * Detect which harnesses are present in a workspace.
 *
 * @param workspaceRoot - Absolute path to workspace root
 * @returns Array of DetectedHarness results
 */
export async function detectHarnesses(workspaceRoot: string): Promise<DetectedHarness[]> {
  const results: DetectedHarness[] = []

  for (const adapter of ALL_ADAPTERS) {
    const detected = await adapter.detect(workspaceRoot)
    results.push({
      type: adapter.type,
      configPath: adapter.configFileName
        ? join(workspaceRoot, adapter.configFileName)
        : '',
      detected,
      lastWriteAt: null,
    })
  }

  return results
}

/**
 * Get adapter for a specific harness type.
 *
 * @param type - Harness type to look up
 * @returns The adapter, or undefined if not found
 */
export function getAdapter(type: string): IHarnessAdapter | undefined {
  return ALL_ADAPTERS.find((a) => a.type === type)
}
