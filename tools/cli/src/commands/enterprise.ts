/**
 * `intutic enterprise install` — CA-trust rollout, Cursor system-level
 * hooks, and Jamf/Intune MDM manifest generation for a managed fleet.
 *
 * Replaces the deleted `enterprise-install.ts` (commit `8481b5d9`). Named
 * `enterprise install`, deliberately not the old hyphenated
 * `enterprise-install` — `tools/scripts/intutic-enterprise-install.sh`
 * already exists as an unrelated air-gapped docker-compose installer.
 *
 * The host firewall is intentionally NOT part of this command — that's
 * `intutic enforce apply`/`generate` (TD-332's real, tested implementation).
 * Rebuilding a `pf.conf`/`iptables.rules` template generator here, as the
 * deleted code did, would just be a second, unmaintained copy of it. This
 * command prints a pointer to it instead.
 *
 * @module
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { writeCursorHooks } from '@intutic/sync-daemon/harness/cursorHooks'
import { log } from '../lib/logger.js'
import { loadConfig, loadCredentials } from '../config/store.js'
import { getIntuticDir } from '../config/paths.js'
import { isElevatedAsync } from '../lib/elevation.js'
import { installCaTrust } from '../lib/caTrust.js'
import { generateMobileconfig, generateJamfManifest, generateIntuneManifest } from '../lib/mdmManifest.js'
import { writeEnforcementState } from '../lib/enforcementState.js'
import { reportDeviceState } from '../lib/deviceReport.js'

const { version: cliVersion } = createRequire(import.meta.url)('../../package.json') as { version: string }

export interface EnterpriseInstallOptions {
  proxyUrl?: string
  generateMdmOnly?: boolean
  mdmOutputDir?: string
  skipCa?: boolean
  skipHooks?: boolean
  dev?: boolean
}

function resolveProxyUrl(opts: EnterpriseInstallOptions): string {
  const raw = opts.proxyUrl ?? process.env.INTUTIC_PROXY_URL ?? 'http://localhost:4000'
  return raw.replace(/\/+$/, '')
}

export async function runEnterpriseInstall(opts: EnterpriseInstallOptions): Promise<void> {
  const proxyUrl = resolveProxyUrl(opts)
  const outputDir = resolve(opts.mdmOutputDir ?? './intutic-mdm')
  const config = loadConfig()
  const creds = await loadCredentials()
  const workspaceRoot = config?.workspaceRoot ?? process.cwd()
  const workspaceId = creds?.workspaceId ?? ''

  log.header('Intutic — Enterprise Install')

  const caCertPath = join(getIntuticDir(), 'ca.crt')
  let caCertPem: string
  try {
    caCertPem = await readFile(caCertPath, 'utf-8')
  } catch {
    log.error(`CA certificate not found at ${caCertPath}.`)
    log.info('Run `intutic connect` (or `intutic start`) at least once first — it generates the CA on first run.')
    process.exit(1)
  }

  // 1. Manifests — no privilege needed, always generated first.
  await mkdir(outputDir, { recursive: true })
  const hookScriptPath = join(workspaceRoot, '.intutic', 'hooks', 'cursor-check.js')

  await writeFile(join(outputDir, 'intutic-governance.mobileconfig'), generateMobileconfig({ caCertPem }), 'utf-8')
  await writeFile(join(outputDir, 'cursor-hooks-jamf.json'), generateJamfManifest({ hookScriptPath }), 'utf-8')
  await writeFile(join(outputDir, 'cursor-hooks-intune.json'), generateIntuneManifest({ hookScriptPath }), 'utf-8')

  log.success(`MDM manifests written to ${outputDir}/`)
  log.field('CA trust profile', 'intutic-governance.mobileconfig')
  log.field('Cursor hooks (Jamf)', 'cursor-hooks-jamf.json')
  log.field('Cursor hooks (Intune)', 'cursor-hooks-intune.json')

  if (opts.generateMdmOnly) {
    return
  }

  // 2. Elevation check — warn but still attempt, matching `enforce.ts`'s
  // "warn but still attempt" discipline (a container or root shell has
  // nothing to escalate from, so pre-blocking would be wrong there).
  const elevation = await isElevatedAsync()
  if (elevation === 'unelevated') {
    log.warn('System-wide CA trust and system-level Cursor hooks need admin/root privilege.')
    log.info('Re-run with sudo (macOS/Linux) or from an elevated shell (Windows) to apply them now.')
  }

  // 3. System-level Cursor hooks — reuses the SAME writer `intutic connect`
  // already uses for project/user level, this time with writeSystemLevel and
  // a real workspaceId embedded in the hook script's event payloads.
  if (!opts.skipHooks) {
    try {
      await writeCursorHooks(workspaceRoot, proxyUrl, workspaceId, true)
      log.success('Cursor hooks written (project, user, and system level).')
      await writeEnforcementState(
        { systemHooks: { installed: true, path: hookScriptPath, reportedAt: new Date().toISOString() } },
        cliVersion,
      )
    } catch (err) {
      log.error(`Failed to write Cursor hooks: ${err instanceof Error ? err.message : String(err)}`)
      await writeEnforcementState(
        { systemHooks: { installed: false, reportedAt: new Date().toISOString() } },
        cliVersion,
      )
    }
  }

  // 4. System-wide CA trust.
  if (!opts.skipCa) {
    const result = await installCaTrust(caCertPath, 'system')
    if (result.installed) {
      log.success(`CA cert trusted system-wide via ${result.mechanism}.`)
    } else {
      log.error(`Could not install system CA trust: ${result.detail}`)
    }
    await writeEnforcementState(
      { caTrust: { installed: result.installed, scope: 'system', mechanism: result.mechanism, reportedAt: new Date().toISOString() } },
      cliVersion,
    )
  }

  // Best-effort phone-home for whatever legs this run actually touched —
  // never fails the command; the CA-trust/hooks steps above already
  // succeeded or failed on their own merits.
  const report = await reportDeviceState({ dev: opts.dev })
  if (!report.reported) {
    log.dim(`  (device report not sent: ${report.reason})`)
  }

  // 5. Firewall — deliberately not duplicated here. Point at the real thing.
  const defaultPort = (() => {
    try {
      return new URL(proxyUrl).port || '4000'
    } catch {
      return '4000'
    }
  })()
  console.log('')
  log.header('Next: mandatory egress firewall')
  log.dim('  This command does not touch the host firewall. To make the proxy the only path out:')
  log.dim(`    sudo intutic enforce apply --port ${defaultPort}`)
  log.dim('  See what it would do first with: intutic enforce generate')
}
