/**
 * githubCopilot.ts — GitHub Copilot adapter.
 *
 * Detects GitHub Copilot presence (.git, .github, or .github/copilot-instructions.md),
 * writes the rule sets as a marked section of `.github/copilot-instructions.md`
 * (the repository-wide instructions file Copilot adds to every chat, agent
 * and code-review request; https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions),
 * keeping the team's own instructions in it, and installs the
 * VS Code agent-mode PreToolUse gate (`.github/hooks/intutic-governance.json`
 * and `~/.copilot/hooks/intutic-governance.json`) — see githubCopilotHooks.ts.
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { join } from 'node:path'
import { access } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { HarnessType } from '@intutic/shared-types'
import type { SyncSopEntry } from '@intutic/shared-types'
import type { IHarnessAdapter } from './types.js'
import { loadCredentials } from '../config/store.js'
import { writeGithubCopilotHooks } from '@intutic/sync-daemon'
import { rulesSectionHash, writeRulesSectionFile } from './rulesFiles.js'

const CONFIG_FILE = '.github/copilot-instructions.md'

export const githubCopilotAdapter: IHarnessAdapter = {
  type: HarnessType.GITHUB_COPILOT,
  configFileName: CONFIG_FILE,

  async detect(workspaceRoot: string): Promise<boolean> {
    const gitFolder = join(workspaceRoot, '.git')
    const githubFolder = join(workspaceRoot, '.github')
    const configFile = join(workspaceRoot, CONFIG_FILE)
    try {
      if (existsSync(gitFolder) || existsSync(githubFolder)) return true
      await access(configFile)
      return true
    } catch {
      return false
    }
  },

  async installGate(workspaceRoot: string, proxyUrl: string): Promise<void> {
    const creds = await loadCredentials()
    await writeGithubCopilotHooks(workspaceRoot, proxyUrl, creds?.workspaceId || 'local')
  },

  writeConfig(workspaceRoot: string, sops: SyncSopEntry[], proxyUrl: string): Promise<string | null> {
    return writeRulesSectionFile(workspaceRoot, CONFIG_FILE, sops, proxyUrl)
  },

  readCurrentHash(workspaceRoot: string): Promise<string | null> {
    return rulesSectionHash(workspaceRoot, CONFIG_FILE)
  },
}
