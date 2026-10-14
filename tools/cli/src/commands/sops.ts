import * as fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { log } from '../lib/logger.js'
import { NOT_AUTHENTICATED } from '../lib/authMessages.js'
import { loadCredentials, loadConfig } from '../config/store.js'
import { resolveControlPlaneUrl } from '../config/paths.js'
import { createApiClient } from '../lib/api.js'
import {
  parseSopFile,
  titleFromFileName,
  renderSopFile,
  slugifyTitle,
  setFrontMatter,
  withSyncRecord,
  type ParsedSopFile,
  type SopSyncRecord,
} from '../lib/sopFrontMatter.js'

async function getClient(dev?: boolean) {
  const creds = await loadCredentials()
  if (!creds) {
    log.error(NOT_AUTHENTICATED)
    process.exit(1)
  }
  const controlPlaneUrl = resolveControlPlaneUrl(dev)
  return createApiClient(controlPlaneUrl, creds.apiKey)
}

/**
 * What `sops push <name>` reads: the folder `.intutic/sops/<name>/` when
 * there is one, else the single file `.intutic/sops/<name>.md` (or `<name>`
 * given with its `.md`). The file form is the layout `sops pull` writes and
 * the proxy enforces, so a pulled, edited SOP pushes back by its file name.
 */
export async function resolvePushTarget(
  sopsRoot: string,
  name: string,
): Promise<{ dir: string; files: string[] } | { error: string }> {
  const folder = join(sopsRoot, name)
  const isDir = await fs.stat(folder).then((st) => st.isDirectory(), () => false)
  if (isDir) {
    let files: string[]
    try {
      files = (await fs.readdir(folder)).filter((e) => e.endsWith('.md')).sort()
    } catch (err) {
      return { error: `Error reading SOP files: ${err instanceof Error ? err.message : String(err)}` }
    }
    if (files.length === 0) return { error: `No markdown (.md) files found in local SOP folder: ${folder}` }
    return { dir: folder, files }
  }
  const fileName = name.endsWith('.md') ? name : `${name}.md`
  const file = join(sopsRoot, fileName)
  const isFile = await fs.stat(file).then((st) => st.isFile(), () => false)
  if (isFile) return { dir: dirname(file), files: [basename(file)] }
  return { error: `No SOP folder ${folder}/ or file ${file} found.` }
}

/**
 * `intutic sops push <name>` — one control-plane SOP per file under
 * `.intutic/sops/<name>/*.md` (or the single file `.intutic/sops/<name>.md`),
 * each carrying that file's own declared `title:`/`risk_tier:`/`version:`
 * front matter.
 *
 * A file that records the SOP it was synced with (`intutic_id:`, written by
 * `sops pull` and by a previous push) updates that SOP in place through
 * `PUT /api/v1/sops/:id`, the same edit path as the dashboard: a DRAFT is
 * edited in place, and an approved SOP gets a new DRAFT version while the
 * approved one keeps enforcing until the draft is promoted. The recorded
 * `intutic_revision:` goes along as `version_counter`, so an edit made on the
 * server since the file was synced is refused (409) instead of overwritten;
 * `--force` sends the server's current counter instead. A file with no record
 * creates a new SOP. Either way, a successful push writes the SOP's id and
 * counter back into the file's front matter (a forked DRAFT's id, when the
 * edit forked one), keeping every other line of the file.
 *
 * Front matter is stripped before the body is sent as `markdown_content` —
 * the judge reads that field verbatim. Declarative enforcement keys
 * (`deny_tools:`, `requires_before:`, ...) have no `sop_registry` column, so
 * they stay file-plane only.
 */
