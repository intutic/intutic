/**
 * `intutic compliance` — framework coverage, and the evidence archive an
 * auditor receives.
 *
 * Subcommands:
 *   - `intutic compliance coverage <framework_id>` — how the latest compliance
 *     probe results cover one framework (EU AI Act, ISO/IEC 42001, NIST AI
 *     RMF, MITRE ATLAS), as a summary or as the report file.
 *   - `intutic compliance collect` — run a fresh evidence collection and seal
 *     it into an archive.
 *   - `intutic compliance download <run_id>` — a stored archive.
 *   - `intutic compliance verify <file>` — check an archive offline.
 *
 * Server side: services/control-plane/src/routes/compliance.ts —
 * `GET .../frameworks/:frameworkId/coverage` (`?format=` json, markdown, csv
 * or pdf; a live report is unsigned, the signed copies are the ones sealed in
 * the evidence pack), `POST .../soc2-collect` and `GET .../soc2-export/:runId`
 * (OWNER/ADMIN). The archive's rules are in
 * services/control-plane/src/services/soc2EvidenceService.ts: a sha256
 * manifest over canonical JSON, and an Ed25519 signature over
 * `intutic-soc2-evidence-v1\n<archiveSha256>` only when the deployment has a
 * signing key. `verify` applies the same rules with nothing but the file and
 * the published key set, so its answer does not depend on trusting the server
 * that produced the archive.
 *
 * @module
 */

import { createHash, createPublicKey, verify as nodeVerify, type JsonWebKey } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import pc from 'picocolors'
import { resolveControlPlaneUrl } from '../config/paths.js'
import { log } from '../lib/logger.js'
import { fail, readJsonFile, runApiCommand, writeOutput, type ApiCommandOpts } from './apiCommand.js'
import { fetchSigningKeys, type SignatureState, type SigningJwks } from './integrity.js'

/** The CLI's format names, and the route's for each. */
const FORMATS = { json: 'json', md: 'markdown', csv: 'csv', pdf: 'pdf' } as const
type Format = keyof typeof FORMATS

interface FrameworkCoverage {
  frameworkId: string
  name: string
  mappingVersion: string
  generatedAt: string
  summary: {
    controls: number
    mapped: number
    full: number
    partial: number
    states: Record<string, number>
  }
}

interface CoverageOpts extends ApiCommandOpts {
  format?: string
  out?: string
}

/** `intutic compliance coverage <framework_id>` */
export async function runComplianceCoverage(frameworkId: string, opts: CoverageOpts): Promise<void> {
  const format = opts.format ?? (opts.json ? 'json' : undefined)
  const path = `/api/v1/compliance/frameworks/${encodeURIComponent(frameworkId)}/coverage`

  if (format === undefined) {
    await runApiCommand(
      opts,
      `Failed to read ${frameworkId} coverage`,
      (client) => client.get<FrameworkCoverage>(path),
      (c) => {
        log.header(`Intutic — ${c.name} coverage`)
        log.field('Controls', `${c.summary.controls} (${c.summary.mapped} mapped: ${c.summary.full} full, ${c.summary.partial} partial)`)
        for (const [state, count] of Object.entries(c.summary.states)) log.field(state, String(count))
        log.field('Mapping version', c.mappingVersion)
        log.field('Generated', c.generatedAt)
        log.dim('  The full report: --format md|csv|pdf --out <file>.')
      },
    )
    return
  }

  if (!Object.keys(FORMATS).includes(format)) fail(`--format must be one of ${Object.keys(FORMATS).join(', ')}, got "${format}"`)
  // A PDF written to a terminal is noise and a lost report; a pipe or a file is fine.
  if (format === 'pdf' && !opts.out && process.stdout.isTTY) {
    fail('A PDF report needs --out <file>, or redirect the output to a file.')
  }

  await runApiCommand(
    // The output is the report itself; `--json` only chose the format.
    { dev: opts.dev },
    `Failed to export ${frameworkId} coverage`,
    (client) => client.getFile(`${path}?format=${FORMATS[format as Format]}`),
    (bytes) => writeOutput(bytes, opts.out, `${frameworkId} coverage (${format})`),
  )
}

// ─── Evidence archive ────────────────────────────────────────────────

/** The domain the control plane signs evidence archives under (soc2EvidenceService.ts). */
export const EVIDENCE_SIGNING_DOMAIN = 'intutic-soc2-evidence-v1'

interface DetachedSignature {
  algorithm: string
  keyId: string
  preimageDomain: string
  value: string
}

/** The parts of an evidence archive `verify` reads; everything else is covered by the archive hash. */
interface EvidenceArchive {
  formatVersion?: number
  runId?: string
  collectedAt?: string
  categories?: Array<{ category: string }>
  frameworks?: Array<{ coverage: { frameworkId: string }; csv?: string; pdf?: string }>
  manifest?: { algorithm?: string; sections?: Record<string, string>; archiveSha256?: string; unsignedReason?: string }
  signature?: DetachedSignature | null
}

