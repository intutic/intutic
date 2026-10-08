/**
 * configWriter.ts — the harness rules-file map, local SOP loading, SkillOpt
 * config edits and the atomic write they share.
 *
 * The harness config files themselves are written by the CLI's adapters
 * (tools/cli/src/harness), which `intutic connect` runs.
 *
 * @module
 */

import * as node_fs from 'node:fs/promises'
import * as node_path from 'node:path'
import { execFile as _execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { HarnessType, SyncSopEntry, ConfigEdit } from '@intutic/shared-types'

const execFile = promisify(_execFile)

/**
 * Clear the macOS user-immutable flag so the daemon can rewrite a file it
 * write-protected (the workspace's `bypassEnforcementTier: 'immutable'`).
 * No-op on other platforms or if the file does not exist yet.
 */
export async function clearImmutable(filePath: string): Promise<void> {
  if (process.platform !== 'darwin') return
  try { await execFile('chflags', ['nouchg', filePath]) } catch { /* file may not exist yet */ }
}

/**
 * Set the macOS user-immutable flag (`chflags uchg`), so a hand edit of a
 * managed file fails with EPERM. The flag needs no root to set or clear; it
 * stops casual editing, not a determined user. No-op on other platforms.
 */
export async function setImmutable(filePath: string): Promise<void> {
  if (process.platform !== 'darwin') return
  try { await execFile('chflags', ['uchg', filePath]) } catch { /* non-fatal */ }
}

// ─── Harness config file mapping ─────────────────────────────────────

/**
 * Each harness's rules file, relative to the workspace root: the file the
 * drift watcher watches, config capture uploads, and SkillOpt edits and the
 * decisions log write into. An empty string means the harness has no
 * workspace rules file: its governance lives elsewhere (dsh under $DSH_HOME),
 * or it writes no config of its own because it delegates to a wrapped
 * harness's gate (Xirp, Agentic Orchestrator, AgentCore Runtime) or is gated
 * by a service (TrueForge server). The SDK-gated frameworks share
 * `.env.intutic`, which carries the proxy variables.
 */
export const HARNESS_FILES: Record<HarnessType, string> = {
  cursor: '.cursorrules',
  'claude-code': 'CLAUDE.md',
  antigravity: 'GEMINI.md',
  windsurf: '.windsurfrules',
  aider: '.aider.conf.yml',
  openhands: '.openhands/microagents/intutic-governance.md',
  codex: '.env.intutic',
  n8n: '.intutic/n8n/governance-workflow.json',
  openclaw: '.openclaw/openclaw.json',
  hermes: '.hermes/config.yaml',
  pi: '.pi/hooks.json',
  'github-copilot': '.github/copilot-instructions.md',
  cline: '.clinerules/intutic-governance.md',
  'roo-code': '.roorules',
  continue: '.continue/config.json',
  'claude-desktop': 'claude_desktop_config.json',
  goose: '.agents/plugins/intutic-governance/hooks/hooks.json',
  'open-webui': '.open-webui/intutic-governance-filter.py',
  langgraph: '.env.intutic',
  // Muse Code, Grok Build and OpenCode all read AGENTS.md.
  'muse-code': 'AGENTS.md',
  grok: 'AGENTS.md',
  opencode: 'AGENTS.md',
  dsh: '',
  xirp: '',
  'agentic-orchestrator': '',
  langchain: '.env.intutic',
  crewai: '.env.intutic',
  autogen: '.env.intutic',
  ag2: '.env.intutic',
  'google-adk': '.env.intutic',
  'openai-agents': '.env.intutic',
  'pydantic-ai': '.env.intutic',
  smolagents: '.env.intutic',
  strands: '.env.intutic',
  'agent-framework': '.env.intutic',
  mastra: '.env.intutic',
  'vercel-ai-sdk': '.env.intutic',
  eve: '.env.intutic',
  trueforge: '.env.intutic',
  'ai-sdk-harness': '.env.intutic',
  'ai-sdk-workflow': '.env.intutic',
  'agentcore-runtime': '',
  'trueforge-server': '',
}

/**
 * The workspace's local SOPs (`.intutic/sops/<dir>/*.md`, narrowed by
 * `session-context.json`'s `activeLocalSops` when present). Read by the
 * gate-cache refresh, which compiles their
 * `review_before:` tokens into hold rules (TD-474 item 4). A missing
 * directory is an empty list.
 */
export async function loadLocalSopEntries(workspaceRoot: string, harnesses: HarnessType[]): Promise<SyncSopEntry[]> {
const localSopEntries: SyncSopEntry[] = []
try {
  const sessionContextPath = node_path.join(workspaceRoot, '.intutic', 'session-context.json')
  let activeLocalSops: string[] | undefined
  try {
    const raw = await node_fs.readFile(sessionContextPath, 'utf-8')
    const parsed = JSON.parse(raw)
    activeLocalSops = parsed.activeLocalSops
  } catch {
    // not configured yet
  }

  const sopsDir = node_path.join(workspaceRoot, '.intutic', 'sops')
  const entries = await node_fs.readdir(sopsDir, { withFileTypes: true })
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)

  const activeDirs = activeLocalSops !== undefined
    ? dirs.filter((d) => activeLocalSops!.includes(d))
    : dirs

  for (const dirName of activeDirs) {
    const dirPath = node_path.join(sopsDir, dirName)
    const files = await node_fs.readdir(dirPath)
    const mdFiles = files.filter((f) => f.endsWith('.md'))
    
    for (const file of mdFiles) {
      const filePath = node_path.join(dirPath, file)
      const content = await node_fs.readFile(filePath, 'utf-8')
      localSopEntries.push({
        sopId: `local:${dirName}:${file}`,
        title: `Local SOP: ${dirName}/${file}`,
        content,
        contentHash: '',
        harnessTargets: harnesses,
      })
    }
  }
} catch {
  // ignore directory read errors (e.g. if sops folder doesn't exist)
}
  return localSopEntries
}

