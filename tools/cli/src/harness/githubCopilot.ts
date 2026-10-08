/**
 * githubCopilot.ts — GitHub Copilot adapter.
 *
 * Detects GitHub Copilot presence (.git, .github, or .github/copilot-instructions.md),
 * writes Markdown rules to `.github/copilot-instructions.md`, and installs the
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
import { hashFile } from '../lib/hash.js'
import { buildMarkdownContent } from './base.js'
import { loadCredentials } from '../config/store.js'
import { writeGithubCopilotHooks, writeOwnedFile } from '@intutic/sync-daemon'

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

  async writeConfig(workspaceRoot: string, sops: SyncSopEntry[], proxyUrl: string): Promise<string | null> {
    if (sops.length === 0) return null
    const filePath = join(workspaceRoot, CONFIG_FILE)
    const content = buildMarkdownContent(sops, proxyUrl)
    await writeOwnedFile(filePath, workspaceRoot, content)
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
