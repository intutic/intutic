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

import { join, dirname } from 'node:path'
import { access, mkdir, writeFile, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { HarnessType } from '@intutic/shared-types'
import type { SyncSopEntry } from '@intutic/shared-types'
import type { IHarnessAdapter } from './types.js'
import { hashFile } from '../lib/hash.js'
import { buildMarkdownContent } from './base.js'
import { loadCredentials } from '../config/store.js'
import { writeGithubCopilotHooks } from '@intutic/sync-daemon'

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

  async writeConfig(workspaceRoot: string, sops: SyncSopEntry[], proxyUrl: string): Promise<string | null> {
    // The gate is installed even with zero SOPs: it is what refuses tool
    // calls, and the built-in protections apply without any SOP.
    const creds = await loadCredentials()
    await writeGithubCopilotHooks(workspaceRoot, proxyUrl, creds?.workspaceId || 'local')

    if (sops.length === 0) return null
    const filePath = join(workspaceRoot, CONFIG_FILE)
    const tmpPath = filePath + '.intutic-tmp'
    const content = buildMarkdownContent(sops, proxyUrl)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(tmpPath, content, 'utf-8')
    await rename(tmpPath, filePath)
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
