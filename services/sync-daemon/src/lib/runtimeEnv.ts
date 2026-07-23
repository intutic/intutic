/**
 * runtimeEnv.ts — Runtime credential file writer.
 *
 * Writes `~/.intutic/env/runtime.env` on every sync cycle so that generated
 * hook scripts can source it at invocation time instead of having credentials
 * baked in at generation time. This means:
 *
 *   1. Key rotation is instant — next tool call picks up the new key.
 *   2. The key is never embedded in a hook script file on disk.
 *   3. The file is chmod 0600 (owner read/write only).
 *
 * Format (POSIX sh source-compatible):
 *
 *   INTUTIC_HOST=https://api.intutic.ai
 *   INTUTIC_API_KEY=sk-live-...
 *   INTUTIC_WORKSPACE_ID=ws_...
 *
 * LLD #14 — Dual-path hook telemetry (WS-A1)
 *
 * @module
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { createLogger } from '@intutic/logger'

const log = createLogger('sync-runtime-env')

/** Default path to the runtime env file sourced by all generated hook scripts. */
export const DEFAULT_RUNTIME_ENV_PATH = path.join(os.homedir(), '.intutic', 'env', 'runtime.env')

export interface RuntimeEnvOptions {
  /** Control plane base URL (e.g., `https://api.intutic.ai`). */
  controlPlaneUrl: string
  /** Workspace API key. */
  apiKey: string
  /** Workspace identifier. */
  workspaceId: string
  /** Override path (defaults to `~/.intutic/env/runtime.env`). */
  envPath?: string
  /** WS-5 Q1: 'open' | 'closed' (default: 'open') */
  mcpProxyFailBehavior?: string
  /** WS-5 Q2: 'per-session' | 'daemon' (default: 'per-session') */
  mcpProxyMode?: string
  /** WS-5 Q3: 'rewrite' | 'immutable' | 'alert-only' (default: 'rewrite') */
  bypassEnforcementTier?: string
}

/**
 * Write runtime credentials to `~/.intutic/env/runtime.env`.
 *
 * Uses atomic rename (.tmp -> final) so hook scripts never read a partial
 * file. Sets permissions to 0o600 (owner read/write only).
 *
 * Safe to call on every sync cycle — idempotent, fast (single write).
 */
export async function writeRuntimeEnv(opts: RuntimeEnvOptions): Promise<void> {
  const envPath = opts.envPath ?? DEFAULT_RUNTIME_ENV_PATH
  const envDir = path.dirname(envPath)

  await fs.mkdir(envDir, { recursive: true })

  // Sanitise values: strip newlines to prevent injection into the env file
  const host = (opts.controlPlaneUrl ?? '').replace(/[\r\n]/g, '')
  const key = (opts.apiKey ?? '').replace(/[\r\n]/g, '')
  const wsId = (opts.workspaceId ?? '').replace(/[\r\n]/g, '')

  const content = [
    `# Intutic hook runtime credentials — auto-generated. DO NOT EDIT.`,
    `# Sourced by ~/.intutic/hooks/*.sh and parsed by ~/.intutic/hooks/*.js at invocation time.`,
    `# To rotate your API key: update via the Intutic control plane — daemon refreshes this file automatically.`,
    `# WS-5: INTUTIC_MCP_FAIL_OPEN (Q1), INTUTIC_MCP_PROXY_MODE (Q2), INTUTIC_BYPASS_TIER (Q3) are written on every sync.`,
    `INTUTIC_HOST=${host}`,
    `INTUTIC_API_KEY=${key}`,
    `INTUTIC_WORKSPACE_ID=${wsId}`,
    `INTUTIC_MCP_FAIL_OPEN=${(opts.mcpProxyFailBehavior ?? 'open') !== 'closed' ? 'true' : 'false'}`,
    `INTUTIC_MCP_PROXY_MODE=${opts.mcpProxyMode ?? 'per-session'}`,
    `INTUTIC_BYPASS_TIER=${opts.bypassEnforcementTier ?? 'rewrite'}`,
    ``,
    `# LLM proxy routing (uncomment when Intutic Rust proxy is running on port 8080)`,
    `# GOOSE_BASE_URL=http://127.0.0.1:8080`,
    `# OPENAI_BASE_URL=http://127.0.0.1:8080`,
    `# ANTHROPIC_BASE_URL=http://127.0.0.1:8080`,
    `# LLM_BASE_URL=http://127.0.0.1:8080`,
    ``,
  ].join('\n')

  const tmpPath = envPath + '.tmp'
  await fs.writeFile(tmpPath, content, { encoding: 'utf-8' })
  await fs.chmod(tmpPath, 0o600)
  await fs.rename(tmpPath, envPath)

  log.debug({ action: 'runtime_env_written', path: envPath }, 'Runtime env file refreshed')
}
