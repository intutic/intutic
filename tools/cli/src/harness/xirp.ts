/**
 * xirp.ts — Spotify "Xirp" adapter (macOS-only desktop orchestrator, beta
 * since 2026-08-11).
 *
 * Xirp is NOT itself an AI agent — it is an orchestrator that spawns one or
 * more ALREADY-INSTALLED CLI coding agents (Claude Code, Codex, Gemini CLI)
 * each inside its own tmux session and `git worktree`, so a developer can run
 * several parallel agent sessions against the same repository without their
 * working-tree state colliding. Per Xirp's own public FAQ, it preserves each
 * wrapped harness's NATIVE, UNMODIFIED configuration — it introduces no
 * config format of its own for Intutic to parse or gate.
 *
 * That means this adapter exists for DETECTION/reporting only. `writeConfig`
 * writes nothing: whatever Intutic already writes for the wrapped harness
 * (`claudeCode.ts` / `codex.ts` / `antigravity.ts`'s own adapters) is what
 * governs a tool call made inside a Xirp-managed session — PROVIDED those
 * files actually reach the git worktree Xirp creates for that session, which
 * they do not by default: a worktree checkout has its own independent
 * working tree, and project-tier governance files are untracked. Part B of
 * the phase that added this adapter (`services/sync-daemon/src/lib/
 * gitWorktrees.ts` + its wiring into `syncLoop.ts`) is what closes that gap;
 * this adapter's only job is recognising that a Xirp-managed workspace is
 * present at all, so `intutic status`/`intutic init` can report it.
 *
 * See `services/sync-daemon/__tests__/harness/gateRegistry.ts`'s NO_GATE row
 * for `xirp` for the full governance rationale, and
 * `apps/docs/integrations/xirp.md` for user-facing docs.
 *
 * # Unconfirmed facts (flagged, not silently assumed)
 *
 * Xirp is a macOS-only beta app with no CLI/npm package and no public
 * download available in this environment, so none of the detection paths
 * below were live-verified against a real install — they follow this
 * codebase's own convention for comparable tools (`~/.grok`, `~/.muse`,
 * `<Name>.app` in `/Applications`) rather than a confirmed Xirp source. See
 * TD-390.
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { HarnessType } from '@intutic/shared-types'
import type { SyncSopEntry } from '@intutic/shared-types'
import type { IHarnessAdapter } from './types.js'

/** Best-effort assumed default — see module doc's "Unconfirmed facts". */
const XIRP_HOME_FRAGMENT = '.xirp'
/** Best-effort assumed default — see module doc's "Unconfirmed facts". */
const XIRP_APP_PATH = '/Applications/Xirp.app'

export const xirpAdapter: IHarnessAdapter = {
  type: HarnessType.XIRP,
  // No config file of its own — see module doc. Matches the goose/cline-
  // style convention of an empty HARNESS_CONFIG_FILES entry for a harness
  // whose governance-relevant writes are not a single named file (in Xirp's
  // case: no writes of its own at all).
  configFileName: '',

  async detect(_workspaceRoot: string): Promise<boolean> {
    // Xirp is macOS-only (per its own FAQ) — guard before touching any
    // macOS-specific path so this adapter is a clean no-op elsewhere.
    if (process.platform !== 'darwin') return false

    // 1. `$XIRP_HOME` env var, if the user (or Xirp itself) has set one.
    const envHome = process.env.XIRP_HOME
    if (envHome) {
      try {
        await access(envHome)
        return true
      } catch { /* fall through */ }
    }

    // 2. `~/.xirp` — assumed default install/state directory.
    try {
      await access(join(homedir(), XIRP_HOME_FRAGMENT))
      return true
    } catch { /* fall through */ }

    // 3. `Xirp.app` installed in /Applications.
    try {
      await access(XIRP_APP_PATH)
      return true
    } catch { /* fall through */ }

    return false
  },

  // Xirp introduces no config format of its own — see module doc. Nothing to
  // write; the wrapped harness's own adapter is what writes real governance
  // content, once per worktree Xirp creates (the sync daemon's worktree
  // propagation, not this adapter).
  async writeConfig(_workspaceRoot: string, _sops: SyncSopEntry[], _proxyUrl: string): Promise<string | null> {
    return null
  },

  async readCurrentHash(_workspaceRoot: string): Promise<string | null> {
    return null
  },
}