/**
 * Finds a match for a target block in content, tolerating line ending and whitespace variations.
 */
function findFuzzyMatch(content: string, target: string): string | null {
  if (content.includes(target)) return target

  const normalize = (s: string) => s.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim()
  const normalizedTarget = normalize(target)
  if (!normalizedTarget) return null

  // Line-by-line normalized search
  const targetLines = target.split(/\r?\n/).map(l => normalize(l)).filter(Boolean)
  if (targetLines.length === 0) return null

  const contentLines = content.split(/\r?\n/)
  for (let i = 0; i <= contentLines.length - targetLines.length; i++) {
    let match = true
    for (let j = 0; j < targetLines.length; j++) {
      const contentLineNorm = normalize(contentLines[i + j] || '')
      if (contentLineNorm !== targetLines[j]) {
        match = false
        break
      }
    }
    if (match) {
      // Reconstruct matching section using original line endings from content
      return contentLines.slice(i, i + targetLines.length).join('\n')
    }
  }
  return null
}

/** Outcome of a single ADD/DELETE/REPLACE operation within one suggestion's edit set. */
export interface ConfigEditOperationOutcome {
  /** Index into the suggestion's `edits` array. */
  index: number
  operation: string
  /** Whether this operation's effect actually landed in the on-disk file. */
  applied: boolean
  /** Present when `applied` is false — why it didn't land. */
  reason?: string
}

/**
 * Per-suggestion result of `applyConfigEdits` — what the daemon reports back
 * to control-plane via `POST /api/v1/skillopt/:suggestionId/apply-result`
 * (TD-349).
 */
export interface ConfigEditApplyOutcome {
  suggestionId: string
  /** True only when every operation for this suggestion landed. */
  ok: boolean
  perOperation: ConfigEditOperationOutcome[]
}

/**
 * Apply a list of custom config edits (ADD, DELETE, REPLACE) to a workspace rule file.
 *
 * Returns one `ConfigEditApplyOutcome` per input suggestion (TD-349) instead
 * of `void` — every operation's real fate (fuzzy-match miss on DELETE/
 * REPLACE, an unresolvable target file, or the final `atomicWrite` itself
 * failing) is recorded here rather than only `console.warn`'d, so the caller
 * (`applySkillOptEdits`, syncCycle.ts) can ack the daemon's actual outcome back to control-plane
 * instead of the daemon-side write being invisible to it.
 */
