/**
 * gooseHardener.ts — Cross-platform immutable flag management for Goose plugin files.
 *
 * After the Goose governance plugin is written, this module applies:
 *   1. chmod 444 — no write for owner, group, or others
 *   2. OS-level immutable flag:
 *        macOS: chflags uchg (user immutable, does not require root)
 *        Linux: chattr +i (requires root; graceful fallback on permission error)
 *
 * The drift watcher checks for immutable status before auto-restoring.
 * If a file is immutable but has been tampered with, a governance_override_attempt
 * incident is emitted to the control plane instead of a silent restore.
 *
 * LLD #14 — Phase 3 cross-harness defence
 * HLD §3.14 — Three-Tier Defense Cascade
 *
 * @module
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createLogger } from '@intutic/logger'

const log = createLogger('sync-goose-hardener')
const execFileAsync = promisify(execFile)

/**
 * Apply chmod 444 and OS immutable flags to all files in the
 * Goose governance plugin directory.
 *
 * @param pluginDir - Absolute path to the plugin directory
 *                    (e.g. ~/.agents/plugins/intutic-governance)
 */
export async function hardenGoosePlugin(pluginDir: string): Promise<void> {
  const targets = [
    path.join(pluginDir, 'hooks', 'hooks.json'),
    path.join(pluginDir, 'scripts', 'intutic-check.sh'),
  ]

  for (const target of targets) {
    try {
      await fs.access(target)
    } catch {
      log.warn({ action: 'harden_skip', target }, 'Goose plugin file not found — skipping hardening')
      continue
    }

    // Step 1: chmod 444
    try {
      await fs.chmod(target, 0o444)
      log.debug({ action: 'chmod_444', target }, 'chmod 444 applied')
    } catch (err) {
      log.error({ action: 'chmod_failed', target, err }, 'chmod 444 failed')
    }

    // Step 2: OS immutable flag
    await applyImmutableFlag(target)
  }
}

/**
 * Remove immutable flags from a file (needed before sync daemon can overwrite
 * during a legitimate governance refresh).
 *
 * @param filePath - Absolute path to the file
 */
export async function unharden(filePath: string): Promise<void> {
  if (process.platform === 'darwin') {
    try {
      await execFileAsync('chflags', ['nouchg', filePath])
      log.debug({ action: 'chflags_nouchg', filePath }, 'Removed macOS uchg flag')
    } catch (err) {
      log.warn({ action: 'chflags_nouchg_failed', filePath, err }, 'chflags nouchg failed')
    }
  } else if (process.platform === 'linux') {
    try {
      await execFileAsync('chattr', ['-i', filePath])
      log.debug({ action: 'chattr_minus_i', filePath }, 'Removed Linux immutable flag')
    } catch {
      // Best-effort — may not have root
    }
  }
  // Restore writable mode temporarily
  try {
    await fs.chmod(filePath, 0o644)
  } catch { /* ignore */ }
}

/**
 * Check whether a file has an OS immutable flag set.
 * Used by the drift watcher to decide whether to restore or emit an incident.
 */
export async function isImmutable(filePath: string): Promise<boolean> {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('ls', ['-lO', filePath])
      return stdout.includes('uchg') || stdout.includes('uimmutable')
    } catch {
      return false
    }
  } else if (process.platform === 'linux') {
    try {
      const { stdout } = await execFileAsync('lsattr', [filePath])
      return stdout.includes('-i-') || /\bi\b/.test(stdout.split(' ')[0] ?? '')
    } catch {
      return false
    }
  }
  return false
}

// ─── Internal ────────────────────────────────────────────────────────

async function applyImmutableFlag(target: string): Promise<void> {
  if (process.platform === 'darwin') {
    try {
      await execFileAsync('chflags', ['uchg', target])
      log.info({ action: 'chflags_uchg', target }, 'macOS uchg immutable flag applied')
    } catch (err) {
      log.error({ action: 'chflags_uchg_failed', target, err }, 'chflags uchg failed')
    }
  } else if (process.platform === 'linux') {
    try {
      await execFileAsync('chattr', ['+i', target])
      log.info({ action: 'chattr_plus_i', target }, 'Linux immutable flag applied')
    } catch (err: unknown) {
      // chattr requires root on most distros; fail gracefully
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('Operation not permitted') || msg.includes('EPERM')) {
        log.warn(
          { action: 'chattr_needs_root', target },
          'chattr +i requires root — immutable flag not applied (chmod 444 still in effect)',
        )
      } else {
        log.error({ action: 'chattr_failed', target, err }, 'chattr +i failed unexpectedly')
      }
    }
  } else if (process.platform === 'win32') {
    // Windows: SetFileAttributes READONLY via attrib
    try {
      await execFileAsync('attrib', ['+R', target])
      log.info({ action: 'attrib_readonly', target }, 'Windows read-only attribute applied')
    } catch (err) {
      log.warn({ action: 'attrib_failed', target, err }, 'Windows attrib +R failed')
    }
  }
}
