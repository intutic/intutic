/**
 * `intutic integrity` — check that sealed trace roots still re-derive.
 *
 * Subcommands:
 *   - `intutic integrity roots [--loop-run <id>] [--json]`
 *   - `intutic integrity verify <root_id> [--json]`
 *   - `intutic integrity chain [--json]`
 *   - `intutic integrity config-chain [--json]`
 *
 * The exit status is the point. This is what a customer puts in CI, so the
 * findings that mean "the record no longer matches what was sealed" — a
 * re-derivation mismatch, a covered trace that is gone, a signature a published
 * key rejects, a break in the root chain, a break or an edited body in the
 * config snapshot chain — leave with 1. Everything else leaves with 0,
 * including the states that look alarming and are not: a root sealed under a
 * key that is no longer published, and a root or snapshot that names no
 * predecessor. See `failsIntegrity`.
 *
 * Server side: services/control-plane/src/routes/integrity.ts.
 *
 * @module
 */

import { createPublicKey, verify as nodeVerify, type JsonWebKey } from 'node:crypto'
import { log } from '../lib/logger.js'
import { loadCredentials } from '../config/store.js'
import { resolveControlPlaneUrl } from '../config/paths.js'
import { createApiClient } from '../lib/api.js'
import pc from 'picocolors'

// ─── Types (mirror routes/integrity.ts) ─────────────────────────────

/** A row of `GET /api/v1/integrity/roots`. Snake_case: these are DB columns. */
export interface SealedRootRow {
  root_id: string
  loop_run_id: string | null
  leaf_schema_version: number
  merkle_root: string
  leaf_count: number
  first_trace_at: string
  last_trace_at: string
  signature_alg: string | null
  signing_key_id: string | null
  sealed_at: string
}

/** The extra columns `GET /api/v1/integrity/roots/:rootId` adds — it selects `*`. */
export interface SignedRootRow {
  workspace_id: string
  loop_run_id: string | null
  leaf_schema_version: number
  merkle_root: string
  signature_alg: string | null
  signature: string | null
  signing_key_id: string | null
  /** The chain link. In the signed bytes from preimage v2 on. */
  previous_root: string | null
  /**
   * Which preimage the signature covers — `trace_merkle_roots.signing_preimage_version`
   * (migration 113). Optional on the wire, and absent means 1: a control plane
   * older than 113 does not serve the column and cannot have sealed anything but
   * v1. Present and unrecognised is a different thing entirely and is reported
   * as unverifiable.
   */
  signing_preimage_version?: number
}

/** The version to rebuild a root's preimage under. See the field's note above. */
function preimageVersionOf(root: SignedRootRow): number {
  return root.signing_preimage_version ?? 1
}

/**
 * Domain tag per preimage version, mirroring `SIGN_DOMAIN` in
 * services/control-plane/src/lib/rootSigner.ts. This map is also the list of
 * versions this build can rebuild — kept as one thing rather than two, because
 * two lists of the same fact drift and the drift is silent.
 */
const SIGN_DOMAIN: Readonly<Record<number, string>> = {
  1: 'intutic.merkle-root.v1',
  2: 'intutic.merkle-root.v2',
}

export type RecomputeVerdict = 'match' | 'mismatch' | 'missing_traces'

interface RootListResponse {
  ok: boolean
  data: SealedRootRow[]
  leafSchemaVersion: number
}

interface RootDetailResponse {
  ok: boolean
  root: SealedRootRow & SignedRootRow
  leaves: Array<{ trace_id: string; leaf_index: number; leaf_hash: string }>
}

interface RecomputeResponse {
  ok: boolean
  verdict: RecomputeVerdict
  storedRoot: string
  recomputedRoot: string | null
  changedTraceIds: string[]
  missingTraceIds: string[]
}

interface ChainBreak {
  rootId: string
  namedPrevious: string
  precedingRootId: string
  precedingMerkleRoot: string
}

