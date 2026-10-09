/**
 * `intutic guardrails` — the Policy Clause Ledger from the terminal
 * (LLD #71, Wave 6): sources, documents, the review queue, and the three
 * decisions that move a cited guardrail. A client of
 * `/api/v1/policy-guardrails/*` and `/api/v1/connectors`; nothing here
 * decides anything the server would not.
 *
 * Not `intutic policy` (the WASM rule loop) and not `intutic sops` (the
 * file plane). The acting identity is never a flag: the server records the
 * authenticated member, so a client-supplied name cannot forge the audit
 * trail — same rule as `intutic findings adjudicate`.
 */

import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { log } from '../lib/logger.js'
import { parseSopFile, withContentHash } from '../lib/sopFrontMatter.js'
import { NOT_AUTHENTICATED } from '../lib/authMessages.js'
import { loadCredentials, loadConfig } from '../config/store.js'
import { resolveControlPlaneUrl } from '../config/paths.js'
import { createApiClient } from '../lib/api.js'
import {
  SOURCE_PROVIDERS,
  GUARDRAIL_STATUSES,
  GUARDRAIL_TARGETS,
  GUARDRAIL_PROVENANCES,
  AuthoredGuardrailCreateSchema,
  AuthoredGuardrailUpdateSchema,
  guardrailIdFromSopTitle,
  guardrailFileStem,
  type ExtractDocumentResult,
  type GuardrailConflict,
  type GuardrailDetail,
  type GuardrailReadiness,
  type GuardrailReplay,
  type GuardrailSummary,
  type AuthoredGuardrailWriteResult,
  type GuardrailCheckResult,
  type PolicyDocumentDetail,
  type PolicyDocumentSummary,
  type TokenCoverage,
  type LedgerImpact,
  type LedgerDuplicates,
  type PassageSearchResult,
} from '@intutic/shared-types'

const BASE = '/api/v1/policy-guardrails'

interface CommonOpts {
  dev?: boolean
  json?: boolean
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function getClient(dev?: boolean) {
  const creds = await loadCredentials()
  if (!creds) {
    log.error(NOT_AUTHENTICATED)
    process.exit(1)
  }
  const config = loadConfig()
  const devMode = dev || config?.devMode || process.env.INTUTIC_DEV === '1'
  return createApiClient(resolveControlPlaneUrl(devMode), creds.apiKey)
}

function emitJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}

/** A null rate is "no measured rate" — never invented as 0%. */
function formatRate(rate: number | null): string {
  return rate === null ? 'no measured rate' : `${(rate * 100).toFixed(1)}%`
}

const enc = encodeURIComponent

// ─── sources ────────────────────────────────────────────────────────

interface ConnectorRow {
  connector_id?: string
  connectorId?: string
  provider: string
  name: string
  last_synced_at?: string | null
  lastSyncedAt?: string | null
  config?: Record<string, unknown>
}

export async function runGuardrailsSourcesList(opts: CommonOpts): Promise<void> {
  const client = await getClient(opts.dev)
  let items: ConnectorRow[]
  try {
    const res = await client.get<{ items?: ConnectorRow[] }>('/api/v1/connectors')
    items = (res.items ?? []).filter((c) => (SOURCE_PROVIDERS as readonly string[]).includes(c.provider))
  } catch (err) {
    log.error(`Failed to list policy sources: ${errMessage(err)}`)
    process.exit(1)
  }
  if (opts.json) {
    emitJson(items)
    return
  }
  log.header('Intutic — Policy Sources')
  if (items.length === 0) {
    log.info(`No policy sources. Add one with \`intutic guardrails sources add <${SOURCE_PROVIDERS.join('|')}> --name … --token …\`.`)
    return
  }
  for (const c of items) {
    const id = c.connector_id ?? c.connectorId ?? '?'
    const synced = c.last_synced_at ?? c.lastSyncedAt ?? null
    const cfg = c.config ?? {}
    log.field(c.name, `${id} — ${c.provider}${cfg.auto_sync === true ? ', auto-sync' : ''}${synced ? `, last synced ${synced}` : ', never synced'}`)
  }
  log.info(`${items.length} policy source(s).`)
}

export async function runGuardrailsSourcesAdd(
  provider: string,
  opts: CommonOpts & { name?: string; token?: string; tokenFile?: string; config?: string },
): Promise<void> {
  if (!(SOURCE_PROVIDERS as readonly string[]).includes(provider)) {
    log.error(`Provider must be one of ${SOURCE_PROVIDERS.join(', ')}.`)
    process.exit(1)
  }
  if (!opts.name) {
    log.error('--name is required.')
    process.exit(1)
  }
  if (Boolean(opts.token) === Boolean(opts.tokenFile)) {
    log.error('Give the credential with exactly one of --token or --token-file (a Google service-account key is a file).')
    process.exit(1)
  }
  let credential = opts.token ?? ''
  if (opts.tokenFile) {
    try {
      credential = (await readFile(opts.tokenFile, 'utf8')).trim()
    } catch (err) {
      log.error(`Could not read --token-file: ${errMessage(err)}`)
      process.exit(1)
    }
    if (!credential) {
      log.error('--token-file is empty.')
      process.exit(1)
    }
  }
  let config: Record<string, unknown> = {}
  if (opts.config) {
    try {
      const parsed: unknown = JSON.parse(opts.config)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      config = parsed as Record<string, unknown>
    } catch (err) {
      log.error(`--config must be a JSON object: ${errMessage(err)}`)
      process.exit(1)
    }
  }
  const client = await getClient(opts.dev)
  try {
    const res = await client.post<{ connector?: ConnectorRow; connectorId?: string; connector_id?: string }>('/api/v1/connectors', {
      provider,
      name: opts.name,
      token: credential,
      config,
    })
    const id = res.connector?.connector_id ?? res.connector?.connectorId ?? res.connectorId ?? res.connector_id ?? '(see dashboard)'
    if (opts.json) {
      emitJson(res)
      return
    }
    log.success(`Added ${provider} source "${opts.name}" (${id}). Sync it with \`intutic guardrails sources sync ${id}\`.`)
  } catch (err) {
    log.error(`Failed to add source: ${errMessage(err)}`)
    process.exit(1)
  }
}

