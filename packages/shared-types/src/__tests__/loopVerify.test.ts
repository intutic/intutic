/**
 * The deterministic stage of loop verification, on the shared
 * scope-plan vectors.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { verifyLoopDeterministic } from '../loopVerify.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the vectors are typed by use
const V = JSON.parse(readFileSync(join(__dirname, '../../fixtures/scope-plan-vectors.json'), 'utf-8')) as any

it('checks scope then plan, as the vectors say', () => {
  expect(V.loopVerify.length).toBeGreaterThan(8)
  for (const c of V.loopVerify) {
    expect(verifyLoopDeterministic({ changedPaths: c.changedPaths, toolSequence: c.toolSequence, sops: c.sops }), c.name).toEqual(c.checks)
  }
})