interface ChainResponse {
  ok: boolean
  workspaceId: string
  rootsWalked: number
  rootsNotWalked: number
  unchainedRootIds: string[]
  breaks: ChainBreak[]
  intact: boolean
}

/**
 * A config snapshot that names a predecessor which is not the snapshot before
 * it — mirrors `ConfigChainBreak` in
 * services/control-plane/src/services/harnessConfigService.ts.
 */
interface ConfigChainBreak {
  snapshotId: string
  harnessType: string
  filePath: string
  namedPrevious: string
  precedingSnapshotId: string
  precedingContentHash: string
}

/** A snapshot whose stored `content_hash` is not the hash of its stored body. */
interface ConfigContentMismatch {
  snapshotId: string
  harnessType: string
  filePath: string
  storedHash: string
  recomputedHash: string
}

interface ConfigChainResponse {
  ok: boolean
  workspaceId: string
  harnessType: string | null
  snapshotsWalked: number
  /**
   * Saturates at 1 — the server fetches one row past the window to detect an
   * overflow, not to measure it. Read as a flag here, never printed as a count.
   */
  snapshotsNotWalked: number
  unchainedSnapshotIds: string[]
  breaks: ConfigChainBreak[]
  contentMismatches: ConfigContentMismatch[]
  intact: boolean
}

/** The published verification keys, one per `kid`. */
export interface SigningJwks {
  keys: Array<Record<string, unknown>>
}

/**
 * What we were able to establish about a root's signature.
 *
 * Five states rather than a boolean, because three of them are "no verdict" for
 * three different reasons and an operator has to act differently on each.
 */
export type SignatureState =
  /** No key was configured when this root was sealed. A supported deployment. */
  | 'unsigned'
  /** A published key accepted the signature. */
  | 'valid'
  /** A published key rejected it. */
  | 'invalid'
  /**
   * Nothing settles it: the `kid` is not published, or the root names a
   * `signing_preimage_version` this build cannot rebuild.
   */
  | 'unverifiable'
  /** The JWKS could not be fetched, so no signature was checked at all. */
  | 'keys_unavailable'

// ─── The guard ──────────────────────────────────────────────────────

export type IntegrityFinding =
  | { kind: 'recompute'; verdict: RecomputeVerdict }
  | { kind: 'signature'; state: SignatureState }
  | { kind: 'chain'; breaks: number }
  | { kind: 'configChain'; breaks: number; contentMismatches: number }

/**
 * Whether a finding should fail the command, and therefore the customer's CI.
 *
 * `unverifiable` deliberately does not. A root whose `signing_key_id` is not in
 * the published JWKS says the operator dropped a rotated-out key from
 * `TRACE_SIGNING_RETIRED_KEYS`; a root whose `signing_preimage_version` this
 * build does not know says the CLI is older than the control plane. Neither
 * says anything is wrong with the root. Failing on either accuses them of
 * rewriting history over a key-management gap or a version skew, which is the
 * distinction rootSigner.ts exists to preserve.
 *
 * `keys_unavailable` does not either — a control plane we could not reach for
 * the JWKS is a fact about the network, not about the root.
 *
 * A chain finding reads `breaks` and never `unchainedRootIds`: an unchained
 * root claimed no predecessor, so it contradicts nothing. It is also what a
 * pre-migration-108 writer produces during a rolling deploy, so failing on it
 * would make every deploy red.
 *
 * `configChain` fails on either of its two findings, and they are carried as
 * two counts rather than one total because they have different causes: a break
 * means a snapshot beside this one went missing, a content mismatch means this
 * snapshot's own body was rewritten under its stored hash. Both contradict a
 * claim the writer made, so both are failures — but a caller that had only a
 * sum could not tell an operator which happened.
 */
export function failsIntegrity(finding: IntegrityFinding): boolean {
  switch (finding.kind) {
    case 'recompute':
      return finding.verdict !== 'match'
    case 'signature':
      return finding.state === 'invalid'
    case 'chain':
      return finding.breaks > 0
    case 'configChain':
      return finding.breaks > 0 || finding.contentMismatches > 0
  }
}

