/**
 * Intutic CLI — Skill Management and Loop Engineering Governance Commands.
 *
 * LLD Phase 8 — Loop Engineering & Ingestion Proposals
 */

import { existsSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { log } from '../lib/logger.js'
import { loadCredentials, loadConfig } from '../config/store.js'
import { getIntuticDir, resolveControlPlaneUrl } from '../config/paths.js'
import { createApiClient } from '../lib/api.js'
import { scanSkillContent, type SkillScanFinding } from '@intutic/shared-types'
import pc from 'picocolors'

// ─── Shared response shapes ──────────────────────────────────────────

/**
 * One row of the local skill/rule-file inventory reported to the control
 * plane by `POST /api/v1/workspaces/:id/skills/report`.
 */
export interface SkillReportEntry {
  /** Path relative to the workspace root, e.g. `CLAUDE.md`. */
  filePath: string
  /** Line count of the file as scanned. */
  linesCount: number
  /** Audit findings in this file; always 0 for `skill list`, which only counts. */
  issuesDetected: number
  /**
   * Bounded findings from `scanSkillContent` (`@intutic/shared-types`), for
   * real `.agents/skills/**\/SKILL.md` / `.claude/skills/**\/SKILL.md` skill
   * files. Absent for the legacy rule-file rows, which keep the coarse
   * regex audit above — never full skill content, see `scanSkillContent`'s
   * own doc comment.
   */
  findings?: SkillScanFinding[]
  /** sha256 of the file content at scan time, so a consumer can tell which
   *  content a set of findings refers to without re-uploading it. */
  sha256?: string
  /**
   * `false` when the file could not be read (permissions, vanished between
   * discovery and read, etc). Refusal-not-pass: an unscanned file MUST NOT
   * be reported as `issuesDetected: 0` implying safety — that would read as
   * "scanned and clean" to anything downstream. Omitted (not `false`) for
   * the legacy rule-file rows and for successfully scanned skill files, so
   * `scanned === false` unambiguously means "we could not tell."
   */
  scanned?: boolean
}

/** Where bundled skill directories live, mirroring the conventions
 *  `services/sync-daemon/src/agentReporter.ts`'s `collectSkills` already
 *  uses for `.agents/skills`, plus Claude Code's own `.claude/skills`. Each
 *  entry directly under the root is a skill; `SKILL.md` is its content. */
const SKILL_DIRECTORY_ROOTS: ReadonlyArray<{ dir: string; source: string }> = [
  { dir: '.agents/skills', source: '.agents/skills' },
  { dir: '.claude/skills', source: '.claude/skills' },
]

export interface DiscoveredSkillFile {
  /** Path relative to the workspace root, e.g. `.agents/skills/foo/SKILL.md`. */
  filePath: string
  fullPath: string
  source: string
}

/**
 * Read, content-scan, and (if `prune` is set and the scan is not clean)
 * auto-prune one real skill file. Extracted from `runSkillAudit` so the
 * discovery/read/scan/report path is testable without the network and
 * credentials setup the full command does.
 *
 * Refusal-not-pass: a read failure returns `scanned: false` with
 * `issuesDetected: 0` — the zero is not a clean bill of health, it is "we
 * never got to look." Callers must treat `scanned: false` as its own status,
 * never as `clean`.
 */
export async function auditSkillFile(
  filePath: string,
  fullPath: string,
  prune: boolean,
): Promise<SkillReportEntry> {
  let content: string
  try {
    content = await fs.readFile(fullPath, 'utf8')
  } catch (err) {
    log.warn(
      `[${filePath}] Could not be read (${err instanceof Error ? err.message : String(err)}) — reported as unscanned, not clean.`,
    )
    return { filePath, linesCount: 0, issuesDetected: 0, scanned: false }
  }

  const contentLines = content.split('\n')
  const result = scanSkillContent(content)
  const sha256 = createHash('sha256').update(content, 'utf8').digest('hex')

  if (!result.clean) {
    for (const finding of result.findings) {
      log.warn(
        `[${filePath}] ${finding.category} finding (${finding.patternId})${finding.excerpt ? `: ${finding.excerpt}` : ''}`,
      )
    }
  }

  // Auto-prune worthy findings, same opt-in as the legacy rule-file audit:
  // drop any LINE that itself trips a pattern, line-by-line — mirroring the
  // existing per-line re-scan below rather than deleting the whole file,
  // since a skill missing a few flagged lines still functions.
  if (!result.clean && prune) {
    let fileUpdated = false
    const filteredLines = contentLines.filter((line) => {
      if (!scanSkillContent(line).clean) {
        fileUpdated = true
        return false
      }
      return true
    })
    if (fileUpdated) {
      await fs.writeFile(fullPath, filteredLines.join('\n'), 'utf8')
      log.success(`[${filePath}] Auto-pruned lines flagged by the skill-content scan.`)
    }
  }

  return {
    filePath,
    linesCount: contentLines.length,
    issuesDetected: result.findings.length,
    findings: result.findings,
    sha256,
    scanned: true,
  }
}

/** Enumerate real `SKILL.md` files under both skill directory roots. A
 *  missing root is not an error — most workspaces have neither. Exported so
 *  tests can walk a fixture directory tree without going through the full
 *  `skill audit`/`skill list` command (credentials, network, etc). */
export async function discoverSkillFiles(workspaceRoot: string): Promise<DiscoveredSkillFile[]> {
  const out: DiscoveredSkillFile[] = []
  for (const root of SKILL_DIRECTORY_ROOTS) {
    const dir = join(workspaceRoot, root.dir)
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const filePath = join(root.dir, entry.name, 'SKILL.md')
      const fullPath = join(workspaceRoot, filePath)
      if (existsSync(fullPath)) {
        out.push({ filePath, fullPath, source: root.source })
      }
    }
  }
  return out
}

