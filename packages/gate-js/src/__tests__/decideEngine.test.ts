/**
 * The decide engine client and the protections around it in the gate SDK:
 * byte-identical copies of the shared-types modules, which run
 * `decide-engine-vectors.json` in full there. The host cases run here too,
 * against this package's copy.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkSelfHostedDecisionHost } from '../decideHostGuard.js'

const SHARED = join(__dirname, '../../../shared-types/src')
const VECTORS = JSON.parse(readFileSync(join(__dirname, '../../../shared-types/fixtures/decide-engine-vectors.json'), 'utf8')) as {
  host: Array<{ name: string; url: string; listed?: string; ok: boolean; reason: string }>
}

it.each(['decideEngine.ts', 'decideHostGuard.ts', 'decideEvaluate.ts'])('carries a byte-identical copy of the shared %s', (file) => {
  expect(readFileSync(join(__dirname, '..', file), 'utf8')).toBe(readFileSync(join(SHARED, file), 'utf8'))
})

describe('host guard', () => {
  it.each(VECTORS.host.map((c) => [c.name, c] as const))('%s', (_n, c) => {
    const v = checkSelfHostedDecisionHost(c.url, c.listed)
    expect({ ok: v.ok, reason: v.reason }).toEqual({ ok: c.ok, reason: c.reason })
  })
})