// ─── Signature verification ─────────────────────────────────────────

/**
 * The exact bytes the control plane signs, per preimage version.
 *
 * Must stay byte-identical to `signingPreimage` in
 * services/control-plane/src/lib/rootSigner.ts — this is an independent
 * verifier, so it rebuilds the preimage rather than being handed it. The scope
 * fields are in the preimage because a signature over the bare 32-byte root
 * would be portable to another workspace's row.
 *
 * v1 is the encoding of migration 107 and is retained verbatim: roots sealed
 * under it are still in the ledger, and rebuilding them any other way reports a
 * forgery on rows nobody touched. v2 adds `previous_root` behind a presence
 * tag, because without it the chain link that makes root deletion detectable
 * sat outside the signature and could be rewritten freely.
 *
 * The version comes off the root itself and is never a parameter. A caller that
 * could pass one is a caller that can pass the wrong one, and the wrong one
 * produces `invalid` — the verdict that accuses an operator of forgery.
 */
export function signingPreimage(root: SignedRootRow): string {
  const US = '\x1f'
  const version = preimageVersionOf(root)
  const domain = SIGN_DOMAIN[version]
  if (domain === undefined) {
    // Unreachable from `verifyRootSignature`, which reports an unknown version
    // as unverifiable before it gets here. It throws rather than falling back
    // to the newest encoding because a fallback would confidently produce bytes
    // that were never signed, and the key would then say "forged".
    throw new RangeError(`integrity: unknown signing preimage version ${version}`)
  }
  const fields = [
    domain,
    root.workspace_id,
    root.loop_run_id ?? '',
    String(root.leaf_schema_version),
    root.merkle_root,
  ]
  if (version >= 2) {
    // Presence tag then value, matching rootSigner.ts. "No predecessor" is a
    // claim about the chain, not a missing field, so it must not encode the
    // same as some value could.
    //
    // Normalised through `?? null` rather than compared against `null` directly:
    // this row is parsed from JSON, and a server that omits the key rather than
    // serialising a null would otherwise be tagged present-with-empty-value here
    // while the control plane and the dashboard both tag it absent. Two of our
    // own verifiers disagreeing on one root is how an auditor gets handed a
    // forgery verdict we manufactured.
    const previous = root.previous_root ?? null
    fields.push(previous === null ? '0' : '1', previous ?? '')
  }
  return fields.join(US)
}

/**
 * Check a root's signature against the key the root itself names.
 *
 * Selection is by `signing_key_id`, never "any key that works": a root sealed
 * under a rotated-out key must verify against that key years later, and a root
 * that verifies under some *other* published key is not the same claim.
 */
export function verifyRootSignature(root: SignedRootRow, jwks: SigningJwks | null): SignatureState {
  if (!root.signature || !root.signing_key_id) return 'unsigned'
  if (!jwks) return 'keys_unavailable'

  const jwk = jwks.keys.find((k) => k['kid'] === root.signing_key_id)
  if (!jwk) return 'unverifiable'
  // An algorithm this build cannot compute is another "no verdict", not a
  // rejection. Only EdDSA is ever written today (rootSigner.ts signs nothing
  // else), so this is the forward-compatible branch.
  if (root.signature_alg !== 'EdDSA') return 'unverifiable'
  // And exactly the same for a preimage this build cannot rebuild. A newer
  // control plane sealing under v3 while a customer's CI still runs last
  // quarter's CLI is the ordinary case. Whatever bytes we produced for it would
  // not be the bytes that were signed, so we would either print INVALID and
  // exit 1 over a version skew, or — worse — reconstruct something that happens
  // to match and report `valid` for a check we did not actually perform.
  // Nothing here settles it either way, which is what `unverifiable` means.
  if (SIGN_DOMAIN[preimageVersionOf(root)] === undefined) return 'unverifiable'

  try {
    const key = createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' })
    const ok = nodeVerify(
      null,
      Buffer.from(signingPreimage(root), 'utf8'),
      key,
      Buffer.from(root.signature, 'base64'),
    )
    return ok ? 'valid' : 'invalid'
  } catch {
    // A published key we cannot load is a key we do not effectively hold. That
    // is the unverifiable case, not a rejection by a key we do hold.
    return 'unverifiable'
  }
}

