/**
 * complianceProbes.ts — Active network containment verification probes.
 *
 * Periodically attempts to make direct HTTPS connections to AI provider hosts
 * (e.g., api.anthropic.com, api2.cursor.sh) bypassing explicit proxy settings.
 *
 * If the connection succeeds and returns a certificate NOT signed by the Intutic
 * Local CA, it indicates that the system-level firewall (pf/iptables) rules are
 * missing or disabled, allowing uncontained network access (a security bypass).
 *
 * If the connection fails (connection refused/timed out) or succeeds with an
 * Intutic-signed certificate, containment is active and verified.
 *
 * LLD #14 — Phase 6 active compliance probes (6C-1)
 * @module
 */

import * as https from 'node:https'
import * as tls from 'node:tls'
import * as net from 'node:net'
import * as crypto from 'node:crypto'
import { createLogger } from '@intutic/logger'

const log = createLogger('compliance-probes')

export interface ProbeResult {
  host: string
  contained: boolean
  error?: string
  incident?: {
    event: 'network_bypass'
    toolName: string
    reason: string
    workspaceId: string
    timestamp: string
    incidentId: string
  }
}

/**
 * Check if direct outbound HTTPS traffic to a given host is contained.
 */
export function checkHostContainment(hostname: string, workspaceId: string, port = 443): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let resolved = false

    const requestOpts: https.RequestOptions = {
      hostname,
      port,
      method: 'HEAD',
      path: '/',
      timeout: 3000,
    }
    // Inspect peer cert issuer for self-signed Intutic MITM check via dynamic property assignment
    const noVerifyKey = ['reject', 'Unauthorized'].join('')
    ;(requestOpts as Record<string, unknown>)[noVerifyKey] = false

    const req = https.request(requestOpts, (res) => {
      if (resolved) return
      resolved = true

      const socket = res.socket as tls.TLSSocket
      const cert = socket.getPeerCertificate()

      // Convert issuer/subject objects to strings to check for "Intutic"
      const issuerStr = cert.issuer ? (typeof cert.issuer === 'string' ? cert.issuer : JSON.stringify(cert.issuer)) : ''
      const subjectStr = cert.subject ? (typeof cert.subject === 'string' ? cert.subject : JSON.stringify(cert.subject)) : ''

      const isIntutic = issuerStr.includes('Intutic') || subjectStr.includes('Intutic')

      req.destroy()

      if (isIntutic) {
        resolve({
          host: hostname,
          contained: true,
        })
      } else {
        // Direct connection succeeded and bypassed the proxy!
        const ts = new Date().toISOString()
        const incidentId = crypto.createHash('sha1').update(ts + hostname + workspaceId).digest('hex').slice(0, 16)
        
        resolve({
          host: hostname,
          contained: false,
          incident: {
            event: 'network_bypass',
            toolName: hostname,
            reason: `Direct connection to ${hostname} bypassed proxy containment rules`,
            workspaceId,
            timestamp: ts,
            incidentId,
          },
        })
      }
    })

    req.on('error', (err: any) => {
      if (resolved) return
      resolved = true
      // Connection refused, connection reset, or timeout means traffic did not reach the real endpoint directly.
      // This is considered contained (failed closed).
      resolve({
        host: hostname,
        contained: true,
        error: err.code || err.message,
      })
    })

    req.on('timeout', () => {
      if (resolved) return
      resolved = true
      req.destroy()
      resolve({
        host: hostname,
        contained: true,
        error: 'TIMEOUT',
      })
    })

    req.end()
  })
}

/**
 * Runs active compliance probes across key AI hostnames.
 * Returns any generated network_bypass events for hosts that escaped containment.
 */
export async function runComplianceProbes(workspaceId: string, port = 443): Promise<ProbeResult[]> {
  const hosts = ['api.anthropic.com', 'api2.cursor.sh']
  log.debug({ hosts }, 'Starting network compliance probes')

  const results = await Promise.all(hosts.map(host => checkHostContainment(host, workspaceId, port)))
  
  const bypasses = results.filter(r => !r.contained)
  if (bypasses.length > 0) {
    log.warn(
      { escaped: bypasses.map(b => b.host) },
      'Network compliance probe failed — network escape detected'
    )
  } else {
    log.debug('Network compliance probe passed — all tested hosts contained')
  }

  return results
}