export async function runSopsPush(
  name: string,
  opts: { dev?: boolean; org?: boolean; force?: boolean; create?: boolean },
): Promise<void> {
  log.header(`Intutic — Push SOP: ${name}`)

  const config = loadConfig()
  const workspaceRoot = config?.workspaceRoot ?? process.cwd()
  const sopsRoot = join(workspaceRoot, '.intutic', 'sops')

  const target = await resolvePushTarget(sopsRoot, name)
  if ('error' in target) {
    log.error(target.error)
    process.exit(1)
  }
  const { dir: sopsDir, files: mdFiles } = target

  const client = await getClient(opts.dev)
  const ctx: PushContext = { client, opts, successorsOf: null }
  const counts: Record<PushOutcome, number> = { created: 0, updated: 0, forked: 0, 'up-to-date': 0, skipped: 0, failed: 0 }

  for (const file of mdFiles) {
    const outcome = opts.org
      ? await pushOrgFile(client, sopsDir, file)
      : await pushFile(ctx, join(sopsDir, file), file)
    counts[outcome] += 1
  }

  log.info(
    `${mdFiles.length} file(s) from ${sopsDir}: ${counts.created} created, ${counts.updated} updated, ` +
      `${counts.forked} new DRAFT version(s), ${counts['up-to-date']} up to date, ${counts.failed} failed` +
      (counts.skipped > 0 ? `, ${counts.skipped} skipped` : '') +
      '.',
  )
  if (counts.failed > 0) process.exit(1)
}

type PushOutcome = 'created' | 'updated' | 'forked' | 'up-to-date' | 'skipped' | 'failed'

type SopsClient = Awaited<ReturnType<typeof getClient>>

interface PushContext {
  client: SopsClient
  opts: { force?: boolean; create?: boolean }
  /** sopId → ids of active SOPs that name it as their prior version; fetched once, on first need. */
  successorsOf: Map<string, string[]> | null
}

/** What `GET /api/v1/sops/:id` answers (or an error body). */
interface SopRecordResponse {
  sopId?: string
  title?: string
  riskTier?: string
  version?: string
  markdownContent?: string
  lifecycleState?: string
  versionCounter?: number
  error?: string
  message?: string
}

const enc = encodeURIComponent

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** `--org` pushes a mandatory org-wide floor: create-only, as before. */
async function pushOrgFile(client: SopsClient, sopsDir: string, file: string): Promise<PushOutcome> {
  const parsed = parseSopFile(await fs.readFile(join(sopsDir, file), 'utf-8'))
  if (!parsed.body) {
    log.warn(`Skipping ${file}: empty after stripping front matter.`)
    return 'skipped'
  }
  const title = parsed.title ?? titleFromFileName(file)
  // The server derives orgId from the caller's own workspace; this CLI never
  // resolves or supplies one.
  try {
    const res = await client.post<{ orgSopId?: string; orgId?: string }>('/api/v1/workspace/org-sops', {
      title,
      markdown_content: parsed.body,
      ...(parsed.riskTier ? { risk_tier: parsed.riskTier } : {}),
    })
    if (res && res.orgSopId) {
      log.info(`${file} → org-wide floor "${title}"`)
      log.field('Org SOP ID', res.orgSopId)
      return 'created'
    }
    log.error(`${file}: failed to create org SOP on the control plane.`)
  } catch (err) {
    log.error(`${file}: failed to push org SOP: ${errMessage(err)}`)
  }
  return 'failed'
}

async function pushFile(ctx: PushContext, filePath: string, file: string): Promise<PushOutcome> {
  const raw = await fs.readFile(filePath, 'utf-8')
  const parsed = parseSopFile(raw)
  if (!parsed.body) {
    log.warn(`Skipping ${file}: empty after stripping front matter.`)
    return 'skipped'
  }
  const title = parsed.title ?? titleFromFileName(file)

  if (parsed.intuticId) {
    const id = parsed.intuticId
    let current: { status: number; body: SopRecordResponse }
    try {
      current = await ctx.client.getWithStatus<SopRecordResponse>(`/api/v1/sops/${enc(id)}`)
    } catch (err) {
      log.error(`${file}: could not read SOP ${id}: ${errMessage(err)}`)
      return 'failed'
    }
    if (current.status === 404) {
      if (!ctx.opts.create) {
        log.error(
          `${file}: SOP ${id} (its intutic_id) is no longer on the control plane. ` +
            'Re-run with --create to create it again as a new SOP.',
        )
        return 'failed'
      }
      log.info(`${file}: SOP ${id} is gone; creating it again (--create).`)
    } else if (current.status !== 200 || !current.body.sopId) {
      log.error(`${file}: could not read SOP ${id} (${current.status}): ${current.body.message ?? current.body.error ?? 'no detail'}`)
      return 'failed'
    } else {
      return updateFile(ctx, filePath, file, raw, parsed, title, current.body)
    }
  }

  return createFile(ctx, filePath, file, raw, parsed, title)
}

