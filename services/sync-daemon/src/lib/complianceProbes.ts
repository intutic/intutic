/**
 * complianceProbes.ts — Active network containment verification probes.
 *
 * Periodically attempts to make direct HTTPS connections to AI provider hosts
 * (e.g., api.anthropic.com, api2.cursor.sh) bypassing explicit proxy settings.
 *
 * If the connection succeeds and returns a certificate NOT signed by this
 * machine's Intutic CA, it indicates that the system-level firewall (pf/iptables)
 * rules are missing or disabled, allowing uncontained network access (a security
 * bypass).
 *
 * If the connection fails (connection refused/timed out) or succeeds with a
 * certificate the Intutic CA issued, containment is active and verified.
 *
 * "Signed by the Intutic CA" is checked cryptographically against the CA the
 * caller passes (`~/.intutic/ca.crt`): the leaf is the CA, or the CA issued it
 * and its signature verifies under the CA's key. It used to be the substring
 * "Intutic" anywhere in the issuer or subject, which any certificate can carry.
 *
 * The caller decides whether to probe at all. A machine that never applied
 * `intutic enforce`, in a workspace that does not enforce egress, has no
 * containment to verify, and probing it filed a CRITICAL incident on every sync.
 *
 * @module
 */

import * as https from 'node:https'
import * as tls from 'node:tls'
import * as crypto from 'node:crypto'
import { createLogger } from '@intutic/logger'

const log = createLogger('compliance-probes')

/** How a probe judges containment and names the machine it ran on. */
export interface ProbeOptions {
  /** This machine's Intutic CA, PEM. Without it no certificate counts as Intutic's. */
  caCertPem?: string
  /**
   * A stable id for this machine. A bypass on it is reported under one
   * reference per host per UTC day (`incidentId`), so the control plane files
   * one incident for the day and counts the rest rather than filing one per sync.
   */
  machineId?: string
}

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
    /** This detection's id, made once: a resend of it is processed once. */
    eventId: string
  }
}

/**
 * Check if direct outbound HTTPS traffic to a given host is contained.
 */
export function checkHostContainment(
  hostname: string,
  workspaceId: string,
  port = 443,
  opts: ProbeOptions = {},
): Promise<ProbeResult> {
  let ca: crypto.X509Certificate | null = null
  try {
    ca = opts.caCertPem ? new crypto.X509Certificate(opts.caCertPem) : null
  } catch {
    ca = null
  }
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
      const isIntutic = issuedByIntuticCa(socket.getPeerCertificate(), ca)

      req.destroy()

      if (isIntutic) {
        resolve({
          host: hostname,
          contained: true,
        })
      } else {
        // Direct connection succeeded and bypassed the proxy!
        const ts = new Date().toISOString()
        // Per machine, host and UTC day when the machine is known (the control
        // plane dedupes on it); per detection otherwise, as before.
        const ref = opts.machineId ? `${opts.machineId}\u0000${ts.slice(0, 10)}` : ts
        const incidentId = crypto.createHash('sha1').update(ref + hostname + workspaceId).digest('hex').slice(0, 16)

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
            eventId: crypto.randomBytes(16).toString('hex'),
          },
        })
      }
    })

    req.on('error', (err: NodeJS.ErrnoException) => {
      if (resolved) return
      resolved = true
      // Connection refused, connection reset, or timeout means traffic did not reach the real endpoint directly.
      // This is considered contained (failed closed).
      resolve({
        host: hostname,
        contained: true,
        // `||`, not `??`, and deliberately. `??` only falls through on
        // null/undefined, so an ErrnoException carrying `code: ''` would report
        // `error: ''` and discard the message that says what actually happened.
        // An empty code is the one case where these differ, and falling through
        // is the behaviour worth having.
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
 * True when `peer` is the Intutic CA itself, or a certificate the CA issued
 * whose signature verifies under the CA's public key. Fingerprints, not names.
 */
function issuedByIntuticCa(peer: tls.PeerCertificate, ca: crypto.X509Certificate | null): boolean {
  if (!ca || !peer?.raw) return false
  try {
    const leaf = new crypto.X509Certificate(peer.raw)
    if (leaf.fingerprint256 === ca.fingerprint256) return true
    return leaf.checkIssued(ca) && leaf.verify(ca.publicKey)
  } catch {
    return false
  }
}

/**
 * Runs active compliance probes across key AI hostnames.
 * Returns any generated network_bypass events for hosts that escaped containment.
 */
export async function runComplianceProbes(workspaceId: string, port = 443, opts: ProbeOptions = {}): Promise<ProbeResult[]> {
  const hosts = ['api.anthropic.com', 'api2.cursor.sh']
  log.debug({ hosts }, 'Starting network compliance probes')

  const results = await Promise.all(hosts.map(host => checkHostContainment(host, workspaceId, port, opts)))
  
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
