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
    body,
  }
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
  riskTier: string
  version: string
  body: string
}): string {
  const hash = createHash('sha256').update(sop.body, 'utf8').digest('hex')
  return [
    '---',
    `title: ${sop.title}`,
    `risk_tier: ${sop.riskTier}`,
    `version: ${sop.version}`,
    `content_hash: ${hash}`,
    '---',
    '',
    sop.body,
    '',
  ].join('\n')
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
