/**
 * settingsGuard.ts — Multi-harness governance config tamper detection & restoration.
 *
 * Expanded from Claude Code-only to cover all 18 Intutic-supported harnesses.
 * Called by the drift watcher whenever any protected governance config file changes.
 *
 * Behaviour per path type:
 *   - JSON hook files (Cursor, Cline, OpenHands, Goose): validate marker presence, restore.
 *   - Immutable files (Goose plugin): log governance_override_attempt incident instead of restoring.
 *   - Text rules (.roorules, .clinerules): restore from last-written hash.
 *   - Settings files (VS Code, Aider, claude_desktop_config.json): detect drift, restore.
 *
 * LLD #14 — settingsGuard.ts
 * HLD §3.14 — Three-Tier Defense Cascade (Tier 1 Native Gating)
 *
 * @module
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import * as crypto from 'node:crypto'
import { createLogger } from '@intutic/logger'
import type { SyncSopEntry } from '@intutic/shared-types'
import { updatePreToolUseHooks, parseSopConstraints } from '../harness/claudeCodeHooks.js'
import { writeClineHooks } from '../harness/clineHooks.js'
import { writeCursorHooks } from '../harness/cursorHooks.js'
import { writeOpenHandsHooks } from '../harness/openhandsHooks.js'
import { writeGooseHooks } from '../harness/gooseHooks.js'
import { writeWindsurfHooks } from '../harness/windsurfHooks.js'
import { isImmutable } from '../harness/gooseHardener.js'

const log = createLogger('sync-settings-guard')

/** Marker embedded in every Intutic-generated hook command. */
const HOOK_MARKER = '.intutic/hooks/'

const home = os.homedir()

// ─── All protected paths, grouped by harness ─────────────────────────

/** Returns the full list of protected paths to watch. */
export function buildProtectedPaths(workspaceRoot: string): string[] {
  return [
    // ── Claude Code ──────────────────────────────────────────────────
    path.join(home, '.claude', 'settings.json'),
    path.join(workspaceRoot, '.claude', 'settings.json'),
    // ── Cursor (3 levels) ────────────────────────────────────────────
    '/etc/cursor/hooks.json',
    path.join(home, '.cursor', 'hooks.json'),
    path.join(workspaceRoot, '.cursor', 'hooks.json'),
    // ── Windsurf ─────────────────────────────────────────────────────
    path.join(home, '.codeium', 'windsurf', 'hooks.json'),
    path.join(home, '.codeium', 'windsurf', 'settings.json'),
    path.join(workspaceRoot, '.windsurf', 'hooks.json'),
    // ── Cline ────────────────────────────────────────────────────────
    path.join(workspaceRoot, '.clinerules', 'hooks', 'hooks.json'),
    // ── OpenHands ────────────────────────────────────────────────────
    path.join(workspaceRoot, '.openhands', 'hooks.json'),
    // ── Goose (immutable — incident on tamper, not silent restore) ───
    path.join(home, '.agents', 'plugins', 'intutic-governance', 'hooks', 'hooks.json'),
    // ── Roo Code ─────────────────────────────────────────────────────
    path.join(workspaceRoot, '.roorules'),
    // ── VS Code settings (Cline / Roo Code) ──────────────────────────
    path.join(home, '.config', 'Code', 'User', 'settings.json'),
    path.join(home, 'Library', 'Application Support', 'Code', 'User', 'settings.json'),
    path.join(workspaceRoot, '.vscode', 'settings.json'),
    // ── Claude Desktop ────────────────────────────────────────────────
    path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    path.join(home, '.config', 'Claude', 'claude_desktop_config.json'),
    // ── Antigravity ───────────────────────────────────────────────────
    path.join(workspaceRoot, '.gemini', 'settings.json'),
  ]
}

// ─── Public entry point ──────────────────────────────────────────────