async function createFile(
  ctx: PushContext,
  filePath: string,
  file: string,
  raw: string,
  parsed: ParsedSopFile,
  title: string,
): Promise<PushOutcome> {
  let sopId: string | undefined
  try {
    const res = await ctx.client.post<{ ok: boolean; sopId?: string }>('/api/v1/sops', {
      title,
      markdown_content: parsed.body,
      // Declared, not guessed: an unstated risk_tier gets the DB's own
      // default (MEDIUM) rather than this CLI choosing LOW.
      risk_tier: parsed.riskTier ?? 'MEDIUM',
      // No front-matter equivalent exists for complexity.
      complexity_tier: 'TIER_0',
      ...(parsed.version ? { version: parsed.version } : {}),
    })
    sopId = res?.sopId
  } catch (err) {
    log.error(`${file}: failed to push SOP: ${errMessage(err)}`)
    return 'failed'
  }
  if (!sopId) {
    log.error(`${file}: failed to create SOP on the control plane.`)
    return 'failed'
  }
  log.info(`${file} → new workspace SOP "${title}"`)
  log.field('SOP ID', sopId)

  // The create response carries no version counter; read it back so the next
  // push has its precondition. A new SOP starts at 1.
  let revision = 1
  try {
    const created = await ctx.client.getWithStatus<SopRecordResponse>(`/api/v1/sops/${enc(sopId)}`)
    if (created.status === 200 && typeof created.body.versionCounter === 'number') revision = created.body.versionCounter
  } catch {
    // Keep 1: the SOP was just created, so nothing has edited it yet.
  }
  await recordSync(filePath, file, raw, { intuticId: sopId, revision })
  return 'created'
}