/**
 * A loop run as returned by `GET /api/v1/loops`.
 *
 * `totalTokenCostUsd` and `budgetLimitUsd` are strings, not numbers: both are
 * Postgres `numeric` columns, which the driver hands back as strings to keep
 * the scale exact — hence the `parseFloat` at every use site.
 */
export interface LoopRunSummary {
  loopRunId: string
  name: string
  /**
   * PENDING_REVIEW is the only non-ACTIVE status that is not terminal — see
   * `LoopRunDetails` in the control plane's loopGovernanceService.
   */
  status: 'ACTIVE' | 'PENDING_REVIEW' | 'COMPLETED' | 'FAILED' | 'KILLED'
  totalTokenCostUsd: string
  budgetLimitUsd: string
}

/** Envelope of `GET /api/v1/loops`. */
export interface LoopListResponse {
  ok: boolean
  loops: LoopRunSummary[]
}

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

  const skillsReport: SkillReportEntry[] = []
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

  // Real skill directories (`.agents/skills`, `.claude/skills`) — discovery
  // only here, matching the existing "list only counts" contract for this
  // command; content scanning happens in `skill audit` below.
  const skillFiles = await discoverSkillFiles(workspaceRoot)
  for (const { filePath } of skillFiles) {
    found++
    let lines = 0
    try {
      lines = (await fs.readFile(join(workspaceRoot, filePath), 'utf8')).split('\n').length
    } catch {
      // Discovery already found the directory entry; a read failure here
      // just means we can't report a line count.
    }
    console.log(`  ${pc.green('✔')} ${pc.bold(filePath)} (${lines} lines)`)
    skillsReport.push({ filePath, linesCount: lines, issuesDetected: 0 })
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
    } catch {
      // Non-blocking: discovery already printed everything the user asked for,
      // and the report is a convenience for the dashboard.
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
  const skillsReport: SkillReportEntry[] = []

  for (const file of filesToScan) {
    const fullPath = join(workspaceRoot, file)
    if (existsSync(fullPath)) {
      const content = await fs.readFile(fullPath, 'utf8')
      let fileIssues = 0
      const contentLines = content.split('\n')
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
      if (content.match(/rm\s+-rf\s+[*/]/)) {
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
          const isUnsafeCmd = line.match(/rm\s+-rf\s+[*/]/) || line.match(/curl\s+|wget\s+/)
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

  // ── Real skill directories (`.agents/skills`, `.claude/skills`) ──────
  //
  // Content-aware scan via `scanSkillContent` (`@intutic/shared-types`),
  // report-only per that module's doc comment — a finding here is never
  // treated as ground truth, only surfaced. `enableLocalSkillAuditDelete`
  // gates pruning here exactly as it already gates the legacy rule-file
  // pruning above: the same opt-in, now covering both audit paths.
  const skillFiles = await discoverSkillFiles(workspaceRoot)
  for (const { filePath, fullPath } of skillFiles) {
    const entry = await auditSkillFile(filePath, fullPath, enableLocalSkillAuditDelete)
    issues += entry.issuesDetected
    skillsReport.push(entry)
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

// Exported so `commands/decision.ts` can share the exact same client
// resolution (creds, dev-mode precedence, base URL) rather than growing a
// second, easily-drifting copy of it.
export async function getClient(dev?: boolean) {
  const creds = await loadCredentials()
  if (!creds) {
    log.error('Not authenticated. This command needs an Intutic control plane, which open core does not include. To run the proxy without one: `intutic start`.')
    process.exit(1)
  }
  // `config?.devMode` is load-bearing and was missing here.
  //
  // Every other command that talks to the control plane resolves dev mode as
  // `flag || config.devMode || INTUTIC_DEV` (sops, policy, budget, connect, exec).
  // This one read only the flag and the env var, so a workspace configured with
  // `devMode: true` still had `intutic loop start` resolve to https://api.intutic.ai
  // — the loop commands, which are the governance feature, were the one family that
  // ignored the workspace's own setting and silently addressed production.
  //
  // It went unnoticed because tools/cli/dist was stale: the built CLI predated this
  // code and still read the config, so the bug only appeared once a workspace build
  // regenerated dist from source.
  const config = loadConfig()
  const devMode = dev || config?.devMode || process.env.INTUTIC_DEV === '1'
  const controlPlaneUrl = resolveControlPlaneUrl(devMode)
  return createApiClient(controlPlaneUrl, creds.apiKey)
}

async function resolveLocalSops(sopsArg?: string): Promise<string[]> {
  if (!sopsArg) return []
  const config = loadConfig()
  const workspaceRoot = config?.workspaceRoot ?? process.cwd()
  const sopsDir = join(workspaceRoot, '.intutic', 'sops')

  let dirs: string[]
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
      const loopEnvPath = join(getIntuticDir(), 'env', 'loop.env')
      await fs.mkdir(dirname(loopEnvPath), { recursive: true }).catch(() => {})
      await fs.writeFile(loopEnvPath, `INTUTIC_LOOP_RUN_ID=${res.loop.loopRunId}\n`)
      log.dim(`Wrote run context to ~/.intutic/env/loop.env`)
    }
  } catch (err) {
    log.error(`Failed to register loop: ${err instanceof Error ? err.message : String(err)}`)
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
      const loopEnvPath = join(getIntuticDir(), 'env', 'loop.env')
      await fs.rm(loopEnvPath, { force: true })
    }
  } catch (err) {
    log.error(`Failed to complete loop: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function runLoopKill(loopRunId: string, opts: { dev?: boolean }): Promise<void> {
  log.header('Intutic — Kill Loop')
  const client = await getClient(opts.dev)
  try {
    const res = await client.post<{ ok: boolean }>(`/api/v1/loops/${loopRunId}/kill`)
    if (res.ok) {
      log.warn(`Loop run ${loopRunId} marked as KILLED.`)
      const loopEnvPath = join(getIntuticDir(), 'env', 'loop.env')
      await fs.rm(loopEnvPath, { force: true })
    }
  } catch (err) {
    log.error(`Failed to kill loop: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function runLoopList(opts: { dev?: boolean }): Promise<void> {
  log.header('Intutic — Workspace Loop Runs')
  const client = await getClient(opts.dev)
  try {
    const res = await client.get<LoopListResponse>('/api/v1/loops')
    if (res.ok && res.loops) {
      console.log(`  ${pc.bold('Loop Run ID')}           | ${pc.bold('Name')}           | ${pc.bold('Status')}    | ${pc.bold('Token Spend')} | ${pc.bold('Budget Limit')}`)
      console.log('  ' + '-'.repeat(85))
      for (const loop of res.loops) {
        // PENDING_REVIEW is amber, not red: it needs a person, but nothing has
        // gone wrong. Falling through to the red branch made a held run look
        // killed, which is the opposite of "waiting for you".
        const statusStr =
          loop.status === 'ACTIVE'
            ? pc.green(loop.status)
            : loop.status === 'COMPLETED'
              ? pc.cyan(loop.status)
              : loop.status === 'PENDING_REVIEW'
                ? pc.yellow(loop.status)
                : pc.red(loop.status)
        console.log(`  ${loop.loopRunId.padEnd(21)} | ${loop.name.padEnd(14)} | ${statusStr.padEnd(17)} | $${parseFloat(loop.totalTokenCostUsd).toFixed(4).padEnd(10)} | $${parseFloat(loop.budgetLimitUsd).toFixed(2)}`)
      }
    }
  } catch (err) {
    log.error(`Failed to list loops: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Approve or reject a run held for human review.
 *
 * The other half of `review_before:`. Without it a hold has no resolution from
 * the terminal, and the hold is deliberately permanent — there is no reaper, so
 * an unreviewed run stays blocked until a person acts.
 */
export async function runLoopReview(
  loopRunId: string,
  opts: { approve?: boolean; reject?: boolean; note?: string; dev?: boolean },
): Promise<void> {
  if (opts.approve === opts.reject) {
    log.error('Specify exactly one of --approve or --reject.')
    process.exit(1)
  }
  const action = opts.approve ? 'approve' : 'reject'
  const client = await getClient(opts.dev)
  try {
    const res = await client.post<{ ok: boolean; status: string }>(
      `/api/v1/loops/${loopRunId}/review`,
      { action, note: opts.note },
    )
    if (res.ok) {
      log.success(
        action === 'approve'
          ? `Loop run ${loopRunId} approved — it is ACTIVE again.`
          : `Loop run ${loopRunId} rejected — it is KILLED.`,
      )
    }
  } catch (err) {
    log.error(`Failed to resolve review: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
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
      // A non-zero exit is the agent failing, not governance stopping it. This used
      // to POST /kill for that case, which conflated the two: KILLED means the
      // circuit breaker or an operator intervened, and a run marked KILLED because
      // the wrapped process returned 1 makes budget-breach data unreadable. It also
      // meant the outcome was never recorded anywhere — the exit code was known
      // right here and thrown away, leaving no way to tell a successful trajectory
      // from a failed one afterwards.
      // A held run is not finished, it is waiting. Completing it would close the
      // review by side effect, with nothing recorded about who decided what — and
      // the route refuses it anyway (400). The agent exits non-zero when the proxy
      // returns 403, so without this check every hold ends in a confusing error.
      try {
        const current = await client.get<{ ok: boolean; loop?: { status?: string } }>(
          `/api/v1/loops/${loopRunId}`,
        )
        if (current?.loop?.status === 'PENDING_REVIEW') {
          log.warn('This loop run is held for human review — it has not finished.')
          log.info(`Approve or reject it:  intutic loop review ${loopRunId} --approve`)
          // loop.env is deliberately left in place: the resumed agent needs the
          // run id, and removing it here would orphan the run.
          process.exit(code || 0)
          return
        }
      } catch {
        // Status unknown — fall through and record the outcome as usual rather
        // than leaving the run open on a transient error.
      }

      if (code === 0) {
        await client
          .post(`/api/v1/loops/${loopRunId}/complete`, { outcome: 'SUCCEEDED' })
          .catch(() => {})
        log.success('Loop command execution succeeded. Wrapper loop marked COMPLETED.')
      } else {
        await client
          .post(`/api/v1/loops/${loopRunId}/complete`, { outcome: 'FAILED' })
          .catch(() => {})
        log.warn(`Loop command execution exited with code ${code}. Wrapper loop marked FAILED.`)
      }
      process.exit(code || 0)
    })
  } catch (err) {
    log.error(`Loop execution wrapper failed: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
