/**
 * `intutic inventory` — the AI harnesses, MCP servers and skill bundles on
 * every connected developer machine, and which of them run ungoverned.
 *
 * Subcommands:
 *   - `intutic inventory summary [--json]`
 *   - `intutic inventory devices [--json]`
 *   - `intutic inventory harnesses|mcp-servers [filters] [--csv] [--out <file>] [--json]`
 *   - `intutic inventory skills [--device <id>] [--search <text>] [--json]`
 *   - `intutic inventory disconnects [--limit <n>] [--json]`
 *
 * Server side: `GET /api/v1/inventory/{summary,devices,harnesses,mcp-servers,skills,disconnects}`
 * (services/control-plane/src/routes/inventory.ts); the harness and MCP
 * server lists filter on the server and serve the same CSV the dashboard
 * downloads (`format=csv`). The skills list filters by machine and text only
 * and has no CSV, as on the dashboard.
 * OWNER, ADMIN and EM see every machine, a DEVELOPER only their own.
 *
 * @module
 */

import pc from 'picocolors'
import { log } from '../lib/logger.js'
import { positiveInt, runApiCommand, writeOutput, type ApiCommandOpts } from './apiCommand.js'

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

interface DeviceRow {
  deviceId: string
  hostname: string
  platform: string
  cliVersion: string | null
  reportedBy: string | null
  lastSeenAt: string
  stale: boolean
  disconnectedAt: string | null
  harnesses: number
  ungovernedHarnesses: number
  staleGates: number
}

interface DisconnectRow {
  hostname: string
  scope: 'machine' | 'harness'
  harnesses: string[]
  reportedBy: string | null
  createdAt: string
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

interface SkillRow {
  hostname: string
  name: string
  source: string
  sha256: string | null
  scanned: boolean
  clean: boolean
  findingsCount: number
  scriptCount: number
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

/** A skill bundle's content scan, as the dashboard's Content scan column says it. */
export function skillScanLabel(r: Pick<SkillRow, 'scanned' | 'clean' | 'findingsCount'>): string {
  if (!r.scanned) return pc.yellow('not readable')
  if (r.clean) return pc.green('clean')
  return pc.yellow(`${r.findingsCount} finding${r.findingsCount === 1 ? '' : 's'}`)
}

/** `intutic inventory skills` */
export async function runInventorySkills(opts: Pick<InventoryListOpts, 'device' | 'search' | 'json' | 'dev'>): Promise<void> {
  await runApiCommand(
    opts,
    'Failed to list skills',
    (client) => client.get<{ data: SkillRow[] }>(`/api/v1/inventory/skills${inventoryQuery({ device: opts.device, search: opts.search })}`),
    (res) => {
      log.header('Intutic — Skills')
      if (res.data.length === 0) {
        log.dim('  Nothing reported.')
        return
      }
      for (const r of res.data) {
        const files = `${r.scriptCount} bundled file${r.scriptCount === 1 ? '' : 's'}`
        console.log(`  ${r.hostname}${r.deviceStale ? pc.dim(' (stale)') : ''}  ${r.name} (${r.source})  ${skillScanLabel(r)}  ${pc.dim(files)}`)
      }
    },
  )
}

/** `intutic inventory devices`: one line per machine, its id first, for `--device`. */
export async function runInventoryDevices(opts: ApiCommandOpts): Promise<void> {
  await runApiCommand(
    opts,
    'Failed to list machines',
    (client) => client.get<{ data: DeviceRow[] }>('/api/v1/inventory/devices'),
    (res) => {
      log.header('Intutic — Machines')
      if (res.data.length === 0) {
        log.dim('  Nothing reported.')
        return
      }
      for (const d of res.data) {
        const state = d.disconnectedAt ? pc.dim(` (disconnected ${d.disconnectedAt})`) : d.stale ? pc.dim(' (stale)') : ''
        console.log(`  ${d.deviceId}  ${d.hostname}${state}  ${d.platform}${d.cliVersion ? `, CLI ${d.cliVersion}` : ''}`)
        log.dim(
          `    ${d.harnesses} harness${d.harnesses === 1 ? '' : 'es'}, ${d.ungovernedHarnesses} ungoverned, ` +
            `${d.staleGates} with a stale gate; last report ${d.lastSeenAt}${d.reportedBy ? ` by ${d.reportedBy}` : ''}`,
        )
      }
    },
  )
}

/** `intutic inventory disconnects`: machines that ran `intutic disconnect`, newest first. */
export async function runInventoryDisconnects(opts: ApiCommandOpts & { limit?: string }): Promise<void> {
  const query = opts.limit === undefined ? '' : `?limit=${positiveInt(opts.limit, '--limit')}`
  await runApiCommand(
    opts,
    'Failed to list disconnects',
    (client) => client.get<{ data: DisconnectRow[] }>(`/api/v1/inventory/disconnects${query}`),
    (res) => {
      log.header('Intutic — Disconnects')
      if (res.data.length === 0) {
        log.dim('  No machine has disconnected.')
        return
      }
      for (const r of res.data) {
        const what = r.scope === 'machine' ? 'every harness' : r.harnesses.join(', ')
        console.log(`  ${r.createdAt}  ${r.hostname}  ${what}${r.reportedBy ? pc.dim(`  by ${r.reportedBy}`) : ''}`)
      }
    },
  )
}
