/**
 * decide(state, questions, opts) as the SDKs carry it, held to
 * `fixtures/decide-sdk-vectors.json` against a mock engine that replays
 * recorded responses. The gate SDK, the clawde SDK and the Python SDK run the
 * same vectors.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DecideEngineError } from '../decideEngine.js'
import { decideQuestions, loadDecideEngineFile } from '../decideSdk.js'
// @ts-expect-error -- a plain ESM fixture without types
import { runDecideSdkCase } from '../../fixtures/decide-sdk-runner.mjs'

const VECTORS = JSON.parse(readFileSync(join(__dirname, '../../fixtures/decide-sdk-vectors.json'), 'utf8')) as {
  sdk: Array<{ name: string }>
}

describe('decide vectors', () => {
  it.each(VECTORS.sdk.map((c) => [c.name, c] as const))('%s', async (_n, c) => {
    expect(await runDecideSdkCase(c, decideQuestions)).toEqual([])
  })
})

describe('engine.json', () => {
  it('is null when the file does not exist', () => {
    const read = () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    }
    expect(loadDecideEngineFile(read, '/home/u/.intutic/decide/engine.json')).toBeNull()
  })

  it('leaves the engine not configured when it does not parse or cannot be read', () => {
    for (const read of [
      () => '{"model":',
      () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' })
      },
    ]) {
      try {
        loadDecideEngineFile(read, 'engine.json')
        expect.unreachable()
      } catch (err) {
        expect(err).toBeInstanceOf(DecideEngineError)
        expect((err as DecideEngineError).code).toBe('not_configured')
      }
    }
  })

  it('parses the file', () => {
    expect(loadDecideEngineFile(() => '{"model":"m","url":"http://127.0.0.1:11434"}', 'engine.json')).toEqual({
      model: 'm',
      url: 'http://127.0.0.1:11434',
    })
  })
})

it('refuses a state that is not a string', async () => {
  await expect(decideQuestions(42 as unknown as string, { a: { type: 'yes_no', ask: 'Is this a question?' } })).rejects.toThrow(TypeError)
})
