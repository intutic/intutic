/**
 * gateArtifacts.ts — where each hook-gated harness's gate file lives, so the
 * AI inventory can say whether it is on disk.
 *
 * Every path is the one the harness's writer emits, relative to the root it
 * was given: the `intutic connect` workspace, or the home directory for the
 * writers that install per user. The inventory looks under both. A harness
 * whose gate is not a file this daemon writes (`gateKind.ts`: `sdk`, `none`,
 * `delegated`, `bridge`) has no entry.
 *
 * `gateArtifacts.test.ts` holds this list to the gate registry the generated
 * gates are tested from (`__tests__/harness/gateRegistry.ts`), in both
 * directions, so a new or removed gate cannot leave it stale.
 *
 * @module
 */

import * as node_fs from 'node:fs/promises'
import * as node_path from 'node:path'
import type { HarnessType } from '@intutic/shared-types'
import { listDshProfileDirs, resolveDshHome } from './dshHooks.js'

/** Gate file paths per harness, relative to the workspace root or the home directory. */
export const GATE_ARTIFACTS: Readonly<Partial<Record<HarnessType, readonly string[]>>> = {
  'claude-code': ['.intutic/hooks/claude-code-check.js'],
  'cursor': ['.intutic/hooks/cursor-check.js'],
  'windsurf': ['.intutic/hooks/windsurf-check.js'],
  'codex': ['.intutic/hooks/codex-check.js'],
  'antigravity': ['.intutic/hooks/antigravity-check.sh', '.intutic/hooks/antigravity-cli-check.js'],
  'openhands': ['.intutic/hooks/openhands-check.sh'],
  'hermes': ['.intutic/hooks/hermes-check.sh'],
  'pi': ['.intutic/hooks/pi-check.sh'],
  'openclaw': ['.intutic/hooks/openclaw-check.js'],
  'muse-code': ['.intutic/hooks/muse-check.js'],
  'github-copilot': ['.intutic/hooks/github-copilot-check.js'],
  'grok': ['.intutic/hooks/grok-check.js'],
  'cline': ['.clinerules/hooks/PreToolUse'],
  'goose': ['.agents/plugins/intutic-governance/scripts/intutic-check.sh'],
  'opencode': ['.opencode/plugins/intutic-governance.js', '.opencode/plugins/intutic-governance/index.js'],
  'n8n': ['.intutic/hooks/n8n-governance-hook.js'],
  'open-webui': ['.open-webui/intutic-governance-filter.py'],
}

/** dsh's gate is a patch file in each profile under `$DSH_HOME/profiles`, whose names only the machine knows. */
export const DSH_PROFILE_GATE_FILE = 'cordis.patch.yml'

async function isFile(p: string): Promise<boolean> {
  try {
    return (await node_fs.stat(p)).isFile()
  } catch {
    return false
  }
}

/**
 * The absolute path of this harness's gate file if one is on disk, else null.
 * Only meaningful for a `hook`-gated harness; any other returns null.
 */
export async function findGateFile(harness: string, workspaceRoot: string, home: string): Promise<string | null> {
  if (harness === 'dsh') {
    for (const profile of await listDshProfileDirs(resolveDshHome())) {
      const file = node_path.join(profile, DSH_PROFILE_GATE_FILE)
      if (await isFile(file)) return file
    }
    return null
  }
  for (const rel of GATE_ARTIFACTS[harness as HarnessType] ?? []) {
    for (const root of [workspaceRoot, home]) {
      const file = node_path.join(root, rel)
      if (await isFile(file)) return file
    }
  }
  return null
}
