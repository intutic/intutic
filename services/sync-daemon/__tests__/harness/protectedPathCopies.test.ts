/**
 * The gate SDK's fidelity suite runs every protected-path pattern from a copy
 * of `UNIVERSAL_PROTECTED_PATHS` (`@intutic/gate` cannot import this service).
 * The copy fell 14 paths behind, so the SDK suite checked only the harness
 * gate files that existed in August. This holds the copy to the source.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { UNIVERSAL_PROTECTED_PATHS } from '../../src/harness/protectedPaths.js'

const GATE_JS_COPY = join(__dirname, '../../../../packages/gate-js/src/__tests__/fixtures/protectedPathsFixtures.ts')

describe('copies of UNIVERSAL_PROTECTED_PATHS', () => {
  it('the gate SDK fixture lists the same paths, in the same order', () => {
    const src = readFileSync(GATE_JS_COPY, 'utf8')
    const block = /export const UNIVERSAL_PROTECTED_PATHS: readonly string\[\] = \[\n([\s\S]*?)\n\]/.exec(src)
    expect(block, 'UNIVERSAL_PROTECTED_PATHS not found in the gate SDK fixture').not.toBeNull()
    const copy = [...block![1]!.matchAll(/^\s*'([^']+)',$/gm)].map((m) => m[1])
    expect(copy).toEqual([...UNIVERSAL_PROTECTED_PATHS])
  })
})
