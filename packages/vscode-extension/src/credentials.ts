/**
 * The control plane the extension's panels read, and the key to read it with.
 *
 * `intutic login` writes ~/.intutic/credentials.json. When the OS keychain
 * accepted the token, the file holds the sentinel `apiKey: 'keychain'` and the
 * token lives in the keychain under the service `intutic:workspace:<id>` and
 * the account `token`, the names tools/cli/src/config/keychain.ts writes (a
 * test holds the two together). The extension used to send the sentinel itself
 * as the bearer token, so on a machine with a keychain every panel got a 401.
 *
 * The address: the `intutic.controlPlaneUrl` setting, then
 * `INTUTIC_CONTROL_PLANE_URL`, then the file. There is no default address.
 */
import { execFile } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export interface IntuticCreds {
  controlPlaneUrl?: string
  apiKey?: string
  workspaceId?: string
}

/** The keychain names the CLI writes (tools/cli/src/config/keychain.ts). */
export const KEYCHAIN_SERVICE = 'intutic'
export const KEYCHAIN_ACCOUNT = 'token'
const KEYCHAIN_SENTINEL = 'keychain'

function run(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: 'utf-8', timeout: 4000 }, (err, stdout) => resolve(err ? null : stdout.trim() || null))
  })
}

/** The token `intutic login` stored in the OS keychain, or null. */
export async function keychainToken(workspaceId: string): Promise<string | null> {
  const target = `${KEYCHAIN_SERVICE}:workspace:${workspaceId}`
  if (process.platform === 'darwin') {
    return run('security', ['find-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', target, '-w'])
  }
  if (process.platform === 'linux') {
    return run('secret-tool', ['lookup', 'workspace', workspaceId, 'service', KEYCHAIN_SERVICE])
  }
  if (process.platform === 'win32') {
    const safe = (v: string) => v.replace(/[^A-Za-z0-9:_\-.]/g, '')
    const script =
      '[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]; ' +
      '$v = New-Object Windows.Security.Credentials.PasswordVault; ' +
      `try { $c = $v.Retrieve("${safe(target)}", "${safe(KEYCHAIN_ACCOUNT)}"); $c.RetrievePassword(); $c.Password } catch { exit 1 }`
    return run('powershell', ['-NoProfile', '-Command', script])
  }
  return null
}

/** The address and key, or null when no control plane is named anywhere. */
export async function loadCredentials(override?: string): Promise<IntuticCreds | null> {
  let creds: IntuticCreds = {}
  try {
    creds = JSON.parse(await fsp.readFile(path.join(os.homedir(), '.intutic', 'credentials.json'), 'utf-8')) as IntuticCreds
  } catch {
    // No login yet: the setting or the environment may still name a control plane.
  }
  const controlPlaneUrl = override?.trim() || process.env['INTUTIC_CONTROL_PLANE_URL']?.trim() || creds.controlPlaneUrl
  if (!controlPlaneUrl) return null
  let apiKey = creds.apiKey
  if (apiKey === KEYCHAIN_SENTINEL) {
    apiKey = (creds.workspaceId ? await keychainToken(creds.workspaceId) : null) ?? undefined
  }
  return { controlPlaneUrl, apiKey, workspaceId: creds.workspaceId }
}
