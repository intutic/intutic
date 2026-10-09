/**
 * `intutic inventory` — the AI harnesses and MCP servers on every connected
 * developer machine, and which of them run ungoverned.
 *
 * Subcommands:
 *   - `intutic inventory summary [--json]`
 *   - `intutic inventory harnesses|mcp-servers [filters] [--csv] [--out <file>] [--json]`
 *
 * Server side: `GET /api/v1/inventory/{summary,harnesses,mcp-servers}`
 * (services/control-plane/src/routes/inventory.ts); the two lists filter on
 * the server and serve the same CSV the dashboard downloads (`format=csv`).
 * OWNER, ADMIN and EM see every machine, a DEVELOPER only their own.
 *
 * @module
 */

import pc from 'picocolors'
import { log } from '../lib/logger.js'
import { runApiCommand, writeOutput, type ApiCommandOpts } from './apiCommand.js'

interface InventorySummary {
  devices: number
  staleDevices: number
  harnesses: number
  governedHarnesses: number
  governedPercent: number | null
  ungovernedHarnesses: number
  staleGates: number
  unverifiedHarnesses: number
  mcpServers: number
  ungovernedMcpServers: number
  skills: number
}

interface HarnessRow {
  hostname: string
  harness: string
  version: string | null
  status: string
  reasonText: string | null
  deviceStale: boolean
}

interface McpServerRow {
  hostname: string
  server: string
  harness: string
  transport: string
  status: string
  reason: string | null
  deviceStale: boolean
}

export interface InventoryListOpts extends ApiCommandOpts {
  status?: string
  harness?: string
  device?: string
  search?: string
  csv?: boolean
  out?: string
}

/** The route's query string for the given filters, plus `format=csv` when asked. */
export function inventoryQuery(opts: InventoryListOpts): string {
  const q = new URLSearchParams()
  if (opts.status) q.set('status', opts.status)
  if (opts.harness) q.set('harness', opts.harness)
  if (opts.device) q.set('device', opts.device)
  if (opts.search) q.set('q', opts.search)
  if (opts.csv) q.set('format', 'csv')
  const s = q.toString()
  return s ? `?${s}` : ''
}

function statusLabel(status: string): string {
  return status === 'governed' ? pc.green(status) : status === 'ungoverned' ? pc.red(status) : pc.yellow(status)
}

/** `intutic inventory summary` */
export async function runInventorySummary(opts: ApiCommandOpts): Promise<void> {
  await runApiCommand(
    opts,
    'Failed to read the AI inventory',
    async (client) => (await client.get<{ data: InventorySummary }>('/api/v1/inventory/summary')).data,
    (s) => {
      log.header('Intutic — AI Inventory')
      log.field('Machines', `${s.devices} (${s.staleDevices} stale)`)
      log.field(
        'Harnesses',
        `${s.harnesses}: ${s.governedHarnesses} governed${s.governedPercent === null ? '' : ` (${s.governedPercent}%)`}, ` +
          `${s.ungovernedHarnesses} ungoverned, ${s.staleGates} with a stale gate, ${s.unverifiedHarnesses} unverified`,
      )
      log.field('MCP servers', `${s.mcpServers}: ${s.ungovernedMcpServers} ungoverned`)
      log.field('Skills', String(s.skills))
    },
  )
}

async function runInventoryList<T>(
  view: 'harnesses' | 'mcp-servers',
  opts: InventoryListOpts,
  title: string,
  print: (row: T) => void,
): Promise<void> {
  const path = `/api/v1/inventory/${view}${inventoryQuery(opts)}`
  if (opts.csv) {
    await runApiCommand(
      // The output is the CSV itself.
      { dev: opts.dev },
      `Failed to export ${view}`,
      (client) => client.getFile(path),
      (bytes) => writeOutput(bytes, opts.out, view),
    )
    return
  }
  await runApiCommand(
    opts,
    `Failed to list ${view}`,
    (client) => client.get<{ data: T[] }>(path),
    (res) => {
      log.header(`Intutic — ${title}`)
      if (res.data.length === 0) {
        log.dim('  Nothing reported.')
        return
      }
      for (const r of res.data) print(r)
    },
  )
}

/** `intutic inventory harnesses` */
export async function runInventoryHarnesses(opts: InventoryListOpts): Promise<void> {
  await runInventoryList<HarnessRow>('harnesses', opts, 'Harnesses', (r) => {
    console.log(`  ${r.hostname}${r.deviceStale ? pc.dim(' (stale)') : ''}  ${r.harness}${r.version ? ` ${r.version}` : ''}  ${statusLabel(r.status)}`)
    if (r.reasonText) log.dim(`    ${r.reasonText}`)
  })
}

/** `intutic inventory mcp-servers` */
export async function runInventoryMcpServers(opts: InventoryListOpts): Promise<void> {
  await runInventoryList<McpServerRow>('mcp-servers', opts, 'MCP Servers', (r) => {
    console.log(`  ${r.hostname}${r.deviceStale ? pc.dim(' (stale)') : ''}  ${r.server} (${r.harness}, ${r.transport})  ${statusLabel(r.status)}`)
    if (r.reason) log.dim(`    ${r.reason}`)
  })
}
