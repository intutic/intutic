/**
 * decisionsDigest.ts — governed decisions log.
 *
 * Mirrors `egressPolicy.ts`'s thin-projection pattern (fetch a bounded,
 * read-only projection from the control plane every sync cycle, write it
 * locally) for a different payload: the last ~20 governance decisions
 * (adjudications, approved/rejected decisions, resolved incidents,
 * settings changes), rendered as one-line summaries SERVER-SIDE by
 * `GET /api/v1/workspace/decisions-digest`. This module never parses or
 * re-renders decision content — it only writes what it is given.
 *
 * Deliberately narrow, same boundary the control-plane route documents:
 * governance-decision records only, never conversational memory or general
 * context management (this repo pivoted away from that harness product —
 * see this repo's own CLAUDE.md history, and `apps/docs/guide/decisions-log.md`).
 *
 * Opt-in via `WorkspaceSettings.decisionsLogEnabled` (default off). The
 * CALLER is responsible for that gate — `refreshDecisionsDigest` always
 * fetches and writes when invoked, so `intutic connect` only calls it when the
 * workspace has opted in. When disabled, the caller simply stops calling
 * this module; existing files are left as they were last written rather than
 * being force-deleted (a developer's editor may have that file open) or
 * overwritten with a stale/misleading "disabled" placeholder.
 *
 * Two files:
 *
 *  1. `.intutic/DECISIONS.md` — the full bounded record (all entries the
 *     digest returns), regenerated whole every cycle with `configWriter.ts`'s
 *     pattern (i): a DO-NOT-EDIT header + `atomicWrite`. Gitignored — runtime
 *     artifacts stay untracked, the same rule this repo's own CLAUDE.md doc
 *     comment states for daemon-generated governance files.
 *  2. The newest ~10 entries, delivered to every active harness that reads
 *     an instructions file, where `HARNESS_RULES_FILES` says it reads them
 *     (`decisionsTargetOf`) — this is what makes the digest something the
 *     agent actually reads without needing to know `.intutic/DECISIONS.md`
 *     exists. In a file the user also writes (`AGENTS.md`, `GEMINI.md`,
 *     ...) it is a marked section of its own (`INTUTIC:DECISIONS_LOG`),
 *     apart from the rules section; next to a rules file of Intutic's own it
 *     is a second file (`.claude/rules/intutic-decisions.md`, ...). Claude
 *     Code gets it from `.claude/rules/`, which it loads with or without a
 *     `CLAUDE.md`; `CLAUDE.md` itself is never written. When Claude Code
 *     also reads the workspace's `AGENTS.md` and that file carries the
 *     section for another harness, Claude Code's own file is left out, so it
 *     does not read the log twice (see `claudeAgentsMd.ts`).
 *
 * Earlier versions put the section in `CLAUDE.md`; {@link
 * retireClaudeMdDigest} takes it out again on every sync.
 *
 * Deliberately does NOT reuse `configWriter.ts`'s own `fileHeader()` for the
 * DECISIONS.md header — that helper stamps `newIso()` (wall-clock "Last
 * sync"), which would make the file churn every cycle even when the digest
 * itself hasn't changed. The header here instead derives its timestamp from
 * the digest's own newest entry, so identical input renders an identical
 * file — see the render-idempotence test.
 *
 * @module
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createLogger } from '@intutic/logger'
import { HarnessType, decisionsTargetOf, rulesFileOf } from '@intutic/shared-types'
import { atomicWrite } from '../configWriter.js'
import { DECISIONS_MARKERS, removeRulesSection, retireRulesFile, writeRulesSection } from '../harness/rulesSection.js'
import { claudeCodeReadsAgentsMd } from '../harness/claudeAgentsMd.js'
import { openclawAgentWorkspace } from '../harness/openclawHooks.js'
import { ensureAiderReadEntry } from '../harness/aiderConfigMerger.js'
import { forgetOriginal, readOriginal, writeOwnedFile } from '../disconnect/originals.js'

const log = createLogger('sync-decisions-digest')

/** Relative to the workspace root. */
export const DECISIONS_LOG_RELATIVE_PATH = path.join('.intutic', 'DECISIONS.md')

/** First line of the decisions log's own files, which `intutic disconnect` recognises. */
export const DECISIONS_FILE_HEADER = '# Intutic Governed Decisions Log (auto-generated)'

