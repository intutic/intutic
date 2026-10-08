/**
 * `intutic init` — Initialize workspace.
 *
 * Detects workspace root, auto-detects harnesses, checks for stored
 * credentials, and writes local config. It writes no harness config files and
 * makes no network call: `intutic connect` writes the harness configs, from
 * the control plane's SOPs plus the local `.intutic/sops`.
 *
 * LLD #8 — Sync Daemon / CLI
 * @module
 */

import { existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { log } from '../lib/logger.js'
import { loadCredentials, loadConfig, saveConfig } from '../config/store.js'
import { detectHarnesses } from '../harness/detector.js'
import { printOnboardingGuide } from '../lib/onboarding.js'
import type { HarnessType } from '@intutic/shared-types'
import pc from 'picocolors'

/**
 * Walk up from cwd looking for .git/ or package.json to find workspace root.
 *
 * Exported for `intutic setup` (LLD #70, cohort wizard) — its codescan step
 * reuses this exact resolution, then `detectHarnesses` below, rather than a
 * second implementation of "where does this workspace start."
 */
export function findWorkspaceRoot(): string | null {
  let dir = process.cwd()
  const root = resolve('/')
  while (dir !== root) {
    if (existsSync(join(dir, '.git')) || existsSync(join(dir, 'package.json'))) {
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * Whether to install the Git hooks: an explicit `--git-hooks` /
 * `--no-git-hooks` wins; otherwise ask, but only when someone is at a
 * terminal to answer. Without a TTY the question would block a CI job or a
 * provisioning script forever, so the hooks are left alone.
 */
async function resolveWantHooks(
  flag: boolean | undefined,
  isTTY: boolean,
  ask: () => Promise<string>,
): Promise<boolean> {
  if (flag !== undefined) return flag
  if (!isTTY) return false
  const normalized = (await ask()).trim().toLowerCase()
  return normalized === '' || normalized === 'y' || normalized === 'yes'
}

export async function runInit(opts: { dev?: boolean; gitHooks?: boolean }): Promise<void> {
  log.header('Intutic — Workspace Initialization')

  // 1. Find workspace root
  const workspaceRoot = findWorkspaceRoot()
  if (!workspaceRoot) {
    log.error('Could not find workspace root (no .git/ or package.json found)')
    log.dim('Run this command from within a project directory.')
    process.exit(1)
  }
  log.success(`Workspace root: ${workspaceRoot}`)

  // 2. Detect harnesses
  log.info('Detecting AI harnesses...')
  const harnesses = await detectHarnesses(workspaceRoot)
  const detected = harnesses.filter((h) => h.detected)
  const notDetected = harnesses.filter((h) => !h.detected)

  console.log('')
  for (const h of detected) {
    console.log(`  ${pc.green('✔')} ${pc.bold(h.type)} ${pc.dim(`→ ${h.configPath}`)}`)
  }
  for (const h of notDetected) {
    console.log(`  ${pc.dim('○')} ${pc.dim(h.type)} ${pc.dim('(not detected)')}`)
  }
  console.log('')

  if (detected.length === 0) {
    log.warn('No harnesses detected. Intutic will still work via proxy redirect.')
  } else {
    log.success(`Detected ${detected.length} harness${detected.length > 1 ? 'es' : ''}`)
  }

  // 3. Check credentials
  const creds = await loadCredentials()
  if (!creds) {
    log.info('Not authenticated — fine for local use.')
    log.info('To run the proxy locally, no account needed: `intutic start`.')
    log.info('Harness config files are written by `intutic connect`, which syncs with a control plane')
    log.info('(open core does not include one; `intutic login` first if you run your own).')
  } else {
    log.success(`Authenticated as ${creds.email}`)
  }

  // 4. Write config
  //
  // Spread the existing config first (matching connect.ts's own pattern) —
  // a fresh object literal here used to silently delete any local key a
  // prior run had set (maxDailyBudgetUsd, and now allowedModels), on every
  // re-run of `intutic init`. `configVersion` and `devMode` below are the
  // only fields THIS command has an opinion about; everything else survives.
  const existing = loadConfig()
  const devMode = opts.dev || process.env.INTUTIC_DEV === '1'
  saveConfig({
    ...existing,
    workspaceRoot,
    harnesses: detected.map((h) => h.type as HarnessType),
    configVersion: 0,
    devMode,
  })

  // 5. Git hook onboarding
  const isTTY = Boolean(process.stdin.isTTY)
  const wantHooks = await resolveWantHooks(opts.gitHooks, isTTY, async () => {
    const readline = await import('node:readline')
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    return new Promise<string>((resolve) => {
      rl.question(
        'Install Intutic Git hooks (post-commit, post-checkout, pre-commit secret scan, post-merge)? [Y/n]: ',
        (answer) => {
          rl.close()
          resolve(answer)
        },
      )
    })
  })

  if (wantHooks) {
    const { installGitHooks } = await import('../lib/gitHooks.js')
    await installGitHooks(workspaceRoot)
  } else if (opts.gitHooks === undefined && !isTTY) {
    log.dim('Git hooks not installed (no terminal to ask). Re-run with --git-hooks to install them.')
  }

  log.success('Workspace initialized.')
  if (devMode) {
    log.dim('Dev mode: using local control plane (http://localhost:3001)')
  }

  // Print onboarding setup instructions for detected harnesses
  const detectedHarnessTypes = detected.map((h) => h.type)
  const apiKey = creds?.apiKey
  printOnboardingGuide(detectedHarnessTypes, apiKey)
}
