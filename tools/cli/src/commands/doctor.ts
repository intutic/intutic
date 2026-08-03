/**
 * `intutic doctor` — Diagnose workspace health.
 *
 * Runs a series of checks to verify that all Intutic components are
 * properly configured and reachable. Each check prints ✓ or ✗ with
 * a one-line remediation.
 *
 * Checks (in order):
 * 1. Proxy reachable (http://127.0.0.1:4000/health)
 * 2. Control plane auth (via stored credentials)
 * 3. Sync daemon running (PID file or process grep)
 * 4. Harness config files intact (SHA-256 hash check)
 * 5. Daemon log readable (~/.intutic/daemon.log)
 * 6. Valkey connectivity (proxy /health or TCP probe port 6379)
 * 7. CA cert trust (~/.intutic/ca.crt + OS trust store)
 *
 * No subscription checks — enforcement is server-side (covenant 13).
 *
 * LLD #8 — Sync Daemon / CLI
 * @module
 */

import { readFileSync, accessSync, constants, existsSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import pc from 'picocolors'

import { log } from '../lib/logger.js'
import { loadCredentials, loadConfig, loadIntegrity } from '../config/store.js'
import { isSyncDaemonRunning } from '../lib/process.js'

// ─── Types ───────────────────────────────────────────────────────────

interface CheckResult {
  name: string
  passed: boolean
  detail: string
  remediation?: string
}

// ─── Constants ───────────────────────────────────────────────────────

const PROXY_HEALTH_URL = 'http://127.0.0.1:4000/health'
const PROXY_TIMEOUT_MS = 3_000
const CONTROL_PLANE_TIMEOUT_MS = 5_000
const DAEMON_LOG_PATH = join(homedir(), '.intutic', 'daemon.log')
const DAEMON_PID_PATH = join(homedir(), '.intutic', 'daemon.pid')
const CA_CERT_PATH = join(homedir(), '.intutic', 'ca.crt')
const VALKEY_PROBE_TIMEOUT_MS = 2_000

// ─── Individual Checks ──────────────────────────────────────────────

/**
 * Check 1: Proxy reachable at localhost:4000.
 */
async function checkProxy(): Promise<CheckResult> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS)

    const res = await fetch(PROXY_HEALTH_URL, {
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (res.ok) {
      return {
        name: 'Proxy',
        passed: true,
        detail: `Reachable at ${PROXY_HEALTH_URL} (HTTP ${res.status})`,
      }
    }

    return {
      name: 'Proxy',
      passed: false,
      detail: `Responded with HTTP ${res.status}`,
      remediation: 'Start the proxy with `intutic connect` or check proxy logs.',
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return {
      name: 'Proxy',
      passed: false,
      detail: `Not reachable — ${message}`,
      remediation: 'Start the proxy: ensure `intutic connect` is running or the proxy binary is started.',
    }
  }
}

/**
 * Check 2: Control plane auth — verifies stored credentials can reach the API.
 */
async function checkControlPlane(): Promise<CheckResult> {
  const creds = await loadCredentials()

  if (!creds) {
    return {
      name: 'Control Plane Auth',
      passed: false,
      detail: 'No credentials found',
      remediation: 'Run `intutic login` to authenticate.',
    }
  }

  const url = `${creds.controlPlaneUrl}/api/v1/health`

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
        detail: `Authenticated at ${creds.controlPlaneUrl}`,
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
      detail: `Reachable at ${creds.controlPlaneUrl} (HTTP ${res.status})`,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return {
      name: 'Control Plane Auth',
      passed: false,
      detail: `Unreachable — ${message}`,
      remediation: `Check network connectivity to ${creds.controlPlaneUrl}.`,
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
 * Check 5: Daemon log readable.
 */
function checkDaemonLog(): CheckResult {
  try {
    accessSync(DAEMON_LOG_PATH, constants.R_OK)

    // Try to read last few bytes to confirm it's not empty
    const content = readFileSync(DAEMON_LOG_PATH, 'utf-8')
    const lines = content.trim().split('\n')
    const lastLine = lines[lines.length - 1] || ''
    const truncated = lastLine.length > 80 ? lastLine.slice(0, 80) + '…' : lastLine

    return {
      name: 'Daemon Log',
      passed: true,
      detail: `Readable at ${DAEMON_LOG_PATH} (${lines.length} lines)`,
    }
  } catch {
    return {
      name: 'Daemon Log',
      passed: false,
      detail: `Not found or not readable at ${DAEMON_LOG_PATH}`,
      remediation: 'The log file is created when `intutic connect` runs. Start the daemon first.',
    }
  }
}

/**
 * Check 6: Valkey connectivity.
 *
 * First tries the proxy /health endpoint and looks for a `valkey` field.
 * If the proxy is unreachable or doesn't report Valkey status, falls back
 * to a direct TCP probe on port 6379.
 */
async function checkValkey(): Promise<CheckResult> {
  // Attempt 1: Read valkey status from proxy /health response
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), VALKEY_PROBE_TIMEOUT_MS)

    const res = await fetch(PROXY_HEALTH_URL, { signal: controller.signal })
    clearTimeout(timeout)

    if (res.ok) {
      const body = await res.json().catch(() => ({}))
      if (body.valkey === 'ok') {
        return {
          name: 'Valkey',
          passed: true,
          detail: 'Connected (reported by proxy /health)',
        }
      }
      // Proxy responded but doesn't report valkey status — fall through
    }
  } catch {
    // Proxy unreachable — fall through to direct probe
  }

  // Attempt 2: Direct TCP probe on port 6379
  try {
    const { createConnection } = await import('node:net')
    const connected = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port: 6379 }, () => {
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
        detail: 'Reachable at 127.0.0.1:6379 (direct TCP probe)',
      }
    }
  } catch {
    // TCP probe failed — report below
  }

  return {
    name: 'Valkey',
    passed: false,
    detail: 'Not reachable on port 6379',
    remediation: 'Start Valkey: `docker compose up -d valkey` or install locally.',
  }
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
function checkCertTrust(): CheckResult {
  // Step 1: Does the CA cert file exist?
  if (!existsSync(CA_CERT_PATH)) {
    return {
      name: 'Cert Trust',
      passed: false,
      detail: `CA certificate not found at ${CA_CERT_PATH}`,
      remediation: 'Start the proxy with `intutic connect` — it auto-generates the CA cert on first run.',
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
      // Linux: check common CA certificate directories
      const systemDirs = [
        '/usr/local/share/ca-certificates',
        '/etc/pki/ca-trust/source/anchors',
        '/etc/ca-certificates/trust-source/anchors',
      ]
      const installed = systemDirs.some(dir => {
        try {
          const files = readFileSync(join(dir, 'intutic-ca.crt'), 'utf-8')
          return files.length > 0
        } catch {
          return false
        }
      })

      if (installed) {
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
        remediation: `Copy and update trust: sudo cp ${CA_CERT_PATH} /usr/local/share/ca-certificates/intutic-ca.crt && sudo update-ca-certificates`,
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
      remediation: os === 'darwin'
        ? `Trust the cert: sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${CA_CERT_PATH}"`
        : `Copy and update trust: sudo cp ${CA_CERT_PATH} /usr/local/share/ca-certificates/intutic-ca.crt && sudo update-ca-certificates`,
    }
  }
}

// ─── Runner ──────────────────────────────────────────────────────────

export async function runDoctor(): Promise<void> {
  log.header('Intutic Doctor — Workspace Health Check')
  console.log('')

  const results: CheckResult[] = []

  // Run checks in sequence (some depend on network)
  results.push(await checkProxy())
  results.push(await checkControlPlane())
  results.push(checkSyncDaemon())
  results.push(checkHarnessConfigs())
  results.push(checkDaemonLog())
  results.push(await checkValkey())
  results.push(checkCertTrust())

  // Print results
  const passed = results.filter(r => r.passed).length
  const failed = results.filter(r => !r.passed).length

  for (const result of results) {
    if (result.passed) {
      console.log(`  ${pc.green('✓')} ${pc.bold(result.name)} — ${result.detail}`)
    } else {
      console.log(`  ${pc.red('✗')} ${pc.bold(result.name)} — ${result.detail}`)
      if (result.remediation) {
        console.log(`    ${pc.dim('→')} ${pc.dim(result.remediation)}`)
      }
    }
  }

  // Summary
  console.log('')
  if (failed === 0) {
    log.success(`All ${passed} checks passed — workspace is healthy.`)
  } else {
    log.warn(`${passed} passed, ${failed} failed — see remediations above.`)
  }
}
