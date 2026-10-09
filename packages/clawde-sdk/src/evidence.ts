/**
 * Offline verification of a compliance evidence archive: the check
 * `intutic compliance verify` makes, with nothing but the archive and the
 * control plane's published key set, so the answer does not depend on
 * trusting the server that produced the archive.
 *
 * The rules are the sealer's (`soc2EvidenceService.ts` in the control plane):
 * a sha256 manifest over canonical JSON, and an Ed25519 signature over
 * `intutic-soc2-evidence-v1\n<archiveSha256>`, present only when the
 * deployment had a signing key. The CLI's `commands/compliance.ts` applies the
 * same rules; the tests hold both to the archive the control plane's own code
 * sealed (`tools/cli/src/commands/__fixtures__/evidence-archive.json`).
 *
 * @module
 */
import { createHash, createPublicKey, verify as cryptoVerify, type JsonWebKey } from 'crypto'
import type { EvidenceArchive, EvidenceDetachedSignature, EvidenceSignatureState, EvidenceVerification, SigningJwks } from './types'

/** The domain the control plane signs evidence archives under. */
export const EVIDENCE_SIGNING_DOMAIN = 'intutic-soc2-evidence-v1'

/**
 * Object keys sorted recursively, arrays in order: the preimage the control
 * plane hashes, because the archive round-trips through storage that does not
 * keep key order.
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

function signatureState(sig: EvidenceDetachedSignature, archiveSha256: string, jwks: SigningJwks | null): EvidenceSignatureState {
  // A signature made under another domain (another kind of export) or
  // algorithm is not this archive's signature, whatever its bytes.
  if (sig.preimageDomain !== EVIDENCE_SIGNING_DOMAIN || sig.algorithm !== 'Ed25519') return 'invalid'
  if (!jwks) return 'keys_unavailable'
  const jwk = jwks.keys.find((k) => k['kid'] === sig.keyId)
  if (!jwk) return 'unverifiable'
  try {
    const ok = cryptoVerify(
      null,
      Buffer.from(`${EVIDENCE_SIGNING_DOMAIN}\n${archiveSha256}`, 'utf8'),
      createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' }),
      Buffer.from(sig.value, 'base64'),
    )
    return ok ? 'valid' : 'invalid'
  } catch {
    // A published key this runtime cannot load is one we do not effectively hold.
    return 'unverifiable'
  }
}

/**
 * Checks an evidence archive the way it was sealed: the manifest's hashes,
 * then the signature over the archive hash against the published key its
 * `keyId` names (`jwks`, from `ControlPlaneClient.getSigningKeys()` or a saved
 * copy; null when it could not be had).
 *
 * `verified` is true only for an archive whose hashes match and whose
 * signature a published key accepts. An unsigned archive, or one whose key is
 * not published, is not verified even when its hashes match: nothing then
 * shows who produced it.
 */
export function verifyEvidenceArchive(archive: EvidenceArchive, jwks: SigningJwks | null): EvidenceVerification {
  const rest: Record<string, unknown> = { ...archive }
  delete rest['manifest']
  delete rest['signature']
  const archiveSha256 = sha256Hex(canonicalJson(rest))
  const manifest: NonNullable<EvidenceArchive['manifest']> = archive.manifest ?? {}
  const archiveHashMatches = archiveSha256 === manifest.archiveSha256

  const sections = Object.entries(manifest.sections ?? {})
  const sectionMismatches = sections
    .filter(([name, recorded]) => {
      const content = sectionContent(archive, name)
      return content === null || sha256Hex(content) !== recorded
    })
    .map(([name]) => name)

  const sig = archive.signature ?? null
  const signature = sig ? signatureState(sig, manifest.archiveSha256 ?? '', jwks) : 'unsigned'
  return {
    archiveSha256,
    archiveHashMatches,
    sectionMismatches,
    sectionsChecked: sections.length,
    signature,
    signingKeyId: sig?.keyId ?? null,
    unsignedReason: sig ? null : (manifest.unsignedReason ?? null),
    verified: archiveHashMatches && sectionMismatches.length === 0 && signature === 'valid',
  }
}