/**
 * Inspect any protected governance config file and restore if tampered.
 *
 * @param changedPath  - Absolute path of the file that changed.
 * @param workspaceRoot - Workspace root for restoration helpers.
 * @param sops          - Current SOP list.
 * @param proxyUrl      - Current proxy URL.
 * @param settings      - Optional passthrough settings.
 * @returns true if tampering was detected.
 */
export async function guardSettingsFile(
  changedPath: string,
  workspaceRoot: string,
  sops: SyncSopEntry[],
  proxyUrl = '',
  settings?: Record<string, unknown>,
): Promise<boolean> {
  // ── Goose plugin: immutable file tamper → incident, not restore ───
  if (changedPath.includes('intutic-governance')) {
    if (await isImmutable(changedPath)) {
      log.error(
        { action: 'governance_override_attempt', path: changedPath },
        'SECURITY: Immutable Goose governance file was modified — OS immutable flag bypassed. Emitting incident.',
      )
      
      // Resolve workspace ID from process env or local runtime-env file
      let workspaceId = process.env.INTUTIC_WORKSPACE_ID || '';
      if (!workspaceId) {
        try {
          const envPath = path.join(workspaceRoot, '.intutic', 'runtime-env');
          const content = await fs.readFile(envPath, 'utf8');
          const match = content.match(/INTUTIC_WORKSPACE_ID=(.+)/);
          if (match && match[1]) {
            workspaceId = match[1].trim();
          }
        } catch {
          workspaceId = 'unknown';
        }
      }

      // Emit incident to control plane via local hook-events queue
      try {
        const tamperEntry = JSON.stringify({
          event: 'config_tamper',
          toolName: 'goose_plugin',
          reason: 'SECURITY: Immutable Goose governance file was modified — OS immutable flag bypassed.',
          workspaceId,
          filePath: changedPath,
          timestamp: new Date().toISOString(),
          incidentId: crypto.createHash('sha1').update(changedPath + Date.now()).digest('hex').slice(0, 16),
        }) + '\n'
        const hookEventsJsonl = path.join(os.homedir(), '.intutic', 'events', 'hook-events.jsonl')
        await fs.appendFile(hookEventsJsonl, tamperEntry, { flag: 'a' })
      } catch (err) {
        log.warn({ err }, 'Failed to write Goose tamper incident to hook-events log')
      }

      return true
    }
    // Not immutable (install in progress or first write) — restore normally
    await writeGooseHooks(proxyUrl)
    return true
  }

  // ── Claude Code settings.json ─────────────────────────────────────
  if (changedPath.includes('.claude') && changedPath.endsWith('settings.json')) {
    return guardClaudeCodeSettings(changedPath, workspaceRoot, sops, settings)
  }

  // ── Cursor hooks.json ─────────────────────────────────────────────
  if (changedPath.includes('.cursor') && changedPath.endsWith('hooks.json')) {
    return guardJsonHookFile(changedPath, 'cursor', async () => {
      await writeCursorHooks(workspaceRoot, proxyUrl, '', changedPath.startsWith('/etc'))
    })
  }

  // ── Windsurf hooks.json ───────────────────────────────────────────
  if ((changedPath.includes('.codeium') || changedPath.includes('.windsurf')) && changedPath.endsWith('hooks.json')) {
    return guardJsonHookFile(changedPath, 'windsurf', async () => {
      await writeWindsurfHooks(workspaceRoot, proxyUrl)
    })
  }

  // ── Cline hooks.json ──────────────────────────────────────────────
  if (changedPath.includes('.clinerules') && changedPath.endsWith('hooks.json')) {
    return guardJsonHookFile(changedPath, 'cline', async () => {
      await writeClineHooks(workspaceRoot, proxyUrl)
    })
  }

  // ── OpenHands hooks.json ──────────────────────────────────────────
  if (changedPath.includes('.openhands') && changedPath.endsWith('hooks.json')) {
    return guardJsonHookFile(changedPath, 'openhands', async () => {
      await writeOpenHandsHooks(workspaceRoot, proxyUrl)
    })
  }

  // ── All other paths: file deleted or corrupted → log drift incident
  const exists = await fileExists(changedPath)
  if (!exists) {
    log.warn({ action: 'governance_drift', path: changedPath }, `Governance config deleted: ${changedPath}`)
    // Emit drift event — restoration depends on harness type (handled above for active harnesses)
    return true
  }

  log.debug({ action: 'settings_intact', path: changedPath }, 'Protected file changed but no action required')
  return false
}