async function updateFile(
  ctx: PushContext,
  filePath: string,
  file: string,
  raw: string,
  parsed: ParsedSopFile,
  title: string,
  current: SopRecordResponse,
): Promise<PushOutcome> {
  const id = current.sopId!
  const serverRevision = current.versionCounter
  const sameContent =
    current.title === title &&
    (current.markdownContent ?? '').trim() === parsed.body &&
    (parsed.riskTier === null || parsed.riskTier === current.riskTier) &&
    (parsed.version === null || parsed.version === current.version)

  if (sameContent) {
    log.info(`${file}: up to date with "${title}" (${id}).`)
    if (typeof serverRevision === 'number' && serverRevision !== parsed.revision) {
      await recordSync(filePath, file, raw, { intuticId: id, revision: serverRevision })
    }
    return 'up-to-date'
  }

  if (!ctx.opts.force && (parsed.revision === null || parsed.revision !== serverRevision)) {
    log.error(
      `${file}: "${title}" changed on the server since you pulled it ` +
        `(revision ${serverRevision ?? '?'} there, ${parsed.revision ?? 'none'} recorded here). ` +
        'Run `intutic sops pull` to fetch it, or push with --force to overwrite it.',
    )
    return 'failed'
  }

  // Editing an approved SOP forks a new DRAFT version. If one already exists,
  // a second fork would leave two competing drafts of one guideline.
  if (current.lifecycleState && current.lifecycleState !== 'DRAFT' && !ctx.opts.force) {
    const successors = (await successorsOf(ctx)).get(id) ?? []
    if (successors.length > 0) {
      log.error(
        `${file}: "${title}" already has a newer DRAFT version on the server (${successors.join(', ')}). ` +
          'Edit that draft instead (`intutic sops pull` writes it to its own file), or push with --force to fork another.',
      )
      return 'failed'
    }
  }

  const body: Record<string, unknown> = {
    title,
    markdown_content: parsed.body,
    ...(parsed.riskTier && parsed.riskTier !== current.riskTier ? { risk_tier: parsed.riskTier } : {}),
    // Only a version the file changed: an unchanged one would pin a forked
    // draft to the approved version's number instead of the server's bump.
    ...(parsed.version && parsed.version !== current.version ? { version: parsed.version } : {}),
    ...(typeof serverRevision === 'number'
      ? { version_counter: ctx.opts.force ? serverRevision : parsed.revision }
      : {}),
  }

  let res: { status: number; body: { sop?: SopRecordResponse; error?: string; message?: string } }
  try {
    res = await ctx.client.putWithStatus(`/api/v1/sops/${enc(id)}`, body)
  } catch (err) {
    log.error(`${file}: failed to update SOP ${id}: ${errMessage(err)}`)
    return 'failed'
  }

  if (res.status === 409) {
    log.error(
      `${file}: "${title}" changed on the server since you pulled it (${res.body.error ?? 'version conflict'}). ` +
        'Run `intutic sops pull` to fetch it, or push with --force to overwrite it.',
    )
    return 'failed'
  }
  if (res.status === 403) {
    // WEAKEN_REQUIRES_OWNER (the edit loosens the guideline) or the role check.
    log.error(`${file}: the control plane refused the edit: ${res.body.message ?? res.body.error ?? 'forbidden'}`)
    return 'failed'
  }
  if (res.status === 404) {
    log.error(`${file}: SOP ${id} is no longer on the control plane. Re-run with --create to create it again as a new SOP.`)
    return 'failed'
  }
  const sop = res.body.sop
  if (res.status !== 200 || !sop?.sopId) {
    log.error(`${file}: update failed (${res.status}): ${res.body.message ?? res.body.error ?? 'no detail'}`)
    return 'failed'
  }

  const forked = sop.sopId !== id
  const revision = typeof sop.versionCounter === 'number' ? sop.versionCounter : (serverRevision ?? 0) + 1
  const extra: Record<string, string> = {}
  if (parsed.version !== null && sop.version && sop.version !== parsed.version) extra.version = sop.version
  await recordSync(filePath, file, raw, { intuticId: sop.sopId, revision }, extra)

  if (forked) {
    log.info(`${file} → new DRAFT version of "${title}"`)
    log.field('SOP ID', sop.sopId)
    log.dim(`  ${id} (${current.lifecycleState}) keeps enforcing until the draft is promoted.`)
    return 'forked'
  }
  log.info(`${file} → updated "${title}" in place`)
  log.field('SOP ID', sop.sopId)
  return 'updated'
}

/** Write the sync record into the file, keeping everything else; a failure is reported, not fatal — the server write already happened. */
async function recordSync(filePath: string, file: string, raw: string, record: SopSyncRecord, extra: Record<string, string> = {}): Promise<void> {
  try {
    await fs.writeFile(filePath, withSyncRecord(raw, record, extra), 'utf-8')
  } catch (err) {
    log.warn(`${file}: pushed, but could not record intutic_id ${record.intuticId} in the file: ${errMessage(err)}`)
  }
}

async function successorsOf(ctx: PushContext): Promise<Map<string, string[]>> {
  if (ctx.successorsOf) return ctx.successorsOf
  const map = new Map<string, string[]>()
  try {
    for (const item of await listAllSops(ctx.client)) {
      if (!item.priorVersionId) continue
      map.set(item.priorVersionId, [...(map.get(item.priorVersionId) ?? []), item.sopId])
    }
  } catch {
    // Without the listing the check cannot run; the server's own
    // precondition still applies to the PUT.
  }
  ctx.successorsOf = map
  return map
}

/** The subset of a control-plane SOP row `pull` and `status` need. */
interface SopListItem {
  sopId: string
  title: string
  contentHash?: string
  versionCounter?: number
  /** The version this one succeeds; absent from servers that predate it. */
  priorVersionId?: string | null
}

/** The route's own cap on `limit`. */
const SOP_PAGE_SIZE = 100

/**
 * Every SOP in the workspace. `GET /api/v1/sops` pages by `page` and `limit`
 * (at most 100) and reports `total`, so one request stopped at the first 100.
 */
