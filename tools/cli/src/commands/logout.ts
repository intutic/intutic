/**
 * `intutic logout` — Clear stored credentials.
 *
 * @module
 */

import { log } from '../lib/logger.js'
import { clearCredentials } from '../config/store.js'

export async function runLogout(): Promise<void> {
  await clearCredentials()
  log.success('Credentials cleared. You are logged out.')
}
