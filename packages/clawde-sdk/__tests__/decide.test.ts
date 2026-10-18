/**
 * The clawde SDK's `decide(state, questions, opts)`: byte-identical copies of
 * the shared decide modules (this package has no dependencies), held to the
 * shared `decide-sdk-vectors.json` through the package's own export, against
 * a mock engine.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { decide } from '../src'
// @ts-expect-error -- a plain ESM fixture without types
import { runDecideSdkCase } from '../../shared-types/fixtures/decide-sdk-runner.mjs'

const SHARED = join(__dirname, '../../shared-types/src')
const VECTORS = JSON.parse(readFileSync(join(__dirname, '../../shared-types/fixtures/decide-sdk-vectors.json'), 'utf-8')) as {
  sdk: Array<{ name: string }>
}

it.each(['decide.ts', 'decideEngine.ts', 'decideHostGuard.ts', 'decideSdk.ts'])('carries a byte-identical copy of the shared %s', (file) => {
  expect(readFileSync(join(__dirname, '../src', file), 'utf-8')).toBe(readFileSync(join(SHARED, file), 'utf-8'))
})

describe('decide vectors', () => {
  it.each(VECTORS.sdk.map((c) => [c.name, c] as const))('%s', async (_n, c) => {
    expect(await runDecideSdkCase(c, decide)).toEqual([])
  })
})