export async function runGuardrailsSourcesSync(connectorId: string, opts: CommonOpts): Promise<void> {
  const client = await getClient(opts.dev)
  try {
    const res = await client.post<{ processedCount?: number; updatedSopIds?: string[]; successorSopIds?: string[]; upstreamDeleted?: string[]; changedDocIds?: string[]; staleGuardrailIds?: string[] }>(
      `/api/v1/connectors/${enc(connectorId)}/sync`,
      {},
    )
    if (opts.json) {
      emitJson(res)
      return
    }
    log.success(`Synced ${connectorId}.`)
    log.field('Documents processed', String(res.processedCount ?? 0))
    log.field('Documents changed', String(res.changedDocIds?.length ?? 0))
    log.field('SOPs written', String(res.updatedSopIds?.length ?? 0))
    if (res.successorSopIds?.length) log.field('Upstream successors', String(res.successorSopIds.length))
    if (res.upstreamDeleted?.length) log.field('Upstream deleted', res.upstreamDeleted.join(', '))
    if (res.staleGuardrailIds?.length) log.warn(`${res.staleGuardrailIds.length} guardrail citation(s) went stale: ${res.staleGuardrailIds.join(', ')}`)
  } catch (err) {
    log.error(`Failed to sync source: ${errMessage(err)}`)
    process.exit(1)
  }
}

// ─── docs ───────────────────────────────────────────────────────────

export async function runGuardrailsDocsList(opts: CommonOpts): Promise<void> {
  const client = await getClient(opts.dev)
  let documents: PolicyDocumentSummary[]
  try {
    documents = (await client.get<{ documents?: PolicyDocumentSummary[] }>(`${BASE}/documents`)).documents ?? []
  } catch (err) {
    log.error(`Failed to list documents: ${errMessage(err)}`)
    process.exit(1)
  }
  if (opts.json) {
    emitJson(documents)
    return
  }
  log.header('Intutic — Policy Documents')
  if (documents.length === 0) {
    log.info('No documents yet. Sync a source first.')
    return
  }
  for (const d of documents) {
    log.field(
      d.title,
      `${d.docId} — ${d.provider}, ${d.passageCount} passage(s), ${d.clauseCount} clause(s), ${d.guardrailCount} guardrail(s)${d.injectionFlagged ? ', INJECTION-FLAGGED' : ''}${d.lastRun ? `, last extraction ${d.lastRun.extractor} at ${d.lastRun.startedAt}${d.lastRun.error ? ` (error: ${d.lastRun.error})` : ''}` : ', never extracted'}`,
    )
  }
  log.info(`${documents.length} document(s).`)
}

export async function runGuardrailsDocsShow(docId: string, opts: CommonOpts): Promise<void> {
  const client = await getClient(opts.dev)
  const { status, body } = await client.getWithStatus<{ document?: PolicyDocumentDetail; error?: string }>(`${BASE}/documents/${enc(docId)}`)
  if (status === 404) {
    log.error(`Document "${docId}" not found in this workspace.`)
    process.exit(1)
  }
  if (status !== 200 || !body.document) {
    log.error(`Failed to load document (${status}): ${body.error ?? 'unknown error'}`)
    process.exit(1)
  }
  const d = body.document
  if (opts.json) {
    emitJson(d)
    return
  }
  log.header(`Intutic — ${d.title}`)
  log.field('Document', d.docId)
  log.field('Source', `${d.provider}${d.sourceUrl ? ` ${d.sourceUrl}` : ''}`)
  log.field('Content', `${d.contentHash.slice(0, 12)}${d.upstreamVersion ? ` (upstream ${d.upstreamVersion})` : ''}`)
  log.field('Passages', String(d.passages.length))
  if (d.injectionFlagged) log.warn('This document is flagged for prompt-injection phrasing; its guardrails are created REJECTED.')
  if (d.clauses.length === 0) log.info('No clauses extracted yet. Run `intutic guardrails docs extract <docId>`.')
  for (const c of d.clauses) {
    const refused = Array.isArray(c.validation) ? (c.validation as Array<{ name: string; passed: boolean }>).filter((v) => !v.passed).map((v) => v.name) : []
    log.field(`${c.kind} [${c.status}]`, `${c.clauseId}${c.guardrailId ? ` → ${c.guardrailStatus} guardrail ${c.guardrailId}` : ''}${refused.length ? ` — refused by ${refused.join(', ')}` : ''}`)
    log.dim(`    "${c.quote}"`)
  }
  for (const r of d.runs) {
    log.dim(`  run ${r.runId}: ${r.extractor} — ${r.clausesValid} valid / ${r.clausesRejected} refused${r.error ? ` — ${r.error}` : ''}`)
  }
}

export async function runGuardrailsDocsExtract(docId: string, opts: CommonOpts & { noLlm?: boolean }): Promise<void> {
  const client = await getClient(opts.dev)
  const { status, body } = await client.postWithStatus<{ result?: ExtractDocumentResult; error?: string; cap?: { count: number; cap: number } }>(`${BASE}/documents/${enc(docId)}/extract`, { llm: !opts.noLlm })
  if (status === 404) {
    log.error(`Document "${docId}" not found in this workspace.`)
    process.exit(1)
  }
  if (status === 403) {
    log.error(body.error ?? 'Extraction needs a paid plan or an active trial.')
    process.exit(1)
  }
  if (status === 429) {
    log.warn(`Daily extraction cap reached (${body.cap?.count ?? '?'} of ${body.cap?.cap ?? '?'} calls today). The front-matter lift still ran.`)
    process.exit(1)
  }
  if (status !== 200 || !body.result) {
    log.error(`Extraction failed (${status}): ${body.error ?? 'unknown error'}`)
    process.exit(1)
  }
  const r = body.result
  if (opts.json) {
    emitJson(r)
    return
  }
  if (r.skipped === 'llm_disabled') log.info('Model call skipped (--no-llm); only the front-matter lift ran.')
  else if (r.skipped === 'no_passages') log.warn('The document has no passages to extract from.')
  else if (r.skipped === 'cap_unavailable') log.warn('The cap store was unreachable, so no model call was made.')
  else if (r.llmUnavailable) log.warn(`The model could not be reached: ${r.error ?? 'no detail'}. The run is recorded with its error.`)
  else log.success(`Extracted ${docId}: ${r.proposals} proposal(s) from ${r.chunks} chunk(s).`)
  log.field('Valid clauses', String(r.valid))
  log.field('Refused by a check', String(r.rejected))
  log.field('Malformed', String(r.malformed))
  log.field('Guardrails proposed', String(r.guardrails.proposed))
  if (r.guardrails.rejectedForInjection > 0) log.field('Rejected (injection-flagged document)', String(r.guardrails.rejectedForInjection))
  if (r.guardrails.existing > 0) log.field('Already existed', String(r.guardrails.existing))
  if (r.lifted.clauses > 0) log.field('Front-matter rules lifted', String(r.lifted.clauses))
  if (r.runId) log.dim(`  run ${r.runId}`)
}

