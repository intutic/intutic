/**
 * Split a local SOP file's front matter from its body, and pull out the
 * three fields `intutic sops push`/`pull` can carry faithfully today
 * (title, risk_tier, version) — declarative enforcement keys (deny_tools,
 * requires_before, scope_paths, ...) have no `sop_registry` column to land
 * in, so they stay embedded in `body` verbatim, exactly as the proxy's own
 * file-plane parser leaves them for a human or the proxy to read, never the
 * control plane.
 *
 * Deliberately not a YAML parser, mirroring `packages/proxy/src/sops.rs`'s
 * own `parse_front_matter`: the front-matter block only ever needs
 * `key: value` scalar lines here, and taking a YAML dependency to read three
 * of them is a poor trade for a CLI that ships as a single binary.
 *
 * @module
 */
import { createHash } from 'node:crypto'

export type SopRiskTier = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'

const VALID_RISK_TIERS: readonly SopRiskTier[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']

export interface ParsedSopFile {
  /** From a `title:` front-matter key, else the file's first `# ` heading, else `null` — the caller falls back to the file name. */
  title: string | null
  /** From a `risk_tier:` key, case-insensitively; `null` if unstated or unrecognised — never guessed. */
  riskTier: SopRiskTier | null
  /** From a `version:` key; `null` if unstated. */
  version: string | null
  /**
   * From a `content_hash:` key — `intutic sops pull`'s own dirty-check
   * marker, recording the body hash at the moment it wrote the file. `null`
   * for a file `pull` never wrote (hand-authored, or pushed but not pulled).
   */
  contentHash: string | null
  /**
   * From an `intutic_id:` key: the control-plane SOP this file was last
   * pulled from or pushed to. `null` for a file never synced, which `sops
   * push` creates as a new SOP.
   */
  intuticId: string | null
  /**
   * From an `intutic_revision:` key: the SOP's `version_counter` when this
   * file was last synced — the precondition `sops push` sends, so an edit
   * made on the server since is refused rather than overwritten. Not the
   * `version:` semver.
   */
  revision: number | null
  /**
   * From an `intutic_draft:` key: this file is the approved version `intutic
   * sops pull` / `push` keeps on disk while another file edits its DRAFT
   * successor (that draft's id). `sops push` never sends it; edit the draft.
   */
  approvedCopyFor: string | null
  /** Everything after the front-matter fence, or the whole trimmed input when there is none. */
  body: string
}

/** One `key:` scalar line's value, trimmed and unquoted — `null` if the key never appears. */
function scalar(front: string, key: string): string | null {
  for (const line of front.split('\n')) {
    const trimmedLine = line.trim()
    if (!trimmedLine.startsWith(key)) continue
    const value = trimmedLine.slice(key.length).trim().replace(/^['"]|['"]$/g, '').trim()
    return value.length > 0 ? value : null
  }
  return null
}

export function parseSopFile(raw: string): ParsedSopFile {
  const trimmed = raw.trimStart()
  let front = ''
  let body = raw.trim()

  if (trimmed.startsWith('---')) {
    const rest = trimmed.slice(3)
    const end = rest.indexOf('\n---')
    // No closing fence: the whole thing is body, matching sops.rs's
    // `FrontMatter::body_only` fallback for an unterminated fence.
    if (end !== -1) {
      front = rest.slice(0, end)
      body = rest.slice(end + 4).replace(/^[ \t]*\n/, '').trim()
    }
  }

  const riskRaw = scalar(front, 'risk_tier:')?.toUpperCase() ?? null
  const riskTier = riskRaw && (VALID_RISK_TIERS as readonly string[]).includes(riskRaw)
    ? (riskRaw as SopRiskTier)
    : null

  let title = scalar(front, 'title:')
  if (!title) {
    const h1 = body.match(/^#\s+(.+)$/m)
    if (h1) title = h1[1]!.trim()
  }

  return {
    title,
    riskTier,
    version: scalar(front, 'version:'),
    contentHash: scalar(front, 'content_hash:'),
    intuticId: scalar(front, 'intutic_id:'),
    revision: parseRevision(scalar(front, 'intutic_revision:')),
    approvedCopyFor: scalar(front, 'intutic_draft:'),
    body,
  }
}

function parseRevision(raw: string | null): number | null {
  if (raw === null || !/^\d+$/.test(raw)) return null
  return Number(raw)
}

/** The sync record `sops pull`/`push` keep in a file's front matter. */
export interface SopSyncRecord {
  intuticId: string
  revision: number
}

/**
 * Set `key: value` lines inside a file's front-matter fence, replacing a line
 * that already sets the key and keeping every other line — the enforcing keys
 * the proxy reads (`deny_tools:`, `requires_before:`, …) included. A `null`
 * value removes the key's line instead (a SOP with no risk tier has no
 * `risk_tier:`, never `risk_tier: null`). The text
 * after the fence is kept verbatim unless `body` is given. A file with no
 * fence gets one holding only these keys. Unknown keys are inert to the
 * proxy's parser, so the sync record never changes what a SOP enforces.
 */
export function setFrontMatter(raw: string, fields: Record<string, string | null>, body?: string): string {
  const trimmed = raw.trimStart()
  const set = (frontLines: string[]): string[] => {
    let out = [...frontLines]
    for (const [key, value] of Object.entries(fields)) {
      const sets = (l: string) => l.trim().startsWith(`${key}:`)
      if (value === null) {
        out = out.filter((l) => !sets(l))
        continue
      }
      const line = `${key}: ${value}`
      const at = out.findIndex(sets)
      if (at === -1) out.push(line)
      else out[at] = line
    }
    return out
  }
  if (trimmed.startsWith('---')) {
    const rest = trimmed.slice(3)
    const end = rest.indexOf('\n---')
    if (end !== -1) {
      // rest.slice(0, end) starts with the newline after the opening fence.
      const frontLines = rest.slice(0, end).split('\n').slice(1)
      const closing = rest.slice(end + 1)
      const afterFence = closing.slice(3)
      const tail = body === undefined ? afterFence : `\n\n${body}\n`
      return ['---', ...set(frontLines), '---'].join('\n') + tail
    }
  }
  const text = body ?? parseSopFile(raw).body
  return ['---', ...set([]), '---', '', text, ''].join('\n')
}

/**
 * Record the SOP a file is synced with — `intutic_id:`, `intutic_revision:`
 * and `content_hash:` (so `sops pull` treats the file as unedited) — keeping
 * everything else in the file. Optional `extra` keys (a `version:` the server
 * assigned) are set alongside.
 */
export function withSyncRecord(raw: string, record: SopSyncRecord, extra: Record<string, string> = {}): string {
  const hash = createHash('sha256').update(parseSopFile(raw).body, 'utf8').digest('hex')
  return setFrontMatter(raw, {
    ...extra,
    content_hash: hash,
    intutic_id: record.intuticId,
    intutic_revision: String(record.revision),
  })
}

/**
 * Render a pulled SOP back into a front-matter-carrying file, with
 * `content_hash:` recording `sha256(body)` at write time — the marker
 * `runSopsPull` compares against on a later pull to tell "the DB changed
 * upstream" (safe to overwrite) from "a human hand-edited this file since
 * the last pull" (refuse without `--force`).
 */
export function renderSopFile(sop: {
  title: string
  /** Null for a SOP with no tier: the file then has no `risk_tier:` line. */
  riskTier: string | null
  version: string
  body: string
  record?: SopSyncRecord
  /** {@link serverEnforces}; null writes no `intutic_enforced:` line. */
  enforced?: boolean | null
}): string {
  const hash = createHash('sha256').update(sop.body, 'utf8').digest('hex')
  return [
    '---',
    `title: ${sop.title}`,
    ...(sop.riskTier === null ? [] : [`risk_tier: ${sop.riskTier}`]),
    `version: ${sop.version}`,
    `content_hash: ${hash}`,
    ...(sop.record ? [`intutic_id: ${sop.record.intuticId}`, `intutic_revision: ${sop.record.revision}`] : []),
    ...(sop.enforced === undefined || sop.enforced === null ? [] : [`intutic_enforced: ${sop.enforced}`]),
    '---',
    '',
    sop.body,
    '',
  ].join('\n')
}

/**
 * Whether the control plane enforces this SOP: an active `VALIDATED` one. Every
 * other state is not enforced there — `DRAFT`, `PENDING_REVIEW`, `GENERATED`
 * and `INVALIDATED` reach no agent, and `HYPOTHESIZED` / `REFINED` are synced
 * as advisory text and judged in shadow, with no gate acting on them
 * (`ENFORCEMENT_BY_STATE`, and the `VALIDATED` filter every gate applies). A
 * SOP no longer active (deleted or replaced) is not enforced either. `null`
 * when the server reported no state, which writes no marker.
 *
 * `intutic sops pull` records the answer as `intutic_enforced:`, and every
 * local reader — the proxy and the sync daemon — skips a file marked
 * `intutic_enforced: false`, so a SOP is never enforced locally because it was
 * pulled.
 */
export function serverEnforces(sop: { lifecycleState?: string | null; isActive?: boolean | null }): boolean | null {
  if (sop.isActive === false) return false
  if (!sop.lifecycleState) return null
  return sop.lifecycleState === 'VALIDATED'
}

/** `Deploy Checklist` / `deploy checklist!!` → `deploy-checklist`. */
export function slugifyTitle(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.length > 0 ? slug : 'untitled'
}

/** `postgres-migration` → `Postgres Migration`; `deploy_checklist.md` → `Deploy Checklist`. */
export function titleFromFileName(fileName: string): string {
  const stem = fileName.replace(/\.md$/i, '')
  return stem
    .split(/[-_]/)
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/**
 * Add `intutic sops pull`'s `content_hash:` marker to a file that already
 * carries its own front matter — a projected guardrail, whose fence holds
 * the enforcing keys the proxy reads.
 *
 * Not `renderSopFile`: that wraps a second fence around the text, and the
 * proxy reads only the first, so the enforcing keys would become body prose
 * and the rule would load, be listed, and never fire. The marker goes INSIDE
 * the existing fence, as the last line before it closes; the hash is over
 * what `parseSopFile` will read back as `body`, so the dirty check is the
 * same one `sops pull` runs. A file with no fence gets one holding only the
 * marker. Unknown keys are inert to the proxy, so enforcement is unchanged.
 */
export function withContentHash(raw: string): string {
  const trimmed = raw.trimStart()
  const body = parseSopFile(raw).body
  const hash = createHash('sha256').update(body, 'utf8').digest('hex')
  if (trimmed.startsWith('---')) {
    const rest = trimmed.slice(3)
    const end = rest.indexOf('\n---')
    if (end !== -1) {
      const front = rest.slice(0, end).split('\n').filter((l) => !l.trim().startsWith('content_hash:')).join('\n')
      const after = rest.slice(end)
      return `---${front}\ncontent_hash: ${hash}${after}`
    }
  }
  return ['---', `content_hash: ${hash}`, '---', '', body, ''].join('\n')
}
