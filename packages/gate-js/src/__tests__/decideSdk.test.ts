/**
 * The gate SDK's public `decide(state, questions, opts)`: a byte-identical
 * copy of the shared decideSdk module, held to the shared
 * `decide-sdk-vectors.json` through this package's own export, against a mock
 * engine. The default engine configuration comes from the home directory's
 * `~/.intutic/decide/engine.json`.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { decide, DecideEngineError } from '../index.js'
// @ts-expect-error -- a plain ESM fixture without types
import { runDecideSdkCase } from '../../../shared-types/fixtures/decide-sdk-runner.mjs'
// @ts-expect-error -- a plain ESM fixture without types
import { startDecideMockEngine } from '../../../shared-types/fixtures/decide-mock-engine.mjs'

const SHARED = join(__dirname, '../../../shared-types/src')
const VECTORS = JSON.parse(readFileSync(join(__dirname, '../../../shared-types/fixtures/decide-sdk-vectors.json'), 'utf8')) as {
  sdk: Array<{ name: string; replay: unknown[] }>
}

it('carries a byte-identical copy of the shared decideSdk.ts', () => {
  expect(readFileSync(join(__dirname, '..', 'decideSdk.ts'), 'utf8')).toBe(readFileSync(join(SHARED, 'decideSdk.ts'), 'utf8'))
})

describe('decide vectors', () => {
  it.each(VECTORS.sdk.map((c) => [c.name, c] as const))('%s', async (_n, c) => {
    expect(await runDecideSdkCase(c, decide)).toEqual([])
  })
})

describe('the default engine configuration', () => {
  const saved = process.env.HOME
  let home: string | null = null
  afterEach(() => {
    process.env.HOME = saved
    if (home) rmSync(home, { recursive: true, force: true })
    home = null
  })

  const yes = {
    method: 'POST',
    path: '/v1/chat/completions',
    status: 200,
    body: { choices: [{ logprobs: { content: [{ token: 'no', logprob: -0.01, top_logprobs: [{ token: 'no', logprob: -0.01 }, { token: 'yes', logprob: -4.6 }] }] } }] },
  }
  const questions = { exports: { type: 'yes_no' as const, ask: 'Does this command copy customer data out of production?' } }

  it('is read from ~/.intutic/decide/engine.json', async () => {
    const m = await startDecideMockEngine([yes])
    try {
      home = mkdtempSync(join(tmpdir(), 'decide-home-'))
      mkdirSync(join(home, '.intutic', 'decide'), { recursive: true })
      writeFileSync(join(home, '.intutic', 'decide', 'engine.json'), JSON.stringify({ url: m.url, model: 'from-file' }))
      process.env.HOME = home
      const r = await decide('STATE', questions, { when: 'exports', env: {} })
      expect(r.outcome).toBe('allow')
      expect(r.model).toBe('from-file')
      expect(m.requests.map((q: { body: { model: string } }) => q.body.model)).toEqual(['from-file'])
    } finally {
      await m.close()
    }
  })

  it('without engine.json or a model is not configured, and sends nothing', async () => {
    home = mkdtempSync(join(tmpdir(), 'decide-home-'))
    process.env.HOME = home
    await expect(decide('STATE', questions, { env: {} })).rejects.toMatchObject({ code: 'not_configured' })
    await expect(decide('STATE', questions, { env: {} })).rejects.toBeInstanceOf(DecideEngineError)
  })
})
