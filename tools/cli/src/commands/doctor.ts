/**
 * `intutic doctor` — Diagnose workspace health.
 *
 * Runs a series of checks to verify that all Intutic components are
 * properly configured and reachable. Each check prints ✓ or ✗ with
 * a one-line remediation.
 *
 * Checks (in order):
 * 1. Proxy reachable (http://127.0.0.1:4000/health, or the INTUTIC_PROXY_URL port)
 * 2. Control plane auth (via stored credentials)
 * 3. Sync daemon running (PID file or process grep)
 * 4. Harness config files intact (SHA-256 hash check)
 * 5. Daemon log readable and non-empty (installed log path, or the legacy
 *    ~/.intutic/daemon.log)
 * 6. Valkey connectivity (proxy /health or TCP probe port 6379)
 * 7. CA cert trust (~/.intutic/ca.crt + OS trust store)
 * 8. Policy snapshot present, intact, and current
 * 8b. Local gates (open core): a gate on disk for each recorded harness
 *
 * Checks 2-5 need a control plane. While no control plane product has
 * launched (CONTROL_PLANE_PRODUCT_RELEASED) and nobody has logged in, they are
 * skipped with one note instead of failing and pointing at hidden commands,
 * and checks 8 and 8b look at the gates `intutic gates install` wrote.
 *
 * No subscription checks — enforcement is server-side (covenant 13).
 *
 * @module
 */

