/**
 * keychain.ts — Secure credential storage using native OS commands.
 *
 * Utilizes:
 * - macOS: `security` command line tool
 * - Linux: `secret-tool` (libsecret-tools package)
 * - Windows: `cmdkey` (Credential Manager CLI) and PowerShell fallback
 *
 * Falls back to local credentials.json if OS keychain utility is unavailable.
 *
 * LLD #14 — keychain.ts
 * HLD §3.14 — OS Keychain Storage
 *
 * @module
 */

import { execFileSync, execSync } from 'node:child_process'
import { log } from '../lib/logger.js'

const SERVICE_NAME = 'intutic'
const ACCOUNT_NAME = 'token'

/**
 * Stores token in OS Keychain. Returns true on success, false on failure/fallback.
 */
export async function storeToken(workspaceId: string, token: string): Promise<boolean> {
  const target = `${SERVICE_NAME}:workspace:${workspaceId}`
  try {
    if (process.platform === 'darwin') {
      // macOS keychain
      execFileSync(
        'security',
        ['add-generic-password', '-a', ACCOUNT_NAME, '-s', target, '-w', token, '-U'],
        { stdio: 'ignore' }
      )
      return true
    } else if (process.platform === 'linux') {
      // Linux libsecret (secret-tool)
      // Pass token via stdin to avoid exposing it in process tree
      execFileSync(
        'secret-tool',
        ['store', `--label=Intutic Workspace ${workspaceId}`, 'workspace', workspaceId, 'service', SERVICE_NAME],
        { input: token, stdio: 'pipe' }
      )
      return true
    } else if (process.platform === 'win32') {
      // Windows cmdkey (Credential Manager)
      execFileSync(
        'cmdkey',
        [`/generic:${target}`, `/user:${ACCOUNT_NAME}`, `/pass:${token}`],
        { stdio: 'ignore' }
      )
      return true
    }
  } catch (err) {
    log.dim(`OS Keychain save failed (falling back to credentials.json): ${err instanceof Error ? err.message : String(err)}`)
  }
  return false
}

/**
 * Retrieves token from OS Keychain. Returns null if absent/fallback.
 */
export async function retrieveToken(workspaceId: string): Promise<string | null> {
  const target = `${SERVICE_NAME}:workspace:${workspaceId}`
  try {
    if (process.platform === 'darwin') {
      const output = execFileSync(
        'security',
        ['find-generic-password', '-a', ACCOUNT_NAME, '-s', target, '-w'],
        { encoding: 'utf-8', stdio: 'pipe' }
      )
      return output.trim()
    } else if (process.platform === 'linux') {
      const output = execFileSync(
        'secret-tool',
        ['lookup', 'workspace', workspaceId, 'service', SERVICE_NAME],
        { encoding: 'utf-8', stdio: 'pipe' }
      )
      return output.trim()
    } else if (process.platform === 'win32') {
      // Windows Credential Manager lookup via PowerShell
      const psCommand = `[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]; $v = New-Object Windows.Security.Credentials.PasswordVault; try { $c = $v.Retrieve("${target.replace(/"/g, '')}", "${ACCOUNT_NAME}"); $c.RetrievePassword(); $c.Password } catch { exit 1 }`
      const output = execFileSync(
        'powershell',
        ['-Command', psCommand],
        { encoding: 'utf-8', stdio: 'pipe' }
      )
      return output.trim()
    }
  } catch {
    // Normal case: key doesn't exist, or tool unavailable. Fallback handles it.
  }
  return null
}

/**
 * Deletes token from OS Keychain. Returns true on success.
 */
export async function deleteToken(workspaceId: string): Promise<boolean> {
  const target = `${SERVICE_NAME}:workspace:${workspaceId}`
  try {
    if (process.platform === 'darwin') {
      execFileSync(
        'security',
        ['delete-generic-password', '-a', ACCOUNT_NAME, '-s', target],
        { stdio: 'ignore' }
      )
      return true
    } else if (process.platform === 'linux') {
      execFileSync(
        'secret-tool',
        ['clear', 'workspace', workspaceId, 'service', SERVICE_NAME],
        { stdio: 'ignore' }
      )
      return true
    } else if (process.platform === 'win32') {
      execFileSync(
        'cmdkey',
        [`/delete:${target}`],
        { stdio: 'ignore' }
      )
      return true
    }
  } catch {
    // Key might not exist or tool unavailable
  }
  return false
}
