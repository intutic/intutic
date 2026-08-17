/**
 * `intutic budget` — CLI command to check remaining budget and active loops.
 */

import type { IntuticConfig } from '@intutic/shared-types'
import { log } from '../lib/logger.js'
import { loadCredentials, loadConfig } from '../config/store.js'
import { resolveControlPlaneUrl } from '../config/paths.js'
import { createApiClient } from '../lib/api.js'
import type { LoopListResponse } from './skill.js'
import pc from 'picocolors'

/**
 * Response body of `GET /api/v1/budget` — mirrors what the control plane's
 * `routes/budget.ts` returns, and the dashboard's `BudgetStatus`. Every
 * monetary field is a JSON number here (the control plane has already run
 * `parseFloat` over the Postgres numerics), unlike the loop rows below.
 */
export interface BudgetStatusResponse {
  workspace_id: string
  monthly_budget_usd: number
  monthly_spend_usd: number
  daily_budget_usd: number
  daily_spend_usd: number
  pct_monthly_used: number
  pct_daily_used: number
  alert_threshold_pct: number
  alert_triggered: boolean
  budget_remaining_usd: number
}

/** Fallback local cap when the workspace config sets neither spelling. */
export const DEFAULT_MAX_DAILY_BUDGET_USD = 10.0

/**
 * Resolve the local daily spending cap from `~/.intutic/config.json`.
 *
 * Both spellings are accepted on purpose: `IntuticConfig` carries
 * `maxDailyBudgetUsd` and the `max_daily_budget_usd` alias, and a config
 * written by an older CLI (or by hand, following the snake_case docs) uses the
 * latter. camelCase wins when both are present.
 */
export function resolveLocalDailyBudget(
  config: Pick<IntuticConfig, 'maxDailyBudgetUsd' | 'max_daily_budget_usd'> | null,
): number {
  return config?.maxDailyBudgetUsd ?? config?.max_daily_budget_usd ?? DEFAULT_MAX_DAILY_BUDGET_USD
}

/**
 * Response body of `GET /intutic/spend` (proxy `router.rs`, loopback-only).
 *
 * This is the MACHINE-LOCAL number — what `local_spend.rs` has summed from
 * this one laptop's `local-spend-*.jsonl` files today, the same figure the
 * budget gate compares against on every request. It is a different number
 * from `BudgetStatusResponse` above, which is the WORKSPACE aggregate across
 * every member and machine. Never conflate the two in output — always label
 * which is which.
 */
export interface LocalSpendResponse {
  local_spend_usd_today: number
  local_cap_usd: number
  enforced: boolean
}

const LOCAL_PROXY_SPEND_URL = 'http://127.0.0.1:4000/intutic/spend'
const LOCAL_PROXY_TIMEOUT_MS = 1_500

/**
 * Fetch today's local-machine spend from the local proxy.
 *
 * Best-effort and optional: the proxy may not be running (or may be bound to
 * a different port), and this figure is a nice-to-have next to the workspace
 * numbers above, not something worth failing the command over. Returns null
 * on any failure — timeout, connection refused, non-2xx, or a body that
 * doesn't parse — and callers fall back to a dash rather than throwing.
 */
export async function fetchLocalSpend(
  fetchImpl: typeof fetch = fetch,
): Promise<LocalSpendResponse | null> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), LOCAL_PROXY_TIMEOUT_MS)
    try {
      const res = await fetchImpl(LOCAL_PROXY_SPEND_URL, { signal: controller.signal })
      if (!res.ok) return null
      return (await res.json()) as LocalSpendResponse
    } finally {
      clearTimeout(timeout)
    }
  } catch {
    return null
  }
}

