/**
 * `intutic status` — Show workspace status.
 *
 * Displays auth state, detected harnesses, last sync time,
 * and config version.
 *
 * LLD #8 — Sync Daemon / CLI
 * @module
 */

import { log } from '../lib/logger.js'
import { loadCredentials, loadConfig, loadIntegrity } from '../config/store.js'
import { getActiveAgentProcesses, isSyncDaemonRunning } from '../lib/process.js'
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
    log.warn('Not authenticated. Run `intutic login` first.')
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
