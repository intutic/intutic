/**
 * `intutic siem` — SIEM export destinations: where governance events stream
 * (syslog CEF, HTTPS webhook, Splunk HEC, Datadog Logs, GCS, S3), and which
 * event sources each receives.
 *
 * Subcommands:
 *   - `intutic siem list [--json]`
 *   - `intutic siem show <destination_id> [--json]`
 *   - `intutic siem sources [--json]`
 *   - `intutic siem create --name <name> --type <adapter> --config <path> [...] [--json]`
 *   - `intutic siem update <destination_id> [...] [--json]`
 *   - `intutic siem delete <destination_id> [--json]`
 *   - `intutic siem rotate-secret <destination_id> [--json]`
 *
 * Server side: services/control-plane/src/routes/siem.ts. Writes need OWNER
 * or ADMIN. The adapter config carries credentials (a HEC token, an API key),
 * so it is read from a JSON file rather than taken on the command line, where
 * it would land in shell history. The server encrypts it, masks it on every
 * read, and refuses a destination that points at an internal address.
 *
 * @module
 */

import pc from 'picocolors'
import { log } from '../lib/logger.js'
import { fail, list, positiveInt, readJsonFile, printSigningSecret, runApiCommand, type ApiCommandOpts } from './apiCommand.js'

const ADAPTERS = ['syslog_cef', 'webhook_https', 'gcs', 's3', 'splunk_hec', 'datadog_logs'] as const

interface SiemDestination {
  destinationId: string
  name: string
  adapterType: string
  isActive: boolean
  sourceTables: string[]
  batchSize: number
  flushIntervalMs: number
  lastHeartbeatAt: string | null
  lastError: string | null
  config?: Record<string, unknown>
  signingSecret?: string
}

interface SiemListResponse {
  items: SiemDestination[]
  sources: { all: string[]; defaults: string[] }
}

/** The flags `create` and `update` share. */
export interface DestinationFlags {
  name?: string
  config?: string
  sources?: string
  defaultSources?: boolean
  batchSize?: string
  flushIntervalMs?: string
}

/** The request body for the given flags: only the fields a flag set. */
export function destinationBody(flags: DestinationFlags): Record<string, unknown> {
  if (flags.sources !== undefined && flags.defaultSources) fail('Pass --sources or --default-sources, not both.')
  const body: Record<string, unknown> = {}
  if (flags.name !== undefined) body.name = flags.name
  if (flags.config !== undefined) {
    const config = readJsonFile(flags.config)
    if (typeof config !== 'object' || config === null || Array.isArray(config)) {
      fail(`${flags.config} must hold a JSON object of adapter settings`)
    }
    body.config = config
  }
  // An empty list is the default set: every source except the opt-in ones.
  if (flags.sources !== undefined) body.sourceTables = list(flags.sources)
  if (flags.defaultSources) body.sourceTables = []
  if (flags.batchSize !== undefined) body.batchSize = positiveInt(flags.batchSize, '--batch-size')
  if (flags.flushIntervalMs !== undefined) body.flushIntervalMs = positiveInt(flags.flushIntervalMs, '--flush-interval-ms')
  return body
}

function printDestination(d: SiemDestination): void {
  log.field('Destination ID', d.destinationId)
  log.field('Name', d.name)
  log.field('Type', d.adapterType)
  log.field('Active', d.isActive ? pc.green('yes') : pc.dim('no'))
  log.field('Sources', d.sourceTables.length > 0 ? d.sourceTables.join(', ') : 'default set')
  log.field('Batch', `${d.batchSize} events / ${d.flushIntervalMs} ms`)
  if (d.config) log.field('Config', JSON.stringify(d.config))
  if (d.lastHeartbeatAt) log.field('Last heartbeat', d.lastHeartbeatAt)
  if (d.lastError) log.field('Last error', pc.red(d.lastError))
}

