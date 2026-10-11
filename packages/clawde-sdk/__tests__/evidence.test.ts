/**
 * `verifyEvidenceArchive` against the archive the control plane's own code
 * sealed and signed (tools/cli/src/commands/__fixtures__/evidence-archive.json,
 * with the key set it published), the same cases the CLI's
 * `complianceVerify.test.ts` runs, so the CLI, this SDK and the Python SDK
 * (`tests/test_evidence.py`) answer alike.
 */
import { describe, it, expect } from 'vitest'
import { generateKeyPairSync, sign } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import { canonicalJson, verifyEvidenceArchive, EVIDENCE_SIGNING_DOMAIN } from '../src/evidence'
import type { SigningJwks } from '../src/types'

const FIXTURES = join(__dirname, '../../../tools/cli/src/commands/__fixtures__')
const archive = () => JSON.parse(readFileSync(join(FIXTURES, 'evidence-archive.json'), 'utf-8'))
const JWKS: SigningJwks = JSON.parse(readFileSync(join(FIXTURES, 'evidence-jwks.json'), 'utf-8'))

describe('verifyEvidenceArchive', () => {
  it('sorts object keys recursively and keeps array order, as the sealer does', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }, null], e: undefined })).toBe('{"a":[{"c":3,"d":2},null],"b":1}')
  })

  it('verifies an archive the control plane sealed and signed', () => {
    expect(verifyEvidenceArchive(archive(), JWKS)).toMatchObject({
      archiveHashMatches: true,
      sectionMismatches: [],
      sectionsChecked: 5,
      signature: 'valid',
      signingKeyId: JWKS.keys[0]!['kid'],
      verified: true,
    })
  })

  it('fails an archive whose content changed: the archive hash and the section say so', () => {
    const a = archive()
    a.categories[0].counts['governance_incidents.severity.high'] = 0
    expect(verifyEvidenceArchive(a, JWKS)).toMatchObject({ archiveHashMatches: false, sectionMismatches: ['security'], verified: false })
  })

  it('checks the CSV and the PDF as the files they are, and as part of their framework', () => {
    const a = archive()
    a.frameworks[0].csv += 'Article 10,failing\n'
    a.frameworks[0].pdf = Buffer.from('%PDF-1.7\n% edited\n').toString('base64')
    expect(verifyEvidenceArchive(a, JWKS).sectionMismatches).toEqual([
      'framework:eu_ai_act',
      'framework:eu_ai_act:csv',
      'framework:eu_ai_act:pdf',
    ])
  })

  it('fails a manifest entry that names nothing in the archive', () => {
    const a = archive()
    a.manifest.sections['framework:sox'] = '0'.repeat(64)
    expect(verifyEvidenceArchive(a, JWKS).sectionMismatches).toEqual(['framework:sox'])
  })

  it('says unsigned, and does not verify, an archive collected without a signing key', () => {
    const a = archive()
    a.signature = null
    a.manifest.unsignedReason = 'Unsigned: this deployment has no signing key.'
    expect(verifyEvidenceArchive(a, JWKS)).toMatchObject({
      archiveHashMatches: true,
      signature: 'unsigned',
      signingKeyId: null,
      unsignedReason: 'Unsigned: this deployment has no signing key.',
      verified: false,
    })
  })

  it('fails a signature another key made under the published key id', () => {
    const a = archive()
    const { privateKey } = generateKeyPairSync('ed25519')
    a.signature.value = sign(null, Buffer.from(`${EVIDENCE_SIGNING_DOMAIN}\n${a.manifest.archiveSha256}`), privateKey).toString('base64')
    expect(verifyEvidenceArchive(a, JWKS)).toMatchObject({ signature: 'invalid', verified: false })
  })

  it('fails a signature made for another kind of export', () => {
    const a = archive()
    a.signature.preimageDomain = 'intutic-human-oversight-v1'
    expect(verifyEvidenceArchive(a, JWKS).signature).toBe('invalid')
  })

  it('does not verify a signature it could not check', () => {
    expect(verifyEvidenceArchive(archive(), { keys: [] })).toMatchObject({ signature: 'unverifiable', verified: false })
    expect(verifyEvidenceArchive(archive(), null)).toMatchObject({ signature: 'keys_unavailable', verified: false })
  })
})