/** One digest entry, exactly as `GET /api/v1/workspace/decisions-digest` returns it — the summary line is already rendered server-side. */
export interface DecisionsDigestEntry {
  id: string
  kind: string
  timestamp: string
  summary: string
}

export interface DecisionsDigestResponse {
  workspaceId: string
  entries: DecisionsDigestEntry[]
}

export interface DecisionsDigestOptions {
  controlPlaneUrl: string
  apiKey: string
  workspaceId: string
  workspaceRoot: string
  /** Active harnesses this cycle: each that reads an instructions file gets the newest entries there. */
  harnesses: HarnessType[]
}

/**
 * Trims trailing `/` without a regex — see the identical helper in
 * `egressPolicy.ts`/`approvedBypasses.ts`: `/\/+$/` is flagged by CodeQL as a
 * polynomial-time pattern on external input, and a loop sidesteps the whole
 * category.
 */
function trimTrailingSlashes(s: string): string {
  let end = s.length
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* '/' */) end--
  return s.slice(0, end)
}

function isDigestEntry(value: unknown): value is DecisionsDigestEntry {
  if (typeof value !== 'object' || value === null) return false
  const e = value as Record<string, unknown>
  return (
    typeof e.id === 'string' &&
    typeof e.kind === 'string' &&
    typeof e.timestamp === 'string' &&
    typeof e.summary === 'string'
  )
}

/**
 * Fetch this workspace's decisions digest. Returns null on any failure — the
 * caller keeps whatever was written last cycle rather than replacing it with
 * nothing, the same rule `egressPolicy.ts`'s fetch follows.
 */
export async function fetchDecisionsDigest(
  opts: Pick<DecisionsDigestOptions, 'controlPlaneUrl' | 'apiKey' | 'workspaceId'>,
): Promise<DecisionsDigestResponse | null> {
  const url =
    `${trimTrailingSlashes(opts.controlPlaneUrl)}/api/v1/workspace/decisions-digest` +
    `?workspaceId=${encodeURIComponent(opts.workspaceId)}`
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${opts.apiKey}`, 'x-workspace-id': opts.workspaceId },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      log.warn(
        { action: 'decisions_digest_fetch_failed', status: res.status },
        'decisions-digest returned non-OK',
      )
      return null
    }
    const body = (await res.json()) as unknown
    if (typeof body !== 'object' || body === null) return null
    const rec = body as Record<string, unknown>
    const workspaceId = typeof rec.workspaceId === 'string' ? rec.workspaceId : opts.workspaceId
    const entries = Array.isArray(rec.entries) ? rec.entries.filter(isDigestEntry) : []
    return { workspaceId, entries }
  } catch (err) {
    log.warn({ action: 'decisions_digest_fetch_failed', err }, 'decisions-digest unreachable')
    return null
  }
}

/** Deterministic header: no wall-clock stamp, so identical input renders an identical file. */
function renderHeader(entries: DecisionsDigestEntry[]): string {
  const latest = entries[0]?.timestamp ?? 'never'
  return [
    '# Intutic Governed Decisions Log (auto-generated)',
    '# DO NOT EDIT — managed by intutic sync daemon',
    `# Most recent entry: ${latest}`,
    '#',
    '# Governance-decision records only (adjudications, approved/rejected',
    '# decisions, resolved incidents, settings changes) — NOT conversational',
    '# memory or general context management.',
    '',
    '',
  ].join('\n')
}

/** Renders the full bounded record written to `.intutic/DECISIONS.md`. */
export function renderDecisionsMarkdown(entries: DecisionsDigestEntry[]): string {
  const header = renderHeader(entries)
  if (entries.length === 0) {
    return `${header}_No governance decisions recorded yet._\n`
  }
  const lines = entries.map((e) => `- ${e.timestamp} — ${e.summary}`)
  return header + lines.join('\n') + '\n'
}

/** The newest `limit` entries, as the body of the section or file each harness reads. */
export function renderDecisionsSectionBody(entries: DecisionsDigestEntry[], limit = 10): string {
  const bounded = entries.slice(0, limit)
  const lines =
    bounded.length > 0
      ? bounded.map((e) => `- ${e.timestamp} — ${e.summary}`)
      : ['_No governance decisions recorded yet._']
  return ['## Recent Governed Decisions', '', ...lines].join('\n')
}

/** A harness's decisions file: the product's front matter, the header, the entries. */
function renderDecisionsFile(body: string, frontMatter: string): string {
  const head = frontMatter ? `---\n${frontMatter}\n---\n\n` : ''
  return `${head}${DECISIONS_FILE_HEADER}\n# DO NOT EDIT — managed by intutic sync daemon\n\n${body}\n`
}