// ─── search ─────────────────────────────────────────────────────────

export async function runGuardrailsSearch(token: string, opts: CommonOpts & { text?: boolean }): Promise<void> {
  if (opts.text) return runPassageTextSearch(token, opts)
  if (!token.trim()) {
    log.error('A tool name or action token is required, e.g. `intutic guardrails search bash`.')
    process.exit(1)
  }
  const client = await getClient(opts.dev)
  let coverage: TokenCoverage
  try {
    coverage = (await client.get<{ coverage: TokenCoverage }>(`${BASE}/coverage?token=${enc(token.trim())}`)).coverage
  } catch (err) {
    log.error(`Search failed: ${errMessage(err)}`)
    process.exit(1)
  }
  if (opts.json) {
    emitJson(coverage)
    return
  }
  log.header(`Intutic — Passages mentioning "${coverage.token}"`)
  if (coverage.passages.length === 0) {
    log.info('No passage mentions it. A guardrail naming it would have nothing to cite.')
    return
  }
  for (const p of coverage.passages) {
    log.field(p.title, `${p.headingPath.join(' › ') || '(no heading)'} — ${p.excerpt}`)
  }
  log.info(`${coverage.passages.length} passage(s); ${coverage.guardrails.length} guardrail(s) stand on them.`)
  for (const g of coverage.guardrails) log.dim(`  ${g.guardrailId} [${g.status}] ${g.target} — "${g.quote}"`)
}

/** `search --text`: the words of every live passage, stemmed, best match first. */
async function runPassageTextSearch(query: string, opts: CommonOpts): Promise<void> {
  if (!query.trim()) {
    log.error('Words to search for are required, e.g. `intutic guardrails search --text "production deploy"`.')
    process.exit(1)
  }
  const client = await getClient(opts.dev)
  let result: PassageSearchResult
  try {
    result = (await client.get<{ search: PassageSearchResult }>(`${BASE}/search?q=${enc(query.trim())}`)).search
  } catch (err) {
    log.error(`Search failed: ${errMessage(err)}`)
    process.exit(1)
  }
  if (opts.json) {
    emitJson(result)
    return
  }
  log.header(`Intutic — Passages about "${result.query}"`)
  if (result.passages.length === 0) {
    log.info('No live passage matches those words.')
    return
  }
  for (const p of result.passages) {
    log.field(p.title, `${p.headingPath.join(' › ') || '(no heading)'} — ${p.excerpt}`)
  }
  log.info(`${result.passages.length} passage(s), best match first.`)
}

// ─── impact / duplicates ────────────────────────────────────────────

export async function runGuardrailsImpact(opts: CommonOpts & { doc?: string; passage?: string }): Promise<void> {
  if (!opts.doc === !opts.passage) {
    log.error('Name exactly one of --doc <docId> or --passage <passageId>.')
    process.exit(1)
  }
  const client = await getClient(opts.dev)
  const seed = opts.doc ? `docId=${enc(opts.doc)}` : `passageId=${enc(opts.passage!)}`
  let impact: LedgerImpact
  try {
    impact = (await client.get<{ impact: LedgerImpact }>(`${BASE}/impact?${seed}`)).impact
  } catch (err) {
    log.error(`Impact failed: ${errMessage(err)}`)
    process.exit(1)
  }
  if (opts.json) {
    emitJson(impact)
    return
  }
  log.header(`Intutic — What a change to ${opts.doc ?? opts.passage} reaches`)
  log.field('Passages', `${impact.passages.length} within ${impact.maxDepth} computed edge(s)${impact.truncated ? ' (capped)' : ''}`)
  log.field('Clauses citing them', String(impact.clauses.length))
  log.field('Guardrails', String(impact.guardrails.length))
  for (const g of impact.guardrails) {
    log.dim(`  ${g.guardrailId} [${g.status}${g.sourceStale ? ', stale' : ''}] ${g.target}, ${g.depth} edge(s) from the change`)
  }
  if (impact.guardrails.some((g) => g.status === 'ENFORCING')) {
    log.warn('An enforcing guardrail stands on this text. An upstream edit marks it stale for review; it never switches enforcement off.')
  }
}