export async function runBudget(opts: { dev?: boolean }): Promise<void> {
  log.header('Intutic — Budget & Loop Status')

  const creds = await loadCredentials()
  const config = loadConfig()
  const devMode = opts.dev || config?.devMode || process.env.INTUTIC_DEV === '1'

  if (creds) {
    const controlPlaneUrl = resolveControlPlaneUrl(devMode)
    const client = createApiClient(controlPlaneUrl, creds.apiKey)

    // 1. Fetch Cloud Budget Status
    try {
      const budgetRes = await client.get<BudgetStatusResponse>('/api/v1/budget')
      if (budgetRes) {
        log.info('Cloud Budget Status:')
        log.field('Workspace ID', budgetRes.workspace_id)
        log.field('Daily Spend', `$${budgetRes.daily_spend_usd.toFixed(4)} / $${budgetRes.daily_budget_usd.toFixed(2)} (${budgetRes.pct_daily_used}%)`)
        log.field('Monthly Spend', `$${budgetRes.monthly_spend_usd.toFixed(2)} / $${budgetRes.monthly_budget_usd.toFixed(2)} (${budgetRes.pct_monthly_used}%)`)
        log.field('Remaining Budget', `$${budgetRes.budget_remaining_usd.toFixed(2)}`)
        if (budgetRes.alert_triggered) {
          console.log(`  ${pc.red('⚠️ Alert: Spend threshold exceeded!')}`)
        }
      }
    } catch (err) {
      log.warn(`Failed to fetch cloud budget status: ${err instanceof Error ? err.message : String(err)}`)
    }
  } else {
    log.info('Running in Standalone (Offline) Mode.')
  }

  // 2. Local Spending Cap
  const maxDailyBudget = resolveLocalDailyBudget(config)
  log.field('Local Spending Cap', `$${maxDailyBudget.toFixed(2)} (configured in ~/.intutic/config.json)`)

  // Local Spend Today — the standing gap this closes: the cap above has
  // always printed, but never what's actually been spent against it. Sourced
  // from the proxy's /intutic/spend (loopback-only), so it's a dash rather
  // than an error when the proxy isn't running.
  const localSpend = await fetchLocalSpend()
  log.field(
    'Local Spend Today',
    localSpend
      ? `$${localSpend.local_spend_usd_today.toFixed(4)}`
      : '— (local proxy not running)',
  )

  // 3. Fetch Active Loops (requires connection)
  if (creds) {
    const controlPlaneUrl = resolveControlPlaneUrl(devMode)
    const client = createApiClient(controlPlaneUrl, creds.apiKey)
    try {
      const loopsRes = await client.get<LoopListResponse>('/api/v1/loops')
      if (loopsRes.ok && loopsRes.loops) {
        const activeLoops = loopsRes.loops.filter(l => l.status === 'ACTIVE')
        console.log('')
        log.info(`Active Running Loops (${activeLoops.length}):`)
        if (activeLoops.length === 0) {
          log.dim('  (none active)')
        } else {
          console.log(`  ${pc.bold('Loop Run ID')}           | ${pc.bold('Name')}           | ${pc.bold('Token Spend')} | ${pc.bold('Budget Limit')}`)
          console.log('  ' + '-'.repeat(70))
          for (const loop of activeLoops) {
            console.log(`  ${loop.loopRunId.padEnd(21)} | ${loop.name.padEnd(14)} | $${parseFloat(loop.totalTokenCostUsd).toFixed(4).padEnd(10)} | $${parseFloat(loop.budgetLimitUsd).toFixed(2)}`)
          }
        }
      }
    } catch (err) {
      log.warn(`Failed to fetch loops status: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

// ─── `intutic budget --watch` ─────────────────────────────────────────

/** Default tick interval, in seconds, when `--interval` is not given. */
export const DEFAULT_WATCH_INTERVAL_SECONDS = 5

/**
 * How many local ticks pass between workspace refreshes.
 *
 * The machine-local number is a synchronous read of a small cached file —
 * cheap enough to poll every tick. The workspace number is a control-plane
 * aggregate across every member and machine in the workspace; polling it as
 * often as the local number would hammer the API for a figure that does not
 * move nearly that fast. Refreshing it every 6th tick (30s at the default
 * 5s interval) keeps it "refreshed less often" without adding a second timer.
 */
export const WORKSPACE_REFRESH_EVERY_N_TICKS = 6

/**
 * There is no existing TTY re-render/watch precedent anywhere in this CLI —
 * every other long-running command (`intutic connect`, the sync daemon)
 * either logs structured lines or is a service, never a redrawn screen. This
 * follows that house shape: one line appended per tick, not a cleared and
 * redrawn terminal.
 */
export async function printWatchTick(
  fetchLocalSpendFn: () => Promise<LocalSpendResponse | null>,
  fetchWorkspaceBudgetFn: () => Promise<BudgetStatusResponse | null>,
  includeWorkspace: boolean,
  lastWorkspace: BudgetStatusResponse | null,
): Promise<BudgetStatusResponse | null> {
  const local = await fetchLocalSpendFn()
  const workspace = includeWorkspace ? await fetchWorkspaceBudgetFn() : lastWorkspace

  const time = new Date().toLocaleTimeString()
  const localPart = local
    ? `machine-local: $${local.local_spend_usd_today.toFixed(4)} / $${local.local_cap_usd.toFixed(2)}${local.enforced ? '' : ' (enforcement off)'}`
    : 'machine-local: — (local proxy not running)'
  const workspacePart = workspace
    ? `workspace: $${workspace.daily_spend_usd.toFixed(4)} / $${workspace.daily_budget_usd.toFixed(2)}`
    : 'workspace: — (not connected)'

  console.log(`[${time}] ${localPart}  |  ${workspacePart}`)
  return workspace
}

export async function runBudgetWatch(opts: { dev?: boolean; interval?: string }): Promise<void> {
  log.header('Intutic — Live Budget Watch')
  log.dim('  Printing one line per tick. Press Ctrl+C to stop.')
  console.log('')

  const creds = await loadCredentials()
  const config = loadConfig()
  const devMode = opts.dev || config?.devMode || process.env.INTUTIC_DEV === '1'
  const client = creds ? createApiClient(resolveControlPlaneUrl(devMode), creds.apiKey) : null

  const intervalSeconds = (() => {
    const parsed = Number(opts.interval)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WATCH_INTERVAL_SECONDS
  })()

  const fetchWorkspaceBudget = async (): Promise<BudgetStatusResponse | null> => {
    if (!client) return null
    try {
      return await client.get<BudgetStatusResponse>('/api/v1/budget')
    } catch {
      return null
    }
  }

  let lastWorkspace: BudgetStatusResponse | null = null
  let tick = 0

  const runTick = async () => {
    const includeWorkspace = tick % WORKSPACE_REFRESH_EVERY_N_TICKS === 0
    lastWorkspace = await printWatchTick(
      () => fetchLocalSpend(),
      fetchWorkspaceBudget,
      includeWorkspace,
      lastWorkspace,
    )
    tick += 1
  }

  await runTick()
  setInterval(runTick, intervalSeconds * 1000)
}
