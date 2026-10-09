/**
 * Harness adapter interface — contract for all harness integrations.
 *
 * Each adapter knows how to detect its harness, write governance
 * config to its native config file, and read the current file hash.
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * LLD #8 — Sync Daemon / CLI
 * @module
 */

import type { HarnessType, SyncSopEntry } from '@intutic/shared-types'

/** Contract implemented by each harness adapter. */
export interface IHarnessAdapter {
  /** Harness type identifier. */
  readonly type: HarnessType
  /**
   * The file drift is tracked on, relative to the workspace root: the
   * harness's rules file when it has one in the workspace (`rulesFileOf` in
   * `@intutic/shared-types`), else the workspace file the adapter writes; ''
   * for none.
   */
  readonly configFileName: string
  /** Detect whether this harness is present in the workspace. */
  detect(workspaceRoot: string): Promise<boolean>
  /**
   * Install what governs this harness whatever rule sets the workspace has:
   * its tool-call gate, and the proxy routing that rides with it. The gate
   * enforces the built-in protections, the destructive-command tier, group
   * rules and holds, none of which need a rule set, so `intutic connect` runs
   * this for every configured harness. Absent when the harness has no gate
   * Intutic installs.
   */
  installGate?(workspaceRoot: string, proxyUrl: string): Promise<void>
  /**
   * Write the rule sets into the file the harness reads as standing
   * instructions — the one `HARNESS_RULES_FILES` names, and no other.
   * `intutic connect` calls it only when a rule set targets the harness, or
   * on a forced sync. Returns the absolute path written, or null if nothing
   * was.
   */
  writeConfig(workspaceRoot: string, sops: SyncSopEntry[], proxyUrl: string): Promise<string | null>
  /** Read SHA-256 hash of current config file content. Returns null if file doesn't exist. */
  readCurrentHash(workspaceRoot: string): Promise<string | null>
}
