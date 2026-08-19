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
import { writeCodexHooks } from './harness/codexHooks.js'
import { writeGithubCopilotHooks } from './harness/githubCopilotHooks.js'
import { writeMuseHooks } from './harness/museHooks.js'
import { writeGrokHooks } from './harness/grokHooks.js'

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
  langgraph: '.env.intutic',
  // Muse Code reads AGENTS.md (falling back to CLAUDE.md) — see muse.ts (CLI)
  // and museHooks.ts (the hook writer invoked below, same split codex uses).
  'muse-code': 'AGENTS.md',
  // Grok Build's native rules file — same cross-tool convention Codex/Amp
  // read. Formatted by `formatMarkdown`, the same `---`-separated formatter
  // Cursor/Claude Code/Windsurf/GitHub Copilot already share below.
  grok: 'AGENTS.md',
  // dsh has no workspace-relative rules file (governance lives entirely
  // under $DSH_HOME) — empty, same as goose/openhands below: this writer's
  // per-harness chain deliberately does not call writeDshHooks either (see
  // the "goose and openhands are deliberately absent here" comment above);
  // dshHooks.ts is invoked by tools/cli/src/harness/dsh.ts's own
  // writeConfig() and re-run on tamper by settingsGuard.ts, the same
  // two-path coverage goose/openhands rely on instead of this loop.
  dsh: '',
  // Xirp writes no config of its own (orchestrates other already-gated
  // harnesses — see gateRegistry.ts's NO_GATE row and tools/cli/src/harness/
  // xirp.ts). Empty filename => the loop below reports it `(deferred)`,
  // same as n8n before it gained a writer.
  xirp: '',
  // Agentic Orchestrator writes no config of its own either — same
  // "delegated" shape as Xirp (orchestrates already-gated Claude Code/Codex,
  // plus OpenCode which has no gate at all — see gateRegistry.ts's NO_GATE
  // row and tools/cli/src/harness/agenticOrchestrator.ts, and TD-397).
  'agentic-orchestrator': '',
  // Wave 1 SDK-gated frameworks — same rationale as langgraph: no on-disk
  // hook/config file exists to gate tool calls, so each writes .env.intutic
  // (proxy base-URL vars + an SDK-gate pointer comment). See formatContent's
  // switch below and SDK_GATED_FRAMEWORKS.
  langchain: '.env.intutic',
  crewai: '.env.intutic',
  autogen: '.env.intutic',
  ag2: '.env.intutic',
  'google-adk': '.env.intutic',
  'openai-agents': '.env.intutic',
  'pydantic-ai': '.env.intutic',
  smolagents: '.env.intutic',
  // A4: AWS Strands Agents — same Python SDK-gated rationale as the Wave 1
  // family above (gate ships in intutic_clawde.gate.adapters.strands).
  strands: '.env.intutic',
  // T2: JS/TS SDK-gated frameworks — same rationale as the Wave 1 Python
  // family above, but the blocking gate ships in @intutic/gate
  // (packages/gate-js) rather than intutic-clawde. See formatContent's
  // switch below and JS_SDK_GATED_FRAMEWORKS.
  mastra: '.env.intutic',
  'vercel-ai-sdk': '.env.intutic',
  // eve (Vercel, PREVIEW) — same JS/TS SDK-gated family: the gate is
  // @intutic/gate/eve's per-tool/per-connection approval policies, attached
  // in the developer's own agent/ directory; this file only carries the
  // proxy vars + pointer comment. See JS_SDK_GATED_FRAMEWORKS below.
  eve: '.env.intutic',
  // A3: Vercel platform-agent runtimes — same @intutic/gate family as the T2
  // rows above. For ai-sdk-harness the env vars are weaker still: tool
  // execution is server-side in Vercel Sandbox microVMs the local proxy
  // never sees (the generated comment says so — see JS_SDK_GATED_FRAMEWORKS'
  // preamble override below and @intutic/gate/harness's module doc).
  'ai-sdk-harness': '.env.intutic',
  'ai-sdk-workflow': '.env.intutic',
  // B2: AWS Bedrock AgentCore Runtime — hosts the customer's own framework
  // code unchanged, so it writes no config of its own; the real tool-call
  // gate belongs to whichever already-supported framework adapter that code
  // uses (Strands, LangGraph, ...). Same 'delegated'/empty-filename shape as
  // xirp/agentic-orchestrator above — see tools/cli/src/harness/agentcore.ts
  // and gateKind.ts's DELEGATED_GATE_HARNESSES.
  'agentcore-runtime': '',
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

  // Bundled agent skills — write-if-missing, not drift-enforced
  try {
    const { writeBundledSkills } = await import('./skillWriter.js')
    await writeBundledSkills(workspaceRoot)
  } catch (e) {
    console.warn('[sync-daemon] writeBundledSkills failed (non-fatal):', e)
  }

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
  } catch {
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

    // cursor is deliberately absent here, for the same reason goose and
    // openhands are below.
    //
    // `cursorHooksJson` was a second writer of `.cursor/hooks.json`, and the two
    // disagreed about the file's schema: `cursorHooks` writes an object per
    // event carrying `failClosed: true`, while `cursorHooksJson.mergeHooks`
    // tested `Array.isArray(existing[event])`, found false, and REPLACED it with
    // a bare `{command}` array. So it silently dropped fail-closed and repointed
    // the user-level shell and MCP gates at `~/.intutic/hooks/cursor-check.js`,
    // a path no writer produces. `cursorHooks` already registers a superset of
    // its events at both levels, so it is deleted rather than repaired.
    // goose and openhands are deliberately absent here.
    //
    // They each used to get a *second* gate from this call site —
    // gooseHooksWriter.ts and openhandsHooksWriter.ts — installed alongside the
    // one their own writer produces. The two had contradictory models: the
    // survivors enforce locally and fail closed, these POSTed every tool call to
    // the control plane and failed open on any error or timeout. For openhands
    // both wrote `.openhands/hooks.json`, so whichever ran last silently won.
    //
    // Deleted rather than deprecated: two modules exporting the same symbol for
    // one harness *is* the defect. And they are not replaced by calls to the
    // survivors here — a second call site is how this started.

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
      // The .env.intutic proxy routing above governs LLM egress only; the gate
      // is what refuses tool calls. Written alongside, same as claude-desktop.
      if (harness === 'codex') {
        try { await writeCodexHooks(workspaceRoot, proxyUrl, workspaceId) } catch (e) {
          console.warn('[sync-daemon] writeCodexHooks failed (non-fatal):', e) }
      }
      // Preview mechanism (VS Code agent hooks) — the writer's header says so,
      // and the gate fails closed if the stdin shape shifts.
      if (harness === 'github-copilot') {
        try { await writeGithubCopilotHooks(workspaceRoot, proxyUrl, workspaceId) } catch (e) {
          console.warn('[sync-daemon] writeGithubCopilotHooks failed (non-fatal):', e) }
      }
      // Same split as codex/claude-desktop: AGENTS.md above carries the rules
      // text, this installs the PreToolUse/PermissionRequest gate (project +
      // managed tiers) and the managed_hooks_path merge into settings.json.
      if (harness === 'muse-code') {
        try { await writeMuseHooks(workspaceRoot, proxyUrl, workspaceId) } catch (e) {
          console.warn('[sync-daemon] writeMuseHooks failed (non-fatal):', e) }
      }
      // AGENTS.md above governs prompt-level rules only; the gate is what
      // refuses tool calls, and the config.toml model base_url merge is what
      // routes LLM egress. Written alongside, same as codex/claude-desktop.
      if (harness === 'grok') {
        try { await writeGrokHooks(workspaceRoot, proxyUrl, workspaceId) } catch (e) {
          console.warn('[sync-daemon] writeGrokHooks failed (non-fatal):', e) }
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
    case 'grok':
      return formatMarkdown(sops)

    case 'antigravity':
      return formatAntigravity(sops)

    case 'aider':
      return formatAider(sops)

    case 'openhands':
      return formatOpenHands(sops)

    case 'codex':
      return formatCodex(sops, proxyUrl)

    case 'langgraph':
      return formatLanggraph(sops, proxyUrl)

    case 'muse-code':
      // AGENTS.md — same markdown shape as CLAUDE.md/.cursorrules/.windsurfrules.
      return formatMarkdown(sops)

    case 'langchain':
    case 'crewai':
    case 'autogen':
    case 'ag2':
    case 'google-adk':
    case 'openai-agents':
    case 'pydantic-ai':
    case 'smolagents':
    case 'strands':
      return formatSdkGatedEnv(sops, proxyUrl, SDK_GATED_FRAMEWORKS[harness])

    case 'mastra':
    case 'vercel-ai-sdk':
    case 'eve':
    case 'ai-sdk-harness':
    case 'ai-sdk-workflow':
      return formatJsSdkGatedEnv(sops, proxyUrl, JS_SDK_GATED_FRAMEWORKS[harness])

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

/**
 * LangGraph: `.env.intutic` with proxy URL vars, plus a pointer at the
 * SDK-side tool gate. LangGraph tools are plain Python callables in the
 * agent's own process — there is no config or hook file this daemon could
 * write a tool-call gate into, so the env vars govern LLM egress only and
 * the blocking gate ships in `intutic-clawde` (`intutic_clawde.gate`).
 */
function formatLanggraph(sops: SyncSopEntry[], proxyUrl: string): string {
  return (
    formatCodex(sops, proxyUrl) +
    '\n' +
    '# These env vars govern LLM egress only. LangGraph tools run in your own\n' +
    '# Python process, where no config or hook file can gate them — the\n' +
    '# blocking tool gate ships SDK-side:\n' +
    '#   pip install intutic-clawde\n' +
    '#   from intutic_clawde.gate import guard_tools\n'
  )
}

/**
 * Wave 1: seven more frameworks in LangGraph's family — tools are plain
 * Python callables/objects in the agent's own process, so the daemon has no
 * on-disk hook/config file to gate a call with, and every one of these
 * writes the same `.env.intutic` shape `formatLanggraph` does (proxy URL
 * vars + a comment pointing at the SDK-side gate). Declared as data here,
 * rather than as seven more hand-copied `formatXxx` functions, so the shape
 * cannot drift per-framework the way `gateBody.ts`'s module doc warns
 * hand-copied gate logic does.
 *
 * `pipExtra` is omitted for the three frameworks with no dedicated
 * `intutic_clawde.gate.adapters.*` module yet (autogen, ag2, pydantic-ai,
 * smolagents ship in a later wave — see `gateRegistry.ts`'s NO_GATE rows) —
 * their tools are governed today through the framework-agnostic
 * `@guard`/`guard_tools` helpers, which need no optional import.
 */
const SDK_GATED_FRAMEWORKS: Record<
  'langchain' | 'crewai' | 'autogen' | 'ag2' | 'google-adk' | 'openai-agents' | 'pydantic-ai' | 'smolagents' | 'strands',
  { label: string; pipExtra?: string; importLine: string; docsSlug: string }
> = {
  langchain: {
    label: 'LangChain',
    pipExtra: 'langchain',
    importLine: 'from intutic_clawde.gate.adapters.langchain import IntuticMiddleware',
    docsSlug: 'langchain',
  },
  crewai: {
    label: 'CrewAI',
    pipExtra: 'crewai',
    importLine: 'from intutic_clawde.gate.adapters.crewai import install',
    docsSlug: 'crewai',
  },
  autogen: {
    label: 'AutoGen',
    importLine: 'from intutic_clawde.gate import guard, guard_tools',
    docsSlug: 'autogen',
  },
  ag2: {
    label: 'AG2',
    importLine: 'from intutic_clawde.gate import guard, guard_tools',
    docsSlug: 'ag2',
  },
  'google-adk': {
    label: 'Google ADK',
    pipExtra: 'google-adk',
    importLine: 'from intutic_clawde.gate.adapters.google_adk import IntuticPlugin',
    docsSlug: 'google-adk',
  },
  'openai-agents': {
    label: 'OpenAI Agents SDK',
    pipExtra: 'openai-agents',
    importLine: 'from intutic_clawde.gate.adapters.openai_agents import intutic_tool_guardrail',
    docsSlug: 'openai-agents',
  },
  'pydantic-ai': {
    label: 'Pydantic AI',
    importLine: 'from intutic_clawde.gate import guard, guard_tools',
    docsSlug: 'pydantic-ai',
  },
  smolagents: {
    label: 'smolagents',
    importLine: 'from intutic_clawde.gate import guard, guard_tools',
    docsSlug: 'smolagents',
  },
  // A4: AWS Strands Agents — dedicated adapter module from day one
  // (intutic_clawde.gate.adapters.strands), unlike the four `pipExtra`-less
  // rows above that started on the framework-agnostic helpers.
  strands: {
    label: 'Strands Agents',
    pipExtra: 'strands',
    importLine: 'from intutic_clawde.gate.adapters.strands import IntuticHookProvider',
    docsSlug: 'strands',
  },
}

/** Shared formatter for every Wave 1 SDK-gated framework — see SDK_GATED_FRAMEWORKS. */
function formatSdkGatedEnv(
  sops: SyncSopEntry[],
  proxyUrl: string,
  info: { label: string; pipExtra?: string; importLine: string; docsSlug: string },
): string {
  const pipInstall = info.pipExtra ? `intutic-clawde[${info.pipExtra}]` : 'intutic-clawde'
  return (
    formatCodex(sops, proxyUrl) +
    '\n' +
    `# These env vars govern LLM egress only. ${info.label} tools run in your own\n` +
    '# Python process, where no config or hook file can gate them — the\n' +
    '# blocking tool gate ships SDK-side:\n' +
    `#   pip install ${pipInstall}\n` +
    `#   ${info.importLine}\n` +
    `# See https://docs.intutic.ai/integrations/${info.docsSlug}\n`
  )
}

/**
 * T2: two more frameworks in LangGraph's family — tools are plain
 * objects/callables in the agent's own Node.js process, so the daemon has no
 * on-disk hook/config file to gate a call with, and both write the same
 * `.env.intutic` shape the Python family does. JS/TS-native, so the pointer
 * comment reads `npm install`/`import { ... } from '@intutic/gate/<subpath>'`
 * rather than `pip install`/`from intutic_clawde...` — see
 * `formatJsSdkGatedEnv`.
 */
const JS_SDK_GATED_FRAMEWORKS: Record<
  'mastra' | 'vercel-ai-sdk' | 'eve' | 'ai-sdk-harness' | 'ai-sdk-workflow',
  {
    label: string
    importLine: string
    usageSummary: string
    docsSlug: string
    /** Replaces the default "govern LLM egress only ... your own Node.js
     *  process" preamble lines when the default prose would be FALSE for
     *  this framework (ai-sdk-harness: tools execute server-side in Vercel
     *  Sandbox microVMs). Same override tools/cli's jsSdkGatedAdapter.ts
     *  carries for the identical reason. */
    envPreamble?: readonly string[]
  }
> = {
  mastra: {
    label: 'Mastra',
    importLine: "import { intuticHooks } from '@intutic/gate/mastra'",
    usageSummary:
      "new Agent({ ..., hooks: intuticHooks() }) — Mastra's beforeToolCall veto point. NOTE: " +
      'per-call `hooks` on .generate()/.stream() OVERRIDE this, not merge with it.',
    docsSlug: 'mastra',
  },
  'vercel-ai-sdk': {
    label: 'Vercel AI SDK',
    importLine: "import { intuticToolApproval, withIntuticProxy } from '@intutic/gate/vercel'",
    usageSummary:
      'generateText({ ..., toolApproval: intuticToolApproval() }) — the toolApproval veto ' +
      'point. NOTE: this framework has NO env-var LLM-egress routing; the vars above do not ' +
      'route it — use withIntuticProxy(createOpenAI)(...) or equivalent in code.',
    docsSlug: 'vercel-ai-sdk',
  },
  eve: {
    label: 'eve',
    importLine: "import { intuticApproval, intuticAuditHooks } from '@intutic/gate/eve'",
    usageSummary:
      'defineTool({ ..., approval: intuticApproval() }) per tool (and intuticConnectionApproval() ' +
      "per MCP/OpenAPI connection) — eve has no agent-level default approval field. NOTE: eve's " +
      'default AI Gateway model routing is NOT proxy-governable; the vars above only reach a ' +
      'direct-provider model built in code via withIntuticProxy(...). PREVIEW product.',
    docsSlug: 'eve',
  },
  'ai-sdk-harness': {
    label: 'AI SDK Harness',
    importLine:
      "import { intuticApprovalResponder, intuticStaticApprovals, recommendedHarnessSettings } from '@intutic/gate/harness'",
    usageSummary:
      'toolApproval: intuticStaticApprovals(tools) routes every custom tool through the approval ' +
      'flow; answer pauses with intuticApprovalResponder(). NOTE: built-in sandbox tools ignore ' +
      "toolApproval entirely — set permissionMode (defaults to 'allow-all') via " +
      'recommendedHarnessSettings(); sandbox egress never crosses this proxy — set a sandbox ' +
      'networkPolicy.',
    docsSlug: 'ai-sdk-harness',
    envPreamble: [
      'These env vars govern LLM egress from THIS process only. AI SDK Harness',
      'agents execute their tools server-side in Vercel Sandbox microVMs — that',
      'traffic never crosses this proxy, and no config or hook file can gate the',
      'sandbox from here. The blocking tool gate (custom host-executed tools',
      'only) ships SDK-side:',
    ],
  },
  'ai-sdk-workflow': {
    label: 'AI SDK Workflow',
    importLine: "import { intuticNeedsApproval, withIntuticApproval } from '@intutic/gate/workflow'",
    usageSummary:
      'new WorkflowAgent({ ..., tools: withIntuticApproval(tools) }) — attaches an async ' +
      'needsApproval per tool (WorkflowAgent itself has no approval option). BLOCK throws a ' +
      'FatalError-compatible refusal so the durable runtime aborts instead of retry-looping ' +
      "the denial; ALLOW resolves false (or true with { onAllow: 'human' }).",
    docsSlug: 'ai-sdk-workflow',
  },
}

/** Shared formatter for every T2 JS/TS SDK-gated framework — see
 *  JS_SDK_GATED_FRAMEWORKS. Same env-var block `formatSdkGatedEnv` writes,
 *  but "npm install"/an ESM import line/"Node.js process" in the pointer
 *  comment, not "pip install"/"Python process". */
function formatJsSdkGatedEnv(
  sops: SyncSopEntry[],
  proxyUrl: string,
  info: {
    label: string
    importLine: string
    usageSummary: string
    docsSlug: string
    envPreamble?: readonly string[]
  },
): string {
  const preamble = info.envPreamble ?? [
    `These env vars govern LLM egress only. ${info.label} tools run in your own`,
    'Node.js process, where no config or hook file can gate them — the',
    'blocking tool gate ships SDK-side:',
  ]
  return (
    formatCodex(sops, proxyUrl) +
    '\n' +
    preamble.map((line) => `# ${line}\n`).join('') +
    `#   npm install @intutic/gate\n` +
    `#   ${info.importLine}\n` +
    `# ${info.usageSummary}\n` +
    `# See https://docs.intutic.ai/integrations/${info.docsSlug}\n`
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
 *
 * Exported for reuse by other full-regenerate writers in this daemon (e.g.
 * `lib/decisionsDigest.ts`) that want the same write-tmp-then-rename
 * atomicity without duplicating it.
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
