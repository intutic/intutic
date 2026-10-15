/**
 * `intutic keys` — your API keys and their scopes.
 *
 * Subcommands:
 *   - `intutic keys list [--json]`
 *   - `intutic keys create --label <label> [--scopes <a,b>] [--expires-in-days <n>] [--service-account] [--json]`
 *   - `intutic keys update <keyId> --scopes <a,b> [--json]`
 *   - `intutic keys revoke <keyId> [--json]`
 *
 * Server side: services/control-plane/src/routes/keys.ts. A created key's
 * plaintext is in the create response only, so it is printed once, with a
 * warning to copy it. Scopes are checked against the registry in
 * `@intutic/shared-types` before anything is sent, with the server's message
 * for an unknown one. Budgets and rate limits are `intutic budget key`.
 *
 * @module
 */

import { unknownApiKeyScopes, unknownScopesMessage, type ApiKeyCreateResponse, type ApiKeyListResponse, type ApiKeyResponse } from '@intutic/shared-types'
import { log } from '../lib/logger.js'
import { fail, list, positiveInt, runApiCommand, type ApiCommandOpts } from './apiCommand.js'

/** The `--scopes` list, or exit 1 naming the valid scopes when one is not in the registry. */
export function parseScopes(value: string): string[] {
  const scopes = list(value)
  if (scopes.length === 0) fail('--scopes must list at least one scope; use * for everything the key owner\'s role allows')
  const unknown = unknownApiKeyScopes(scopes)
  if (unknown.length > 0) fail(unknownScopesMessage(unknown))
  return scopes
}

type KeyFields = Pick<ApiKeyResponse, 'keyId' | 'keyPrefix' | 'label' | 'scopes' | 'expiresAt'> & Partial<Pick<ApiKeyResponse, 'revokedAt'>>

function printKey(key: KeyFields): void {
  log.field('Key ID', key.keyId)
  log.field('Label', key.label)
  log.field('Prefix', key.keyPrefix)
  log.field('Scopes', key.scopes.join(', '))
  log.field('Expires', key.expiresAt ?? 'never')
  if (key.revokedAt) log.field('Revoked', key.revokedAt)
}

/** `intutic keys list` */
export async function runKeysList(opts: ApiCommandOpts): Promise<void> {
  await runApiCommand(
    opts,
    'Failed to list API keys',
    (client) => client.get<ApiKeyListResponse>('/api/v1/keys'),
    (res) => {
      log.header('Intutic — API Keys')
      if (res.data.length === 0) {
        log.dim('  No API keys.')
        return
      }
      for (const key of res.data) {
        console.log('')
        printKey(key)
      }
    },
  )
}

/** `intutic keys create` */
export async function runKeysCreate(
  opts: ApiCommandOpts & { label: string; scopes?: string; expiresInDays?: string; serviceAccount?: boolean },
): Promise<void> {
  const body: Record<string, unknown> = { label: opts.label }
  if (opts.scopes !== undefined) body.scopes = parseScopes(opts.scopes)
  if (opts.expiresInDays !== undefined) body.expiresInDays = positiveInt(opts.expiresInDays, '--expires-in-days')
  if (opts.serviceAccount) body.isServiceAccount = true
  await runApiCommand(
    opts,
    'Failed to create API key',
    (client) => client.post<ApiKeyCreateResponse>('/api/v1/keys', body),
    (key) => {
      log.success('API key created.')
      printKey(key)
      log.field('Key', key.key)
      log.warn('Copy the key now: it is shown once and never again.')
    },
  )
}

/** `intutic keys update <keyId>` */
export async function runKeysUpdate(keyId: string, opts: ApiCommandOpts & { scopes: string }): Promise<void> {
  const scopes = parseScopes(opts.scopes)
  await runApiCommand(
    opts,
    `Failed to update the scopes of ${keyId}`,
    (client) => client.patch<ApiKeyResponse>(`/api/v1/keys/${encodeURIComponent(keyId)}`, { scopes }),
    (key) => {
      log.success('Scopes updated; they apply from the key\'s next request.')
      printKey(key)
    },
  )
}

/** `intutic keys revoke <keyId>` */
export async function runKeysRevoke(keyId: string, opts: ApiCommandOpts): Promise<void> {
  await runApiCommand(
    opts,
    `Failed to revoke API key ${keyId}`,
    (client) => client.del<{ revoked: true }>(`/api/v1/keys/${encodeURIComponent(keyId)}`),
    () => log.success(`API key ${keyId} revoked.`),
  )
}
