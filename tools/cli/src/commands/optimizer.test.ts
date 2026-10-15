/**
 * `intutic optimizer` against a mocked control plane: `settings` reads
 * `GET /api/v1/dream-cycle/settings`, `set` sends the whole object the PUT
 * requires (keeping the current threshold when `--auto-threshold` is
 * omitted), refuses a bad flag before sending anything, and prints the
 * server's message and exits 1 on a refusal.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'

vi.mock('../config/store.js', () => ({
  loadCredentials: vi.fn(async () => ({ apiKey: 'vk_test_key', workspaceId: 'ws_test' })),
  loadConfig: vi.fn(() => ({ devMode: false })),
}))

vi.mock('../config/paths.js', () => ({
  resolveControlPlaneUrl: vi.fn(() => 'https://api.test.invalid'),
}))

import { runOptimizerSettings, runOptimizerSet } from './optimizer.js'

const URL_ = 'https://api.test.invalid/api/v1/dream-cycle/settings'

function reply(status: number, body: unknown) {
  const text = JSON.stringify(body)
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(text),
    text: async () => text,
  })
}

const settings = (mode: string, autoThreshold: number) => ({ ok: true, settings: { workspaceId: 'ws_test', mode, autoThreshold } })

let fetchMock: ReturnType<typeof vi.fn>
let logSpy: MockInstance<typeof console.log>
let errSpy: MockInstance<typeof console.error>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`)
  }) as never)
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const printed = () => logSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n')
const errors = () => errSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n')

describe('intutic optimizer settings', () => {
  it('reads GET /api/v1/dream-cycle/settings and prints the settings as JSON with --json', async () => {
    fetchMock.mockReturnValueOnce(reply(200, settings('auto', 0.9)))
    await runOptimizerSettings({ json: true })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(URL_)
    expect(init.method).toBe('GET')
    expect(JSON.parse(printed())).toEqual({ workspaceId: 'ws_test', mode: 'auto', autoThreshold: 0.9 })
  })

  it('renders the mode and threshold without --json', async () => {
    fetchMock.mockReturnValueOnce(reply(200, settings('manual', 0.85)))
    await runOptimizerSettings({})
    expect(printed()).toContain('manual')
    expect(printed()).toContain('0.85')
  })
})

describe('intutic optimizer set', () => {
  it('keeps the current threshold when --auto-threshold is omitted: reads it, then PUTs the whole object', async () => {
    fetchMock.mockReturnValueOnce(reply(200, settings('manual', 0.72))).mockReturnValueOnce(reply(200, settings('auto', 0.72)))
    await runOptimizerSet({ mode: 'auto', json: true })
    expect(fetchMock.mock.calls.map(([, init]) => init.method)).toEqual(['GET', 'PUT'])
    const [url, init] = fetchMock.mock.calls[1]!
    expect(url).toBe(URL_)
    expect(JSON.parse(init.body)).toEqual({ mode: 'auto', autoThreshold: 0.72 })
    expect(JSON.parse(printed())).toEqual({ workspaceId: 'ws_test', mode: 'auto', autoThreshold: 0.72 })
  })

  it('sends --auto-threshold as a number without reading first', async () => {
    fetchMock.mockReturnValueOnce(reply(200, settings('auto', 0.95)))
    await runOptimizerSet({ mode: 'auto', autoThreshold: '0.95' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0]!
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body)).toEqual({ mode: 'auto', autoThreshold: 0.95 })
  })

  it.each([
    [{ mode: 'sometimes' }, '--mode must be manual or auto'],
    [{ mode: 'auto', autoThreshold: '1.5' }, '--auto-threshold must be a number from 0 to 1'],
    [{ mode: 'auto', autoThreshold: 'high' }, '--auto-threshold must be a number from 0 to 1'],
    [{ mode: 'auto', autoThreshold: '' }, '--auto-threshold must be a number from 0 to 1'],
  ])('refuses %o before sending anything', async (opts, message) => {
    await expect(runOptimizerSet(opts)).rejects.toThrow('process.exit(1)')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(errors()).toContain(message)
  })

  it("prints the server's refusal and exits 1", async () => {
    fetchMock.mockReturnValueOnce(reply(403, { error: 'Forbidden', detail: 'Requires one of: OWNER, ADMIN' }))
    await expect(runOptimizerSet({ mode: 'manual', autoThreshold: '0.85' })).rejects.toThrow('process.exit(1)')
    expect(errors()).toContain('Failed to set the SOP Optimizer approval mode')
    expect(errors()).toContain('OWNER, ADMIN')
  })
})
