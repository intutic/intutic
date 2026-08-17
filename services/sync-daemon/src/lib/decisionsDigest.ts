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
 * fetches and writes when invoked, so `syncLoop.ts` only calls it when the
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
 *  2. A bounded, marker-delimited section (last ~10 entries) idempotently
 *     injected into the `claude-code` harness's own regenerated config file
 *     (`HARNESS_FILES['claude-code']`, i.e. `CLAUDE.md`) — this is what makes
 *     the digest something the agent actually reads without needing to know
 *     `.intutic/DECISIONS.md` exists. A marker pair
 *     (`INTUTIC:DECISIONS_LOG:START`/`END`) is replaced in place on every
 *     cycle, never re-appended.
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
import { HarnessType } from '@intutic/shared-types'
import { HARNESS_FILES, atomicWrite } from '../configWriter.js'

const log = createLogger('sync-decisions-digest')

/** Relative to the workspace root. */
export const DECISIONS_LOG_RELATIVE_PATH = path.join('.intutic', 'DECISIONS.md')

const SECTION_START = '<!-- INTUTIC:DECISIONS_LOG:START -->'
const SECTION_END = '<!-- INTUTIC:DECISIONS_LOG:END -->'

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
  /** Active harnesses this cycle — the bounded section is only injected when `claude-code` is among them. */
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

/** Renders the bounded, marker-delimited section injected into the harness config file — the newest `limit` entries only. */
export function renderBoundedSection(entries: DecisionsDigestEntry[], limit = 10): string {
  const bounded = entries.slice(0, limit)
  const lines =
    bounded.length > 0
      ? bounded.map((e) => `- ${e.timestamp} — ${e.summary}`)
      : ['_No governance decisions recorded yet._']
  return [SECTION_START, '## Recent Governed Decisions', '', ...lines, SECTION_END].join('\n')
}

/**
 * Idempotently inject/replace the bounded section in `content`. If the
 * markers are present, everything between them (inclusive) is replaced — the
 * mechanism the `applyConfigEdits` SkillOpt writer already uses elsewhere in
 * this file's sibling module, `configWriter.ts` — never duplicated. If
 * absent, the section is appended once, with a separating blank line.
 */
export function injectBoundedSection(content: string, section: string): string {
  const startIdx = content.indexOf(SECTION_START)
  const endIdx = content.indexOf(SECTION_END)
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    return content.slice(0, startIdx) + section + content.slice(endIdx + SECTION_END.length)
  }
  const sep = content.endsWith('\n\n') ? '' : content.endsWith('\n') ? '\n' : '\n\n'
  return `${content}${sep}${section}\n`
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

    if (opts.harnesses.includes(HarnessType.CLAUDE_CODE)) {
      const claudeMdPath = path.join(opts.workspaceRoot, HARNESS_FILES[HarnessType.CLAUDE_CODE])
      let existing: string | null = null
      try {
        existing = await fs.readFile(claudeMdPath, 'utf-8')
      } catch {
        existing = null
      }
      if (existing !== null) {
        const section = renderBoundedSection(digest.entries, 10)
        const updated = injectBoundedSection(existing, section)
        if (updated !== existing) {
          await atomicWrite(claudeMdPath, updated)
        }
      } else {
        log.debug(
          { action: 'decisions_digest_skip_inject' },
          'claude-code config file not written yet this run — skipping bounded-section injection this cycle',
        )
      }
    }

    return { entriesWritten: digest.entries.length }
  } catch (err) {
    log.warn({ action: 'decisions_digest_write_failed', err }, 'Could not write decisions-log files')
    return null
  }
}