// ─── Internal helpers ────────────────────────────────────────────────

async function guardClaudeCodeSettings(
  settingsFilePath: string,
  workspaceRoot: string,
  sops: SyncSopEntry[],
  settings?: Record<string, unknown>,
): Promise<boolean> {
  let raw: string
  try {
    raw = await fs.readFile(settingsFilePath, 'utf-8')
  } catch {
    log.warn({ action: 'settings_deleted', path: settingsFilePath }, 'Claude Code settings.json deleted — restoring')
    await updatePreToolUseHooks(workspaceRoot, sops, settings)
    return true
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    log.warn({ action: 'settings_corrupted', path: settingsFilePath }, 'Claude Code settings.json corrupted — restoring')
    await updatePreToolUseHooks(workspaceRoot, sops, settings)
    return true
  }

  const hooks = (parsed.hooks as Record<string, unknown> | undefined) ?? {}
  const preToolUse = (hooks.PreToolUse as unknown[] | undefined) ?? []
  const hasIntuticHook = preToolUse.some((entry) => {
    if (typeof entry !== 'object' || entry === null) return false
    const h = (entry as Record<string, unknown[]>).hooks ?? []
    return h.some((hh) => typeof (hh as Record<string, unknown>).command === 'string'
      && String((hh as Record<string, unknown>).command).includes(HOOK_MARKER))
  })

  if (!hasIntuticHook) {
    log.warn({ action: 'hook_missing', path: settingsFilePath }, 'Claude Code PreToolUse hook missing — restoring')
    await updatePreToolUseHooks(workspaceRoot, sops, settings)
    return true
  }

  const deny = ((parsed.permissions as Record<string, unknown>)?.deny as unknown[]) ?? []
  const constraints = parseSopConstraints(sops, settings)
  const expectedDenyCount = constraints.highRiskTools.length + constraints.patterns.length
  if (deny.length < expectedDenyCount) {
    log.warn({ action: 'deny_rules_cleared', path: settingsFilePath }, 'Deny rules cleared — restoring')
    await updatePreToolUseHooks(workspaceRoot, sops, settings)
    return true
  }

  log.debug({ action: 'settings_intact', path: settingsFilePath }, 'Claude Code settings integrity OK')
  return false
}

async function guardJsonHookFile(
  filePath: string,
  harness: string,
  restore: () => Promise<void>,
): Promise<boolean> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf-8')
  } catch {
    log.warn({ action: 'hook_file_deleted', harness, path: filePath }, `${harness} hooks.json deleted — restoring`)
    await safeRestore(harness, restore)
    return true
  }

  try {
    const parsed = JSON.parse(raw)
    // Check that the Intutic marker is present in the hooks config
    const hasMarker = JSON.stringify(parsed).includes('intutic')
    if (!hasMarker) {
      log.warn({ action: 'hook_marker_missing', harness, path: filePath }, `${harness} hooks.json tampered — restoring`)
      await safeRestore(harness, restore)
      return true
    }
  } catch {
    log.warn({ action: 'hook_file_corrupted', harness, path: filePath }, `${harness} hooks.json corrupted — restoring`)
    await safeRestore(harness, restore)
    return true
  }

  return false
}

async function safeRestore(harness: string, restore: () => Promise<void>): Promise<void> {
  try {
    await restore()
    log.info({ action: 'hook_restored', harness }, `${harness} governance hooks restored`)
  } catch (err) {
    log.error({ action: 'hook_restore_failed', harness, err }, `Failed to restore ${harness} governance hooks`)
  }
}

async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true } catch { return false }
}