interface CollectResponse {
  runId: string
  archive: EvidenceArchive & { overallScore: number | null; periodStart: string; periodEnd: string }
  artifactUrl: string | null
  signed: boolean
  signingKeyId?: string
  unsignedReason?: string
}

/**
 * Object keys sorted recursively, arrays in order: the preimage the control
 * plane hashes (`canonicalJson` in soc2EvidenceService.ts), because the
 * archive round-trips through a JSONB column that does not keep key order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

const sha256Hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')

/** What one manifest entry hashes, or null when the archive has nothing under that name. */
function sectionContent(archive: EvidenceArchive, name: string): string | Buffer | null {
  const category = archive.categories?.find((c) => c.category === name)
  if (category) return canonicalJson(category)
  const m = /^framework:([^:]+)(?::(csv|pdf))?$/.exec(name)
  const framework = m ? archive.frameworks?.find((f) => f.coverage?.frameworkId === m[1]) : undefined
  if (!m || !framework) return null
  // The CSV as its UTF-8 bytes and the PDF decoded, so a file saved out of
  // the archive checks with `sha256sum` alone.
  if (m[2] === 'csv') return framework.csv ?? null
  if (m[2] === 'pdf') return framework.pdf === undefined ? null : Buffer.from(framework.pdf, 'base64')
  return canonicalJson(framework)
}

export interface EvidenceVerification {
  /** The recomputed whole-archive hash, and whether it equals `manifest.archiveSha256`. */
  archiveSha256: string
  archiveHashMatches: boolean
  /** Manifest entries whose content does not hash to the recorded value, or that name nothing in the archive. */
  sectionMismatches: string[]
  sectionsChecked: number
  signature: SignatureState
  signingKeyId: string | null
  /** Why the archive is unsigned, as the archive states it (format 3 on). */
  unsignedReason: string | null
}

/**
 * Check an evidence archive the way it was sealed: the manifest's hashes,
 * then the signature over the archive hash against the published key its
 * `keyId` names. A signature over a hash that does not match proves nothing
 * about this file, so it is reported only once the hash matches.
 */
export function verifyEvidenceArchive(archive: EvidenceArchive, jwks: SigningJwks | null): EvidenceVerification {
  const rest: Record<string, unknown> = { ...archive }
  delete rest['manifest']
  delete rest['signature']
  const archiveSha256 = sha256Hex(canonicalJson(rest))
  const manifest = archive.manifest ?? {}
  const archiveHashMatches = archiveSha256 === manifest.archiveSha256

  const sections = Object.entries(manifest.sections ?? {})
  const sectionMismatches = sections
    .filter(([name, recorded]) => {
      const content = sectionContent(archive, name)
      return content === null || sha256Hex(content) !== recorded
    })
    .map(([name]) => name)

  const sig = archive.signature ?? null
  return {
    archiveSha256,
    archiveHashMatches,
    sectionMismatches,
    sectionsChecked: sections.length,
    signature: sig ? signatureState(sig, manifest.archiveSha256 ?? '', jwks) : 'unsigned',
    signingKeyId: sig?.keyId ?? null,
    unsignedReason: sig ? null : (manifest.unsignedReason ?? null),
  }
}

function signatureState(sig: DetachedSignature, archiveSha256: string, jwks: SigningJwks | null): SignatureState {
  // A signature made under another domain (a human-oversight or SLA export)
  // or algorithm is not this archive's signature, whatever its bytes.
  if (sig.preimageDomain !== EVIDENCE_SIGNING_DOMAIN || sig.algorithm !== 'Ed25519') return 'invalid'
  if (!jwks) return 'keys_unavailable'
  const jwk = jwks.keys.find((k) => k['kid'] === sig.keyId)
  if (!jwk) return 'unverifiable'
  try {
    const ok = nodeVerify(
      null,
      Buffer.from(`${EVIDENCE_SIGNING_DOMAIN}\n${archiveSha256}`, 'utf8'),
      createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' }),
      Buffer.from(sig.value, 'base64'),
    )
    return ok ? 'valid' : 'invalid'
  } catch {
    // A published key this build cannot load is one we do not effectively hold.
    return 'unverifiable'
  }
}

/**
 * The exit code for a verification: 0 only for an archive whose hashes match
 * and whose signature a published key accepts; 1 when the file or its
 * signature contradicts the archive (it was changed); 2 when the hashes match
 * but nothing establishes who produced it (unsigned, or the key could not be
 * had), which a script must not read as a pass.
 */
export function verificationExitCode(v: EvidenceVerification): 0 | 1 | 2 {
  if (!v.archiveHashMatches || v.sectionMismatches.length > 0 || v.signature === 'invalid') return 1
  return v.signature === 'valid' ? 0 : 2
}