import { readFileSync, accessSync, constants, existsSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import pc from 'picocolors'

import { CONTROL_PLANE_PRODUCT_RELEASED, NO_CONTROL_PLANE_MESSAGE, gateKindForHarness, type HarnessType } from '@intutic/shared-types'
import { findGateFile } from '@intutic/sync-daemon'
import { log } from '../lib/logger.js'
import { loadCredentials, loadConfig, loadIntegrity } from '../config/store.js'
import { isSyncDaemonRunning } from '../lib/process.js'
import { caTrustCommandFor, LINUX_CA_TRUST_PATHS } from '../lib/caTrust.js'
import { getPaths } from './install-daemon.js'
import { configuredControlPlaneUrl } from '../config/paths.js'
import { localProxyProbeBase } from '../lib/localProxy.js'

/** The local proxy's health endpoint, on the port every command uses. */
function proxyHealthUrl(): string {
  return `${localProxyProbeBase()}/health`
}
import {
  readPolicySnapshot,
  SNAPSHOT_STALE_AFTER_DAYS,
  type PolicySnapshotHealth,
} from '../lib/policySnapshot.js'
import { ciscoScannerOnPath, ciscoScannerVersion } from '../lib/ciscoScanner.js'

// ─── Types ───────────────────────────────────────────────────────────

export interface CheckResult {
  name: string
  passed: boolean
  detail: string
  remediation?: string
}

// ─── Constants ───────────────────────────────────────────────────────

const PROXY_TIMEOUT_MS = 3_000
const CONTROL_PLANE_TIMEOUT_MS = 5_000
/**
 * Historical location. Nothing in the CLI or the daemon has ever written here —
 * `intutic install-daemon` points the service at getPaths().logPath — so it is
 * kept only so an old install still gets a hit.
 */
const LEGACY_DAEMON_LOG_PATH = join(homedir(), '.intutic', 'daemon.log')
const DAEMON_PID_PATH = join(homedir(), '.intutic', 'daemon.pid')
const CA_CERT_PATH = join(homedir(), '.intutic', 'ca.crt')
const VALKEY_PROBE_TIMEOUT_MS = 2_000

// ─── Individual Checks ──────────────────────────────────────────────

/**
 * Check 1: Proxy reachable on its local port.
 */
async function checkProxy(startCommand = 'intutic connect'): Promise<CheckResult> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS)

    const res = await fetch(proxyHealthUrl(), {
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (res.ok) {
      return {
        name: 'Proxy',
        passed: true,
        detail: `Reachable at ${proxyHealthUrl()} (HTTP ${res.status})`,
      }
    }

    return {
      name: 'Proxy',
      passed: false,
      detail: `Responded with HTTP ${res.status}`,
      remediation: `Start the proxy with \`${startCommand}\` or check proxy logs.`,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return {
      name: 'Proxy',
      passed: false,
      detail: `Not reachable — ${message}`,
      remediation: `Start the proxy: ensure \`${startCommand}\` is running or the proxy binary is started.`,
    }
  }
}

/**
 * Check 2: Control plane auth — verifies the stored credentials are accepted.
 *
 * Asks `/api/v1/auth/me`, the route `intutic login` validates a key against.
 * This used to request `/api/v1/health`, which the control plane does not
 * serve: a valid key came back 404 and was reported as "Reachable (HTTP 404)",
 * so the check never said "Authenticated" for a working login.
 */
export async function checkControlPlane(): Promise<CheckResult> {
  const creds = await loadCredentials()

  if (!creds) {
    return {
      name: 'Control Plane Auth',
      passed: false,
      detail: 'No credentials found',
      remediation: 'Run `intutic login` to authenticate.',
    }
  }

  // The same control plane every other command would use for these
  // credentials, so this checks what they will actually hit.
  const controlPlaneUrl = configuredControlPlaneUrl()
  if (controlPlaneUrl === undefined) {
    return { name: 'Control Plane Auth', passed: false, detail: NO_CONTROL_PLANE_MESSAGE }
  }
  const url = `${controlPlaneUrl}/api/v1/auth/me`

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), CONTROL_PLANE_TIMEOUT_MS)

    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${creds.apiKey}`,
      },
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (res.ok) {
      return {
        name: 'Control Plane Auth',
        passed: true,
        detail: `Authenticated at ${controlPlaneUrl}`,
      }
    }

    if (res.status === 401 || res.status === 403) {
      return {
        name: 'Control Plane Auth',
        passed: false,
        detail: `Auth failed (HTTP ${res.status})`,
        remediation: 'API key may be revoked. Run `intutic login` to re-authenticate.',
      }
    }

    return {
      name: 'Control Plane Auth',
      passed: true,
      detail: `Reachable at ${controlPlaneUrl} (HTTP ${res.status})`,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return {
      name: 'Control Plane Auth',
      passed: false,
      detail: `Unreachable — ${message}`,
      remediation: `Check network connectivity to ${controlPlaneUrl}.`,
    }
  }
}

/**
 * Check 3: Sync daemon running — PID file or process detection.
 */
function checkSyncDaemon(): CheckResult {
  // Check PID file first
  try {
    const pid = readFileSync(DAEMON_PID_PATH, 'utf-8').trim()
    if (pid && !isNaN(Number(pid))) {
      try {
        process.kill(Number(pid), 0) // Signal 0 checks if process exists
        return {
          name: 'Sync Daemon',
          passed: true,
          detail: `Running (PID ${pid})`,
        }
      } catch {
        // PID file exists but process is dead — stale PID
      }
    }
  } catch {
    // No PID file — fall through to process detection
  }

  // Fallback: use process detection
  if (isSyncDaemonRunning()) {
    return {
      name: 'Sync Daemon',
      passed: true,
      detail: 'Running (detected via process scan)',
    }
  }

  return {
    name: 'Sync Daemon',
    passed: false,
    detail: 'Not running',
    remediation: 'Start with `intutic connect` or install as a service with `intutic daemon install`.',
  }
}

/**
 * Check 4: Harness config files intact — SHA-256 hash comparison.
 */
function checkHarnessConfigs(): CheckResult {
  const config = loadConfig()
  if (!config) {
    return {
      name: 'Harness Configs',
      passed: false,
      detail: 'No workspace config found',
      remediation: 'Run `intutic init` to initialize the workspace.',
    }
  }

  const integrity = loadIntegrity(config.workspaceRoot)
  if (!integrity || !integrity.files || Object.keys(integrity.files).length === 0) {
    return {
      name: 'Harness Configs',
      passed: false,
      detail: 'No integrity data — configs have never been synced',
      remediation: 'Run `intutic connect` to sync config files from the control plane.',
    }
  }

  const drifted: string[] = []
  const missing: string[] = []

  for (const [filePath, expectedHash] of Object.entries(integrity.files)) {
    try {
      const fullPath = isAbsolute(filePath) ? filePath : join(config.workspaceRoot, filePath)
      const content = readFileSync(fullPath, 'utf-8')
      const actualHash = createHash('sha256').update(content).digest('hex')

      if (actualHash !== expectedHash) {
        drifted.push(filePath)
      }
    } catch {
      missing.push(filePath)
    }
  }

  const totalFiles = Object.keys(integrity.files).length
  const healthy = totalFiles - drifted.length - missing.length

  if (drifted.length === 0 && missing.length === 0) {
    return {
      name: 'Harness Configs',
      passed: true,
      detail: `${totalFiles} file(s) intact — no drift detected`,
    }
  }

  const issues: string[] = []
  if (drifted.length > 0) issues.push(`${drifted.length} drifted`)
  if (missing.length > 0) issues.push(`${missing.length} missing`)

  return {
    name: 'Harness Configs',
    passed: false,
    detail: `${healthy}/${totalFiles} intact — ${issues.join(', ')}`,
    remediation: 'Run `intutic connect` to re-sync config files. Drift will be auto-corrected.',
  }
}

/**
 * Every place a sync-daemon log can legitimately be, most likely first: the
 * per-user service, the system service, then the legacy path.
 */
function daemonLogCandidates(): string[] {
  return [
    getPaths(false, false).logPath,
    getPaths(true, false).logPath,
    LEGACY_DAEMON_LOG_PATH,
  ]
}

/**
 * How long ago the newest entry was written, taken from the `time` field pino
 * puts on every line (`@intutic/logger` configures it as an ISO string; plain
 * pino uses epoch milliseconds, so both are accepted).
 *
 * Returns null when the last line is not a pino record — a stack trace
 * continuation, or plain text from the service supervisor — in which case the
 * caller simply omits the age.
 *
 * The line itself is deliberately never printed. `intutic doctor` output is
 * written to be pasted into a support thread, and daemon logs carry workspace
 * identifiers and request metadata.
 */
function describeLastEntryAge(lastLine: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(lastLine)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null

  const time = (parsed as { time?: unknown }).time
  if (typeof time !== 'string' && typeof time !== 'number') return null

  const writtenAt = new Date(time).getTime()
  if (Number.isNaN(writtenAt)) return null

  const minutes = Math.floor((Date.now() - writtenAt) / 60_000)
  if (minutes < 0) return null
  if (minutes < 1) return 'last entry just now'
  if (minutes < 60) return `last entry ${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `last entry ${hours}h ago`
  return `last entry ${Math.floor(hours / 24)}d ago`
}

