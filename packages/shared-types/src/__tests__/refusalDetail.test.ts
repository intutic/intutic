/**
 * A refusal's scope and evidence: the shared vectors through
 * the module and through the JavaScript source the hook gates embed.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as detail from '../refusalDetail.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the vectors are typed by use
const V = JSON.parse(readFileSync(join(__dirname, '../../fixtures/refusal-detail-vectors.json'), 'utf-8')) as any

type Api = Pick<typeof detail, 'boundRefusalScope' | 'boundRefusalEvidence' | 'refusalDetailForMode' | 'retryScopeLine'>
const EMITTED = new Function(`${detail.REFUSAL_DETAIL_JS_SOURCE}\nreturn { boundRefusalScope, boundRefusalEvidence, refusalDetailForMode, retryScopeLine }`)() as Api

describe.each([
  ['the module', detail as Api],
  ['the emitted source', EMITTED],
] as const)('refusal detail through %s', (_label, api) => {
  it('bounds a scope', () => {
    for (const c of V.scope) {
      const got = api.boundRefusalScope(c.input)
      expect(got, c.name).toEqual(c.output)
      // A fixed key order, so every surface writes the same bytes.
      if (got) expect(Object.keys(got), c.name).toEqual(Object.keys(c.output))
    }
  })

  it('bounds evidence', () => {
    for (const c of V.evidence) expect(api.boundRefusalEvidence(c.input), c.name).toEqual(c.output)
  })

  it('drops both in OPAQUE', () => {
    for (const c of V.forMode) expect(api.refusalDetailForMode(c.mode, c.scope, c.evidence), c.name).toEqual(c.output)
  })

  it('writes the retry line', () => {
    for (const c of V.retryLine) expect(api.retryScopeLine(c.mode, c.scope), c.name).toBe(c.line)
  })
})
