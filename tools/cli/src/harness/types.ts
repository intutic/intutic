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
  /** Config file name relative to workspace root. */
  readonly configFileName: string
  /** Detect whether this harness is present in the workspace. */
  detect(workspaceRoot: string): Promise<boolean>
  /**
   * Write governance config to the harness's native config file.
   * Returns the absolute path written, or null if skipped.
   */
  writeConfig(workspaceRoot: string, sops: SyncSopEntry[], proxyUrl: string): Promise<string | null>
  /** Read SHA-256 hash of current config file content. Returns null if file doesn't exist. */
  readCurrentHash(workspaceRoot: string): Promise<string | null>
}

/** Harness config file mapping for file-based harnesses. */
export const HARNESS_CONFIG_FILES: Record<HarnessType, string> = {
  'cursor': '.cursorrules',
  'claude-code': 'CLAUDE.md',
  'antigravity': '.gemini/settings.json',
  'windsurf': '.windsurfrules',
  'aider': '.aider.conf.yml',
  'openhands': 'config.toml',
  'codex': '.env.intutic',
  'n8n': '', // Phase 2 — TD-037: API call, not file write
  'openclaw': '.openclaw/openclaw.json',
  'hermes': '.hermes/config.yaml',
  'pi': '.pi/hooks.json',
  'github-copilot': '.github/copilot-instructions.md',
  'cline': '',
  'roo-code': '',
  'continue': '',
  'claude-desktop': '',
  'goose': '',
  'open-webui': '',
}
