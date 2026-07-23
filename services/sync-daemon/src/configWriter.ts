/**
 * configWriter.ts — Write SOP content to harness config files.
 *
 * Each harness (Cursor, Claude Code, Antigravity, Windsurf, Aider,
 * OpenHands, Codex) has a distinct config file format. This module
 * resolves paths, formats content, and performs atomic writes
 * (write-to-tmp → rename) to prevent partial/corrupt files.
 *
 * HLD §3.14 — Real-Time State Mirroring
 * LLD #8 — Sync Daemon / CLI
 *
 * @module
 */

import * as node_fs from 'node:fs/promises'
import * as node_path from 'node:path'
import { execFile as _execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { newIso } from '@intutic/id'
import type { HarnessType, SyncSopEntry, ConfigEdit } from '@intutic/shared-types'

const execFile = promisify(_execFile)

/**
 * Clear the macOS user-immutable flag before writing a file.
 * No-op on non-macOS platforms or if the file doesn't exist yet.
 * Called when bypassEnforcementTier === 'immutable'. (WS-5 Q3)
 */
async function clearImmutable(filePath: string): Promise<void> {
  if (process.platform !== 'darwin') return
  try { await execFile('chflags', ['nouchg', filePath]) } catch { /* file may not exist yet */ }
}

/**
 * Set the macOS user-immutable flag after writing a file.
 * Prevents direct edits from succeeding — any attempt gets EPERM.
 * The flag is cleared before the next sync write.
 * No-op on non-macOS platforms. (WS-5 Q3)
 */
async function setImmutable(filePath: string): Promise<void> {
  if (process.platform !== 'darwin') return
  try { await execFile('chflags', ['uchg', filePath]) } catch { /* non-fatal */ }
}

import { writeAntigravityHooks } from './harness/antigravityHooks.js'
import { writeClaudeDesktopHooks } from './harness/claudeDesktopHooks.js'
import { writeRooCodeHooks } from './harness/rooCodeHooks.js'
import { writeContinueHooks } from './harness/continueHooks.js'
import { writeOpenWebuiHooks } from './harness/openWebuiHooks.js'
import { writeN8nHooks } from './harness/n8nHooks.js'
import { writeHermesHooks } from './harness/hermesHooks.js'
import { writeOpenclawHooks } from './harness/openclawHooks.js'
import { writePiHooks } from './harness/piHooks.js'
import { writeCursorHooksJson } from './harness/cursorHooksJson.js'
import { writeGooseHooks as writeGooseHooksNative } from './harness/gooseHooksWriter.js'
import { writeOpenHandsHooks as writeOpenHandsHooksNative } from './harness/openhandsHooksWriter.js'

// ─── Harness config file mapping ─────────────────────────────────────

/**
 * Maps each harness type to its expected config filename relative to
 * the workspace root. Empty string means the harness is deferred to
 * Phase 2 (e.g., n8n — TD-037).
 */
export const HARNESS_FILES: Record<HarnessType, string> = {
  cursor: '.cursorrules',
  'claude-code': 'CLAUDE.md',
  antigravity: '.gemini/settings.json',
  windsurf: '.windsurfrules',
  aider: '.aider.conf.yml',
  openhands: 'config.toml',
  codex: '.env.intutic',
  n8n: '.intutic/n8n/governance-workflow.json',
  openclaw: '.openclaw/openclaw.json',
  hermes: '.hermes/config.yaml',
  pi: '.pi/hooks.json',
  'github-copilot': '.github/copilot-instructions.md',
  cline: '.cline/hooks/hooks.json',
  'roo-code': '.roorules',
  continue: '.continue/config.json',
  'claude-desktop': 'claude_desktop_config.json',
  goose: '.agents/plugins/intutic-governance/hooks/hooks.json',
  'open-webui': '.open-webui/intutic-governance-filter.py',
}

// ─── Public interface ────────────────────────────────────────────────

/** Result of a config-write operation across one or more harnesses. */
export interface WriteResult {
  /** Paths of files that were successfully written. */
  filesWritten: string[]
  /** Paths where the harness was skipped (not detected or deferred). */
  filesSkipped: string[]
}

/**
 * Write SOP content to all targeted harness config files.
 *
 * For each harness type, resolves the config file path, formats the
 * content according to the harness-specific format, and performs an
 * atomic write (tmp file → rename).
 *
 * @param workspaceRoot - Absolute path to the workspace root.
 * @param sops - SOPs to write, each specifying which harnesses to target.
 * @param proxyUrl - Intutic proxy URL for LLM API redirect.
 * @param harnesses - Harness types detected in the workspace.
 * @returns WriteResult with written and skipped file paths.
 */
export async function writeConfigFiles(
  workspaceRoot: string,
  sops: SyncSopEntry[],
  proxyUrl: string,
  harnesses: HarnessType[],
  workspaceId = '',
  /** WS-5 Q3: 'rewrite' (default) | 'immutable' | 'alert-only' */
  bypassEnforcementTier?: string,
): Promise<WriteResult> {
  const filesWritten: string[] = []
  const filesSkipped: string[] = []

  // Load and compile local SOP entries
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
  } catch (err) {
    // ignore directory read errors (e.g. if sops folder doesn't exist)
  }

  const combinedSops = [...sops, ...localSopEntries]

  for (const harness of harnesses) {
    const filename = HARNESS_FILES[harness]

    // Phase 3 proprietary harnesses — no config file path needed (handled below)
    if (harness === 'hermes') {
      try { await writeHermesHooks(workspaceRoot, proxyUrl, workspaceId) } catch (e) {
        console.warn('[sync-daemon] writeHermesHooks failed (non-fatal):', e) }
      continue
    }
    if (harness === 'openclaw') {
      try { await writeOpenclawHooks(workspaceRoot, proxyUrl, workspaceId) } catch (e) {
        console.warn('[sync-daemon] writeOpenclawHooks failed (non-fatal):', e) }
      continue
    }
    if (harness === 'pi') {
      try { await writePiHooks(workspaceRoot, proxyUrl, workspaceId) } catch (e) {
        console.warn('[sync-daemon] writePiHooks failed (non-fatal):', e) }
      continue
    }

    // Phase 4 WS-4C — native hook script writers
    if (harness === 'cursor') {
      try { await writeCursorHooksJson(workspaceRoot) } catch (e) {
        console.warn('[sync-daemon] writeCursorHooksJson failed (non-fatal):', e) }
    }
    if (harness === 'goose') {
      try { await writeGooseHooksNative(workspaceRoot) } catch (e) {
        console.warn('[sync-daemon] writeGooseHooksNative failed (non-fatal):', e) }
    }
    if (harness === 'openhands') {
      try { await writeOpenHandsHooksNative(workspaceRoot) } catch (e) {
        console.warn('[sync-daemon] writeOpenHandsHooksNative failed (non-fatal):', e) }
    }

    // Phase 2 deferred or unknown harness
    if (!filename) {
      filesSkipped.push(`[${harness}] (deferred)`)
      continue
    }

    const configPath = node_path.join(workspaceRoot, filename)

    // Filter SOPs that target this harness
    const targetedSops = combinedSops.filter((sop) =>
      sop.harnessTargets.includes(harness),
    )

    if (targetedSops.length === 0) {
      filesSkipped.push(configPath)
      continue
    }

    const content = formatContent(harness, targetedSops, proxyUrl)

    try {
      await atomicWrite(configPath, content, bypassEnforcementTier)
      filesWritten.push(configPath)

      // For 'antigravity', also write the governance hook script and settings.json merge.
      // This is separate from the SOP content write above (which writes customInstructions).
      if (harness === 'antigravity') {
        try {
          await writeAntigravityHooks(workspaceRoot, proxyUrl, workspaceId)
        } catch (hookErr) {
          // Non-fatal — SOP content was written, only the hook script failed
          console.warn('[sync-daemon] writeAntigravityHooks failed (non-fatal):', hookErr)
        }
      }
      if (harness === 'claude-desktop') {
        try { await writeClaudeDesktopHooks(workspaceRoot, proxyUrl, workspaceId) } catch (e) {
          console.warn('[sync-daemon] writeClaudeDesktopHooks failed (non-fatal):', e) }
      }
      if (harness === 'roo-code') {
        try { await writeRooCodeHooks(workspaceRoot, proxyUrl, workspaceId) } catch (e) {
          console.warn('[sync-daemon] writeRooCodeHooks failed (non-fatal):', e) }
      }
      if (harness === 'continue') {
        try { await writeContinueHooks(workspaceRoot, proxyUrl, workspaceId) } catch (e) {
          console.warn('[sync-daemon] writeContinueHooks failed (non-fatal):', e) }
      }
      if (harness === 'open-webui') {
        try { await writeOpenWebuiHooks(workspaceRoot, proxyUrl, workspaceId) } catch (e) {
          console.warn('[sync-daemon] writeOpenWebuiHooks failed (non-fatal):', e) }
      }
      if (harness === 'n8n') {
        try { await writeN8nHooks(workspaceRoot, proxyUrl, workspaceId) } catch (e) {
          console.warn('[sync-daemon] writeN8nHooks failed (non-fatal):', e) }
      }
    } catch (err) {
      console.warn(`[sync-daemon] writeConfigFiles failed for ${filename}:`, err)
      // Don't crash the loop — report as skipped
      filesSkipped.push(configPath)
    }
  }

  return { filesWritten, filesSkipped }
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

/**
 * Apply a list of custom config edits (ADD, DELETE, REPLACE) to a workspace rule file.
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
): Promise<void> {
  for (const applied of appliedEdits) {
    const filename = HARNESS_FILES[applied.harnessType as HarnessType] || applied.filePath
    if (!filename) continue

    const filePath = node_path.join(workspaceRoot, filename)

    let currentContent = ''
    try {
      currentContent = await node_fs.readFile(filePath, 'utf-8')
    } catch {
      // file doesn't exist
    }

    let updatedContent = currentContent
    const editsList: ConfigEdit[] = typeof applied.edits === 'string'
      ? JSON.parse(applied.edits)
      : applied.edits

    for (const edit of editsList) {
      if (edit.operation === 'ADD') {
        // Idempotency: skip if edit content already exists in file
        if (edit.content && updatedContent.includes(edit.content)) {
          continue
        }
        const header = `## ${edit.section}`
        if (updatedContent.includes(header)) {
          updatedContent = updatedContent.replace(header, `${header}\n${edit.content ?? ''}`)
        } else {
          updatedContent += `\n\n${header}\n${edit.content ?? ''}`
        }
      } else if (edit.operation === 'DELETE') {
        if (edit.content) {
          const match = findFuzzyMatch(updatedContent, edit.content)
          if (match) {
            updatedContent = updatedContent.replace(match, '')
          } else {
            console.warn(`[sync-daemon] [DELETE] Pattern not found in ${filename}:`, edit.content.slice(0, 100))
          }
        }
      } else if (edit.operation === 'REPLACE') {
        if (edit.target) {
          const match = findFuzzyMatch(updatedContent, edit.target)
          if (match) {
            updatedContent = updatedContent.replace(match, edit.content ?? '')
          } else {
            console.warn(`[sync-daemon] [REPLACE] Target pattern not found in ${filename}:`, edit.target.slice(0, 100))
          }
        }
      }
    }

    try {
      await atomicWrite(filePath, updatedContent, bypassEnforcementTier)
      console.log(`[sync-daemon] Applied SkillOpt config edits to ${filename} (suggestion: ${applied.suggestionId})`)
    } catch (err) {
      console.warn(`[sync-daemon] Failed to apply config edits to ${filename}:`, err)
    }
  }
}

// ─── Formatters ──────────────────────────────────────────────────────

/** Standard file header injected at the top of every auto-generated file. */
function fileHeader(): string {
  return [
    '# Intutic Governance Rules (auto-generated)',
    '# DO NOT EDIT — managed by intutic sync daemon',
    `# Last sync: ${newIso()}`,
    '',
    '',
  ].join('\n')
}

/**
 * Format SOP content for a specific harness type.
 *
 * Each harness has a distinct format:
 * - Cursor / Claude Code / Windsurf → Markdown with `---` separators
 * - Antigravity → JSON with `customInstructions` field
 * - Aider → YAML with `extra-instructions` field
 * - OpenHands → TOML with `[intutic]` section
 * - Codex → `.env.intutic` with proxy URL vars
 */
function formatContent(
  harness: HarnessType,
  sops: SyncSopEntry[],
  proxyUrl: string,
): string {
  switch (harness) {
    case 'cursor':
    case 'claude-code':
    case 'windsurf':
    case 'github-copilot':
      return formatMarkdown(sops)

    case 'antigravity':
      return formatAntigravity(sops)

    case 'aider':
      return formatAider(sops)

    case 'openhands':
      return formatOpenHands(sops)

    case 'codex':
      return formatCodex(sops, proxyUrl)

    default:
      return formatMarkdown(sops)
  }
}

/** Cursor / Claude Code / Windsurf: Markdown with `---` separators. */
function formatMarkdown(sops: SyncSopEntry[]): string {
  const header = fileHeader()
  const sections = sops.map((sop) => {
    // Hybrid approach: full SOP content + sop:// pointer comment for traceability
    const ref = sop.sopRef ? `\n${sop.sopRef}` : ''
    return [`## ${sop.title}`, '', sop.content + ref].join('\n')
  })

  return header + sections.join('\n\n---\n\n') + '\n'
}

/** Antigravity: JSON with `customInstructions` field. */
function formatAntigravity(sops: SyncSopEntry[]): string {
  const combinedContent = sops
    .map((sop) => `## ${sop.title}\n\n${sop.content}`)
    .join('\n\n---\n\n')

  const payload = {
    _comment: 'Intutic Governance Rules (auto-generated) — DO NOT EDIT',
    _lastSync: newIso(),
    customInstructions: combinedContent,
  }

  return JSON.stringify(payload, null, 2) + '\n'
}

/** Aider: YAML with `extra-instructions` field. */
function formatAider(sops: SyncSopEntry[]): string {
  const header = fileHeader()
  const combinedContent = sops
    .map((sop) => `## ${sop.title}\n\n${sop.content}`)
    .join('\n\n---\n\n')

  // YAML multiline block scalar using `|`
  const indented = combinedContent
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')

  return header + `extra-instructions: |\n${indented}\n`
}

/** OpenHands: TOML with `[intutic]` section. */
function formatOpenHands(sops: SyncSopEntry[]): string {
  const header = fileHeader()
  const combinedContent = sops
    .map((sop) => `## ${sop.title}\n\n${sop.content}`)
    .join('\n\n---\n\n')

  // TOML multiline basic string uses triple quotes
  const escaped = combinedContent
    .replace(/\\/g, '\\\\')
    .replace(/"""/g, '\\"\\"\\"')

  return (
    header +
    `[intutic]\n` +
    `last_sync = "${newIso()}"\n` +
    `governance_rules = """\n${escaped}\n"""\n`
  )
}

/** Codex: `.env.intutic` with proxy URL vars. */
function formatCodex(sops: SyncSopEntry[], proxyUrl: string): string {
  const header = fileHeader()
  const sopIds = sops.map((sop) => sop.sopId).join(',')

  return (
    header +
    `INTUTIC_PROXY_URL=${proxyUrl}\n` +
    `INTUTIC_SOP_IDS=${sopIds}\n` +
    `INTUTIC_LAST_SYNC=${newIso()}\n`
  )
}

// ─── Atomic file write ───────────────────────────────────────────────

/**
 * Write content to a file atomically.
 *
 * Writes to a `.tmp` sibling first, then renames to the target path.
 * This prevents partial/corrupt files if the process is interrupted mid-write.
 *
 * If bypassEnforcementTier === 'immutable', clears the macOS user-immutable
 * flag before writing and re-sets it after (WS-5 Q3).
 */
async function atomicWrite(
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
