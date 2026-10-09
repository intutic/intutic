/**
 * Claude Code adapter — rule sets in `.claude/rules/intutic-governance.md`.
 *
 * Claude Code loads every `.claude/rules/*.md` without `paths:` front matter
 * at launch, with the priority of `.claude/CLAUDE.md`
 * (https://code.claude.com/docs/en/memory). Not `CLAUDE.md` itself, which is
 * usually the team's own: and under Claude Code's default setting a project
 * `CLAUDE.md` stops it reading `AGENTS.md`, so creating one would hide a
 * team's `AGENTS.md` from it. Earlier versions overwrote `CLAUDE.md`; the
 * user's own copy comes back.
 *
 * The gate is installed by `intutic connect`'s own step, with the synced
 * settings its deny rules need.
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { HarnessType } from '@intutic/shared-types'
import type { SyncSopEntry } from '@intutic/shared-types'
import type { IHarnessAdapter } from './types.js'
import { ownRulesFileHash, retireLegacyRulesFile, writeOwnRulesFile } from './rulesFiles.js'

const RULES_FILE = '.claude/rules/intutic-governance.md'
const LEGACY_FILE = 'CLAUDE.md'

export const claudeCodeAdapter: IHarnessAdapter = {
  type: HarnessType.CLAUDE_CODE,
  configFileName: RULES_FILE,

  async detect(workspaceRoot: string): Promise<boolean> {
    try {
      await access(join(workspaceRoot, LEGACY_FILE))
      return true
    } catch {
      return false
    }
  },

  async writeConfig(workspaceRoot: string, sops: SyncSopEntry[], proxyUrl: string): Promise<string | null> {
    await retireLegacyRulesFile(workspaceRoot, LEGACY_FILE)
    return writeOwnRulesFile(workspaceRoot, RULES_FILE, sops, proxyUrl)
  },

  readCurrentHash(workspaceRoot: string): Promise<string | null> {
    return ownRulesFileHash(workspaceRoot, RULES_FILE)
  },
}
