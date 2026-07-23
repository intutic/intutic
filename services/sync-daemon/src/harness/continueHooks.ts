/**
 * continueHooks.ts — Continue.dev governance via proxy routing.
 *
 * Continue.dev has no native hook system. Governance is applied by routing
 * all model API calls through the Intutic proxy: each model's `apiBase`
 * field is set to `proxyUrl` in `~/.continue/config.json`.
 *
 * JSONC handling: ~/.continue/config.json allows `// comments`. We strip
 * single-line comments with a regex before parsing, then write back as
 * standard JSON with a managed-file header comment.
 *
 * LLD #14 — Phase 3 cross-harness defence (Gap 3, WS-B)
 * HLD §3.14 — Three-Tier Defense Cascade (Tier 1 Native Gating)
 *
 * @module
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { createLogger } from '@intutic/logger'
import { newIso } from '@intutic/id'

const log = createLogger('sync-continue-hooks')

/** Default path to the Continue.dev global config file. */
const CONTINUE_CONFIG_PATH = path.join(os.homedir(), '.continue', 'config.json')

/** Governance notice injected into customInstructions. */
const GOVERNANCE_NOTICE = [
  'This workspace is governed by Intutic SOP policies.',
  'All LLM API requests are routed through the Intutic governance proxy.',
  'Do not remove or override the apiBase field in this configuration.',
].join(' ')

// ─── JSONC comment stripper ───────────────────────────────────────────────────

/**
 * Strip single-line `// ...` comments from a JSONC string so it can be
 * parsed by JSON.parse. Block comments (`/* ... *\/`) are not stripped
 * because they are uncommon in Continue config files.
 */
function stripJsoncComments(raw: string): string {
  // Remove // comments that are not inside strings.
  // Simple approach: replace // up to end-of-line (acceptable for Continue config).
  return raw.replace(/\/\/[^\n]*/g, '')
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Configure Continue.dev to route all model API calls through the Intutic proxy.
 *
 *  1. Reads `~/.continue/config.json` (JSONC — strips // comments before parsing).
 *  2. Sets `apiBase = proxyUrl` on each model that doesn't already use it.
 *  3. Adds a `customInstructions` governance notice.
 *  4. Writes the merged result back atomically.
 *  5. Writes `.intutic/env/continue.env` with the proxy URL.
 *
 * Safe to call repeatedly — uses atomic rename (`.intutic-tmp` → final path).
 *
 * @param workspaceRoot - Absolute workspace root path.
 * @param proxyUrl      - Intutic proxy URL to set as model apiBase.
 * @param workspaceId   - Workspace ID stored in the env snippet.
 */
export async function writeContinueHooks(
  workspaceRoot: string,
  proxyUrl: string,
  workspaceId = '',
): Promise<void> {
  // ── 1. Ensure directories ──────────────────────────────────────────────────

  const continueDir = path.join(os.homedir(), '.continue')
  const envDir = path.join(workspaceRoot, '.intutic', 'env')

  await Promise.all([
    fs.mkdir(continueDir, { recursive: true }),
    fs.mkdir(envDir, { recursive: true }),
  ])

  // ── 2. Read and parse ~/.continue/config.json ─────────────────────────────

  let configObj: Record<string, unknown> = {}
  try {
    const raw = await fs.readFile(CONTINUE_CONFIG_PATH, 'utf-8')
    const stripped = stripJsoncComments(raw)
    configObj = JSON.parse(stripped)
  } catch {
    // File doesn't exist or is malformed — start with empty config
    log.warn({ action: 'continue_config_read_failed', path: CONTINUE_CONFIG_PATH }, 'Could not read ~/.continue/config.json — creating fresh')
  }

  // ── 3. Update model apiBase fields ────────────────────────────────────────

  const models = Array.isArray(configObj.models) ? configObj.models : []
  let modifiedCount = 0

  const updatedModels = models.map((model: unknown) => {
    if (typeof model !== 'object' || model === null) return model
    const m = model as Record<string, unknown>
    if (m.apiBase === proxyUrl) return m // Already set — no-op
    modifiedCount++
    return { ...m, apiBase: proxyUrl }
  })

  // ── 4. Build merged config ────────────────────────────────────────────────

  const mergedConfig: Record<string, unknown> = {
    ...configObj,
    // Re-attach updated models array (or keep original if empty)
    ...(models.length > 0 ? { models: updatedModels } : {}),
    // Add/overwrite customInstructions with governance notice
    customInstructions: GOVERNANCE_NOTICE,
    // Metadata fields
    _intutic_managed: true,
    _intutic_last_sync: newIso(),
    _intutic_workspace_id: workspaceId,
  }

  // ── 5. Write back atomically ──────────────────────────────────────────────

  // Prepend a managed-file warning as a comment (will be lost on next read —
  // that's acceptable; we re-add it on each sync).
  const managedHeader = `// AUTO-MANAGED by Intutic sync-daemon. Last sync: ${newIso()}\n// Do not edit apiBase fields — they are governance proxy routes.\n`
  const serialized = managedHeader + JSON.stringify(mergedConfig, null, 2) + '\n'

  const tmpConfig = CONTINUE_CONFIG_PATH + '.intutic-tmp'
  await fs.writeFile(tmpConfig, serialized, 'utf-8')
  await fs.rename(tmpConfig, CONTINUE_CONFIG_PATH)

  log.info(
    { action: 'continue_config_written', path: CONTINUE_CONFIG_PATH, modifiedModels: modifiedCount },
    'Continue.dev config patched with Intutic proxy apiBase',
  )

  // ── 6. Write .intutic/env/continue.env ────────────────────────────────────

  const envContent = [
    `# Intutic Continue.dev governance env — auto-generated ${newIso()}`,
    `# This file is managed by the Intutic sync-daemon. DO NOT EDIT.`,
    `CONTINUE_PROXY_URL=${proxyUrl}`,
    workspaceId ? `INTUTIC_WORKSPACE_ID=${workspaceId}` : '',
    `# All Continue.dev model requests are routed through CONTINUE_PROXY_URL.`,
  ].filter((l) => l !== '').join('\n') + '\n'

  const envFilePath = path.join(envDir, 'continue.env')
  const tmpEnv = envFilePath + '.intutic-tmp'
  await fs.writeFile(tmpEnv, envContent, 'utf-8')
  await fs.rename(tmpEnv, envFilePath)

  log.info(
    { action: 'continue_env_written', path: envFilePath },
    'Continue.dev env snippet written',
  )
}