export async function runGuardrailsDuplicates(opts: CommonOpts & { minJaccard?: string }): Promise<void> {
  let query = ''
  if (opts.minJaccard !== undefined) {
    const n = Number(opts.minJaccard)
    if (opts.minJaccard.trim() === '' || !Number.isFinite(n) || n < 0 || n > 1) {
      log.error('--min-jaccard must be a number between 0 and 1.')
      process.exit(1)
    }
    query = `?minJaccard=${n}`
  }
  const client = await getClient(opts.dev)
  let d: LedgerDuplicates
  try {
    d = (await client.get<{ duplicates: LedgerDuplicates }>(`${BASE}/duplicates${query}`)).duplicates
  } catch (err) {
    log.error(`Failed to list duplicates: ${errMessage(err)}`)
    process.exit(1)
  }
  if (opts.json) {
    emitJson(d)
    return
  }
  log.header('Intutic — Duplicate passages and repeated rules')
  if (d.passagePairs.length === 0 && d.sameRule.length === 0) {
    log.info(`No passages overlap at Jaccard ${d.minJaccard.toFixed(2)} or above, and no rule is cited twice.`)
    return
  }
  for (const pp of d.passagePairs) {
    log.field(`Jaccard ${pp.jaccard.toFixed(2)}${pp.nearIdentical ? ', near-identical' : ''}`, `${pp.a.title} and ${pp.b.title} (${pp.intersection} of ${pp.union} shingles shared)`)
    log.dim(`    ${pp.a.passageId}: ${pp.a.excerpt}`)
    log.dim(`    ${pp.b.passageId}: ${pp.b.excerpt}`)
  }
  for (const r of d.sameRule) {
    log.field(`The same ${r.kind} rule`, `cited ${r.clauses.length} times`)
    for (const c of r.clauses) log.dim(`    ${c.clauseId} in ${c.title}${c.guardrailId ? ` (${c.guardrailId}, ${c.guardrailStatus})` : ''}: "${c.quote}"`)
  }
  log.info(`${d.passagePairs.length} overlapping pair(s); ${d.sameRule.length} repeated rule(s).`)
}

// ─── guardrails ─────────────────────────────────────────────────────

export async function runGuardrailsList(opts: CommonOpts & { status?: string; target?: string; provenance?: string; doc?: string; limit?: string }): Promise<void> {
  const params = new URLSearchParams()
  if (opts.status !== undefined) {
    if (!(GUARDRAIL_STATUSES as readonly string[]).includes(opts.status)) {
      log.error(`--status must be one of ${GUARDRAIL_STATUSES.join(', ')}.`)
      process.exit(1)
    }
    params.set('status', opts.status)
  }
  if (opts.target !== undefined) {
    if (!(GUARDRAIL_TARGETS as readonly string[]).includes(opts.target)) {
      log.error(`--target must be one of ${GUARDRAIL_TARGETS.join(', ')}.`)
      process.exit(1)
    }
    params.set('target', opts.target)
  }
  if (opts.provenance !== undefined) {
    if (!(GUARDRAIL_PROVENANCES as readonly string[]).includes(opts.provenance)) {
      log.error(`--provenance must be one of ${GUARDRAIL_PROVENANCES.join(', ')}.`)
      process.exit(1)
    }
    params.set('provenance', opts.provenance)
  }
  if (opts.doc) params.set('docId', opts.doc)
  if (opts.limit !== undefined) {
    const n = Number(opts.limit)
    if (!Number.isInteger(n) || n < 1) {
      log.error('--limit must be a positive integer.')
      process.exit(1)
    }
    params.set('limit', String(n))
  }
  const client = await getClient(opts.dev)
  let guardrails: GuardrailSummary[]
  try {
    const q = params.toString()
    guardrails = (await client.get<{ guardrails?: GuardrailSummary[] }>(`${BASE}/guardrails${q ? `?${q}` : ''}`)).guardrails ?? []
  } catch (err) {
    log.error(`Failed to list guardrails: ${errMessage(err)}`)
    process.exit(1)
  }
  if (opts.json) {
    emitJson(guardrails)
    return
  }
  log.header('Intutic — Policy Guardrails')
  if (guardrails.length === 0) {
    log.info(`No guardrails${opts.status ? ` with status ${opts.status}` : ''}.`)
    return
  }
  for (const g of guardrails) {
    const ir = g.ir as { kind: string; title?: string }
    const title = ir.title ?? ir.kind
    log.field(`${g.guardrailId} [${g.status}${g.sourceStale ? ', stale' : ''}]`, `${g.target} — ${title}`)
    log.dim(`    ${standsOn(g)}`)
    if (g.status === 'SHADOW') log.dim(`    shadow: ${g.shadowEvaluations} evaluation(s), ${g.shadowWouldAct} would-act`)
  }
  log.info(`${guardrails.length} guardrail(s).`)
}

/** What a guardrail stands on, in one line: its quote and document, or — authored — its name, description and version. */
function standsOn(g: GuardrailSummary): string {
  if (g.clause && g.document) return `"${g.clause.quote}" — ${g.document.title}${g.document.sourceUrl ? ` ${g.document.sourceUrl}` : ''}`
  return `authored: ${g.name ?? g.guardrailId}${g.description ? ` — "${g.description}"` : ''}, version ${g.version}`
}

function printReadiness(r: GuardrailReadiness): void {
  log.field('Ready to enforce', r.ready ? (r.neverFired ? 'yes — but no observed traffic exercised it; promote with --acknowledge-no-traffic' : 'yes') : 'no')
  log.field('Shadow evaluations', `${r.evaluations}/${r.thresholds.minShadowEvaluations}`)
  log.field('Would-act rate', `${formatRate(r.wouldActRate)} (ceiling ${(r.thresholds.maxWouldActRate * 100).toFixed(0)}%)`)
  log.field('Adjudicated fires', `${r.adjudicated}/${r.adjudicatedRequired}, FP rate ${formatRate(r.falsePositiveRate)} (ceiling ${(r.thresholds.maxAdjudicatedFalsePositiveRate * 100).toFixed(0)}%)`)
  for (const reason of r.reasons) log.dim(`    ${reason}`)
}

