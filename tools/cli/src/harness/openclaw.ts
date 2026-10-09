/**
 * openclaw.ts — OpenClaw adapter.
 *
 * Detects OpenClaw presence and invokes the sync-daemon hooks compiler
 * to inject Intutic pre-tool use gates.
 *
 * OpenClaw loads standing instructions only from its own agent workspace
 * (`AGENTS.md` and the other bootstrap files), never from a project, even
 * when it works in one. The rule sets therefore go into a marked section of
 * that workspace's `AGENTS.md` (see `openclawAgentWorkspace`), and the rest
 * of the file stays the user's. OpenClaw truncates a bootstrap file past
 * 20,000 characters
 * (https://github.com/openclaw/openclaw/blob/98457908cf3e4fbbd0354b530e0aa0d15b560158/docs/gateway/config-agents/workspace-and-bootstrap.md).
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { join } from 'node:path'
import { access, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { HarnessType } from '@intutic/shared-types'
import type { SyncSopEntry } from '@intutic/shared-types'
import type { IHarnessAdapter } from './types.js'
import { hashString } from '../lib/hash.js'
import { loadCredentials } from '../config/store.js'
import { openclawAgentWorkspace, rulesSectionOf, writeOpenclawHooks, writeRulesSection } from '@intutic/sync-daemon'
import { buildRulesBody } from './rulesFiles.js'

const DETECT_FILE = '.openclaw/openclaw.json'

export const openclawAdapter: IHarnessAdapter = {
  type: HarnessType.OPENCLAW,
  // The rules file is outside the workspace.
  configFileName: '',

  async detect(workspaceRoot: string): Promise<boolean> {
    const globalOpenclaw = join(homedir(), '.openclaw')
    const localOpenclaw = join(workspaceRoot, DETECT_FILE)
    try {
      if (existsSync(globalOpenclaw)) return true
      await access(localOpenclaw)
      return true
    } catch {
      return false
    }
  },

  async installGate(workspaceRoot: string, proxyUrl: string): Promise<void> {
    const creds = await loadCredentials()
    await writeOpenclawHooks(workspaceRoot, proxyUrl, creds?.workspaceId || 'local')
  },

  async writeConfig(workspaceRoot: string, sops: SyncSopEntry[], proxyUrl: string): Promise<string | null> {
    if (sops.length === 0) return null
    const filePath = join(await openclawAgentWorkspace(), 'AGENTS.md')
    await writeRulesSection(filePath, workspaceRoot, buildRulesBody(sops, proxyUrl, 'section'))
    return filePath
  },

  async readCurrentHash(): Promise<string | null> {
    try {
      const section = rulesSectionOf(await readFile(join(await openclawAgentWorkspace(), 'AGENTS.md'), 'utf-8'))
      return section === null ? null : hashString(section)
    } catch {
      return null
    }
  },
}
