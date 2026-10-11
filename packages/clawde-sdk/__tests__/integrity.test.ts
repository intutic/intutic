/**
 * `verifyIntegrityRoot` against the roots the control plane's own signer
 * sealed (tools/cli/src/commands/__fixtures__/integrity-roots.json, with the
 * key set it published), running the fixture's cases, which the CLI's
 * `integrity.test.ts` and the Python SDK's `tests/test_integrity.py` run too,
 * so all three reach the same verdict.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { integrityRootPreimage, verifyIntegrityRoot } from '../src/integrity'
import type { IntegrityRootDetail, SignedIntegrityRoot, SigningJwks } from '../src/types'

const FIXTURES = join(__dirname, '../../../tools/cli/src/commands/__fixtures__')
const fixture = JSON.parse(readFileSync(join(FIXTURES, 'integrity-roots.json'), 'utf-8'))
const published: SigningJwks = JSON.parse(readFileSync(join(FIXTURES, 'integrity-jwks.json'), 'utf-8'))

const keySets: Record<string, SigningJwks | null> = {
  published,
  activeOnly: { keys: published.keys.filter((k) => k['kid'] === fixture.activeKeyId) },
  empty: { keys: [] },
  brokenActive: { keys: published.keys.map((k) => (k['kid'] === fixture.activeKeyId ? { ...k, x: 'AAAA' } : k)) },
  none: null,
}

interface Case {
  name: string
  root: string
  set: Record<string, unknown>
  delete: string[]
  jwks: string
  expect: string
}

describe('verifyIntegrityRoot', () => {
  for (const c of fixture.cases as Case[]) {
    it(`${c.expect}: ${c.name}`, () => {
      const root: Record<string, unknown> = { ...fixture.roots[c.root], ...c.set }
      for (const field of c.delete) delete root[field]
      expect(verifyIntegrityRoot(root as unknown as SignedIntegrityRoot, keySets[c.jwks]!)).toBe(c.expect)
    })
  }

  it('takes the root getIntegrityRoot() returns', () => {
    const detail: IntegrityRootDetail = { ok: true, root: fixture.roots.v2Chained, leaves: [] }
    expect(verifyIntegrityRoot(detail.root, published)).toBe('valid')
  })

  it('rebuilds the preimage the signer wrote, field by field', () => {
    const root = fixture.roots.v2Chained
    expect(integrityRootPreimage(root)).toBe(
      ['intutic.merkle-root.v2', root.workspace_id, 'lr_7', '2', root.merkle_root, '1', root.previous_root].join('\x1f'),
    )
    expect(integrityRootPreimage(fixture.roots.v1RetiredKey).split('\x1f')).toHaveLength(5)
    expect(() => integrityRootPreimage({ ...root, signing_preimage_version: 3 })).toThrow(RangeError)
  })
})
