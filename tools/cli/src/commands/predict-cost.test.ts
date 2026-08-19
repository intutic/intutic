/**
 * `intutic predict-cost` — refuses missing/conflicting input-size flags
 * before sending anything, posts the right body to
 * `POST /api/v1/predict-cost`, and renders the report (or `--json`) without
 * inventing figures. Mirrors `routing.test.ts`'s fetch-mocking conventions.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../config/store.js', () => ({
  loadCredentials: vi.fn(async () => ({ apiKey: 'vk_test_key', workspaceId: 'ws_test' })),
}))

vi.mock('../config/paths.js', () => ({
  resolveControlPlaneUrl: vi.fn(() => 'https://api.test.invalid'),
}))

const readFileMock = vi.fn()
vi.mock('node:fs/promises', () => ({
  readFile: (...args: unknown[]) => readFileMock(...args),
}))

import { runPredictCost } from './predict-cost.js'

describe('intutic predict-cost', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- spyOn's inferred type narrows to the
  // mocked implementation's signature, which is incompatible with a pre-declared generic annotation.
  let exitSpy: any
  let logSpy: any
  let errSpy: any

  beforeEach(() => {
    readFileMock.mockReset()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`)
    }) as never)
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const printed = () => logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')

  const prediction = {
    inputTokens: 1200,
    estimatedOutputTokens: 400,
    estimatedReasoningTokens: null,
    estimatedCostUsd: 0.0234,
    confidence: 'medium' as const,
    basedOnSamples: 5,
  }

  it('refuses a missing --model before sending any request', async () => {
    await expect(runPredictCost({ tokens: '100' })).rejects.toThrow('process.exit(1)')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalled()
  })

  it('refuses when neither --tokens nor --file is given', async () => {
    await expect(runPredictCost({ model: 'claude-sonnet-4-5' })).rejects.toThrow('process.exit(1)')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('One of --tokens'))
  })

  it('refuses when both --tokens and --file are given', async () => {
    await expect(
      runPredictCost({ model: 'claude-sonnet-4-5', tokens: '100', file: 'x.txt' }),
    ).rejects.toThrow('process.exit(1)')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('mutually exclusive'))
  })

  it('refuses a non-numeric --tokens', async () => {
    await expect(
      runPredictCost({ model: 'claude-sonnet-4-5', tokens: 'lots' }),
    ).rejects.toThrow('process.exit(1)')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('posts workspaceId, model, inputTokenCount and taskType (default "coding") when using --tokens', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => prediction })

    await runPredictCost({ model: 'claude-sonnet-4-5', tokens: '1200' })

    const [url, init] = fetchMock.mock.calls[0]
    expect(new URL(url).pathname).toBe('/api/v1/predict-cost')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer vk_test_key')
    const body = JSON.parse(init.body)
    expect(body).toEqual({
      workspaceId: 'ws_test',
      model: 'claude-sonnet-4-5',
      inputTokenCount: 1200,
      taskType: 'coding',
    })
  })

  it('reads --file contents into inputText instead of inputTokenCount', async () => {
    readFileMock.mockResolvedValue('a prompt from disk')
    fetchMock.mockResolvedValue({ ok: true, json: async () => prediction })

    await runPredictCost({ model: 'gpt-4o', file: 'prompt.txt', taskType: 'review' })

    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(init.body)
    expect(body).toEqual({
      workspaceId: 'ws_test',
      model: 'gpt-4o',
      inputText: 'a prompt from disk',
      taskType: 'review',
    })
  })

  it('exits non-zero when --file cannot be read, without making a request', async () => {
    readFileMock.mockRejectedValue(new Error('ENOENT: no such file'))

    await expect(
      runPredictCost({ model: 'claude-sonnet-4-5', file: 'missing.txt' }),
    ).rejects.toThrow('process.exit(1)')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('missing.txt'))
  })

  it('renders the prediction report, including "none" for a null reasoning estimate', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => prediction })

    await runPredictCost({ model: 'claude-sonnet-4-5', tokens: '1200' })

    const out = printed()
    expect(out).toContain('1,200')
    expect(out).toContain('400')
    expect(out).toContain('none')
    expect(out).toContain('$0.023400')
    expect(out).toContain('medium')
    expect(out).toContain('5 prior sample(s)')
  })

  it('renders "no baseline" rather than "0 prior sample(s)" when basedOnSamples is 0', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ...prediction, basedOnSamples: 0, confidence: 'low' }),
    })

    await runPredictCost({ model: 'claude-sonnet-4-5', tokens: '1200' })

    const out = printed()
    expect(out).toContain('no baseline')
    expect(out).not.toContain('0 prior sample(s)')
  })

  it('--json prints the raw response verbatim instead of the formatted report', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => prediction })

    await runPredictCost({ model: 'claude-sonnet-4-5', tokens: '1200', json: true })

    expect(JSON.parse(printed())).toEqual(prediction)
  })

  it('exits non-zero and reports the failure on a non-2xx response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'Internal error' })

    await expect(runPredictCost({ model: 'claude-sonnet-4-5', tokens: '1200' })).rejects.toThrow(
      'process.exit(1)',
    )
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errSpy).toHaveBeenCalled()
  })

  it('reports not-authenticated and exits without making a request when no credentials are stored', async () => {
    const store = await import('../config/store.js')
    vi.mocked(store.loadCredentials).mockResolvedValueOnce(null as never)

    await expect(runPredictCost({ model: 'claude-sonnet-4-5', tokens: '1200' })).rejects.toThrow(
      'process.exit(1)',
    )
    expect(fetchMock).not.toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('open core does not include'))
  })
})
