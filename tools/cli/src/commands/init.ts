/**
 * `intutic init` — Initialize workspace.
 *
 * Detects workspace root, auto-detects harnesses, validates
 * credentials, and writes local config.
 *
 * LLD #8 — Sync Daemon / CLI
 * @module
 */

import { existsSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { log } from '../lib/logger.js'
import { loadCredentials, saveConfig } from '../config/store.js'
import { detectHarnesses } from '../harness/detector.js'
import { printOnboardingGuide } from '../lib/onboarding.js'
import type { HarnessType } from '@intutic/shared-types'
import pc from 'picocolors'

/**
 * Walk up from cwd looking for .git/ or package.json to find workspace root.
 */
function findWorkspaceRoot(): string | null {
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

export async function runInit(opts: { dev?: boolean }): Promise<void> {
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
    log.warn('Not authenticated. Run `intutic login` to connect to the control plane.')
  } else {
    log.success(`Authenticated as ${creds.email}`)
  }

  // 4. Write config
  const devMode = opts.dev || process.env.INTUTIC_DEV === '1'
  saveConfig({
    workspaceRoot,
    harnesses: detected.map((h) => h.type as HarnessType),
    configVersion: 0,
    devMode,
  })

  // 5. Prompt for Git hook onboarding
  const readline = await import('node:readline')
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  const wantHooks = await new Promise<boolean>((resolve) => {
    rl.question('Would you like to install Git sync hooks (post-commit, post-checkout)? [Y/n]: ', (answer) => {
      rl.close()
      const normalized = answer.trim().toLowerCase()
      if (normalized === '' || normalized === 'y' || normalized === 'yes') {
        resolve(true)
      } else {
        resolve(false)
      }
    })
  })

  if (wantHooks) {
    const { installGitHooks } = await import('../lib/gitHooks.js')
    await installGitHooks(workspaceRoot)
  }

  log.success('Workspace initialized.')
  if (devMode) {
    log.dim('Dev mode: using local control plane (http://localhost:3001)')
  }

  // Print onboarding setup instructions for detected harnesses
  const detectedHarnessTypes = detected.map((h) => h.type)
  const apiKey = creds?.apiKey
  printOnboardingGuide(detectedHarnessTypes, apiKey, devMode)
}