export async function runGuardrailsShow(guardrailId: string, opts: CommonOpts): Promise<void> {
  const client = await getClient(opts.dev)
  const { status, body } = await client.getWithStatus<{ guardrail?: GuardrailDetail; error?: string }>(`${BASE}/guardrails/${enc(guardrailId)}`)
  if (status === 404) {
    log.error(`Guardrail "${guardrailId}" not found in this workspace.`)
    process.exit(1)
  }
  if (status !== 200 || !body.guardrail) {
    log.error(`Failed to load guardrail (${status}): ${body.error ?? 'unknown error'}`)
    process.exit(1)
  }
  const g = body.guardrail
  let readiness: GuardrailReadiness | null = null
  if (g.status === 'SHADOW') {
    try {
      readiness = (await client.get<{ readiness: GuardrailReadiness }>(`${BASE}/guardrails/${enc(guardrailId)}/readiness`)).readiness
    } catch {
      readiness = null
    }
  }
  if (opts.json) {
    emitJson({ guardrail: g, readiness })
    return
  }
  const ir = g.ir as { kind: string; title?: string }
  log.header(`Intutic — ${ir.title ?? ir.kind}`)
  log.field('Guardrail', `${g.guardrailId} [${g.status}${g.sourceStale ? ', stale citation' : ''}] ${g.target}`)
  if (g.clause && g.document) {
    log.field('Cites', `"${g.clause.quote}"`)
    log.field('From', `${g.document.title} (${g.document.provider})${g.document.sourceUrl ? ` ${g.document.sourceUrl}` : ''} — passage ${g.clause.passageHash.slice(0, 12)}`)
  } else {
    log.field('Authored', `${g.name ?? g.guardrailId}, version ${g.version}${g.supersedes ? ` (replaced ${g.supersedes})` : ''}`)
    if (g.description) log.field('Description', g.description)
  }
  if (g.supersededBy) log.field('Superseded by', `${g.supersededBy} — an IR edit created the next version`)
  const rendered = g.rendered as { toolPattern?: string; argPattern?: string; reason?: string; lines?: string; source?: string; key?: string; values?: string[] }
  if (g.target === 'hook_rule' && rendered.toolPattern) {
    log.field('Tool pattern', rendered.toolPattern)
    if (rendered.argPattern) log.field('Input pattern', rendered.argPattern)
    log.field('On block', `[Intutic Governance] BLOCKED: ${rendered.reason ?? ''} [sop.guardrail.${g.guardrailId}]`)
  } else if (g.target === 'sop_front_matter' && rendered.lines) {
    log.field('Front matter', '')
    for (const line of rendered.lines.split('\n')) log.dim(`    ${line}`)
  } else if (g.target === 'wasm_rule' && rendered.source) {
    log.field('Predicate source', '')
    for (const line of rendered.source.split('\n')) log.dim(`    ${line}`)
  } else if (g.target === 'workspace_setting' && rendered.key && Array.isArray(rendered.values)) {
    // A settings-class guardrail (TD-474 item 2) is a proposed value for one workspace setting.
    log.field('Workspace setting', `${rendered.key}: ${rendered.values.join(', ')}`)
    if (rendered.key === 'egressAllow') {
      log.dim('    No shadow evidence exists for egress: `promote --acknowledge-no-traffic` adds these entries from PROPOSED, and only adds.')
      log.dim('    Entries take effect only while the workspace egress mode is monitor or enforce.')
    } else {
      log.dim('    Measured in shadow on every proxied request; promotion writes the list, narrowed by the current one.')
    }
  }
  if (g.status === 'REJECTED' && g.rejectedReason) log.field('Rejected', g.rejectedReason)
  if (readiness) printReadiness(readiness)
  const checks = Array.isArray(g.validation) ? (g.validation as Array<{ name: string; passed: boolean; detail: string }>) : []
  if (checks.length > 0) log.field('Checks', checks.map((c) => `${c.passed ? '✓' : '✗'} ${c.name}`).join('  '))
  for (const e of g.events) log.dim(`  ${e.createdAt} ${e.event}${e.actorId ? ` by ${e.actorId}` : ' (system)'}`)
}

async function transition(
  guardrailId: string,
  action: 'approve-shadow' | 'promote' | 'reject' | 'retire' | 'reconfirm',
  body: Record<string, unknown>,
  opts: CommonOpts,
  done: string,
): Promise<void> {
  const client = await getClient(opts.dev)
  const { status, body: res } = await client.postWithStatus<{ ok?: boolean; guardrail?: GuardrailDetail; readiness?: GuardrailReadiness; error?: string; code?: string }>(
    `${BASE}/guardrails/${enc(guardrailId)}/${action}`,
    body,
  )
  if (status === 404) {
    log.error(`Guardrail "${guardrailId}" not found in this workspace.`)
    process.exit(1)
  }
  if (status === 403) {
    log.error(res.error ?? 'Refused: a guardrail transition needs a signed-in member of the workspace.')
    process.exit(1)
  }
  if (status === 409) {
    log.error(res.error ?? `Refused (${res.code ?? 'conflict'}).`)
    if (res.readiness) printReadiness(res.readiness)
    process.exit(1)
  }
  if (status !== 200 || !res.guardrail) {
    log.error(`${action} failed (${status}): ${res.error ?? 'unknown error'}`)
    process.exit(1)
  }
  if (opts.json) {
    emitJson(res)
    return
  }
  log.success(`${guardrailId}: ${done}`)
  if (res.readiness) printReadiness(res.readiness)
  if (action === 'approve-shadow' && res.guardrail.target === 'wasm_rule' && res.guardrail.ruleCandidateId) {
    // A wasm guardrail is enforced by nothing this row projects: it was handed
    // to the rule-candidate pipeline, and the next step is a compile.
    log.info(`Handed off to rule candidate ${res.guardrail.ruleCandidateId}. Next: intutic policy compile --candidate ${res.guardrail.ruleCandidateId} --upload`)
  }
  const last = res.guardrail.events.at(-1)
  if (last) log.dim(`  ${last.event}${last.actorId ? ` by ${last.actorId}` : ''}`)
}

export async function runGuardrailsApproveShadow(guardrailId: string, opts: CommonOpts): Promise<void> {
  await transition(guardrailId, 'approve-shadow', {}, opts, 'now in SHADOW — distributed as warn, measuring, enforcing nothing.')
}

export async function runGuardrailsPromote(guardrailId: string, opts: CommonOpts & { acknowledgeNoTraffic?: boolean }): Promise<void> {
  await transition(guardrailId, 'promote', { acknowledgeNoTraffic: opts.acknowledgeNoTraffic === true }, opts, 'now ENFORCING.')
}