/**
 * Check 5: Daemon log present, readable, and actually being written to.
 */
function checkDaemonLog(): CheckResult {
  const candidates = daemonLogCandidates()

  const logPath = candidates.find((candidate) => {
    try {
      accessSync(candidate, constants.R_OK)
      return true
    } catch {
      return false
    }
  })

  if (!logPath) {
    return {
      name: 'Daemon Log',
      passed: false,
      detail: `Not found or not readable at ${candidates.join(', ')}`,
      remediation: 'The log file is created when `intutic connect` runs. Start the daemon first.',
    }
  }

  let content: string
  try {
    content = readFileSync(logPath, 'utf-8')
  } catch (err) {
    return {
      name: 'Daemon Log',
      passed: false,
      detail: `Found ${logPath} but could not read it — ${err instanceof Error ? err.message : String(err)}`,
      remediation: `Check the file's permissions: ls -l ${logPath}`,
    }
  }

  // An empty log means the daemon has never logged a line — a real fault that
  // used to be reported as a pass with a misleading "1 lines".
  const lines = content.trim().split('\n').filter((line) => line.length > 0)
  if (lines.length === 0) {
    return {
      name: 'Daemon Log',
      passed: false,
      detail: `Empty at ${logPath} — the daemon has not written anything`,
      remediation: 'The daemon has a log file but has never logged. Restart it with `intutic connect` and re-run doctor.',
    }
  }

  const age = describeLastEntryAge(lines[lines.length - 1])
  const suffix = age ? `, ${age}` : ''

  return {
    name: 'Daemon Log',
    passed: true,
    detail: `Readable at ${logPath} (${lines.length} lines${suffix})`,
  }
}

/**
 * Check 6: Valkey connectivity, by a direct TCP probe.
 *
 * Only the probe. This check used to ask the proxy's /health first and look
 * for a `valkey` field, but /health reports status, service and version and
 * nothing about Valkey, so that branch could never pass and cost a second
 * request on every run.
 */
