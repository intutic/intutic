/**
 * `intutic optimizer` — the SOP Optimizer's Approval mode: whether a manually
 * triggered optimizer run may apply a STRENGTHEN proposal without review.
 *
 * Subcommands:
 *   - `intutic optimizer settings [--json]` — the mode and the auto-apply threshold
 *   - `intutic optimizer set --mode <manual|auto> [--auto-threshold <n>] [--json]` — change them (OWNER, ADMIN)
 *
 * Server side: `GET` and `PUT /api/v1/dream-cycle/settings`
 * (services/control-plane/src/routes/dreamCycle.ts). The PUT takes the whole
 * object and sets an omitted threshold to 0.85, so `set` without
 * `--auto-threshold` reads the current settings first and sends their
 * threshold back.
 *
 * @module
 */

import { log } from '../lib/logger.js'
import { fail, runApiCommand, type ApiCommandOpts } from './apiCommand.js'

const SETTINGS_PATH = '/api/v1/dream-cycle/settings'

type OptimizerMode = 'manual' | 'auto'

interface OptimizerSettings {
  workspaceId: string
  mode: OptimizerMode
  autoThreshold: number
}

interface OptimizerSettingsResponse {
  ok: boolean
  settings: OptimizerSettings
}

function render(s: OptimizerSettings): void {
  log.field('Approval mode', s.mode)
  log.field('Auto-apply threshold', String(s.autoThreshold))
  log.dim(
    s.mode === 'auto'
      ? '  A manually triggered optimizer run applies a STRENGTHEN proposal scoring at least the threshold without review; every other proposal waits for review.'
      : '  Nothing is applied automatically: every proposal waits for review.',
  )
}

/** `intutic optimizer settings` */
export async function runOptimizerSettings(opts: ApiCommandOpts): Promise<void> {
  await runApiCommand(
    opts,
    'Failed to read the SOP Optimizer settings',
    async (client) => (await client.get<OptimizerSettingsResponse>(SETTINGS_PATH)).settings,
    (s) => {
      log.header('Intutic — SOP Optimizer approval mode')
      render(s)
    },
  )
}

export interface OptimizerSetOpts extends ApiCommandOpts {
  mode?: string
  autoThreshold?: string
}

/** `intutic optimizer set` */
export async function runOptimizerSet(opts: OptimizerSetOpts): Promise<void> {
  const mode = opts.mode
  if (mode !== 'manual' && mode !== 'auto') fail(`--mode must be manual or auto, got "${mode ?? ''}"`)
  let threshold: number | undefined
  if (opts.autoThreshold !== undefined) {
    threshold = Number(opts.autoThreshold)
    if (opts.autoThreshold.trim() === '' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      fail(`--auto-threshold must be a number from 0 to 1, got "${opts.autoThreshold}"`)
    }
  }
  await runApiCommand(
    opts,
    'Failed to set the SOP Optimizer approval mode',
    async (client) => {
      const autoThreshold = threshold ?? (await client.get<OptimizerSettingsResponse>(SETTINGS_PATH)).settings.autoThreshold
      return (await client.put<OptimizerSettingsResponse>(SETTINGS_PATH, { mode, autoThreshold })).settings
    },
    (s) => {
      log.success(`SOP Optimizer approval mode set to ${s.mode}.`)
      render(s)
    },
  )
}
