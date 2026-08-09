/**
 * MCP Daemon Status Reporter — periodic upload to the control plane.
 *
 * The predecessor of this module (uploadSnapshots in healthMonitor.ts, removed
 * in 514eff7c) POSTed to /api/v1/mcp-daemon/health-snapshot, a route that never
 * existed in the control plane, so every heartbeat 404'd. Its removal note said
 * "restore an ingest route before re-adding an upload" — the ingest route now
 * exists (`POST /api/v1/mcp-daemon/report`), and this is the upload half.
 *
 * The workspace credential is attached ONLY to the control-plane request, never
 * to the per-server probes in healthMonitor.ts — those hit third-party MCP
 * servers named in the user's local harness config, and forwarding the Intutic
 * key there would send it to hosts Intutic does not control.
 *
 * Reporting is best-effort and quiet: a control plane that is briefly down
 * costs one snapshot (TTL on the stored key makes staleness self-describing —
 * the dashboard reads an expired key as "not running"). No retry ladder, no
 * disk buffer: unlike hook events, a status snapshot is worthless once the next
 * one exists.
 *
 * LLD #28: MCP Daemon Mode, WS-5MCP
 * @module
 */
import https from 'node:https'
import http  from 'node:http'
import { createLogger } from '@intutic/logger'
import { getHealthSnapshot } from './healthMonitor.js'
import { getCacheStats } from './policyCache.js'
import { pendingCount } from './telemetryBatcher.js'

const logger = createLogger('mcp-proxy.statusReporter')

const CP_URL         = process.env['CONTROL_PLANE_URL'] ?? 'http://localhost:3001'
const DAEMON_API_KEY = process.env['INTUTIC_API_KEY']   ?? ''
const REPORT_MS      = parseInt(process.env['MCP_DAEMON_STATUS_REPORT_MS'] ?? '60000', 10)

const startedAt = new Date().toISOString()
let timer: ReturnType<typeof setInterval> | null = null

function buildSnapshot(running: boolean): string {
  return JSON.stringify({
    running,
    policyCache: getCacheStats(),
    telemetryBuffer: { pending: pendingCount() },
    mcpServers: getHealthSnapshot(),
    startedAt,
  })
}

function postReport(body: string): Promise<void> {
  const url = new URL('/api/v1/mcp-daemon/report', CP_URL)
  const lib = url.protocol === 'https:' ? https : http

  return new Promise<void>((resolve, reject) => {
    const req = lib.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
                   'Authorization': `Bearer ${DAEMON_API_KEY}` } },
      (res) => {
        res.resume()
        if (res.statusCode && res.statusCode < 400) resolve()
        else reject(new Error(`HTTP ${res.statusCode}`))
      },
    )
    req.on('error', reject)
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')) })
    req.write(body)
    req.end()
  })
}

/**
 * Starts periodic status reporting. A daemon with no workspace credential
 * stays silent — an unauthenticated report would only ever 401, which is the
 * 404-heartbeat failure mode this module exists to not repeat.
 */
export function startStatusReporter(): void {
  if (DAEMON_API_KEY.length === 0) {
    logger.info('status_reporter.disabled_no_api_key')
    return
  }

  const report = () => {
    postReport(buildSnapshot(true)).catch((err: unknown) => {
      logger.debug({ err: err instanceof Error ? err.message : String(err) }, 'status_reporter.report_failed')
    })
  }

  report() // First snapshot immediately — the panel should not wait a full interval.
  timer = setInterval(report, REPORT_MS)
  timer.unref()
}

/**
 * Stops the timer and sends a final `running: false` snapshot so the dashboard
 * flips promptly on clean shutdown instead of waiting out the TTL.
 */
export async function stopStatusReporter(): Promise<void> {
  if (timer) { clearInterval(timer); timer = null }
  if (DAEMON_API_KEY.length === 0) return
  await postReport(buildSnapshot(false)).catch(() => {
    // Shutdown path — the TTL covers an unreachable control plane.
  })
}