/** `intutic siem list` */
export async function runSiemList(opts: ApiCommandOpts): Promise<void> {
  await runApiCommand(
    opts,
    'Failed to list SIEM destinations',
    (client) => client.get<SiemListResponse>('/api/v1/siem/destinations'),
    (res) => {
      log.header('Intutic — SIEM Destinations')
      if (res.items.length === 0) {
        log.dim('  No SIEM destinations.')
        return
      }
      for (const d of res.items) {
        console.log('')
        printDestination(d)
      }
    },
  )
}

/** `intutic siem show <destination_id>` */
export async function runSiemShow(destinationId: string, opts: ApiCommandOpts): Promise<void> {
  await runApiCommand(
    opts,
    `Failed to read SIEM destination ${destinationId}`,
    (client) => client.get<SiemDestination>(`/api/v1/siem/destinations/${encodeURIComponent(destinationId)}`),
    (d) => {
      log.header('Intutic — SIEM Destination')
      printDestination(d)
    },
  )
}

/** `intutic siem sources` */
export async function runSiemSources(opts: ApiCommandOpts): Promise<void> {
  await runApiCommand(
    opts,
    'Failed to list SIEM sources',
    async (client) => (await client.get<SiemListResponse>('/api/v1/siem/destinations')).sources,
    (sources) => {
      log.header('Intutic — SIEM Sources')
      const defaults = new Set(sources.defaults)
      for (const s of sources.all) {
        console.log(`  ${s}${defaults.has(s) ? '' : pc.dim('  (opt-in: only when listed)')}`)
      }
    },
  )
}

/** `intutic siem create` */
export async function runSiemCreate(opts: ApiCommandOpts & DestinationFlags & { type?: string }): Promise<void> {
  if (!opts.type || !(ADAPTERS as readonly string[]).includes(opts.type)) {
    fail(`--type must be one of ${ADAPTERS.join(', ')}`)
  }
  const body = { ...destinationBody(opts), adapterType: opts.type }
  await runApiCommand(
    opts,
    'Failed to create SIEM destination',
    (client) => client.post<SiemDestination>('/api/v1/siem/destinations', body),
    (d) => {
      log.success('SIEM destination created.')
      printDestination(d)
      printSigningSecret(d.signingSecret)
    },
  )
}

/** `intutic siem update <destination_id>` */
export async function runSiemUpdate(
  destinationId: string,
  opts: ApiCommandOpts & DestinationFlags & { enable?: boolean },
): Promise<void> {
  const body = destinationBody(opts)
  if (opts.enable) body.isActive = true
  if (Object.keys(body).length === 0) fail('Nothing to update: pass at least one field to change.')
  await runApiCommand(
    opts,
    `Failed to update SIEM destination ${destinationId}`,
    (client) => client.put<SiemDestination>(`/api/v1/siem/destinations/${encodeURIComponent(destinationId)}`, body),
    (d) => {
      log.success('SIEM destination updated.')
      printDestination(d)
    },
  )
}

/** `intutic siem delete <destination_id>` */
export async function runSiemDelete(destinationId: string, opts: ApiCommandOpts): Promise<void> {
  await runApiCommand(
    opts,
    `Failed to delete SIEM destination ${destinationId}`,
    (client) => client.del<{ destinationId: string }>(`/api/v1/siem/destinations/${encodeURIComponent(destinationId)}`),
    () => log.success(`SIEM destination ${destinationId} deactivated; \`intutic siem update ${destinationId} --enable\` turns it back on.`),
  )
}

/** `intutic siem rotate-secret <destination_id>` */
export async function runSiemRotateSecret(destinationId: string, opts: ApiCommandOpts): Promise<void> {
  await runApiCommand(
    opts,
    `Failed to replace the signing secret of ${destinationId}`,
    (client) =>
      client.post<{ destinationId: string; signingSecret: string }>(
        `/api/v1/siem/destinations/${encodeURIComponent(destinationId)}/signing-secret`,
      ),
    (res) => {
      log.success(`New signing secret for ${res.destinationId}; deliveries are signed with it from now on.`)
      printSigningSecret(res.signingSecret)
    },
  )
}
