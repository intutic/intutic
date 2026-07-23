/**
 * Intutic CLI — Skill Management and Loop Engineering Governance Commands.
 *
 * LLD Phase 8 — Loop Engineering & Ingestion Proposals
 */

import { existsSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { log } from '../lib/logger.js'
import { loadCredentials, loadConfig } from '../config/store.js'
import { resolveControlPlaneUrl } from '../config/paths.js'
import { createApiClient } from '../lib/api.js'
import pc from 'picocolors'

// ─── Skill Commands ──────────────────────────────────────────────────

export async function runSkillList(): Promise<void> {
  log.header('Intutic — Skill Discovery')
  const config = loadConfig()
  const workspaceRoot = config?.workspaceRoot ?? process.cwd()

  const filesToScan = [
    '.cursorrules',
    'CLAUDE.md',
    '.windsurfrules',
    '.clauderules',
    'rules.md',
  ]

  const skillsReport: any[] = []
  let found = 0

  for (const file of filesToScan) {
    const fullPath = join(workspaceRoot, file)
    if (existsSync(fullPath)) {
      found++
      const content = await fs.readFile(fullPath, 'utf8')
      const lines = content.split('\n')
      console.log(`  ${pc.green('✔')} ${pc.bold(file)} (${lines.length} lines)`)
      skillsReport.push({
        filePath: file,
        linesCount: lines.length,
        issuesDetected: 0,
      })
    }
  }

  if (found === 0) {
    log.info('No active skill or rule files found in workspace root.')
  } else {
    log.success(`Discovered ${found} local harness configuration/skill files.`)
  }

  // Report discovered skills to the Control Plane
  const creds = await loadCredentials().catch(() => null)
  if (creds && skillsReport.length > 0) {
    try {
      const client = await getClient(config?.devMode)
      await client.post(`/api/v1/workspaces/${creds.workspaceId}/skills/report`, { skills: skillsReport })
      log.dim('Reported local skills to Intutic control plane.')
    } catch (err) {
      // Non-blocking
    }
  }
}

export async function runSkillAudit(): Promise<void> {
  log.header('Intutic — Skill Security Audit')
  const config = loadConfig()
  const workspaceRoot = config?.workspaceRoot ?? process.cwd()

  const creds = await loadCredentials().catch(() => null)
  let enableLocalSkillAuditDelete = false

  // Fetch workspace settings to see if auto-delete is enabled
  if (creds) {
    try {
      const client = await getClient(config?.devMode)
      const syncConfig = await client.fetchConfig(creds.workspaceId)
      enableLocalSkillAuditDelete = syncConfig.settings?.enableLocalSkillAuditDelete ?? false
    } catch {
      // fallback to false
    }
  }

  const filesToScan = [
    '.cursorrules',
    'CLAUDE.md',
    '.windsurfrules',
    '.clauderules',
  ]

  let issues = 0
  const skillsReport: any[] = []

  for (const file of filesToScan) {
    const fullPath = join(workspaceRoot, file)
    if (existsSync(fullPath)) {
      const content = await fs.readFile(fullPath, 'utf8')
      let fileIssues = 0
      let contentLines = content.split('\n')
      let fileUpdated = false

      // 1. Audit for secrets (AWS, Intutic, generic keys)
      if (content.match(/vk_[a-zA-Z0-9]{30,}/)) {
        log.error(`[${file}] Hardcoded Intutic virtual key prefix detected.`)
        fileIssues++
      }
      if (content.match(/sk-live-[a-zA-Z0-9]{30,}/)) {
        log.error(`[${file}] Hardcoded API secrets detected.`)
        fileIssues++
      }

      // 2. Audit for unsafe wildcard commands (e.g. rm -rf *, sh *)
      if (content.match(/rm\s+-rf\s+[\*\/]/)) {
        log.warn(`[${file}] Unsafe recursive delete wildcard patterns (rm -rf *) found.`)
        fileIssues++
      }
      if (content.match(/curl\s+|wget\s+/)) {
        log.warn(`[${file}] Network retrieval commands (curl, wget) found inside rules instructions.`)
        fileIssues++
      }

      // 3. Auto-delete/prune unsafe lines if setting is enabled
      if (fileIssues > 0 && enableLocalSkillAuditDelete) {
        const filteredLines = contentLines.filter((line) => {
          const isSecret = line.match(/vk_[a-zA-Z0-9]{30,}/) || line.match(/sk-live-[a-zA-Z0-9]{30,}/)
          const isUnsafeCmd = line.match(/rm\s+-rf\s+[\*\/]/) || line.match(/curl\s+|wget\s+/)
          if (isSecret || isUnsafeCmd) {
            fileUpdated = true
            return false
          }
          return true
        })

        if (fileUpdated) {
          await fs.writeFile(fullPath, filteredLines.join('\n'), 'utf8')
          log.success(`[${file}] Auto-pruned unsafe lines/rules during security audit.`)
        }
      }

      issues += fileIssues
      skillsReport.push({
        filePath: file,
        linesCount: contentLines.length,
        issuesDetected: fileIssues,
      })
    }
  }

  if (issues === 0) {
    log.success('Skill security audit passed. No credentials or critical safety risks detected.')
  } else {
    log.warn(`Security audit completed with ${issues} findings. Review warnings above.`)
  }

  // Report findings to Control Plane
  if (creds && skillsReport.length > 0) {
    try {
      const client = await getClient(config?.devMode)
      await client.post(`/api/v1/workspaces/${creds.workspaceId}/skills/report`, { skills: skillsReport })
    } catch {
      // Non-blocking
    }
  }
}

// ─── Loop Commands ───────────────────────────────────────────────────

async function getClient(dev?: boolean) {
  const creds = await loadCredentials()
  if (!creds) {
    log.error('Not authenticated. Run `intutic login` first.')
    process.exit(1)
  }
  const devMode = dev || process.env.INTUTIC_DEV === '1'
  const controlPlaneUrl = resolveControlPlaneUrl(devMode)
  return createApiClient(controlPlaneUrl, creds.apiKey)
}

async function resolveLocalSops(sopsArg?: string): Promise<string[]> {
  if (!sopsArg) return []
  const config = loadConfig()
  const workspaceRoot = config?.workspaceRoot ?? process.cwd()
  const sopsDir = join(workspaceRoot, '.intutic', 'sops')

  let dirs: string[] = []
  try {
    const entries = await fs.readdir(sopsDir, { withFileTypes: true })
    dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }

  const selectedSops: string[] = []
  const parts = sopsArg.split(',').map((p) => p.trim())
  for (const part of parts) {
    const optIndex = parseInt(part, 10) - 1
    if (!isNaN(optIndex) && optIndex >= 0 && optIndex < dirs.length) {
      selectedSops.push(dirs[optIndex])
    } else {
      const partLower = part.toLowerCase()
      const matched = dirs.find((d) => d.toLowerCase() === partLower) ||
                      dirs.find((d) => d.toLowerCase().includes(partLower))
      if (matched && !selectedSops.includes(matched)) {
        selectedSops.push(matched)
      }
    }
  }
  return selectedSops
}

export async function runLoopStart(opts: { 
  name: string; 
  budget?: string; 
  sops?: string; 
  autoJudge?: boolean; 
  dev?: boolean; 
}): Promise<void> {
  log.header('Intutic — Start Loop Run')
  if (!opts.name) {
    log.error('Loop run name is required (--name <name>)')
    process.exit(1)
  }

  const config = loadConfig()
  const workspaceRoot = config?.workspaceRoot ?? process.cwd()
  const resolvedSops = await resolveLocalSops(opts.sops)

  if (resolvedSops.length > 0) {
    const sessionContextPath = join(workspaceRoot, '.intutic', 'session-context.json')
    await fs.mkdir(join(workspaceRoot, '.intutic'), { recursive: true }).catch(() => {})
    await fs.writeFile(
      sessionContextPath,
      JSON.stringify({ activeLocalSops: resolvedSops }, null, 2) + '\n',
      'utf-8'
    )
    log.info(`Active local SOPs configuration updated: ${resolvedSops.join(', ')}`)
  }

  const client = await getClient(opts.dev)
  try {
    const res = await client.post<{ ok: boolean; loop: { loopRunId: string; budgetLimitUsd: string } }>(
      '/api/v1/loops/start',
      { 
        name: opts.name, 
        budgetLimitUsd: opts.budget,
        sops: resolvedSops,
        autoJudge: opts.autoJudge
      }
    )

    if (res.ok && res.loop) {
      log.success(`Loop run active: ${pc.bold(res.loop.loopRunId)}`)
      log.info(`Budget limit: $${res.loop.budgetLimitUsd} USD`)

      // Write loop env file locally
      const loopEnvPath = join(process.env.HOME || '', '.intutic', 'env', 'loop.env')
      await fs.mkdir(dirname(loopEnvPath), { recursive: true }).catch(() => {})
      await fs.writeFile(loopEnvPath, `INTUTIC_LOOP_RUN_ID=${res.loop.loopRunId}\n`)
      log.dim(`Wrote run context to ~/.intutic/env/loop.env`)
    }
  } catch (err: any) {
    log.error(`Failed to register loop: ${err.message}`)
  }
}

export async function runLoopComplete(loopRunId: string, opts: { dev?: boolean }): Promise<void> {
  log.header('Intutic — Complete Loop')
  const client = await getClient(opts.dev)
  try {
    const res = await client.post<{ ok: boolean }>(`/api/v1/loops/${loopRunId}/complete`)
    if (res.ok) {
      log.success(`Loop run ${loopRunId} completed.`)
      // Clean env
      const loopEnvPath = join(process.env.HOME || '', '.intutic', 'env', 'loop.env')
      await fs.rm(loopEnvPath, { force: true })
    }
  } catch (err: any) {
    log.error(`Failed to complete loop: ${err.message}`)
  }
}

export async function runLoopKill(loopRunId: string, opts: { dev?: boolean }): Promise<void> {
  log.header('Intutic — Kill Loop')
  const client = await getClient(opts.dev)
  try {
    const res = await client.post<{ ok: boolean }>(`/api/v1/loops/${loopRunId}/kill`)
    if (res.ok) {
      log.warn(`Loop run ${loopRunId} marked as KILLED.`)
      const loopEnvPath = join(process.env.HOME || '', '.intutic', 'env', 'loop.env')
      await fs.rm(loopEnvPath, { force: true })
    }
  } catch (err: any) {
    log.error(`Failed to kill loop: ${err.message}`)
  }
}

export async function runLoopList(opts: { dev?: boolean }): Promise<void> {
  log.header('Intutic — Workspace Loop Runs')
  const client = await getClient(opts.dev)
  try {
    const res = await client.get<{ ok: boolean; loops: any[] }>('/api/v1/loops')
    if (res.ok && res.loops) {
      console.log(`  ${pc.bold('Loop Run ID')}           | ${pc.bold('Name')}           | ${pc.bold('Status')}    | ${pc.bold('Token Spend')} | ${pc.bold('Budget Limit')}`)
      console.log('  ' + '-'.repeat(85))
      for (const loop of res.loops) {
        const statusStr = loop.status === 'ACTIVE' ? pc.green(loop.status) : loop.status === 'COMPLETED' ? pc.cyan(loop.status) : pc.red(loop.status)
        console.log(`  ${loop.loopRunId.padEnd(21)} | ${loop.name.padEnd(14)} | ${statusStr.padEnd(17)} | $${parseFloat(loop.totalTokenCostUsd).toFixed(4).padEnd(10)} | $${parseFloat(loop.budgetLimitUsd).toFixed(2)}`)
      }
    }
  } catch (err: any) {
    log.error(`Failed to list loops: ${err.message}`)
  }
}

export async function runLoopExec(
  commandAndArgs: string[], 
  opts: { 
    name?: string; 
    budget?: string; 
    sops?: string; 
    autoJudge?: boolean; 
    dev?: boolean; 
  }
): Promise<void> {
  if (commandAndArgs.length === 0) {
    log.error('No command provided. Use: intutic loop exec -- <command> [args...]')
    process.exit(1)
  }

  const loopName = opts.name || `exec-${commandAndArgs[0]}`
  const config = loadConfig()
  const workspaceRoot = config?.workspaceRoot ?? process.cwd()
  const resolvedSops = await resolveLocalSops(opts.sops)

  if (resolvedSops.length > 0) {
    const sessionContextPath = join(workspaceRoot, '.intutic', 'session-context.json')
    await fs.mkdir(join(workspaceRoot, '.intutic'), { recursive: true }).catch(() => {})
    await fs.writeFile(
      sessionContextPath,
      JSON.stringify({ activeLocalSops: resolvedSops }, null, 2) + '\n',
      'utf-8'
    )
    log.info(`Active local SOPs configuration updated: ${resolvedSops.join(', ')}`)
  }

  const client = await getClient(opts.dev)

  log.header(`Intutic — Execute Loop Wrapper: ${loopName}`)
  try {
    const res = await client.post<{ ok: boolean; loop: { loopRunId: string } }>(
      '/api/v1/loops/start',
      { 
        name: loopName, 
        budgetLimitUsd: opts.budget,
        sops: resolvedSops,
        autoJudge: opts.autoJudge
      }
    )

    if (!res.ok || !res.loop) {
      log.error('Failed to start loop wrapper')
      process.exit(1)
    }

    const loopRunId = res.loop.loopRunId
    log.success(`Loop run registered: ${loopRunId}`)

    // Execute process with INTUTIC_LOOP_RUN_ID in environment
    const childEnv = {
      ...process.env,
      INTUTIC_LOOP_RUN_ID: loopRunId,
      // For dynamic header routing
      HTTP_X_LOOP_RUN_ID: loopRunId,
    }

    const command = commandAndArgs[0]
    const args = commandAndArgs.slice(1)

    log.info(`Executing wrapper command: ${command} ${args.join(' ')}`)

    const child = spawn(command, args, {
      env: childEnv,
      stdio: 'inherit',
      shell: true,
    })

    child.on('close', async (code) => {
      if (code === 0) {
        await client.post(`/api/v1/loops/${loopRunId}/complete`).catch(() => {})
        log.success(`Loop command execution succeeded. Wrapper loop marked COMPLETED.`)
      } else {
        await client.post(`/api/v1/loops/${loopRunId}/kill`).catch(() => {})
        log.warn(`Loop command execution exited with code ${code}. Wrapper loop marked KILLED.`)
      }
      process.exit(code || 0)
    })
  } catch (err: any) {
    log.error(`Loop execution wrapper failed: ${err.message}`)
    process.exit(1)
  }
}

function dirname(filePath: string): string {
  const parts = filePath.split('/')
  parts.pop()
  return parts.join('/')
}
