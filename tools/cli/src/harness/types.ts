/**
 * Harness adapter interface — contract for all harness integrations.
 *
 * Each adapter knows how to detect its harness, write governance
 * config to its native config file, and read the current file hash.
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import type { HarnessType, SyncSopEntry } from '@intutic/shared-types'

/** How an adapter writes, beyond what to write. */
export interface HarnessWriteOptions {
  /**
   * Also point the harness's LLM traffic at the proxy (base URLs, HTTP proxy
   * settings). Default true, which is what `intutic connect` does. False
   * (`intutic gates install` without `--route`) writes the gate and the rules
   * only, so a harness keeps working when no proxy is running.
   */
  routing?: boolean
}

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
   * Intutic installs. With `opts.routing` false, the routing is left out.
   */
  installGate?(workspaceRoot: string, proxyUrl: string, opts?: HarnessWriteOptions): Promise<void>
  /**
   * Write the rule sets into the file the harness reads as standing
   * instructions — the one `HARNESS_RULES_FILES` names, and no other.
   * `intutic connect` calls it only when a rule set targets the harness, or
   * on a forced sync. Returns the absolute path written, or null if nothing
   * was. With `opts.routing` false, a config that also carries routing (Aider,
   * OpenHands) is written without it.
   */
  writeConfig(workspaceRoot: string, sops: SyncSopEntry[], proxyUrl: string, opts?: HarnessWriteOptions): Promise<string | null>
  /** Read SHA-256 hash of current config file content. Returns null if file doesn't exist. */
  readCurrentHash(workspaceRoot: string): Promise<string | null>
}
