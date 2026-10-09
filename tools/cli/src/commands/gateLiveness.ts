/**
 * `intutic gate-liveness` — whether each installed harness's gate is actually
 * reporting, and whether a silent-gate alert is open for it.
 *
 * Server side: `GET /api/v1/governance/gate-liveness`
 * (services/control-plane/src/routes/gateLiveness.ts), OWNER, ADMIN or EM.
 * The hourly sweep alerts on a gate that goes silent; this is the read side,
 * for when no notification rule is set up or the alert has not fired yet.
 *
 * @module
 */

import pc from 'picocolors'
import { log } from '../lib/logger.js'
import { runApiCommand, type ApiCommandOpts } from './apiCommand.js'

interface GateLivenessResponse {
  windowHours: number
  gates: Array<{
    harnessType: string
    status: 'reporting' | 'silent' | 'new'
    lastSeen: string | null
    agentLastSeen: string | null
    alertOpen: boolean
  }>
}

const STATUS = { reporting: pc.green('reporting'), silent: pc.red('silent'), new: pc.dim('new') }

/** `intutic gate-liveness` */
export async function runGateLiveness(opts: ApiCommandOpts): Promise<void> {
  await runApiCommand(
    opts,
    'Failed to read gate liveness',
    (client) => client.get<GateLivenessResponse>('/api/v1/governance/gate-liveness'),
    (res) => {
      log.header('Intutic — Gate Liveness')
      log.dim(`  A gate is reporting when it sent an event in the last ${res.windowHours} hours.`)
      if (res.gates.length === 0) {
        log.dim('  No harnesses installed in this workspace.')
        return
      }
      for (const g of res.gates) {
        console.log('')
        log.field('Harness', g.harnessType)
        log.field('Gate', `${STATUS[g.status]}${g.alertOpen ? pc.red('  (silent-gate alert open)') : ''}`)
        log.field('Last gate event', g.lastSeen ?? '—')
        log.field('Agent last seen', g.agentLastSeen ?? '—')
      }
    },
  )
}
