/**
 * rooCode.ts — Roo Code adapter.
 *
 * Detects the Roo Code VS Code extension and writes the rule sets into the
 * workspace's `AGENTS.md` through the shared writer (agentsMd.ts). Roo reads
 * `AGENTS.md` at the workspace root unless `roo-cline.useAgentRules` is off,
 * the default being on. Not `.roo/rules/`: once that directory has a file,
 * Roo stops reading a `.roorules` or `.clinerules` the user keeps
 * (https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/src/core/prompts/sections/custom-instructions.ts).
 * Earlier versions overwrote `.roorules`; the user's own copy comes back.
 *
 * Roo Code has no hook system to install a tool-call gate into, and keeps its
 * API provider and base URL in its own settings panel rather than in any file
 * this adapter can write, so routing it through the proxy is a manual step
 * (see the Roo Code integration page).
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { access, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { HarnessType } from '@intutic/shared-types'
import type { SyncSopEntry } from '@intutic/shared-types'
import type { IHarnessAdapter } from './types.js'
import { AGENTS_MD, agentsMdHash, writeAgentsMd } from './agentsMd.js'
import { retireLegacyRulesFile } from './rulesFiles.js'

const LEGACY_FILE = '.roorules'

export const rooCodeAdapter: IHarnessAdapter = {
  type: HarnessType.ROO_CODE,
  configFileName: AGENTS_MD,

  async detect(workspaceRoot: string): Promise<boolean> {
    for (const marker of ['.roomodes', LEGACY_FILE]) {
      try {
        await access(join(workspaceRoot, marker))
        return true
      } catch {
        // fall through
      }
    }

    try {
      const entries = await readdir(join(homedir(), '.vscode', 'extensions'))
      return entries.some((entry) => entry.startsWith('rooveterinaryinc.roo-cline-'))
    } catch {
      return false
    }
  },

  async writeConfig(workspaceRoot: string, sops: SyncSopEntry[], proxyUrl: string): Promise<string | null> {
    await retireLegacyRulesFile(workspaceRoot, LEGACY_FILE)
    return writeAgentsMd(workspaceRoot, sops, proxyUrl)
  },

  readCurrentHash(workspaceRoot: string): Promise<string | null> {
    return agentsMdHash(workspaceRoot)
  },
}
