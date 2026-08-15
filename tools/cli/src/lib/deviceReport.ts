/**
 * Best-effort phone-home: reads local enforcement state (A4) and reports it
 * to the control plane's `/api/v1/devices/report` (A6) — the "continuous"
 * half of "continuous compliance and enforcement". Never throws: the
 * underlying privileged action (`enforce apply/remove`, `enterprise
 * install`) already succeeded or failed on its own merits before this runs;
 * a report failure must not turn that into a command failure.
 *
 * @module
 */

import { createRequire } from 'node:module'
import { loadCredentials } from '../config/store.js'
import { resolveControlPlaneUrl } from '../config/paths.js'
import { createApiClient } from './api.js'
import { readEnforcementState } from './enforcementState.js'

const { version: cliVersion } = createRequire(import.meta.url)('../../package.json') as { version: string }

export interface DeviceReportResult {
  reported: boolean
  reason?: string
}

export interface ReportDeviceStateOptions {
  dev?: boolean
}

/**
 * Reads `~/.intutic/` credentials and the local enforcement state file, and
 * POSTs whatever legs are present. A `sudo`-elevated caller with no
 * readable credentials (root can't read a Keychain-backed API key) simply
 * reports `reported: false` — the caller decides whether that's worth
 * surfacing, this function never throws over it.
 */
export async function reportDeviceState(opts: ReportDeviceStateOptions = {}): Promise<DeviceReportResult> {
  try {
    const creds = await loadCredentials()
    if (!creds) return { reported: false, reason: 'not authenticated' }

    const state = await readEnforcementState()
    if (!state) return { reported: false, reason: 'no local enforcement state recorded yet' }

    const body: Record<string, unknown> = {
      fingerprint: state.fingerprint,
      hostname: state.hostname,
      platform: state.platform,
      cliVersion: state.cliVersion ?? cliVersion,
    }
    if (state.firewall) {
      body.firewall = { active: state.firewall.active, backend: state.firewall.backend, detail: state.firewall.detail }
    }
    if (state.caTrust) {
      body.caTrust = { installed: state.caTrust.installed, scope: state.caTrust.scope }
    }
    if (state.systemHooks) {
      body.systemHooks = { installed: state.systemHooks.installed, path: state.systemHooks.path }
    }

    const client = createApiClient(resolveControlPlaneUrl(opts.dev), creds.apiKey)
    await client.post('/api/v1/devices/report', body)
    return { reported: true }
  } catch (err) {
    return { reported: false, reason: err instanceof Error ? err.message : String(err) }
  }
}