async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf-8')
  } catch {
    return null
  }
}

/**
 * Writes `body` wherever each of `harnesses` reads its instructions, once per
 * file. Claude Code's own file is left out (and removed) when Claude Code
 * reads the workspace's `AGENTS.md` and that file gets the section for
 * another harness.
 */
export async function writeDecisionsTargets(workspaceRoot: string, harnesses: readonly HarnessType[], body: string): Promise<void> {
  const claudeFromAgentsMd =
    harnesses.includes(HarnessType.CLAUDE_CODE) &&
    harnesses.some((h) => rulesFileOf(h) === 'AGENTS.md') &&
    (await claudeCodeReadsAgentsMd(workspaceRoot))
  const written = new Set<string>()
  for (const harness of harnesses) {
    const target = decisionsTargetOf(harness)
    if (!target) continue
    const file =
      target.kind === 'section' && target.scope === 'user'
        ? path.join(await openclawAgentWorkspace(), 'AGENTS.md')
        : path.join(workspaceRoot, target.path)
    if (harness === HarnessType.CLAUDE_CODE && claudeFromAgentsMd) {
      await retireRulesFile(file, workspaceRoot)
      continue
    }
    if (written.has(file)) continue
    written.add(file)
    if (target.kind === 'section') {
      await writeRulesSection(file, workspaceRoot, body, DECISIONS_MARKERS)
      continue
    }
    const content = renderDecisionsFile(body, target.frontMatter?.('Intutic governed decisions log') ?? '')
    if ((await readText(file)) !== content) await writeOwnedFile(file, workspaceRoot, content)
    // Aider loads no file it is not told about.
    if (harness === HarnessType.AIDER) await ensureAiderReadEntry(path.join(workspaceRoot, '.aider.conf.yml'), file)
  }
}

/**
 * Takes out the decisions-log section earlier versions wrote into the
 * workspace's `CLAUDE.md`, leaving the user's text as it was. A `CLAUDE.md`
 * Intutic created that holds nothing else goes, with its record; one an
 * earlier version wrote whole is given back (`retireRulesFile`). Runs on
 * every sync, whether or not the decisions log is on.
 */
export async function retireClaudeMdDigest(workspaceRoot: string): Promise<void> {
  const file = path.join(workspaceRoot, 'CLAUDE.md')
  const text = await readText(file)
  if (text === null) return
  const next = removeRulesSection(text, DECISIONS_MARKERS)
  if (next !== null) {
    const record = await readOriginal(file, workspaceRoot)
    if (next.trim() === '' && record && !record.existed) {
      await fs.rm(file, { force: true })
      await forgetOriginal(file, workspaceRoot)
      log.info({ action: 'decisions_claude_md_removed', path: file }, 'Removed the CLAUDE.md an earlier version created for the decisions log')
      return
    }
    const mode = (await fs.stat(file)).mode & 0o7777
    const tmp = `${file}.intutic-tmp`
    await fs.writeFile(tmp, next, 'utf-8')
    await fs.chmod(tmp, mode)
    await fs.rename(tmp, file)
    log.info({ action: 'decisions_claude_md_section_removed', path: file }, 'Took the decisions-log section out of CLAUDE.md')
  }
  await retireRulesFile(file, workspaceRoot)
}

/**
 * Fetch and write both files in one call, mirroring `refreshEgressPolicy`.
 * Never throws — a failed poll must not take down the sync loop.
 *
 * Does NOT itself check `WorkspaceSettings.decisionsLogEnabled` — see this
 * module's own doc comment for why that gate belongs to the caller.
 */
export async function refreshDecisionsDigest(
  opts: DecisionsDigestOptions,
): Promise<{ entriesWritten: number } | null> {
  const digest = await fetchDecisionsDigest(opts)
  if (digest === null) return null

  try {
    const fullPath = path.join(opts.workspaceRoot, DECISIONS_LOG_RELATIVE_PATH)
    await atomicWrite(fullPath, renderDecisionsMarkdown(digest.entries))

    await writeDecisionsTargets(opts.workspaceRoot, opts.harnesses, renderDecisionsSectionBody(digest.entries, 10))

    return { entriesWritten: digest.entries.length }
  } catch (err) {
    log.warn({ action: 'decisions_digest_write_failed', err }, 'Could not write decisions-log files')
    return null
  }
}
