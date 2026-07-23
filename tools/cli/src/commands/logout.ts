/**
 * `intutic logout` — Clear stored credentials.
 *
 * LLD #8 — Sync Daemon / CLI
 * @module
 */

import { log } from '../lib/logger.js'
import { clearCredentials } from '../config/store.js'

export async function runLogout(): Promise<void> {
  await clearCredentials()
  log.success('Credentials cleared. You are logged out.')
}
