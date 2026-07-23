/**
 * `intutic whoami` — Show current authenticated identity.
 *
 * Calls GET /api/v1/auth/me to fetch fresh identity info.
 *
 * LLD #8 — Sync Daemon / CLI
 * @module
 */

import { log } from '../lib/logger.js'
import { loadCredentials } from '../config/store.js'
import { resolveControlPlaneUrl } from '../config/paths.js'
import { createApiClient } from '../lib/api.js'

export async function runWhoami(opts: { dev?: boolean }): Promise<void> {
  const creds = await loadCredentials()
  if (!creds) {
    log.error('Not authenticated. Run `intutic login` first.')
    process.exit(1)
  }

  const controlPlaneUrl = resolveControlPlaneUrl(opts.dev) 
  const client = createApiClient(controlPlaneUrl, creds.apiKey)

  try {
    const me = await client.getMe()
    log.header('Intutic — Identity')
    log.field('Email', me.email)
    log.field('Member ID', me.memberId)
    log.field('Workspace', me.workspaceId)
    log.field('Role', me.role)
  } catch (err) {
    log.error(`Failed to fetch identity: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