export async function checkValkey(port = 6379): Promise<CheckResult> {
  try {
    const { createConnection } = await import('node:net')
    const connected = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port }, () => {
        socket.end()
        resolve(true)
      })
      socket.setTimeout(VALKEY_PROBE_TIMEOUT_MS)
      socket.on('timeout', () => { socket.destroy(); resolve(false) })
      socket.on('error', () => resolve(false))
    })

    if (connected) {
      return {
        name: 'Valkey',
        passed: true,
        detail: `Reachable at 127.0.0.1:${port} (direct TCP probe)`,
      }
    }
  } catch {
    // TCP probe failed — report below
  }

  return {
    name: 'Valkey',
    passed: false,
    detail: `Not reachable on port ${port}`,
    remediation: 'Start Valkey: `docker compose up -d valkey` or install locally.',
  }
}

/**
 * Builds the system-scope CA-trust remediation string from the SAME source
 * `caTrust.ts`'s `installCaTrust` actually runs, instead of a hand-written
 * duplicate — the two had already drifted once (this check looks in three
 * Linux cert-anchor directories; the old remediation only ever named one).
 */
function systemTrustRemediation(os: string): string {
  const cmds = caTrustCommandFor(os as NodeJS.Platform, 'system', CA_CERT_PATH)
  if (!cmds) return `See docs/integrations/enterprise-install.md for manual CA-trust steps on ${os}.`
  const quoted = (arg: string) => (arg.includes(' ') ? `"${arg}"` : arg)
  return cmds.map((c) => `sudo ${c.cmd} ${c.args.map(quoted).join(' ')}`).join(' && ')
}

/**
 * Whether the CA sits in a Linux system trust directory: any of the paths
 * `caTrust.ts` installs to (`enterprise install` writes `intutic-ca.crt`,
 * `intutic connect` writes `intutic-connect-ca.crt`), plus the same names in
 * Arch's anchors directory for a manual install there.
 */
export function linuxCaTrustInstalled(read: (path: string) => string = (p) => readFileSync(p, 'utf-8')): boolean {
  const archDir = '/etc/ca-certificates/trust-source/anchors'
  const names = [...new Set(LINUX_CA_TRUST_PATHS.map((p) => p.slice(p.lastIndexOf('/') + 1)))]
  const candidates = [...LINUX_CA_TRUST_PATHS, ...names.map((name) => join(archDir, name))]
  return candidates.some((path) => {
    try {
      return read(path).length > 0
    } catch {
      return false
    }
  })
}

/**
 * Check 7: CA certificate trust.
 *
 * Verifies that the Intutic proxy CA certificate exists at ~/.intutic/ca.crt
 * and is trusted by the operating system's trust store.
 *
 * - macOS: Uses `security verify-cert` to check trust chain.
 * - Linux: Checks if the cert is installed in the system CA directory.
 */
function checkCertTrust(startCommand = 'intutic connect'): CheckResult {
  // Step 1: Does the CA cert file exist?
  if (!existsSync(CA_CERT_PATH)) {
    return {
      name: 'Cert Trust',
      passed: false,
      detail: `CA certificate not found at ${CA_CERT_PATH}`,
      remediation: `Start the proxy with \`${startCommand}\` — it auto-generates the CA cert on first run.`,
    }
  }

  // Step 2: Is the cert trusted by the OS?
  const os = platform()
  try {
    if (os === 'darwin') {
      // macOS: verify-cert returns exit 0 if trusted
      execSync(`security verify-cert -c "${CA_CERT_PATH}" 2>/dev/null`, { timeout: 3000 })
      return {
        name: 'Cert Trust',
        passed: true,
        detail: 'CA cert exists and is trusted by macOS Keychain',
      }
    } else if (os === 'linux') {
      if (linuxCaTrustInstalled()) {
        return {
          name: 'Cert Trust',
          passed: true,
          detail: 'CA cert exists and is installed in system trust store',
        }
      }

      return {
        name: 'Cert Trust',
        passed: false,
        detail: 'CA cert exists but is not in system trust store',
        remediation: systemTrustRemediation(os),
      }
    } else {
      // Windows or unknown OS — skip trust verification, just check file
      return {
        name: 'Cert Trust',
        passed: true,
        detail: `CA cert exists at ${CA_CERT_PATH} (trust verification skipped on ${os})`,
      }
    }
  } catch {
    return {
      name: 'Cert Trust',
      passed: false,
      detail: 'CA cert exists but is NOT trusted by the OS',
      remediation: systemTrustRemediation(os),
    }
  }
}