/** Where the verification keys are published. Unauthenticated by design. */
const JWKS_PATH = '/.well-known/intutic-trace-signing.json'

/**
 * Fetch the published verification keys, or null when they cannot be had.
 *
 * No credentials: an auditor who must hold your API key to obtain the verifying
 * key is not an external auditor, and this command must exercise the same path
 * one of them would.
 */
async function fetchSigningKeys(controlPlaneUrl: string): Promise<SigningJwks | null> {
  try {
    const res = await fetch(`${controlPlaneUrl}${JWKS_PATH}`)
    if (!res.ok) return null
    const body = (await res.json()) as SigningJwks
    return Array.isArray(body?.keys) ? body : null
  } catch {
    return null
  }
}

// ─── Formatting helpers ─────────────────────────────────────────────

/** Truncate an id for table display. */
function truncateId(id: string): string {
  if (id.length <= 20) return id
  return id.slice(0, 17) + '...'
}

/** Format ISO timestamp for compact table display. */
function formatTimestamp(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  const pad2 = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** Pad a string to a fixed width (right-pad with spaces). */
/**
 * ANSI escapes are zero-width. Measuring and slicing raw string length counts
 * them, so a coloured cell is both mis-padded and cut mid-escape.
 *
 * `pc.yellow('unverifiable')` is 22 characters of which 12 are visible. Against
 * a 13-wide column the old `slice(0, width)` cut after `ESC[33munver`, leaving a
 * truncated word and an unterminated escape sequence that bleeds colour into
 * everything after it. It looked fine locally only because picocolors disables
 * colour when stdout is not a TTY — so the bug was invisible in a pipe and
 * present in every real terminal.
 */
const ANSI = /\u001b\[[0-9;]*m/g

function visibleLength(str: string): number {
  return str.replace(ANSI, '').length
}

/** Cut to `width` VISIBLE characters, keeping escapes and closing any left open. */
function truncateVisible(str: string, width: number): string {
  let out = ''
  let seen = 0
  let i = 0
  let coloured = false
  while (i < str.length && seen < width) {
    ANSI.lastIndex = i
    const m = ANSI.exec(str)
    if (m && m.index === i) {
      out += m[0]
      coloured = m[0] !== '\u001b[39m' && m[0] !== '\u001b[0m'
      i += m[0].length
      continue
    }
    out += str[i]
    seen += 1
    i += 1
  }
  // Never leave a colour open — it would tint the border and every later row.
  return coloured ? out + '\u001b[0m' : out
}

export function padCell(str: string, width: number): string {
  const visible = visibleLength(str)
  if (visible >= width) return truncateVisible(str, width)
  return str + ' '.repeat(width - visible)
}

/** Render a simple table with borders. */
function renderTable(headers: string[], widths: number[], rows: string[][]): void {
  const top = '┌' + widths.map((w) => '─'.repeat(w + 2)).join('┬') + '┐'
  const mid = '├' + widths.map((w) => '─'.repeat(w + 2)).join('┼') + '┤'
  const bot = '└' + widths.map((w) => '─'.repeat(w + 2)).join('┴') + '┘'

  const fmtRow = (cells: string[]) =>
    '│ ' + cells.map((c, i) => padCell(c, widths[i])).join(' │ ') + ' │'

  console.log(top)
  console.log(fmtRow(headers))
  console.log(mid)
  for (const row of rows) {
    console.log(fmtRow(row))
  }
  console.log(bot)
}

/**
 * All the listing can establish about a root's key, which is not verification.
 *
 * `GET /roots` does not carry the signature itself, only `signing_key_id`. So
 * the strongest true statement about a listed root is whether the key it names
 * is published — which is exactly the difference between a root that could be
 * checked by an auditor and one that could not.
 */
export type KeyPublication = 'unsigned' | 'published' | 'not_published' | 'keys_unavailable'

export function keyPublication(
  row: Pick<SealedRootRow, 'signing_key_id'>,
  jwks: SigningJwks | null,
): KeyPublication {
  if (!row.signing_key_id) return 'unsigned'
  if (!jwks) return 'keys_unavailable'
  return jwks.keys.some((k) => k['kid'] === row.signing_key_id) ? 'published' : 'not_published'
}

/** Colour a key-publication state for the listing. */
function colorPublication(state: KeyPublication): string {
  switch (state) {
    case 'published':
      return pc.cyan('key published')
    case 'not_published':
      return pc.yellow('unverifiable')
    case 'keys_unavailable':
      return pc.yellow('keys unread')
    case 'unsigned':
      return pc.dim('unsigned')
  }
}

/** Colour a signature state. Amber for "no verdict", red only for a rejection. */
function colorSignature(state: SignatureState): string {
  switch (state) {
    case 'valid':
      return pc.green('valid')
    case 'invalid':
      return pc.red('INVALID')
    case 'unverifiable':
      return pc.yellow('unverifiable')
    case 'keys_unavailable':
      return pc.yellow('not checked')
    case 'unsigned':
      return pc.dim('unsigned')
  }
}

/** What each signature state means, and what the operator does about it. */
function signatureNote(state: SignatureState, controlPlaneUrl: string): string {
  switch (state) {
    case 'valid':
      return 'Signed by a key this deployment publishes. That proves the root came from this deployment — not that its history is true, since the same party holds the key.'
    case 'invalid':
      return 'The key this root names REJECTED its signature. The root does not say what it was sealed saying.'
    case 'unverifiable':
      return `Nothing here settles this either way: either the key id it was sealed under is not published at ${controlPlaneUrl}${JWKS_PATH} — put the rotated-out PEM back into TRACE_SIGNING_RETIRED_KEYS — or the root records a signing preimage version this CLI cannot rebuild, in which case upgrade the CLI.`
    case 'keys_unavailable':
      return `Could not read ${controlPlaneUrl}${JWKS_PATH}, so the signature was not checked.`
    case 'unsigned':
      return 'Sealed with no signing key configured. Supported — the root still re-derives; it just cannot be attributed to this deployment by a third party.'
  }
}

/** Cap a long id list so a mismatch over 4,000 traces stays readable. */
function sampleIds(ids: string[], limit = 10): string {
  if (ids.length <= limit) return ids.join(', ')
  return `${ids.slice(0, limit).join(', ')} … and ${ids.length - limit} more`
}

const NOT_AUTHENTICATED =
  'Not authenticated. This command needs an Intutic control plane, which open core does not include. To run the proxy without one: `intutic start`.'

interface IntegrityCliOpts {
  json?: boolean
  dev?: boolean
}

// ─── Commands ───────────────────────────────────────────────────────

/**
 * `intutic integrity roots` — the sealed roots for the workspace, newest first.
 */
export async function runIntegrityRoots(
  opts: IntegrityCliOpts & { loopRun?: string },
): Promise<void> {
  const creds = await loadCredentials()
  if (!creds) {
    log.error(NOT_AUTHENTICATED)
    process.exit(1)
  }

  const controlPlaneUrl = resolveControlPlaneUrl(opts.dev)
  const client = createApiClient(controlPlaneUrl, creds.apiKey)

  try {
    const query = opts.loopRun ? `?loopRunId=${encodeURIComponent(opts.loopRun)}` : ''
    const data = await client.get<RootListResponse>(`/api/v1/integrity/roots${query}`)
    const roots = data.data ?? []

    if (opts.json) {
      console.log(JSON.stringify(data, null, 2))
      return
    }

    log.header('Intutic — Sealed Trace Roots')

    if (roots.length === 0) {
      log.dim('  No roots sealed yet.')
      log.dim(
        '  An hourly sweep seals a loop run once it is terminal and has been quiet for',
      )
      log.dim(
        '  fifteen minutes. Until then its traces are recorded but under no root.',
      )
      return
    }

    // Fetched once for the whole listing. Without it the signature column could
    // only report presence, and "signed" would be indistinguishable from
    // "signed by a key nobody can obtain".
    const jwks = await fetchSigningKeys(controlPlaneUrl)

    const headers = ['Root ID', 'Sealed', 'Loop Run', 'Traces', 'Leaf v', 'Signature']
    const widths = [20, 16, 20, 6, 6, 13]
    const rows = roots.map((r) => [
      truncateId(r.root_id),
      formatTimestamp(r.sealed_at),
      r.loop_run_id ? truncateId(r.loop_run_id) : '—',
      String(r.leaf_count),
      `v${r.leaf_schema_version}`,
      // The list endpoint does not carry the signature itself, so this column
      // reports key publication and nothing more. `verify` checks the bytes.
      colorPublication(keyPublication(r, jwks)),
    ])

    renderTable(headers, widths, rows)
    console.log(
      pc.dim(
        `Showing ${roots.length} root${roots.length === 1 ? '' : 's'}. The Signature column reports whether the sealing key is published,\n` +
          'not whether the signature verifies — `intutic integrity verify <root_id>` checks the bytes.',
      ),
    )
  } catch (err) {
    log.error(`Failed to list roots: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

/**
 * `intutic integrity verify <root_id>` — re-derive one root from the live rows
 * and check its signature.
 *
 * Exits 1 on a mismatch, on missing traces, or on a signature a published key
 * rejects.
 */
export async function runIntegrityVerify(
  rootId: string,
  opts: IntegrityCliOpts,
): Promise<void> {
  const creds = await loadCredentials()
  if (!creds) {
    log.error(NOT_AUTHENTICATED)
    process.exit(1)
  }

  const controlPlaneUrl = resolveControlPlaneUrl(opts.dev)
  const client = createApiClient(controlPlaneUrl, creds.apiKey)
  const encoded = encodeURIComponent(rootId)

  let detail: RootDetailResponse
  let recompute: RecomputeResponse
  try {
    detail = await client.get<RootDetailResponse>(`/api/v1/integrity/roots/${encoded}`)
    // Always 200, whatever the verdict: a mismatch is a successful check that
    // found something, and an HTTP error here would be retried and then ignored.
    recompute = await client.post<RecomputeResponse>(
      `/api/v1/integrity/roots/${encoded}/recompute`,
      {},
    )
  } catch (err) {
    log.error(`Failed to verify root: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  const signature = verifyRootSignature(detail.root, await fetchSigningKeys(controlPlaneUrl))
  const findings: IntegrityFinding[] = [
    { kind: 'recompute', verdict: recompute.verdict },
    { kind: 'signature', state: signature },
  ]
  const failed = findings.some(failsIntegrity)

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          rootId,
          verdict: recompute.verdict,
          storedRoot: recompute.storedRoot,
          recomputedRoot: recompute.recomputedRoot,
          changedTraceIds: recompute.changedTraceIds,
          missingTraceIds: recompute.missingTraceIds,
          signature,
          leafSchemaVersion: detail.root.leaf_schema_version,
          leafCount: detail.root.leaf_count,
          failed,
        },
        null,
        2,
      ),
    )
  } else {
    log.header('Intutic — Root Verification')
    log.field('Root ID', detail.root.root_id)
    log.field('Loop run', detail.root.loop_run_id ?? '— (not scoped to a run)')
    log.field('Sealed', formatTimestamp(detail.root.sealed_at))
    log.field('Traces covered', `${detail.leaves.length} of ${detail.root.leaf_count} enumerated`)
    log.field('Leaf schema', `v${detail.root.leaf_schema_version}`)
    console.log('')

    switch (recompute.verdict) {
      case 'match':
        log.success('Re-derivation: match — every covered trace still hashes to what was sealed.')
        break
      case 'mismatch':
        log.error(`Re-derivation: MISMATCH — ${recompute.changedTraceIds.length} trace(s) changed after sealing.`)
        log.field('Changed', sampleIds(recompute.changedTraceIds))
        log.field('Sealed root', recompute.storedRoot)
        log.field('Re-derived', recompute.recomputedRoot ?? '—')
        break
      case 'missing_traces':
        log.error(`Re-derivation: MISSING TRACES — ${recompute.missingTraceIds.length} covered trace(s) are gone.`)
        log.field('Missing', sampleIds(recompute.missingTraceIds))
        break
    }

    console.log('')
    console.log(`  ${pc.dim('Signature:')} ${colorSignature(signature)}`)
    log.dim(`  ${signatureNote(signature, controlPlaneUrl)}`)
  }

  if (failed) process.exit(1)
}

