/**
 * identity.ts — who is calling, as far as this proxy process can tell.
 *
 * Carried on every governance event and hold record. Three of these fields are
 * local observations the control plane records as reported, never as proof:
 * the OS account the proxy runs under, the harness session it shares with its
 * sibling proxies (sessionScope.ts), and the server it fronts. The fourth is
 * the API key's prefix — the first 12 characters of a `vk_` key, which the
 * control plane itself treats as a published identifier rather than a secret
 * (`apiKeyAuth.ts` keys its lookup on it). The member the key belongs to is
 * resolved by the control plane from the key itself, so it is not here: a
 * proxy can claim an OS user, but not a member.
 *
 * @module
 */

import * as node_os from 'node:os'

export interface CallerIdentity {
  /** First 12 characters of the `vk_` API key; absent for any other credential. */
  apiKeyPrefix?: string
  /** The OS account this proxy runs as. */
  osUser?: string
  /** The harness session scope shared with sibling proxies, when one could be derived. */
  session?: string
  /** The MCP server this proxy fronts (`--server-name`). */
  serverName: string
}

/** The same prefix length the control plane's key lookup uses. */
const KEY_PREFIX_LENGTH = 12

function osUserName(): string | undefined {
  try {
    return node_os.userInfo().username || undefined
  } catch {
    // No passwd entry for the uid (some containers): there is no name to report.
    return undefined
  }
}

export function callerIdentity(apiKey: string, serverName: string, session: string | undefined): CallerIdentity {
  return {
    ...(apiKey.startsWith('vk_') ? { apiKeyPrefix: apiKey.slice(0, KEY_PREFIX_LENGTH) } : {}),
    ...(osUserName() ? { osUser: osUserName() } : {}),
    ...(session ? { session } : {}),
    serverName,
  }
}