/**
 * Turns a snapshot's state into the line doctor prints.
 *
 * Split from the check so the mapping can be tested without a home directory:
 * every branch here is a different thing being enforced on the machine, and
 * getting one of them wrong is silent by construction.
 *
 * `passed` is false for everything except `ok`, including `stale`. A stale
 * snapshot is still fully enforced — staleness governs alerting, not
 * enforcement — but reaching the window means the daemon has not completed a
 * sync in over a week, which is a fault whatever the gates are doing with the
 * rules they still have.
 */
export function describePolicySnapshot(snap: PolicySnapshotHealth, opts: { local?: boolean } = {}): CheckResult {
  const name = 'Policy Snapshot'
  // With no control plane, `intutic gates install` is what writes it.
  const rewrite = opts.local ? 'intutic gates install' : 'intutic policy snapshot'
  const dropped = snap.droppedRules > 0 ? `, ${snap.droppedRules} rule(s) dropped as uncompilable` : ''

  switch (snap.state) {
    case 'ok':
      return {
        name,
        passed: true,
        detail: `${snap.ruleCount} rule(s), digest ${snap.digest}, ${snap.ageDays}d old${dropped}`,
      }

    case 'stale':
      return {
        name,
        passed: false,
        detail:
          `${snap.ageDays} days old and still enforced (${snap.ruleCount} rule(s)) — ` +
          `nothing has refreshed it in over ${SNAPSHOT_STALE_AFTER_DAYS} days${dropped}`,
        remediation: opts.local
          ? 'Nothing has refreshed it. Refresh it with `intutic gates install`, or keep `intutic start` running.'
          : 'The daemon has not synced. Check `intutic daemon status`, then refresh with `intutic policy snapshot`.',
      }

    case 'invalid':
      return {
        name,
        passed: false,
        detail:
          `Failed its ${snap.workspaceId ? 'digest or workspace' : 'digest'} check at ${snap.path} — ` +
          'every gate has DROPPED the dynamic rules, so workspace policy is enforcing nothing',
        remediation:
          `The file was edited or belongs to another workspace. Overwrite it with \`${rewrite}\`.`,
      }

    case 'empty':
      return {
        name,
        passed: false,
        // The writer always ships the destructive tier, so zero rules is not a
        // quiet workspace — it is a compile that produced nothing.
        detail: `Present at ${snap.path} but contains no rules — the policy compile produced nothing${dropped}`,
        remediation:
          opts.local
            ? 'Rebuild it with `intutic gates install`.'
            : 'Check that the workspace has active BLOCK: SOPs, then rebuild it with `intutic policy snapshot`.',
      }

    case 'absent':
      return {
        name,
        passed: false,
        detail: `No snapshot at ${snap.path} — built-in protections only, workspace policy enforces nothing`,
        remediation: opts.local
          ? 'Write it with `intutic gates install`.'
          : 'Write it with `intutic policy snapshot`, or start the daemon with `intutic connect`.',
      }
  }
}

/**
 * Check 8: Policy snapshot — the dynamic tier every harness gate reads.
 *
 * Absent, invalid or empty all mean the same thing on the machine: the gates
 * fall back to the compiled floor and the workspace's own rules stop applying,
 * with no error anywhere. That is the whole reason this check exists — the
 * failure is invisible from every other angle in this command.
 */
async function checkPolicySnapshot(): Promise<CheckResult> {
  // The workspace id is what makes a mismatch detectable. Without credentials
  // the comparison is skipped rather than guessed, exactly as the gates skip it.
  const creds = await loadCredentials()
  return describePolicySnapshot(readPolicySnapshot({ expectedWorkspaceId: creds?.workspaceId }))
}

/**
 * Check 8b (open core): a tool-call gate on disk for every recorded harness
 * that has one (`findGateFile`), which `intutic gates install` writes.
 */