export async function applyConfigEdits(
  workspaceRoot: string,
  appliedEdits: Array<{
    suggestionId: string
    harnessType: string
    filePath: string
    edits: string | ConfigEdit[]
  }>,
  bypassEnforcementTier?: string,
): Promise<ConfigEditApplyOutcome[]> {
  const outcomes: ConfigEditApplyOutcome[] = []

  for (const applied of appliedEdits) {
    const filename = HARNESS_FILES[applied.harnessType as HarnessType] || applied.filePath
    const editsList: ConfigEdit[] = typeof applied.edits === 'string'
      ? JSON.parse(applied.edits)
      : applied.edits

    if (!filename) {
      // No writable target for this harness — every operation fails to land.
      outcomes.push({
        suggestionId: applied.suggestionId,
        // Vacuously ok only when there was nothing to apply in the first
        // place — matches the `perOperation.every(...)` rule used below.
        ok: editsList.length === 0,
        perOperation: editsList.map((edit, index) => ({
          index,
          operation: edit.operation,
          applied: false,
          reason: `No config file resolved for harness "${applied.harnessType}"`,
        })),
      })
      continue
    }

    const filePath = node_path.join(workspaceRoot, filename)

    let currentContent = ''
    try {
      currentContent = await node_fs.readFile(filePath, 'utf-8')
    } catch {
      // file doesn't exist
    }

    let updatedContent = currentContent
    const perOperation: ConfigEditOperationOutcome[] = []

    editsList.forEach((edit, index) => {
      if (edit.operation === 'ADD') {
        // Idempotency: skip if edit content already exists in file — already
        // landed, so this counts as applied, not a no-op failure.
        if (edit.content && updatedContent.includes(edit.content)) {
          perOperation.push({ index, operation: edit.operation, applied: true })
          return
        }
        const header = `## ${edit.section}`
        if (updatedContent.includes(header)) {
          updatedContent = updatedContent.replace(header, `${header}\n${edit.content ?? ''}`)
        } else {
          updatedContent += `\n\n${header}\n${edit.content ?? ''}`
        }
        perOperation.push({ index, operation: edit.operation, applied: true })
      } else if (edit.operation === 'DELETE') {
        if (edit.content) {
          const match = findFuzzyMatch(updatedContent, edit.content)
          if (match) {
            updatedContent = updatedContent.replace(match, '')
            perOperation.push({ index, operation: edit.operation, applied: true })
          } else {
            console.warn(`[sync-daemon] [DELETE] Pattern not found in ${filename}:`, edit.content.slice(0, 100))
            perOperation.push({
              index,
              operation: edit.operation,
              applied: false,
              reason: `DELETE target pattern not found in ${filename}`,
            })
          }
        } else {
          perOperation.push({ index, operation: edit.operation, applied: false, reason: 'DELETE edit had no content to match' })
        }
      } else if (edit.operation === 'REPLACE') {
        if (edit.target) {
          const match = findFuzzyMatch(updatedContent, edit.target)
          if (match) {
            updatedContent = updatedContent.replace(match, edit.content ?? '')
            perOperation.push({ index, operation: edit.operation, applied: true })
          } else {
            console.warn(`[sync-daemon] [REPLACE] Target pattern not found in ${filename}:`, edit.target.slice(0, 100))
            perOperation.push({
              index,
              operation: edit.operation,
              applied: false,
              reason: `REPLACE target pattern not found in ${filename}`,
            })
          }
        } else {
          perOperation.push({ index, operation: edit.operation, applied: false, reason: 'REPLACE edit had no target to match' })
        }
      } else {
        perOperation.push({ index, operation: edit.operation, applied: false, reason: `Unknown operation "${edit.operation}"` })
      }
    })

    try {
      await atomicWrite(filePath, updatedContent, bypassEnforcementTier)
      console.log(`[sync-daemon] Applied SkillOpt config edits to ${filename} (suggestion: ${applied.suggestionId})`)
    } catch (err) {
      // The write itself failed (e.g. protected-path/tamper guard) — nothing
      // that "landed" in memory above actually reached disk. Every operation
      // that had been recorded as applied must be walked back to failed.
      const reason = `atomicWrite failed for ${filename}: ${err instanceof Error ? err.message : String(err)}`
      console.warn(`[sync-daemon] Failed to apply config edits to ${filename}:`, err)
      for (const op of perOperation) {
        op.applied = false
        op.reason = op.reason ?? reason
      }
    }

    outcomes.push({
      suggestionId: applied.suggestionId,
      ok: perOperation.every((op) => op.applied),
      perOperation,
    })
  }

  return outcomes
}

// ─── Atomic file write ───────────────────────────────────────────────

/**
 * Write content to a file atomically.
 *
 * Writes to a `.tmp` sibling first, then renames to the target path.
 * This prevents partial/corrupt files if the process is interrupted mid-write.
 *
 * If bypassEnforcementTier === 'immutable', clears the macOS user-immutable
 * flag before writing and re-sets it after.
 *
 * Exported for `lib/decisionsDigest.ts`, which regenerates whole files too.
 */
export async function atomicWrite(
  filePath: string,
  content: string,
  bypassEnforcementTier?: string,
): Promise<void> {
  const dir = node_path.dirname(filePath)
  await node_fs.mkdir(dir, { recursive: true })

  // Clear immutable flag before writing (macOS only, opt-in)
  if (bypassEnforcementTier === 'immutable') {
    await clearImmutable(filePath)
  }

  const tmpPath = `${filePath}.tmp`
  await node_fs.writeFile(tmpPath, content, 'utf-8')
  await node_fs.rename(tmpPath, filePath)

  // Re-set immutable flag after writing (macOS only, opt-in)
  if (bypassEnforcementTier === 'immutable') {
    await setImmutable(filePath)
  }
}