async function listAllSops(client: Awaited<ReturnType<typeof getClient>>): Promise<SopListItem[]> {
  const all: SopListItem[] = []
  for (let page = 1; ; page++) {
    const res = await client.get<{ items?: SopListItem[]; total?: number }>(
      `/api/v1/sops?page=${page}&limit=${SOP_PAGE_SIZE}`,
    )
    const items = res.items ?? []
    // A control plane that ignores `page` would hand back page 1 forever.
    if (items.length > 0 && all.some((s) => s.sopId === items[0].sopId)) return all
    all.push(...items)
    if (items.length < SOP_PAGE_SIZE) return all
    if (typeof res.total === 'number' && all.length >= res.total) return all
  }
}
interface SopDetail {
  sopId: string
  title: string
  riskTier: string
  version: string
  markdownContent: string
  versionCounter?: number
}

/** A local SOP file: its path, the name to print, and what it parses to. */
interface LocalSopFile {
  path: string
  /** `deploy.md`, or `checklists/deploy.md` for the folder layout. */
  label: string
  raw: string
  parsed: ParsedSopFile
}

/**
 * Every SOP file under `.intutic/sops/`: the flat `*.md` files `sops pull`
 * writes and the `<name>/*.md` folder layout `sops push <name>` also reads.
 * `guardrail-*.md` are `intutic guardrails pull`'s and have no SOP behind
 * them. Empty when the directory does not exist.
 */
async function readLocalSops(sopsDir: string): Promise<LocalSopFile[]> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(sopsDir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: LocalSopFile[] = []
  const add = async (path: string, label: string) => {
    const raw = await fs.readFile(path, 'utf-8').catch(() => null)
    if (raw !== null) out.push({ path, label, raw, parsed: parseSopFile(raw) })
  }
  for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('guardrail-')) {
      await add(join(sopsDir, e.name), e.name)
    } else if (e.isDirectory()) {
      const inner = await fs.readdir(join(sopsDir, e.name)).catch(() => [] as string[])
      for (const f of inner.filter((n) => n.endsWith('.md')).sort()) await add(join(sopsDir, e.name, f), `${e.name}/${f}`)
    }
  }
  return out
}

/**
 * `intutic sops pull` — every workspace SOP on the control plane, written
 * with front matter reconstructed from the row (`title:`, `risk_tier:`,
 * `version:`) plus the sync record `sops push` reads: `intutic_id:` (the
 * SOP) and `intutic_revision:` (its `version_counter`).
 *
 * A SOP lands in the local file that already records its id — flat or in a
 * `<name>/` folder — and otherwise in `.intutic/sops/<slug-of-title>.md`. An
 * existing file keeps its other front-matter lines (the enforcing keys the
 * proxy reads); only the synced keys and the body are replaced. An approved
 * version is skipped when a local file already tracks its DRAFT successor,
 * so a push that forked a draft does not come back as a second file.
 *
 * Refuses to overwrite a file it did not itself write most recently, unless
 * `--force` is passed. The check is a recorded hash, not a live diff: every
 * file this command writes carries `content_hash: sha256(body)`, and a later
 * pull compares that against the CURRENT local body's hash. A mismatch means
 * a human edited the file since; a file with no recorded hash at all —
 * hand-authored — is treated as unverifiable and always requires `--force`.
 */