export async function runGuardrailsReject(guardrailId: string, opts: CommonOpts & { reason?: string }): Promise<void> {
  if (!opts.reason || !opts.reason.trim()) {
    log.error('--reason is required; the rejection is recorded with it.')
    process.exit(1)
  }
  await transition(guardrailId, 'reject', { reason: opts.reason.trim() }, opts, 'rejected.')
}

export async function runGuardrailsRetire(guardrailId: string, opts: CommonOpts): Promise<void> {
  await transition(guardrailId, 'retire', {}, opts, 'retired — gone from every rule endpoint on the next poll.')
}

export async function runGuardrailsReconfirm(guardrailId: string, opts: CommonOpts): Promise<void> {
  await transition(guardrailId, 'reconfirm', {}, opts, 'citation re-confirmed against a live passage.')
}

// ─── Authored guardrails ────────────────────────────────────────────
//
// A guardrail written directly instead of extracted from a document: the same
// IR, refused by the same server-side checks, created PROPOSED and moved by
// the same transitions above. The IR comes from a file (YAML or JSON: a bare
// IR, or `{ name, description, ir }`) or from flags.

export interface AuthorOpts extends CommonOpts {
  file?: string
  name?: string
  description?: string
  clearDescription?: boolean
  kind?: string
  title?: string
  tools?: string
  tokens?: string
  argContains?: string[]
  argNotContains?: string[]
  first?: string
  then?: string
  token?: string
  limit?: string
  taint?: string
  roles?: string
  models?: string
  hosts?: string
  rationale?: string
  predicate?: string
}

/** The IR flags, by the IR key each one sets. */
const IR_FLAGS = ['title', 'tools', 'tokens', 'argContains', 'argNotContains', 'first', 'then', 'token', 'limit', 'taint', 'roles', 'models', 'hosts', 'rationale', 'predicate'] as const

const list = (v: string) =>
  v
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.length > 0)

function fail(message: string): never {
  log.error(message)
  process.exit(1)
}

/** An IR from flags: `--kind` plus the keys that kind takes. The server's validator decides whether the result is a rule. */
function irFromFlags(opts: AuthorOpts): Record<string, unknown> | null {
  const given = IR_FLAGS.filter((f) => opts[f] !== undefined)
  if (opts.kind === undefined) {
    if (given.length > 0) fail(`--${given[0]!.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} needs --kind.`)
    return null
  }
  const ir: Record<string, unknown> = { kind: opts.kind }
  if (opts.title !== undefined) ir.title = opts.title
  if (opts.tools !== undefined) ir.tools = list(opts.tools)
  if (opts.tokens !== undefined) ir.tokens = list(opts.tokens)
  if (opts.argContains !== undefined) ir.argContains = opts.argContains
  if (opts.argNotContains !== undefined) ir.argNotContains = opts.argNotContains
  if (opts.first !== undefined) ir.first = opts.first
  if (opts.then !== undefined) ir.then = opts.then
  if (opts.token !== undefined) ir.token = opts.token
  if (opts.limit !== undefined) {
    const n = Number(opts.limit)
    if (!Number.isInteger(n)) fail('--limit must be an integer.')
    ir.limit = n
  }
  if (opts.taint !== undefined) ir.taint = opts.taint
  if (opts.roles !== undefined) ir.roles = list(opts.roles)
  if (opts.models !== undefined) ir.models = list(opts.models)
  if (opts.hosts !== undefined) ir.hosts = list(opts.hosts)
  if (opts.rationale !== undefined) ir.rationale = opts.rationale
  if (opts.predicate !== undefined) {
    try {
      ir.predicate = JSON.parse(opts.predicate)
    } catch (err) {
      fail(`--predicate must be JSON: ${errMessage(err)}`)
    }
  }
  // The schema pins a generated or authored predicate to re-ask; there is nothing to choose.
  if (opts.kind === 'wasm_predicate') ir.verdict = 3
  return ir
}