const SIGNATURE_TEXT: Record<SignatureState, string> = {
  valid: 'valid: the published key accepts the signature over this archive hash',
  invalid: 'INVALID: the signature does not match this archive',
  unsigned: 'unsigned: the deployment had no signing key when this archive was collected',
  unverifiable: 'not verified: no published key has this key id',
  keys_unavailable: 'not verified: the published keys could not be fetched; pass --jwks <file>',
}

/** The published key set, from a file when given, else from the control plane's unauthenticated endpoint. */
function loadJwks(path: string): SigningJwks {
  const parsed = readJsonFile(path) as SigningJwks
  if (!Array.isArray(parsed?.keys)) fail(`${path} is not a JWKS: it has no "keys" array`)
  return parsed
}

/** `intutic compliance verify <file>` */
export async function runComplianceVerify(file: string, opts: ApiCommandOpts & { jwks?: string }): Promise<void> {
  const archive = readJsonFile(file) as EvidenceArchive
  if (!archive?.manifest?.archiveSha256) fail(`${file} is not an evidence archive: it has no manifest.archiveSha256`)

  const jwks = opts.jwks
    ? loadJwks(opts.jwks)
    : archive.signature
      ? await fetchSigningKeys(resolveControlPlaneUrl(opts.dev))
      : null
  const v = verifyEvidenceArchive(archive, jwks)
  const code = verificationExitCode(v)

  if (opts.json) {
    console.log(JSON.stringify({ file, ...v, verified: code === 0 }, null, 2))
  } else {
    log.header('Intutic — Evidence Archive')
    if (archive.runId) log.field('Run', archive.runId)
    if (archive.collectedAt) log.field('Collected', archive.collectedAt)
    log.field('Archive hash', v.archiveHashMatches ? pc.green(`matches (${v.archiveSha256})`) : pc.red(`DOES NOT MATCH the manifest (recomputed ${v.archiveSha256})`))
    log.field(
      'Sections',
      v.sectionMismatches.length === 0
        ? pc.green(`${v.sectionsChecked} of ${v.sectionsChecked} match`)
        : pc.red(`${v.sectionMismatches.length} of ${v.sectionsChecked} DO NOT MATCH: ${v.sectionMismatches.join(', ')}`),
    )
    const text = SIGNATURE_TEXT[v.signature]
    log.field('Signature', v.signature === 'valid' ? pc.green(text) : v.signature === 'invalid' ? pc.red(text) : pc.yellow(text))
    if (v.signingKeyId) log.field('Key id', v.signingKeyId)
    if (v.unsignedReason) log.dim(`  ${v.unsignedReason}`)
    if (code === 2) log.warn('Not verified: the hashes match, but nothing shows who produced this archive.')
  }
  if (code !== 0) process.exit(code)
}

/** `intutic compliance collect` */
export async function runComplianceCollect(opts: ApiCommandOpts & { from?: string; to?: string; out?: string }): Promise<void> {
  for (const [flag, value] of [['--from', opts.from], ['--to', opts.to]] as const) {
    if (value !== undefined && Number.isNaN(Date.parse(value))) fail(`${flag} must be an ISO 8601 date or datetime, got "${value}"`)
  }
  await runApiCommand(
    // Not `opts`: with --json the response is printed, and --out still writes the archive.
    { dev: opts.dev },
    'Failed to collect evidence',
    (client) => client.post<CollectResponse>('/api/v1/compliance/soc2-collect', { periodStart: opts.from, periodEnd: opts.to }),
    (res) => {
      if (opts.out) writeFileSync(opts.out, JSON.stringify(res.archive, null, 2))
      if (opts.json) {
        console.log(JSON.stringify(res, null, 2))
        return
      }
      log.header('Intutic — Evidence Collected')
      log.field('Run', res.runId)
      log.field('Period', `${res.archive.periodStart} to ${res.archive.periodEnd}`)
      log.field('Overall score', res.archive.overallScore === null ? '— (no scored category)' : String(res.archive.overallScore))
      log.field('Signed', res.signed ? pc.green(`yes (key ${res.signingKeyId})`) : pc.yellow('no'))
      if (!res.signed && res.unsignedReason) log.dim(`  ${res.unsignedReason}`)
      if (res.artifactUrl) log.field('Stored at', res.artifactUrl)
      if (opts.out) log.success(`Wrote the archive to ${opts.out}. Check it: intutic compliance verify ${opts.out}`)
      else log.dim(`  Download it: intutic compliance download ${res.runId} --out <file>`)
    },
  )
}

/** `intutic compliance download <run_id>` */
export async function runComplianceDownload(runId: string, opts: ApiCommandOpts & { out?: string }): Promise<void> {
  await runApiCommand(
    // The output is the archive itself.
    { dev: opts.dev },
    `Failed to download evidence run ${runId}`,
    (client) => client.getFile(`/api/v1/compliance/soc2-export/${encodeURIComponent(runId)}`),
    (bytes) => {
      writeOutput(bytes, opts.out, `evidence run ${runId}`)
      if (opts.out) log.dim(`  Check it: intutic compliance verify ${opts.out}`)
    },
  )
}
