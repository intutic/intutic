import * as fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { log } from '../lib/logger.js'
import { loadCredentials, loadConfig } from '../config/store.js'
import { resolveControlPlaneUrl } from '../config/paths.js'
import { createApiClient } from '../lib/api.js'
import { parseSopFile, titleFromFileName, renderSopFile, slugifyTitle } from '../lib/sopFrontMatter.js'

async function getClient(dev?: boolean) {
  const creds = await loadCredentials()
  if (!creds) {
    log.error('Not authenticated. This command needs an Intutic control plane, which open core does not include. To run the proxy without one: `intutic start`.')
    process.exit(1)
  }
  const config = loadConfig()
  const devMode = dev || config?.devMode || process.env.INTUTIC_DEV === '1'
  const controlPlaneUrl = resolveControlPlaneUrl(devMode)
  return createApiClient(controlPlaneUrl, creds.apiKey)
}

/**
 * `intutic sops push <name>` — one control-plane SOP per file under
 * `.intutic/sops/<name>/*.md`, each carrying that file's own declared
 * `title:`/`risk_tier:`/`version:` front matter rather than the folder's
 * name and two hardcoded constants.
 *
 * Previously concatenated every file in the folder into one blob under one
 * title derived from the folder name, and always sent `risk_tier: 'LOW'`,
 * `version: '1.0.0'` regardless of what the files declared — a folder of
 * five SOPs at five different risk tiers pushed as one LOW-tier SOP whose
 * title named none of them. Per-file push is what the DB plane can actually
 * represent faithfully: `sop_registry` has no concept of "a folder of SOPs,"
 * only individual rows.
 *
 * Front matter is stripped before the body is sent as `markdownContent` —
 * `formatOrgSopConstraints` in `routes/judge.ts` interpolates that field
 * verbatim into the judge's system prompt, and a `---\nrisk_tier: HIGH\n---`
 * block in the middle of it is noise no judge prompt should carry.
 * Declarative enforcement keys (`deny_tools:`, `requires_before:`, ...) have
 * no `sop_registry` column, so they are lost from the DB-plane row exactly
 * as they always were — this fixes what already had somewhere to go
 * (title, risk tier, version), not what does not.
 */