/** `--file`: YAML or JSON (YAML reads both). A top-level `kind` is a bare IR; otherwise `{ name?, description?, ir }`. */
async function readAuthoredFile(file: string): Promise<{ name?: unknown; description?: unknown; ir?: unknown }> {
  let parsed: unknown
  try {
    parsed = parseYaml(await readFile(file, 'utf8'))
  } catch (err) {
    fail(`Could not read ${file}: ${errMessage(err)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(`${file} must hold an object: an IR with a \`kind\`, or { name, description, ir }.`)
  const obj = parsed as Record<string, unknown>
  if ('kind' in obj) return { ir: obj }
  const extra = Object.keys(obj).filter((k) => !['name', 'description', 'ir'].includes(k))
  if (extra.length > 0) fail(`${file}: unknown key(s) ${extra.join(', ')}; a guardrail file holds name, description and ir.`)
  return obj
}

/** The fields a create or an update sends: the file first, flags over it. */
async function authoredFields(opts: AuthorOpts): Promise<Record<string, unknown>> {
  const fromFile = opts.file ? await readAuthoredFile(opts.file) : {}
  const flagIr = irFromFlags(opts)
  if (flagIr && fromFile.ir !== undefined) fail('Give the IR with --file or with --kind and its flags, not both.')
  if (opts.description !== undefined && opts.clearDescription) fail('--description and --clear-description contradict each other.')
  const body: Record<string, unknown> = {}
  const name = opts.name ?? fromFile.name
  if (name !== undefined) body.name = typeof name === 'string' ? name.trim() : name
  const description = opts.clearDescription ? null : (opts.description ?? fromFile.description)
  if (description !== undefined) body.description = description
  const ir = flagIr ?? fromFile.ir
  if (ir !== undefined) body.ir = ir
  return body
}

function zodMessage(error: { issues: Array<{ path: Array<string | number>; message: string }> }): string {
  const first = error.issues[0]
  return `${first?.path.length ? `${first.path.join('.')}: ` : ''}${first?.message ?? 'invalid'}`
}

function printChecks(checks: GuardrailCheckResult[]): void {
  for (const c of checks) log.dim(`    ${c.passed ? '✓' : '✗'} ${c.name}${c.passed ? '' : ` — ${c.detail}`}`)
}

/** The answers an authored write shares: 400 with the refusing check, 403, 404, 409 with a code. */
function reportWriteFailure(status: number, body: { error?: string; code?: string; validation?: GuardrailCheckResult[] }, guardrailId: string | null, action: string): never {
  if (status === 400) {
    log.error(body.error ?? `${action} refused (400).`)
    if (body.validation) printChecks(body.validation)
    process.exit(1)
  }
  if (status === 404 && guardrailId) fail(`Guardrail "${guardrailId}" not found in this workspace.`)
  if (status === 403) fail(body.error ?? 'Refused: authoring guardrails needs an OWNER or ADMIN member of the workspace.')
  if (status === 409) fail(body.error ?? `Refused (${body.code ?? 'conflict'}).`)
  fail(`${action} failed (${status}): ${body.error ?? 'unknown error'}`)
}

export async function runGuardrailsCreate(opts: AuthorOpts): Promise<void> {
  const body = await authoredFields(opts)
  if (body.ir === undefined) fail('Give the IR with --file <path> or with --kind and its flags.')
  const parsed = AuthoredGuardrailCreateSchema.safeParse(body)
  if (!parsed.success) fail(`Not a guardrail the server would accept: ${zodMessage(parsed.error)}`)
  const client = await getClient(opts.dev)
  const { status, body: res } = await client.postWithStatus<Partial<AuthoredGuardrailWriteResult> & { error?: string; code?: string; validation?: GuardrailCheckResult[] }>(`${BASE}/guardrails`, parsed.data)
  if (status !== 201 || !res.guardrail) reportWriteFailure(status, res, null, 'Create')
  const g = res.guardrail
  if (opts.json) {
    emitJson(res)
    return
  }
  log.success(`Created ${g.guardrailId} (${g.target}), PROPOSED: it enforces and measures nothing yet.`)
  log.info(`Next: intutic guardrails approve-shadow ${g.guardrailId} — then promotion waits on shadow evidence, as for an extracted guardrail.`)
}

export async function runGuardrailsUpdate(guardrailId: string, opts: AuthorOpts): Promise<void> {
  const body = await authoredFields(opts)
  if (Object.keys(body).length === 0) fail('Nothing to update: give --name, --description, --clear-description, --file or --kind with its flags.')
  const parsed = AuthoredGuardrailUpdateSchema.safeParse(body)
  if (!parsed.success) fail(`Not an update the server would accept: ${zodMessage(parsed.error)}`)
  const client = await getClient(opts.dev)
  const { status, body: res } = await client.putWithStatus<Partial<AuthoredGuardrailWriteResult> & { error?: string; code?: string; validation?: GuardrailCheckResult[] }>(`${BASE}/guardrails/${enc(guardrailId)}`, parsed.data)
  if (status !== 200 || !res.guardrail) reportWriteFailure(status, res, guardrailId, 'Update')
  const g = res.guardrail
  if (opts.json) {
    emitJson(res)
    return
  }
  if (res.forked) {
    log.success(`The IR changed: version ${g.version} is ${g.guardrailId}, PROPOSED with no evidence. ${guardrailId} is retired.`)
    log.info(`Shadow evidence belongs to the rule that earned it. Next: intutic guardrails approve-shadow ${g.guardrailId}`)
  } else {
    log.success(`${guardrailId}: updated in place (${g.status}); its evidence stands.`)
  }
}

export async function runGuardrailsDelete(guardrailId: string, opts: CommonOpts): Promise<void> {
  const client = await getClient(opts.dev)
  const { status, body: res } = await client.delWithStatus<{ ok?: boolean; guardrail?: GuardrailDetail; error?: string; code?: string }>(`${BASE}/guardrails/${enc(guardrailId)}`)
  if (status !== 200 || !res.guardrail) reportWriteFailure(status, res, guardrailId, 'Delete')
  if (opts.json) {
    emitJson(res)
    return
  }
  log.success(`${guardrailId}: retired — gone from every rule endpoint on the next poll. Its history is kept.`)
}

const REPLAY_SOURCE_LABEL: Record<GuardrailReplay['source'], string> = {
  enforcement_log: 'hook-gate and proxy verdicts with a captured input',
  context_snapshots: 'sampled request contexts',
  execution_traces: 'requests through the proxy, by model',
  none: 'nothing captured can answer this',
}

export async function runGuardrailsReplay(guardrailId: string, opts: CommonOpts): Promise<void> {
  const client = await getClient(opts.dev)
  const { status, body } = await client.postWithStatus<{ replay?: GuardrailReplay; error?: string }>(`${BASE}/guardrails/${enc(guardrailId)}/replay`, {})
  if (status === 404) {
    log.error(`Guardrail "${guardrailId}" not found in this workspace, or it has no replay (WASM candidates replay through \`intutic policy replay\`).`)
    process.exit(1)
  }
  if (status !== 200 || !body.replay) {
    log.error(`Replay failed (${status}): ${body.error ?? 'unknown error'}`)
    process.exit(1)
  }
  const r = body.replay
  if (opts.json) {
    emitJson(r)
    return
  }
  log.header(`Intutic — Replay ${guardrailId}`)
  log.field('Would have fired', `${r.fires} of ${r.captured} captured call(s)`)
  log.field('Source', `${REPLAY_SOURCE_LABEL[r.source]}, last ${r.windowDays} day(s)${r.truncated ? ', capped' : ''}`)
  if (r.unsupported.length > 0) log.warn(`Cannot be replayed: ${r.unsupported.join(', ')}`)
  for (const s of r.sample) log.dim(`  ${s.at} ${s.toolName}: ${s.excerpt}`)
}

export async function runGuardrailsConflicts(opts: CommonOpts): Promise<void> {
  const client = await getClient(opts.dev)
  let conflicts: GuardrailConflict[]
  try {
    conflicts = (await client.get<{ conflicts?: GuardrailConflict[] }>(`${BASE}/conflicts`)).conflicts ?? []
  } catch (err) {
    log.error(`Failed to detect conflicts: ${errMessage(err)}`)
    process.exit(1)
  }
  if (opts.json) {
    emitJson(conflicts)
    return
  }
  log.header('Intutic — Guardrail Conflicts')
  if (conflicts.length === 0) {
    log.info('No two live guardrails or lifted front-matter rules contradict each other.')
    return
  }
  for (const c of conflicts) {
    log.field(c.kind, `${c.token ?? ''} — ${c.detail}`)
    log.dim(`    ${c.a.id}: "${c.a.quote}"`)
    log.dim(`    ${c.b.id}: "${c.b.quote}"`)
  }
  log.info(`${conflicts.length} conflict(s).`)
}

// ─── The file plane (Wave 9) ─────────────────────────────────────────

interface ServedSop {
  title: string
  markdownContent: string
  scope?: string
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

/**
 * `intutic guardrails pull` — the SHADOW and ENFORCING front-matter
 * guardrails `GET /api/v1/workspace/sops-policy` serves, written to
 * `.intutic/sops/guardrail-<id>.md` for a proxy that reads SOPs from disk.
 *
 * Flat, not in a subdirectory: the proxy's loader reads one directory level
 * and titles each SOP by its file stem, and `guardrail-<id>` is a stem the
 * control plane credits shadow reports to. The served markdown already
 * carries its own front-matter fence with the enforcing keys and
 * `mode: shadow`; `withContentHash` puts the pull marker inside that fence
 * rather than wrapping a second one the proxy would never read.
 *
 * Same overwrite rule as `intutic sops pull`: a file whose recorded hash no
 * longer matches its body was edited by hand and is left alone without
 * `--force`. A file for a guardrail that is no longer served (retired or
 * rejected) is reported — a proxy reading the directory still enforces it —
 * and removed only with `--prune`, and only when it is unmodified.
 */
export async function runGuardrailsPull(opts: CommonOpts & { force?: boolean; prune?: boolean }): Promise<void> {
  const config = loadConfig()
  const workspaceRoot = config?.workspaceRoot ?? process.cwd()
  const sopsDir = join(workspaceRoot, '.intutic', 'sops')
  const say = (level: 'info' | 'warn', message: string) => {
    if (opts.json) return
    if (level === 'warn') log.warn(message)
    else log.info(message)
  }
  if (!opts.json) log.header('Intutic — Pull Guardrails')

  const client = await getClient(opts.dev)
  let served: ServedSop[]
  try {
    served = (await client.get<{ sops?: ServedSop[] }>('/api/v1/workspace/sops-policy')).sops ?? []
  } catch (err) {
    log.error(`Failed to fetch the workspace SOP policy: ${errMessage(err)}`)
    process.exit(1)
  }
  const guardrails = served
    .map((entry) => ({ id: guardrailIdFromSopTitle(entry.title), entry }))
    .filter((x): x is { id: string; entry: ServedSop } => x.id !== null && typeof x.entry.markdownContent === 'string' && x.entry.markdownContent.trim().length > 0)

  await mkdir(sopsDir, { recursive: true })
  const written: string[] = []
  const unchanged: string[] = []
  const skipped: string[] = []
  const servedStems = new Set<string>()
  for (const { id, entry } of guardrails) {
    const stem = guardrailFileStem(id)
    servedStems.add(stem)
    const filePath = join(sopsDir, `${stem}.md`)
    const rendered = withContentHash(`${entry.markdownContent.trim()}\n`)
    const existing = await readFile(filePath, 'utf-8').catch(() => null)
    if (existing !== null) {
      if (existing === rendered) {
        unchanged.push(stem)
        continue
      }
      if (!opts.force) {
        const parsedExisting = parseSopFile(existing)
        const dirty = parsedExisting.contentHash === null || parsedExisting.contentHash !== sha256(parsedExisting.body)
        if (dirty) {
          say('warn', `${filePath}: locally modified (or not written by pull) — refusing to overwrite. Use --force to pull anyway.`)
          skipped.push(stem)
          continue
        }
      }
    }
    await writeFile(filePath, rendered, 'utf-8')
    written.push(stem)
    say('info', `${filePath} ← ${entry.title}`)
  }

  // Files this command wrote for guardrails the server no longer serves.
  const onDisk = (await readdir(sopsDir).catch(() => [] as string[])).filter((f) => /^guardrail-.+\.md$/.test(f))
  const pruned: string[] = []
  const stale: string[] = []
  for (const file of onDisk) {
    const stem = file.replace(/\.md$/, '')
    if (servedStems.has(stem)) continue
    const filePath = join(sopsDir, file)
    if (!opts.prune) {
      say('warn', `${filePath}: no longer served (retired or rejected) — a proxy reading this directory still enforces it. Re-run with --prune to remove it.`)
      stale.push(stem)
      continue
    }
    const existing = await readFile(filePath, 'utf-8').catch(() => null)
    const parsed = existing !== null ? parseSopFile(existing) : null
    const clean = parsed !== null && parsed.contentHash !== null && parsed.contentHash === sha256(parsed.body)
    if (!clean) {
      say('warn', `${filePath}: no longer served but locally modified — left in place; remove it by hand.`)
      stale.push(stem)
      continue
    }
    await unlink(filePath)
    pruned.push(stem)
    say('info', `${filePath}: removed (no longer served)`)
  }

  if (opts.json) {
    emitJson({ sopsDir, written, unchanged, skipped, pruned, stale })
    return
  }
  if (guardrails.length === 0) log.info('No SHADOW or ENFORCING front-matter guardrails are served for this workspace.')
  log.info(`${written.length} written, ${unchanged.length} unchanged, ${skipped.length} left untouched, ${pruned.length} pruned, ${stale.length} stale — in ${sopsDir}.`)
  if (skipped.length > 0) log.info('Re-run with --force to overwrite locally-modified guardrail files.')
  log.dim('A proxy that reads .intutic/sops from disk (standalone, or INTUTIC_SOPS_DIR) enforces these within 30 s. A gateway-mode proxy reads the served projection directly and ignores this directory.')
}