export async function runSopsPull(opts: { dev?: boolean; force?: boolean }): Promise<void> {
  log.header('Intutic — Pull SOPs')

  const config = loadConfig()
  const workspaceRoot = config?.workspaceRoot ?? process.cwd()
  const sopsDir = join(workspaceRoot, '.intutic', 'sops')

  const client = await getClient(opts.dev)

  let items: SopListItem[]
  try {
    items = await listAllSops(client)
  } catch (err) {
    log.error(`Failed to list SOPs: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  if (items.length === 0) {
    log.info('No SOPs found in this workspace.')
    return
  }

  await fs.mkdir(sopsDir, { recursive: true })

  const local = await readLocalSops(sopsDir)
  const fileById = new Map<string, LocalSopFile>()
  for (const f of local) if (f.parsed.intuticId) fileById.set(f.parsed.intuticId, f)
  // An approved version whose DRAFT successor a local file tracks.
  const supersededBy = new Map<string, string>()
  for (const item of items) {
    const tracked = fileById.get(item.sopId)
    if (item.priorVersionId && tracked) supersededBy.set(item.priorVersionId, tracked.label)
  }

  let written = 0
  let conflicts = 0
  const seenSlugs = new Set<string>()

  for (const item of items) {
    const tracked = fileById.get(item.sopId)
    if (!tracked && supersededBy.has(item.sopId)) {
      log.dim(`  ${item.title} (${item.sopId}): skipped, ${supersededBy.get(item.sopId)} tracks its newer version.`)
      continue
    }

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

    let filePath: string
    if (tracked) {
      filePath = tracked.path
    } else {
      // Two SOPs with the same title collide on the same file, as does a file
      // that records a different SOP. The second gets its sopId suffixed — a
      // visible, if ugly, signal beats a quiet data loss.
      let slug = slugifyTitle(detail.title)
      const claimed = (s: string) =>
        seenSlugs.has(s) || local.some((f) => f.path === join(sopsDir, `${s}.md`) && f.parsed.intuticId !== null && f.parsed.intuticId !== detail.sopId)
      if (claimed(slug)) slug = `${slug}-${detail.sopId.slice(-6)}`
      seenSlugs.add(slug)
      filePath = join(sopsDir, `${slug}.md`)
    }

    const body = detail.markdownContent.trim()
    const record = { intuticId: detail.sopId, revision: detail.versionCounter ?? item.versionCounter ?? 1 }
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

    const rendered =
      existing === null
        ? renderSopFile({ title: detail.title, riskTier: detail.riskTier, version: detail.version, body, record })
        : setFrontMatter(
            existing,
            {
              title: detail.title,
              risk_tier: detail.riskTier,
              version: detail.version,
              content_hash: createHash('sha256').update(body, 'utf8').digest('hex'),
              intutic_id: record.intuticId,
              intutic_revision: String(record.revision),
            },
            body,
          )
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
 * `intutic sops status` — drift between the local SOP files (flat and
 * `<name>/` folders) and the control plane, read-only against the file
 * system.
 *
 * A file that records its SOP (`intutic_id:`) is compared with that SOP; a
 * file without one is matched by title, the heuristic `pull` used before
 * files carried ids. `intutic_revision:` tells whether the server moved since
 * the file was synced, so a file edited on both sides reports `diverged`
 * rather than `local-ahead`. A file with no `content_hash:` marker cannot be
 * told apart as "never pulled" or "edited after an old pull", so it reports
 * `diverged` when its content differs.
 *
 * Every matched (non-`push-only`) result is reported to
 * `POST /api/v1/sops/git-drift-report`, best-effort, so the compliance probe
 * (`sop_git_drift`) has something to read. Report failures never fail the
 * command.
 */
export async function runSopsStatus(opts: { dev?: boolean }): Promise<void> {
  log.header('Intutic — SOP Drift Status')

  const config = loadConfig()
  const workspaceRoot = config?.workspaceRoot ?? process.cwd()
  const sopsDir = join(workspaceRoot, '.intutic', 'sops')

  try {
    await fs.access(sopsDir)
  } catch {
    log.info(`No local SOPs directory at ${sopsDir}.`)
    return
  }
  const localFiles = await readLocalSops(sopsDir)
  if (localFiles.length === 0) {
    log.info(`No .md files in ${sopsDir}.`)
    return
  }

  const client = await getClient(opts.dev)
  let remoteById: Map<string, SopListItem>
  let remoteByTitle: Map<string, SopListItem>
  try {
    const items = await listAllSops(client)
    remoteById = new Map(items.map((r) => [r.sopId, r]))
    remoteByTitle = new Map(items.map((r) => [r.title, r]))
  } catch (err) {
    log.error(`Failed to fetch workspace SOPs: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  const counts: Record<SopDrift, number> = { 'in-sync': 0, 'local-ahead': 0, 'remote-ahead': 0, diverged: 0, 'push-only': 0 }
  const driftReport: Array<{ sop_id: string; status: 'in-sync' | 'local-ahead' | 'remote-ahead' | 'diverged' }> = []

  for (const { label: file, parsed } of localFiles) {
    const title = parsed.title ?? titleFromFileName(file.slice(file.lastIndexOf('/') + 1))
    const localHash = createHash('sha256').update(parsed.body, 'utf8').digest('hex')

    const remote = parsed.intuticId ? remoteById.get(parsed.intuticId) : remoteByTitle.get(title)
    if (!remote) {
      counts['push-only'] += 1
      log.field(
        file,
        parsed.intuticId
          ? `push-only — its SOP ${parsed.intuticId} is not active on the control plane (deleted, or replaced by a promoted version); \`sops push --create\` creates it again`
          : `push-only — no SOP titled "${title}" on the control plane yet`,
      )
      continue
    }

    const remoteHash = remote.contentHash
    const remoteMoved =
      parsed.revision !== null && typeof remote.versionCounter === 'number' && remote.versionCounter !== parsed.revision
    let status: SopDrift
    if (remoteHash && localHash === remoteHash) {
      status = 'in-sync'
    } else if (parsed.contentHash === localHash) {
      // Unedited since the last sync, but no longer what the control plane
      // holds — the control plane moved, this file did not.
      status = 'remote-ahead'
    } else if (parsed.contentHash !== null) {
      // Edited since the last sync. If the server's revision moved too, both
      // sides changed.
      status = remoteMoved ? 'diverged' : 'local-ahead'
    } else {
      // No sync marker at all, and it does not match the control plane
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
      diverged: remoteMoved
        ? 'changed both here and on the control plane — `sops pull --force` or `sops push --force` picks one'
        : 'diverges from the control plane, and was never (verifiably) pulled',
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

/** The subset of an org-level SOP row `org-list` prints. */
interface OrgSopListItem {
  orgSopId: string
  title: string
  riskTier: string
  createdAt: string
}

/**
 * `intutic sops org-list` — every org-wide SOP floor for the caller's own
 * org, the read side of `sops push <name> --org`.
 *
 * `GET /api/v1/workspace/org-sops` resolves `orgId` server-side from the
 * caller's own workspace and answers a bare `{ data: [...] }`, not the
 * `applyListEnvelope` shape most list endpoints use — so this reads
 * `res.data` directly rather than `res.items`.
 */
export async function runSopsOrgList(opts: { dev?: boolean }): Promise<void> {
  log.header('Intutic — Org-Wide SOPs')

  const client = await getClient(opts.dev)

  let items: OrgSopListItem[]
  try {
    const res = await client.get<{ data: OrgSopListItem[] }>('/api/v1/workspace/org-sops')
    items = res.data ?? []
  } catch (err) {
    log.error(`Failed to list org SOPs: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  if (items.length === 0) {
    log.info('No org-wide SOPs found for this org.')
    return
  }

  for (const item of items) {
    log.field(item.title, `${item.orgSopId} — risk_tier: ${item.riskTier}`)
  }
  log.info(`${items.length} org-wide SOP(s).`)
}

/**
 * `intutic sops org-rm <orgSopId>` — soft-deletes an org-wide SOP floor.
 *
 * `DELETE /api/v1/workspace/org-sops/:orgSopId` requires OWNER/ADMIN on some
 * active workspace under the org, and 404s on both "not found" and
 * "you lack admin access" — deliberately (see `routes/orgSops.ts`), so this
 * command cannot and does not try to distinguish the two.
 */
export async function runSopsOrgRm(orgSopId: string, opts: { dev?: boolean }): Promise<void> {
  log.header(`Intutic — Remove Org SOP: ${orgSopId}`)

  const client = await getClient(opts.dev)

  try {
    await client.del<{ deleted: boolean }>(`/api/v1/workspace/org-sops/${orgSopId}`)
  } catch (err) {
    log.error(`Failed to remove org SOP: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  log.info(`Removed org SOP ${orgSopId}.`)
}
