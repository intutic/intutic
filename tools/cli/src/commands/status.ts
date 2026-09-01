/**
 * `intutic status` — Show workspace status.
 *
 * Displays auth state, detected harnesses, last sync time,
 * and config version.
 *
 * LLD #8 — Sync Daemon / CLI
 * @module
 */

import { existsSync } from 'node:fs'
import * as node_path from 'node:path'
import { log } from '../lib/logger.js'
import { NOT_AUTHENTICATED } from '../lib/authMessages.js'
import { loadCredentials, loadConfig, loadIntegrity } from '../config/store.js'
import { getActiveAgentProcesses, isSyncDaemonRunning } from '../lib/process.js'
import { resolveDshHome, listDshProfileDirs, detectDshCoverageGap } from '@intutic/sync-daemon/harness/dshHooks'
import pc from 'picocolors'

const HARNESS_TO_PROCESS_NAME: Record<string, string[]> = {
  cursor: ['Cursor'],
  'claude-code': ['Claude Code'],
  antigravity: ['Antigravity'],
  n8n: ['n8n'],
  codex: ['Codex'],
  windsurf: ['Windsurf'],
  aider: ['Aider'],
  openhands: ['OpenHands'],
  openclaw: ['OpenClaw'],
  cline: ['VS Code'],
  'roo-code': ['VS Code'],
  continue: ['VS Code', 'JetBrains IDE'],
  'claude-desktop': ['Claude Desktop'],
  goose: ['Goose'],
  'open-webui': ['OpenWebUI'],
}

export async function runStatus(): Promise<void> {
  log.header('Intutic — Workspace Status')

  // Auth
  const creds = await loadCredentials()
  if (creds) {
    log.field('Email', creds.email)
    log.field('Workspace', creds.workspaceId)
    log.field('Control Plane', creds.controlPlaneUrl)
  } else {
    log.warn(NOT_AUTHENTICATED)
  }

  // Config
  const config = loadConfig()
  if (config) {
    log.field('Workspace Root', config.workspaceRoot)
    log.field('Dev Mode', config.devMode ? 'yes' : 'no')
    log.field('Config Version', String(config.configVersion))

    console.log('')
    log.info('Detected harnesses:')
    if (config.harnesses.length === 0) {
      log.dim('  (none)')
    } else {
      for (const h of config.harnesses) {
        console.log(`  ${pc.green('✔')} ${h}`)
      }
    }

    // dsh has no canonical config file to diff (see HARNESS_FILES.dsh in
    // configWriter.ts) and a real manual activation step after this daemon's
    // automatic writes (TD-370) — worth its own status block rather than the
    // plain checkmark every other harness gets above.
    if (config.harnesses.includes('dsh')) {
      console.log('')
      log.info('dsh (DeepSeek harness):')
      const dshHome = resolveDshHome()
      const profileDirs = await listDshProfileDirs(dshHome)
      if (profileDirs.length === 0) {
        const gap = await detectDshCoverageGap(dshHome)
        if (gap.dshDetected) {
          log.warn(`  ${pc.yellow('dsh is present on this machine but has zero profiles — nothing is governed yet.')}`)
          log.dim('  Run `dsh --profile <name> ...` once, then re-run `intutic connect` to register it.')
        } else {
          log.dim('  No dsh profiles detected.')
        }
      } else {
        const notActivated: string[] = []
        for (const dir of profileDirs) {
          const name = node_path.basename(dir)
          const installed = existsSync(node_path.join(dir, 'node_modules', '@intutic', 'gate'))
          if (!installed) notActivated.push(name)
        }
        if (notActivated.length > 0) {
          log.warn(`  ${pc.yellow(`${notActivated.length} of ${profileDirs.length} profile(s) registered but not yet activated:`)}`)
          for (const name of notActivated) {
            log.dim(`    ${name} — run: dsh plugin --profile ${name} add @intutic/gate`)
          }
          log.dim(`  See ${node_path.join(dshHome, 'INSTALL.md')}`)
        } else {
          console.log(`  ${pc.green('✔')} ${profileDirs.length} profile(s) registered and activated`)
        }
      }
    }

    // Integrity
    const integrity = loadIntegrity(config.workspaceRoot)
    if (integrity) {
      log.field('Last Sync', integrity.lastSyncAt)
      log.field('Tracked Files', String(Object.keys(integrity.files).length))
    } else {
      log.dim('  No sync data yet. Run `intutic connect` to start syncing.')
    }

    // Active Processes
    const activeProcs = getActiveAgentProcesses()
    const daemonRunning = isSyncDaemonRunning()

    console.log('')
    log.info('Active Running Processes:')
    if (activeProcs.length === 0) {
      log.dim('  (none detected)')
    } else {
      for (const p of activeProcs) {
        console.log(`  ${pc.yellow('●')} ${pc.bold(p.name)} (PID: ${p.pid}) — ${pc.dim(p.command)}`)
      }
    }

    console.log('')
    log.field('Sync Daemon State', daemonRunning ? pc.green('Running') : pc.red('Stopped'))

    // Warning highlights
    if (!daemonRunning && activeProcs.length > 0) {
      const runningNames = new Set(activeProcs.map(p => p.name))
      const configuredHarnesses = config.harnesses

      let runningConfiguredHarness = false
      for (const h of configuredHarnesses) {
        const procNames = HARNESS_TO_PROCESS_NAME[h] || []
        if (procNames.some(name => runningNames.has(name))) {
          runningConfiguredHarness = true
          break
        }
      }

      if (runningConfiguredHarness) {
        console.log('')
        log.warn(pc.yellow(pc.bold('Active agent process(es) detected, but the sync daemon ("intutic connect") is NOT running.')))
        log.dim('  Configuration changes or SOP rules will not be synced to these agents until you start the daemon.')
        log.dim('  Run `intutic connect` to start the sync daemon.')
      }
    }
  } else {
    log.warn('Not initialized. Run `intutic init` first.')
  }
}
