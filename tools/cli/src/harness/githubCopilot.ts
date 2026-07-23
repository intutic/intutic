/**
 * githubCopilot.ts — GitHub Copilot adapter.
 *
 * Detects GitHub Copilot presence (.git, .github, or .github/copilot-instructions.md)
 * and writes Markdown rules to `.github/copilot-instructions.md`.
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
