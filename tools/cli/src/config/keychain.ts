/**
 * keychain.ts — Secure credential storage using native OS commands.
 *
 * Utilizes:
 * - macOS: `security` command line tool
 * - Linux: `secret-tool` (libsecret-tools package)
 * - Windows: PowerShell against the WinRT `PasswordVault`
 *
 * Falls back to local credentials.json if the OS keychain utility is
 * unavailable, or if it accepts a token it cannot then return.
 *
 * LLD #14 — keychain.ts
 * HLD §3.14 — OS Keychain Storage
 *
 * @module
 */

import { execFileSync } from 'node:child_process'
import { log } from '../lib/logger.js'

const SERVICE_NAME = 'intutic'
const ACCOUNT_NAME = 'token'

/**
 * Escape a value for interpolation into a double-quoted PowerShell string.
 *
 * Only the target and account name go through here, and both are built from a
 * fixed prefix plus a workspace id, so this is belt-and-braces rather than a
 * live injection path. The token itself never appears in a script — it arrives
 * on stdin.
 */
function psLiteral(value: string): string {
  return value.replace(/[^A-Za-z0-9:_\-.]/g, '')
}

/**
 * The PowerShell preamble that loads the WinRT PasswordVault type.
 *
 * All three Windows operations must address this same vault. They did not: the
 * write half used `cmdkey /generic:`, which lands in Credential Manager, while
 * the read half asked the PasswordVault — a store that cannot see cmdkey's
 * entries. Every Windows login therefore stored a token nothing could retrieve.
 */
const PS_VAULT_PREAMBLE =
  '[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]; ' +
  '$v = New-Object Windows.Security.Credentials.PasswordVault'

/**
 * Stores token in OS Keychain. Returns true on success, false on failure/fallback.
 *
 * A `true` here means the token was written AND read back. Reporting success on
 * the strength of a zero exit code is what broke Windows: `saveCredentials`
 * replaces the token with the sentinel `'keychain'` whenever this returns true,
 * so a write that cannot be read back does not degrade to the JSON fallback —
 * it destroys the credential, and re-running `intutic login` destroys it again.
 * The read-back costs one extra keychain lookup per login.
 */
export async function storeToken(workspaceId: string, token: string): Promise<boolean> {
  const target = `${SERVICE_NAME}:workspace:${workspaceId}`
  try {
    if (process.platform === 'darwin') {
      // macOS keychain. `-w` last, with the password on stdin: given a value it
      // would sit in this process's argv, readable by anything running as the
      // same user. The prompt asks twice, hence the token twice.
      execFileSync(
        'security',
        ['add-generic-password', '-a', ACCOUNT_NAME, '-s', target, '-U', '-w'],
        { input: `${token}\n${token}\n`, stdio: ['pipe', 'ignore', 'ignore'] }
      )
    } else if (process.platform === 'linux') {
      // Linux libsecret (secret-tool)
      // Pass token via stdin to avoid exposing it in process tree
      execFileSync(
        'secret-tool',
        ['store', `--label=Intutic Workspace ${workspaceId}`, 'workspace', workspaceId, 'service', SERVICE_NAME],
        { input: token, stdio: 'pipe' }
      )
    } else if (process.platform === 'win32') {
      // Windows WinRT PasswordVault — the same store `retrieveToken` reads.
      // The token arrives on stdin rather than in the script or in argv, which
      // is what `cmdkey /pass:` got wrong.
      const psStore = [
        PS_VAULT_PREAMBLE,
        '$t = [Console]::In.ReadToEnd().Trim()',
        // Add() throws if the (resource, user) pair already exists, so clear
        // any previous login first. Absent is the normal case, hence the catch.
        `try { $v.Remove($v.Retrieve("${psLiteral(target)}", "${psLiteral(ACCOUNT_NAME)}")) } catch {}`,
        `$c = New-Object Windows.Security.Credentials.PasswordCredential("${psLiteral(target)}", "${psLiteral(ACCOUNT_NAME)}", $t)`,
        '$v.Add($c)',
      ].join('; ')
      execFileSync('powershell', ['-NoProfile', '-Command', psStore], {
        input: token,
        stdio: ['pipe', 'ignore', 'ignore'],
      })
    } else {
      return false
    }
  } catch (err) {
    log.dim(`OS Keychain save failed (falling back to credentials.json): ${err instanceof Error ? err.message : String(err)}`)
    return false
  }

  // Verify the write against the read path that will actually be used. A store
  // whose write succeeds and whose read comes back empty is not a store, and
  // the caller needs to know that now rather than on the next command.
  const readBack = await retrieveToken(workspaceId)
  if (readBack !== token) {
    log.dim('OS Keychain accepted the token but could not return it; using credentials.json instead.')
    return false
  }
  return true
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
      // WinRT PasswordVault — the store `storeToken` writes to.
      const psCommand = [
        PS_VAULT_PREAMBLE,
        `try { $c = $v.Retrieve("${psLiteral(target)}", "${psLiteral(ACCOUNT_NAME)}"); $c.RetrievePassword(); $c.Password } catch { exit 1 }`,
      ].join('; ')
      const output = execFileSync(
        'powershell',
        ['-NoProfile', '-Command', psCommand],
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
      const psDelete = [
        PS_VAULT_PREAMBLE,
        `$v.Remove($v.Retrieve("${psLiteral(target)}", "${psLiteral(ACCOUNT_NAME)}"))`,
      ].join('; ')
      execFileSync('powershell', ['-NoProfile', '-Command', psDelete], { stdio: 'ignore' })
      // Best-effort cleanup of the Credential Manager entry older builds wrote
      // and nothing could ever read. Failure is expected on a clean install.
      try {
        execFileSync('cmdkey', [`/delete:${target}`], { stdio: 'ignore' })
      } catch {
        // No legacy entry — nothing to clean up.
      }
      return true
    }
  } catch {
    // Key might not exist or tool unavailable
  }
  return false
}
