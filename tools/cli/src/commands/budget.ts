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
interface BudgetStatusResponse {
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