export async function checkLocalGates(): Promise<CheckResult> {
  const name = 'Local Gates'
  const config = loadConfig()
  if (!config) {
    return { name, passed: false, detail: 'No workspace config found', remediation: 'Run `intutic init`, then `intutic gates install`.' }
  }
  const disconnected = new Set<string>(config.disconnectedHarnesses ?? [])
  const hooked = config.harnesses.filter((h) => !disconnected.has(h) && gateKindForHarness(h as HarnessType) === 'hook')
  if (hooked.length === 0) {
    return { name, passed: true, detail: 'No recorded harness has a tool-call gate to install' }
  }
  const missing: string[] = []
  for (const h of hooked) {
    if ((await findGateFile(h, config.workspaceRoot, homedir())) === null) missing.push(h)
  }
  if (missing.length === 0) {
    return { name, passed: true, detail: `${hooked.length} gate(s) installed: ${hooked.join(', ')}` }
  }
  return {
    name,
    passed: false,
    detail:
      missing.length === hooked.length
        ? `None installed for ${missing.join(', ')} — tool calls are not gated`
        : `${hooked.length - missing.length}/${hooked.length} installed; none for ${missing.join(', ')}`,
    remediation: 'Install them with `intutic gates install`.',
  }
}

/**
 * Check 9: Cisco `skill-scanner` integration (Phase S3) — an OPTIONAL
 * external tool `intutic skill audit --engine cisco` (or the
 * `ciscoSkillScannerEnabled` workspace setting's auto-run) shells out to.
 *
 * Unlike every other check above, absence here is NOT a failure —
 * `passed: true` either way. This is the operator's own separate
 * installation (`pipx install cisco-ai-skill-scanner`), and `intutic skill audit`
 * degrades gracefully without it (see `lib/ciscoScanner.ts`'s module doc
 * comment). The remediation string is still populated when absent, purely
 * informational — `runDoctor`'s print loop shows it as a dimmed hint on a
 * passing row, not an error.
 */
export async function checkCiscoScanner(): Promise<CheckResult> {
  const present = await ciscoScannerOnPath()
  if (!present) {
    return {
      name: 'Cisco Skill Scanner',
      passed: true,
      detail: 'not installed (optional integration)',
      remediation: 'pipx install cisco-ai-skill-scanner',
    }
  }

  const version = await ciscoScannerVersion()
  return {
    name: 'Cisco Skill Scanner',
    passed: true,
    detail: version ? `Installed — ${version}` : 'Installed on PATH (version unavailable)',
  }
}

// ─── Runner ──────────────────────────────────────────────────────────

export async function runDoctor(): Promise<void> {
  log.header('Intutic Doctor — Workspace Health Check')
  console.log('')

  const results: CheckResult[] = []

  // An open-core install with no login has no control plane to check.
  const connected = CONTROL_PLANE_PRODUCT_RELEASED || (await loadCredentials()) !== null

  // Run checks in sequence (some depend on network)
  results.push(await checkProxy(connected ? 'intutic connect' : 'intutic start'))
  if (connected) {
    results.push(await checkControlPlane())
    results.push(checkSyncDaemon())
    results.push(checkHarnessConfigs())
    results.push(checkDaemonLog())
  }
  results.push(await checkValkey())
  results.push(checkCertTrust(connected ? 'intutic connect' : 'intutic start'))
  if (connected) {
    results.push(await checkPolicySnapshot())
  } else {
    // The snapshot `intutic gates install` wrote, with no workspace to compare.
    results.push(describePolicySnapshot(readPolicySnapshot({}), { local: true }))
    results.push(await checkLocalGates())
  }
  results.push(await checkCiscoScanner())

  // Print results
  const passed = results.filter(r => r.passed).length
  const failed = results.filter(r => !r.passed).length

  for (const result of results) {
    if (result.passed) {
      console.log(`  ${pc.green('✓')} ${pc.bold(result.name)} — ${result.detail}`)
      // Informational only: every OTHER passing check has no remediation —
      // this is the one exception (checkCiscoScanner, absent-but-optional),
      // where the hint is still worth surfacing even though nothing failed.
      if (result.remediation) {
        console.log(`    ${pc.dim('→')} ${pc.dim(result.remediation)}`)
      }
    } else {
      console.log(`  ${pc.red('✗')} ${pc.bold(result.name)} — ${result.detail}`)
      if (result.remediation) {
        console.log(`    ${pc.dim('→')} ${pc.dim(result.remediation)}`)
      }
    }
  }

  if (!connected) {
    console.log(`  ${pc.dim('–')} ${pc.dim('Control plane, sync daemon, harness sync and daemon log checks skipped: open core, no control plane connected. The gates are checked as `intutic gates install` writes them.')}`)
  }

  // Summary
  console.log('')
  if (failed === 0) {
    log.success(`All ${passed} checks passed — workspace is healthy.`)
  } else {
    log.warn(`${passed} passed, ${failed} failed — see remediations above.`)
  }
}
