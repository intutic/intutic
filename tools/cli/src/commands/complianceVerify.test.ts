/**
 * `intutic compliance verify` against an archive the control plane's own
 * code sealed and signed (`__fixtures__/evidence-archive.json`, with the key
 * set it published, `evidence-jwks.json`). The control plane's
 * `evidenceArchiveFixture.test.ts` re-derives the same fixture's hashes with
 * `soc2EvidenceService.ts`, so the two implementations cannot drift apart
 * without one of them failing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../config/paths.js', () => ({
  resolveControlPlaneUrl: vi.fn(() => 'https://api.test.invalid'),
}))

import {
  canonicalJson,
  verifyEvidenceArchive,
  verificationExitCode,
  runComplianceVerify,
  EVIDENCE_SIGNING_DOMAIN,
} from './compliance.js'
import type { SigningJwks } from './integrity.js'

const FIXTURES = join(__dirname, '__fixtures__')
const archive = () => JSON.parse(readFileSync(join(FIXTURES, 'evidence-archive.json'), 'utf8'))
const JWKS: SigningJwks = JSON.parse(readFileSync(join(FIXTURES, 'evidence-jwks.json'), 'utf8'))

describe('verifyEvidenceArchive', () => {
  it('sorts object keys recursively and keeps array order, as the sealer does', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }, null], e: undefined })).toBe('{"a":[{"c":3,"d":2},null],"b":1}')
  })

  it('verifies an archive the control plane sealed and signed', () => {
    const v = verifyEvidenceArchive(archive(), JWKS)
    expect(v).toMatchObject({ archiveHashMatches: true, sectionMismatches: [], sectionsChecked: 5, signature: 'valid' })
    expect(verificationExitCode(v)).toBe(0)
  })

  it('fails an archive whose content changed: the archive hash and the section say so', () => {
    const a = archive()
    a.categories[0].counts['governance_incidents.severity.high'] = 0
    const v = verifyEvidenceArchive(a, JWKS)
    expect(v.archiveHashMatches).toBe(false)
    expect(v.sectionMismatches).toEqual(['security'])
    expect(verificationExitCode(v)).toBe(1)
  })

  it('checks the CSV and the PDF as the files they are', () => {
    const a = archive()
    a.frameworks[0].csv += 'Article 10,failing\n'
    a.frameworks[0].pdf = Buffer.from('%PDF-1.7\n% edited\n').toString('base64')
    const v = verifyEvidenceArchive(a, JWKS)
    expect(v.sectionMismatches).toEqual(expect.arrayContaining(['framework:eu_ai_act:csv', 'framework:eu_ai_act:pdf']))
    expect(verificationExitCode(v)).toBe(1)
  })

  it('fails a manifest entry that names nothing in the archive', () => {
    const a = archive()
    a.manifest.sections['framework:sox'] = '0'.repeat(64)
    expect(verifyEvidenceArchive(a, JWKS).sectionMismatches).toEqual(['framework:sox'])
  })

  it('says unsigned, and does not pass, for an archive collected without a signing key', () => {
    const a = archive()
    a.signature = null
    a.manifest.signed = false
    a.manifest.unsignedReason = 'Unsigned: this deployment has no signing key.'
    const v = verifyEvidenceArchive(a, JWKS)
    expect(v).toMatchObject({ archiveHashMatches: true, signature: 'unsigned', unsignedReason: 'Unsigned: this deployment has no signing key.' })
    expect(verificationExitCode(v)).toBe(2)
  })

  it('fails a signature another key made under the published key id', () => {
    const a = archive()
    const { privateKey } = generateKeyPairSync('ed25519')
    a.signature.value = nodeSign(null, Buffer.from(`${EVIDENCE_SIGNING_DOMAIN}\n${a.manifest.archiveSha256}`), privateKey).toString('base64')
    expect(verifyEvidenceArchive(a, JWKS).signature).toBe('invalid')
  })

  it('fails a signature made for another kind of export', () => {
    const a = archive()
    a.signature.preimageDomain = 'intutic-human-oversight-v1'
    expect(verificationExitCode(verifyEvidenceArchive(a, JWKS))).toBe(1)
  })

  it('does not pass a signature it could not check', () => {
    const noKey = verifyEvidenceArchive(archive(), { keys: [] })
    expect(noKey.signature).toBe('unverifiable')
    expect(verificationExitCode(noKey)).toBe(2)
    expect(verifyEvidenceArchive(archive(), null).signature).toBe('keys_unavailable')
  })
})

describe('intutic compliance verify', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let exitSpy: ReturnType<typeof vi.spyOn>
  let out: string[]

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`)
    }) as never)
    out = []
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.map(String).join(' ')))
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void out.push(a.map(String).join(' ')))
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void out.push(a.map(String).join(' ')))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const write = (name: string, value: unknown) => {
    const path = join(mkdtempSync(join(tmpdir(), 'intutic-evidence-')), name)
    writeFileSync(path, JSON.stringify(value))
    return path
  }

  it('verifies offline with a saved key set, and exits 0', async () => {
    await runComplianceVerify(join(FIXTURES, 'evidence-archive.json'), { jwks: join(FIXTURES, 'evidence-jwks.json') })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(exitSpy).not.toHaveBeenCalled()
    expect(out.join('\n')).toMatch(/Signature.*valid/)
  })

  it('fetches the published keys from the control plane without credentials when no --jwks is given', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => JWKS })
    await runComplianceVerify(join(FIXTURES, 'evidence-archive.json'), { json: true })
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.test.invalid/.well-known/intutic-trace-signing.json')
    expect(fetchMock.mock.calls[0][1]).toBeUndefined()
    expect(JSON.parse(out.join('\n'))).toMatchObject({ verified: true, signature: 'valid' })
  })

  it('prints unsigned and exits 2 for an unsigned archive, without fetching keys', async () => {
    const a = archive()
    a.signature = null
    await expect(runComplianceVerify(write('unsigned.json', a), {})).rejects.toThrow('process.exit(2)')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(out.join('\n')).toMatch(/unsigned/)
  })

  it('exits 1 for a changed archive', async () => {
    const a = archive()
    a.overallScore = 99
    await expect(runComplianceVerify(write('changed.json', a), { jwks: join(FIXTURES, 'evidence-jwks.json') })).rejects.toThrow('process.exit(1)')
    expect(out.join('\n')).toMatch(/DOES NOT MATCH/)
  })

  it('refuses a file that is not an evidence archive', async () => {
    await expect(runComplianceVerify(write('other.json', { keys: [] }), {})).rejects.toThrow('process.exit(1)')
    expect(out.join('\n')).toContain('not an evidence archive')
  })
})
