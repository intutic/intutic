/**
 * agenticOrchestrator.ts — DoorDash "Agentic Orchestrator" adapter (binary
 * `agentico`, Go, Apache-2.0, `doordash-oss/agentic-orchestrator`).
 *
 * Agentic Orchestrator is NOT itself an AI agent — it is a desktop app +
 * CLI that turns a feature prompt into a multi-phase workflow (research,
 * planning, implementation, review, PR publish), delegating the actual
 * model-driving work to ALREADY-INSTALLED CLI backends: Claude Code, Codex,
 * and OpenCode (confirmed via `agentico server --help`'s `--providers`
 * flag: "Available: claude, codex, opencode"). Each feature runs in its own
 * `git worktree` under `~/.agentic-orchestrator/worktrees/` (confirmed via
 * the project's own README), the same "one workflow, one worktree" shape
 * Xirp uses — so the sync daemon's existing worktree propagation
 * (`services/sync-daemon/src/lib/gitWorktrees.ts`) already covers these
 * worktrees too, with no changes needed: `git worktree list --porcelain`
 * enumerates every worktree of a watched repo regardless of where under the
 * filesystem it lives.
 *
 * Unlike Xirp, this project's facts were LIVE-VERIFIED against the real
 * released artifact, not just its README: the actual `agentico` binary
 * (darwin_arm64, v0.152.0) was downloaded from a GitHub release and run
 * directly (`agentico --version`, `agentico --help`, `agentico server
 * --help`) during this integration's research. `--help`'s documented
 * defaults for `--config` (`~/.agentic-orchestrator/config.yaml`) and
 * `--state-dir` (`~/.agentic-orchestrator/features`) matched the README
 * exactly, with no env-var override for either path documented anywhere in
 * the binary's own help text (unlike Xirp's guessed `$XIRP_HOME`).
 *
 * `writeConfig` is a no-op for the same reason as Xirp's: this integration
 * introduces no config format of its own to gate. `config.yaml`'s
 * `defaults.models.*` keys select WHICH model each phase uses, not how that
 * phase's chosen backend reaches its LLM provider — that routing is each
 * wrapped backend's own concern (Claude Code's `.claude/settings.json` +
 * env vars, Codex's `~/.codex/config.toml`, OpenCode's own config), exactly
 * as it already is when those backends run standalone.
 *
 * KNOWN GAP (see module doc on `HarnessType.AGENTIC_ORCHESTRATOR` and
 * TD-397): OpenCode is one of the three wrapped backends but has no adapter
 * or gate anywhere in this registry — a feature run against the
 * `opencode:` provider has no Intutic governance today, unlike a Claude
 * Code- or Codex-backed feature. This adapter cannot fix that; it can only
 * detect that Agentic Orchestrator itself is present.
 *
 * See `services/sync-daemon/__tests__/harness/gateRegistry.ts`'s NO_GATE
 * row for `agentic-orchestrator` for the full governance rationale, and
 * `apps/docs/integrations/agentic-orchestrator.md` for user-facing docs.
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { access } from 'node:fs/promises'
import { accessSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { HarnessType } from '@intutic/shared-types'
import type { SyncSopEntry } from '@intutic/shared-types'
import type { IHarnessAdapter } from './types.js'

/** Confirmed default (via `agentico server --help`) — not a guess. */
const AGENTIC_ORCHESTRATOR_HOME_FRAGMENT = '.agentic-orchestrator'
/** Confirmed default install path for the macOS desktop app (README's
 *  `xattr -dr com.apple.quarantine /Applications/Agentico.app` note). */
const AGENTIC_ORCHESTRATOR_APP_PATH = '/Applications/Agentico.app'

export const agenticOrchestratorAdapter: IHarnessAdapter = {
  type: HarnessType.AGENTIC_ORCHESTRATOR,
  // No config file of its own — see module doc. Matches xirp.ts's/goose.ts's
  // convention of an empty HARNESS_CONFIG_FILES entry for a harness whose
  // governance-relevant writes are not a single named workspace-relative
  // file (in this case: no writes of its own at all, same as Xirp).
  configFileName: '',

  async detect(_workspaceRoot: string): Promise<boolean> {
    // 1. `~/.agentic-orchestrator` — confirmed default home directory (holds
    //    config.yaml, the features/ state dir, and worktrees/). Cross-
    //    platform: unlike xirp.ts, no `process.platform !== 'darwin'` guard
    //    here, since Agentic Orchestrator ships for both macOS and Linux
    //    (confirmed via the project's own release artifacts: darwin/linux,
    //    amd64/arm64).
    try {
      await access(join(homedir(), AGENTIC_ORCHESTRATOR_HOME_FRAGMENT))
      return true
    } catch { /* fall through */ }

    // 2. `agentico` on PATH — the same PATH-scan convention dsh.ts/grok.ts
    //    use for CLI-distributed binaries (Homebrew, a prebuilt release
    //    tarball extracted onto PATH, or `go install`).
    const pathDirs = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')
    for (const dir of pathDirs) {
      try {
        accessSync(join(dir, 'agentico'))
        return true
      } catch { /* not here */ }
    }

    // 3. `Agentico.app` installed in /Applications — the desktop app, macOS
    //    only. Confirmed path (see module doc); guarded to darwin only
    //    since this specific check is platform-specific even though the
    //    harness as a whole is not.
    if (process.platform === 'darwin') {
      try {
        await access(AGENTIC_ORCHESTRATOR_APP_PATH)
        return true
      } catch { /* fall through */ }
    }

    return false
  },

  // Agentic Orchestrator introduces no config format of its own — see
  // module doc. Nothing to write; each wrapped backend's own adapter
  // (claudeCode.ts / codex.ts — OpenCode has none, see TD-397) is what
  // writes real governance content, once per worktree Agentic Orchestrator
  // creates (the sync daemon's worktree propagation, not this adapter).
  async writeConfig(_workspaceRoot: string, _sops: SyncSopEntry[], _proxyUrl: string): Promise<string | null> {
    return null
  },

  async readCurrentHash(_workspaceRoot: string): Promise<string | null> {
    return null
  },
}