export async function runSopsPush(name: string, opts: { dev?: boolean; org?: boolean }): Promise<void> {
  log.header(`Intutic — Push SOP: ${name}`)

  const config = loadConfig()
  const workspaceRoot = config?.workspaceRoot ?? process.cwd()
  const sopsDir = join(workspaceRoot, '.intutic', 'sops', name)

  try {
    const stat = await fs.stat(sopsDir)
    if (!stat.isDirectory()) {
      log.error(`Path is not a directory: ${sopsDir}`)
      process.exit(1)
    }
  } catch {
    log.error(`Local SOP folder not found: ${sopsDir}`)
    process.exit(1)
  }

  let mdFiles: string[]
  try {
    mdFiles = (await fs.readdir(sopsDir)).filter((e) => e.endsWith('.md')).sort()
    if (mdFiles.length === 0) {
      log.error(`No markdown (.md) files found in local SOP folder: ${sopsDir}`)
      process.exit(1)
    }
  } catch (err) {
    log.error(`Error reading SOP files: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  const client = await getClient(opts.dev)
  let failures = 0

  for (const file of mdFiles) {
    const raw = await fs.readFile(join(sopsDir, file), 'utf-8')
    const parsed = parseSopFile(raw)
    if (!parsed.body) {
      log.warn(`Skipping ${file}: empty after stripping front matter.`)
      continue
    }
    const title = parsed.title ?? titleFromFileName(file)

    // --org pushes a mandatory org-wide floor (migration 139) instead of a
    // workspace SOP -- the server derives orgId from the caller's own
    // workspace; this CLI never resolves or supplies one.
    if (opts.org) {
      try {
        const res = await client.post<{ orgSopId?: string; orgId?: string }>(
          '/api/v1/workspace/org-sops',
          {
            title,
            markdown_content: parsed.body,
            ...(parsed.riskTier ? { risk_tier: parsed.riskTier } : {}),
          },
        )
        if (res && res.orgSopId) {
          log.info(`${file} → org-wide floor "${title}"`)
          log.field('Org SOP ID', res.orgSopId)
        } else {
          log.error(`${file}: failed to create org SOP on the control plane.`)
          failures += 1
        }
      } catch (err) {
        log.error(`${file}: failed to push org SOP: ${err instanceof Error ? err.message : String(err)}`)
        failures += 1
      }
      continue
    }

    try {
      const res = await client.post<{ ok: boolean; sopId?: string }>(
        '/api/v1/sops',
        {
          title,
          markdown_content: parsed.body,
          // Declared, not guessed: an unstated risk_tier lets the DB's own
          // default (MEDIUM) apply rather than this CLI silently choosing
          // LOW for every SOP that never mentioned one.
          risk_tier: parsed.riskTier ?? 'MEDIUM',
          // No front-matter equivalent exists for complexity — nothing in
          // packages/proxy/src/sops.rs's front matter declares it.
          complexity_tier: 'TIER_0',
          ...(parsed.version ? { version: parsed.version } : {}),
        },
      )
      if (res && res.sopId) {
        log.info(`${file} → workspace SOP "${title}"`)
        log.field('SOP ID', res.sopId)
      } else {
        log.error(`${file}: failed to create SOP on the control plane.`)
        failures += 1
      }
    } catch (err) {
      log.error(`${file}: failed to push SOP: ${err instanceof Error ? err.message : String(err)}`)
      failures += 1
    }
  }

  log.info(`Pushed ${mdFiles.length - failures}/${mdFiles.length} file(s) from ${sopsDir}.`)
  if (failures > 0) process.exit(1)
}

/** The subset of a control-plane SOP row `pull` needs. */
interface SopListItem {
  sopId: string
  title: string
}
interface SopDetail {
  sopId: string
  title: string
  riskTier: string
  version: string
  markdownContent: string
}

/**
 * `intutic sops pull` — the round trip `push` never had: every workspace SOP
 * on the control plane, written to `.intutic/sops/<slug-of-title>.md` with
 * front matter reconstructed from the row (`title:`, `risk_tier:`,
 * `version:`).
 *
 * Refuses to overwrite a file it did not itself write most recently, unless
 * `--force` is passed. The check is a recorded hash, not a live diff: every
 * file this command writes carries `content_hash: sha256(body)` in its own
 * front matter (see `renderSopFile`), and a later pull compares that
 * recorded value against the CURRENT local body's hash — not against the
 * control plane's. A mismatch means a human edited the file since the last
 * pull; a match means nothing local changed, so pulling fresh content from
 * the plane (which may itself have changed) is safe. A file with no
 * recorded hash at all — hand-authored, or only ever pushed — is treated as
 * unverifiable and always requires `--force`, since overwriting a
 * hand-written SOP the first time this command sees it would be the
 * expensive direction to get wrong.
 */
export async function runSopsPull(opts: { dev?: boolean; force?: boolean }): Promise<void> {
  log.header('Intutic — Pull SOPs')

  const config = loadConfig()
  const workspaceRoot = config?.workspaceRoot ?? process.cwd()
  const sopsDir = join(workspaceRoot, '.intutic', 'sops')

  const client = await getClient(opts.dev)

  let items: SopListItem[]
  try {
    const res = await client.get<{ items: SopListItem[] }>('/api/v1/sops?limit=100')
    items = res.items ?? []
  } catch (err) {
    log.error(`Failed to list SOPs: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  if (items.length === 0) {
    log.info('No SOPs found in this workspace.')
    return
  }

  await fs.mkdir(sopsDir, { recursive: true })

  let written = 0
  let conflicts = 0
  const seenSlugs = new Set<string>()

  for (const item of items) {
    let detail: SopDetail
    try {
      detail = await client.get<SopDetail>(`/api/v1/sops/${item.sopId}`)
    } catch (err) {
      log.warn(`${item.title}: failed to fetch content, skipping (${err instanceof Error ? err.message : String(err)})`)
      continue
    }
    if (!detail.markdownContent) {
      log.warn(`${item.title}: no content on the control plane, skipping.`)
      continue
    }

    // Two SOPs with the same title collide on the same file. Rather than
    // silently overwriting one with the other, the second gets its sopId
    // suffixed — a visible, if ugly, signal beats a quiet data loss.
    let slug = slugifyTitle(detail.title)
    if (seenSlugs.has(slug)) slug = `${slug}-${detail.sopId.slice(-6)}`
    seenSlugs.add(slug)

    const filePath = join(sopsDir, `${slug}.md`)
    const rendered = renderSopFile({
      title: detail.title,
      riskTier: detail.riskTier,
      version: detail.version,
      body: detail.markdownContent.trim(),
    })

    const existing = await fs.readFile(filePath, 'utf-8').catch(() => null)

    if (existing !== null && !opts.force) {
      const parsedExisting = parseSopFile(existing)
      const actualLocalHash = createHash('sha256').update(parsedExisting.body, 'utf8').digest('hex')
      const dirty = parsedExisting.contentHash === null || parsedExisting.contentHash !== actualLocalHash
      if (dirty) {
        log.warn(`${filePath}: locally modified (or never pulled before) — refusing to overwrite. Use --force to pull anyway.`)
        conflicts += 1
        continue
      }
    }

    await fs.writeFile(filePath, rendered, 'utf-8')
    written += 1
    log.info(`${filePath} ← "${detail.title}"`)
  }

  log.info(`Pulled ${written} file(s) into ${sopsDir}${conflicts > 0 ? `, ${conflicts} conflict(s) left untouched` : ''}.`)
  if (conflicts > 0) {
    log.info('Re-run with --force to overwrite locally-modified files.')
  }
}

type SopDrift = 'in-sync' | 'local-ahead' | 'remote-ahead' | 'diverged' | 'push-only'

/**
 * `intutic sops status` — drift between `.intutic/sops/*.md` and the
 * control plane, read-only against the file system (the comparison itself
 * never writes a local file).
 *
 * Matched by title, the same heuristic `pull` uses to name files: neither
 * plane has a stable identifier the other side carries (a pushed file has
 * no `sopId` until after the fact; a filename is not a title). A file
 * `pull` has never touched carries no `content_hash:` marker, so this
 * cannot tell "hand-authored, never pushed" apart from "hand-authored,
 * edited after an old pull" — both report `diverged` rather than guessing.
 *
 * The comparison itself is computed entirely client-side, same as always.
 * What's new: once computed, every matched (non-`push-only`) result is
 * reported to `POST /api/v1/sops/git-drift-report`, best-effort — a live
 * sync-daemon reconciliation loop is still not attempted here (still "a
 * second project", per `apps/docs/guide/gitops-sops.md`), but a human or CI
 * job running this command on a schedule now leaves the compliance probe
 * (`sop_git_drift`) something to read instead of nothing. Report failures
 * never fail the command — the read-only status output above is already
 * complete and correct on its own.
 */
export async function runSopsStatus(opts: { dev?: boolean }): Promise<void> {
  log.header('Intutic — SOP Drift Status')

  const config = loadConfig()
  const workspaceRoot = config?.workspaceRoot ?? process.cwd()
  const sopsDir = join(workspaceRoot, '.intutic', 'sops')

  let localFiles: string[]
  try {
    localFiles = (await fs.readdir(sopsDir)).filter((f) => f.endsWith('.md')).sort()
  } catch {
    log.info(`No local SOPs directory at ${sopsDir}.`)
    return
  }
  if (localFiles.length === 0) {
    log.info(`No .md files in ${sopsDir}.`)
    return
  }

  const client = await getClient(opts.dev)
  let remoteByTitle: Map<string, { sopId: string; contentHash?: string }>
  try {
    const res = await client.get<{ items: Array<{ sopId: string; title: string; contentHash?: string }> }>(
      '/api/v1/sops?limit=100',
    )
    remoteByTitle = new Map((res.items ?? []).map((r) => [r.title, { sopId: r.sopId, contentHash: r.contentHash }]))
  } catch (err) {
    log.error(`Failed to fetch workspace SOPs: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  const counts: Record<SopDrift, number> = { 'in-sync': 0, 'local-ahead': 0, 'remote-ahead': 0, diverged: 0, 'push-only': 0 }
  const driftReport: Array<{ sop_id: string; status: 'in-sync' | 'local-ahead' | 'remote-ahead' | 'diverged' }> = []

  for (const file of localFiles) {
    const raw = await fs.readFile(join(sopsDir, file), 'utf-8')
    const parsed = parseSopFile(raw)
    const title = parsed.title ?? titleFromFileName(file)
    const localHash = createHash('sha256').update(parsed.body, 'utf8').digest('hex')

    const remote = remoteByTitle.get(title)
    if (!remote) {
      counts['push-only'] += 1
      log.field(file, `push-only — no SOP titled "${title}" on the control plane yet`)
      continue
    }

    const remoteHash = remote.contentHash
    let status: SopDrift
    if (remoteHash && localHash === remoteHash) {
      status = 'in-sync'
    } else if (parsed.contentHash === localHash) {
      // Unedited since the last pull, but the local hash no longer matches
      // the control plane — the control plane moved, this file did not.
      status = 'remote-ahead'
    } else if (parsed.contentHash !== null) {
      // Had a recorded pull hash, and the file no longer matches it — a
      // human edited it since.
      status = 'local-ahead'
    } else {
      // No pull marker at all, and it does not match the control plane
      // either: cannot tell "never pulled" apart from "edited since a very
      // old pull" from local information alone.
      status = 'diverged'
    }

    counts[status] += 1
    driftReport.push({ sop_id: remote.sopId, status })
    const label = {
      'in-sync': 'in sync',
      'local-ahead': 'locally modified — `sops push` to publish',
      'remote-ahead': 'control plane has newer content — `sops pull` to fetch',
      diverged: 'diverges from the control plane, and was never (verifiably) pulled',
      'push-only': '',
    }[status]
    log.field(file, `${status} — ${label}`)
  }

  log.info(
    `${counts['in-sync']} in sync, ${counts['local-ahead']} locally modified, ` +
      `${counts['remote-ahead']} behind, ${counts.diverged} diverged, ${counts['push-only']} push-only.`,
  )

  if (driftReport.length > 0) {
    try {
      await client.post('/api/v1/sops/git-drift-report', { results: driftReport })
    } catch {
      // Non-fatal: the status output above is already complete on its own,
      // and a report the control plane never sees just leaves the
      // `sop_git_drift` probe with stale (or absent) data until the next
      // successful run — never a reason to fail this command.
    }
  }
}
