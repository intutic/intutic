/**
 * `intutic budget` — CLI command to check remaining budget and active loops.
 */

import { log } from '../lib/logger.js'
import { loadCredentials, loadConfig } from '../config/store.js'
import { resolveControlPlaneUrl } from '../config/paths.js'
import { createApiClient } from '../lib/api.js'
import pc from 'picocolors'

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
      const budgetRes = await client.get<any>('/api/v1/budget')
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
    } catch (err: any) {
      log.warn(`Failed to fetch cloud budget status: ${err.message}`)
    }
  } else {
    log.info('Running in Standalone (Offline) Mode.')
  }

  // 2. Local Spending Cap
  const maxDailyBudget = config?.maxDailyBudgetUsd ?? config?.max_daily_budget_usd ?? 10.0
  log.field('Local Spending Cap', `$${maxDailyBudget.toFixed(2)} (configured in ~/.intutic/config.json)`)

  // 3. Fetch Active Loops (requires connection)
  if (creds) {
    const controlPlaneUrl = resolveControlPlaneUrl(devMode)
    const client = createApiClient(controlPlaneUrl, creds.apiKey)
    try {
      const loopsRes = await client.get<{ ok: boolean; loops: any[] }>('/api/v1/loops')
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
    } catch (err: any) {
      log.warn(`Failed to fetch loops status: ${err.message}`)
    }
  }
}