/**
 * `intutic integrity chain` — walk the `previous_root` chain.
 *
 * Exits 1 on a break. Re-derivation cannot see a root that was deleted outright
 * — the survivors all verify perfectly — so this walk is the only check that
 * notices one is missing.
 */
export async function runIntegrityChain(opts: IntegrityCliOpts): Promise<void> {
  const creds = await loadCredentials()
  if (!creds) {
    log.error(NOT_AUTHENTICATED)
    process.exit(1)
  }

  const controlPlaneUrl = resolveControlPlaneUrl(opts.dev)
  const client = createApiClient(controlPlaneUrl, creds.apiKey)

  let status: number
  let body: ChainResponse
  try {
    // The break case answers 409 with the walk in the body, so the status
    // cannot be allowed to throw past the reporting.
    const res = await client.getWithStatus<ChainResponse>('/api/v1/integrity/chain')
    status = res.status
    body = res.body
  } catch (err) {
    log.error(`Failed to walk the chain: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  if (status !== 200 && status !== 409) {
    log.error(`Chain walk failed (${status}): ${JSON.stringify(body)}`)
    process.exit(1)
  }

  const breaks = body.breaks ?? []
  const unchained = body.unchainedRootIds ?? []

  if (opts.json) {
    console.log(JSON.stringify({ ...body, failed: failsIntegrity({ kind: 'chain', breaks: breaks.length }) }, null, 2))
  } else {
    log.header('Intutic — Root Chain Walk')
    log.field('Roots walked', String(body.rootsWalked))
    if (body.rootsNotWalked > 0) {
      // An unwalked tail is not an intact one, and the endpoint says so rather
      // than letting the caller read "no breaks" as "no breaks anywhere".
      log.field('Older, not walked', `${body.rootsNotWalked} (outside the 500-root window)`)
    }

    if (breaks.length === 0) {
      log.success('No breaks: every walked root names the root that actually precedes it.')
    } else {
      log.error(`${breaks.length} break(s) — a root names a predecessor that is not the root before it.`)
      for (const b of breaks) {
        log.field(b.rootId, `names ${b.namedPrevious}, but ${b.precedingRootId} (${b.precedingMerkleRoot}) precedes it`)
      }
    }

    if (unchained.length > 0) {
      log.warn(
        `${unchained.length} root(s) name no predecessor. Not a break — nothing was claimed, so ` +
          'nothing contradicts. It means a deletion at that point would go unseen.',
      )
      log.field('Unchained', sampleIds(unchained))
    }
  }

  if (failsIntegrity({ kind: 'chain', breaks: breaks.length })) process.exit(1)
}

/**
 * `intutic integrity config-chain` — walk the harness config snapshot chain.
 *
 * The TD-232 verifier, reached from the product rather than from a hand-written
 * curl. `content_hash` and `previous_hash` are written on every config snapshot
 * and were read only to find a diff predecessor, so for months a snapshot could
 * be deleted, or its body rewritten under its stored hash, and every reader
 * returned exactly what it returned before.
 *
 * Exits 1 on either finding. They are reported apart because they have
 * different causes and different remedies: a break says a snapshot next to this
 * one is gone, a content mismatch says this snapshot's own stored body no
 * longer hashes to the hash recorded with it. Collapsing them into one count is
 * the mistake the `audit_log_integrity` probe made by averaging independent
 * controls into a single score.
 */
export async function runIntegrityConfigChain(opts: IntegrityCliOpts): Promise<void> {
  const creds = await loadCredentials()
  if (!creds) {
    log.error(NOT_AUTHENTICATED)
    process.exit(1)
  }

  const controlPlaneUrl = resolveControlPlaneUrl(opts.dev)
  const client = createApiClient(controlPlaneUrl, creds.apiKey)

  let status: number
  let body: ConfigChainResponse
  try {
    // Same reason as `chain` above: the contradicted case answers 409 with the
    // walk in the body, so the status must not throw past the reporting.
    const res = await client.getWithStatus<ConfigChainResponse>('/api/v1/integrity/config-chain')
    status = res.status
    body = res.body
  } catch (err) {
    log.error(`Failed to walk the config chain: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  if (status !== 200 && status !== 409) {
    log.error(`Config chain walk failed (${status}): ${JSON.stringify(body)}`)
    process.exit(1)
  }

  const breaks = body.breaks ?? []
  const mismatches = body.contentMismatches ?? []
  const unchained = body.unchainedSnapshotIds ?? []
  const walked = body.snapshotsWalked ?? 0
  const failed = failsIntegrity({
    kind: 'configChain',
    breaks: breaks.length,
    contentMismatches: mismatches.length,
  })

  if (opts.json) {
    console.log(JSON.stringify({ ...body, failed }, null, 2))
  } else {
    log.header('Intutic — Config Snapshot Chain Walk')
    log.field('Snapshots walked', String(walked))
    if (body.snapshotsNotWalked > 0) {
      // Never printed as a count: the server stops counting at one. An
      // unwalked tail is still not an intact one, so it is stated.
      log.field('Older, not walked', 'yes — snapshots past the 500-snapshot window were not examined')
    }

    if (walked === 0) {
      // Not a pass, and it must not read as one. Nothing was checked, so
      // "no breaks" here would be the same sentence an intact chain prints
      // while standing for nothing at all.
      log.warn(
        'No config snapshots for this workspace, so nothing was verified. This is not a clean ' +
          'chain — it is an absent one. A workspace whose harness configs are being captured ' +
          'has snapshots; if this one should, the sync daemon is not reaching the control plane.',
      )
    } else if (breaks.length === 0 && mismatches.length === 0) {
      log.success(
        `No breaks and no content mismatches across ${walked} snapshot(s): every walked snapshot ` +
          'names the snapshot that actually precedes it, and every stored body still hashes to its ' +
          'recorded content_hash.',
      )
    }

    if (breaks.length > 0) {
      log.error(
        `${breaks.length} break(s) — a snapshot names a predecessor that is not the snapshot ` +
          'before it. That is what deleting a snapshot leaves behind.',
      )
      for (const b of breaks) {
        log.field(
          `${b.snapshotId} (${b.harnessType} ${b.filePath})`,
          `names ${b.namedPrevious}, but ${b.precedingSnapshotId} (${b.precedingContentHash}) precedes it`,
        )
      }
    }

    if (mismatches.length > 0) {
      // Deliberately not called a break, and deliberately printed as its own
      // finding: the links here are all intact. The body under one of them was
      // edited, which link-checking alone cannot see.
      log.error(
        `${mismatches.length} content mismatch(es) — a stored snapshot body no longer hashes to ` +
          'the content_hash recorded with it. The body was rewritten in place.',
      )
      for (const m of mismatches) {
        log.field(
          `${m.snapshotId} (${m.harnessType} ${m.filePath})`,
          `recorded ${m.storedHash}, body now hashes to ${m.recomputedHash}`,
        )
      }
    }

    if (unchained.length > 0) {
      log.warn(
        `${unchained.length} snapshot(s) name no predecessor mid-chain. Nothing was claimed, so ` +
          'nothing contradicts — but a deletion at that point would go unseen.',
      )
      log.field('Unchained', sampleIds(unchained))
    }
  }

  if (failed) process.exit(1)
}
