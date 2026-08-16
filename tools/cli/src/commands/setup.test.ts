/**
 * `intutic setup` — driven through the injected SetupIO adapter, no TTY
 * needed. A FakeIO consumes a scripted queue of answers and records every
 * call, so a test can assert both what the user was asked and what the
 * command did with each answer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('./init.js', () => ({ findWorkspaceRoot: vi.fn(() => null) }))
vi.mock('../harness/detector.js', () => ({ detectHarnesses: vi.fn(async () => []) }))
vi.mock('../config/store.js', () => ({ loadCredentials: vi.fn(async () => ({ apiKey: 'vk_test', email: 'dev@example.com' })) }))
vi.mock('../config/paths.js', () => ({ resolveControlPlaneUrl: vi.fn(() => 'https://api.test.invalid') }))

// vi.mock factories are hoisted above top-level const declarations, so the
// mocks they reference must be created via vi.hoisted() rather than a plain
// `const` above them.
const { putMock, postMock, probeMock } = vi.hoisted(() => ({ putMock: vi.fn(), postMock: vi.fn(), probeMock: vi.fn() }))
vi.mock('../lib/api.js', () => ({ createApiClient: () => ({ put: putMock, post: postMock }) }))
vi.mock('../lib/providerProbe.js', () => ({ probeProviderCredential: probeMock }))

import { runSetup, CANCELLED, type SetupIO } from './setup.js'
import { findWorkspaceRoot } from './init.js'
import { loadCredentials } from '../config/store.js'

/** Consumes a scripted queue of answers, recording every call it serves. */
class FakeIO implements SetupIO {
  calls: Array<{ method: string; arg: unknown }> = []
  private queue: unknown[]

  constructor(answers: unknown[]) {
    this.queue = [...answers]
  }

  private next(method: string, arg: unknown) {
    this.calls.push({ method, arg })
    if (this.queue.length === 0) throw new Error(`FakeIO: no scripted answer left for ${method}(${JSON.stringify(arg)})`)
    return this.queue.shift()
  }

  intro(msg: string) { this.calls.push({ method: 'intro', arg: msg }) }
  outro(msg: string) { this.calls.push({ method: 'outro', arg: msg }) }
  note(msg: string, title?: string) { this.calls.push({ method: 'note', arg: { msg, title } }) }
  log = {
    info: (msg: string) => this.calls.push({ method: 'log.info', arg: msg }),
    success: (msg: string) => this.calls.push({ method: 'log.success', arg: msg }),
    warn: (msg: string) => this.calls.push({ method: 'log.warn', arg: msg }),
    error: (msg: string) => this.calls.push({ method: 'log.error', arg: msg }),
  }
  async select<T extends string>(opts: { message: string; options: Array<{ value: T }> }) {
    return this.next('select', opts.message) as T | typeof CANCELLED
  }
  async text(opts: { message: string }) {
    return this.next('text', opts.message) as string | typeof CANCELLED
  }
  async password(opts: { message: string }) {
    return this.next('password', opts.message) as string | typeof CANCELLED
  }
  async confirm(opts: { message: string }) {
    return this.next('confirm', opts.message) as boolean | typeof CANCELLED
  }
}

beforeEach(() => {
  putMock.mockReset().mockResolvedValue({})
  postMock.mockReset().mockResolvedValue({ ok: true, provider: 'anthropic', latencyMs: 250 })
  probeMock.mockReset().mockResolvedValue({ status: 'valid', detail: 'looks valid' })
})

describe('runSetup — connected mode', () => {
  it('happy path: provider -> credential -> verify -> save -> judge model, hitting the same PUT routes the standalone commands use', async () => {
    const io = new FakeIO([
      'connected', // mode
      'anthropic', // provider
      'sk-ant-test-key-1234567890', // apiKey (password prompt)
      true, // wantJudge
      'anthropic/claude-haiku-4-5', // judge model select
    ])

    await runSetup({}, io)

    expect(putMock).toHaveBeenNthCalledWith(1, '/api/v1/workspace/provider-credentials/anthropic', {
      apiKey: 'sk-ant-test-key-1234567890',
    })
    expect(putMock).toHaveBeenNthCalledWith(2, '/api/v1/workspace/settings', {
      managedJudgeModel: 'anthropic/claude-haiku-4-5',
    })
    // The same round-trip the dashboard's JudgeModelPanel Test button runs,
    // fired automatically after the save -- not just a PUT-and-hope.
    expect(postMock).toHaveBeenCalledWith('/api/v1/workspace/judge-model/test', {
      model: 'anthropic/claude-haiku-4-5',
    })
    expect(io.calls.some((c) => c.method === 'log.success' && String(c.arg).includes('credential saved'))).toBe(true)
    expect(io.calls.some((c) => c.method === 'log.success' && String(c.arg).includes('Judge model verified'))).toBe(true)
  })

  it('a failed judge-model test reports the stage but does not undo the already-saved setting', async () => {
    postMock.mockResolvedValue({ ok: false, stage: 'completion', error: 'upstream returned 500' })
    const io = new FakeIO([
      'connected',
      'anthropic',
      'sk-ant-test-key-1234567890',
      true,
      'anthropic/claude-haiku-4-5',
    ])

    await runSetup({}, io)

    // The setting is saved regardless of the test outcome.
    expect(putMock).toHaveBeenNthCalledWith(2, '/api/v1/workspace/settings', {
      managedJudgeModel: 'anthropic/claude-haiku-4-5',
    })
    expect(
      io.calls.some((c) => c.method === 'log.warn' && String(c.arg).includes('failed at the completion stage')),
    ).toBe(true)
  })

  it('an invalid credential (401) prompts to save anyway, and declining cancels before any PUT', async () => {
    probeMock.mockResolvedValue({ status: 'invalid', detail: 'rejected the credential (HTTP 401)' })
    const io = new FakeIO([
      'connected',
      'openai',
      'sk-bad-key-1234567890',
      false, // "save anyway?" -> no
    ])

    await runSetup({}, io)

    expect(putMock).not.toHaveBeenCalled()
    expect(io.calls.at(-1)).toEqual({ method: 'outro', arg: 'Cancelled.' })
  })

  it('an invalid credential CAN be saved if the operator confirms', async () => {
    probeMock.mockResolvedValue({ status: 'invalid', detail: 'rejected the credential (HTTP 401)' })
    const io = new FakeIO([
      'connected',
      'openai',
      'sk-bad-key-1234567890',
      true, // "save anyway?" -> yes
      false, // wantJudge -> no
    ])

    await runSetup({}, io)
    expect(putMock).toHaveBeenCalledWith('/api/v1/workspace/provider-credentials/openai', { apiKey: 'sk-bad-key-1234567890' })
  })

  it('not authenticated + connected mode refuses before any prompt for credentials', async () => {
    vi.mocked(loadCredentials).mockResolvedValueOnce(null)
    const io = new FakeIO(['connected'])

    await runSetup({}, io)
    expect(io.calls.some((c) => c.method === 'log.error' && String(c.arg).includes('Not authenticated'))).toBe(true)
    expect(putMock).not.toHaveBeenCalled()
  })

  it('skipping the judge-model step sends no settings PUT', async () => {
    const io = new FakeIO(['connected', 'anthropic', 'sk-ant-test-key-1234567890', false])
    await runSetup({}, io)
    expect(putMock).toHaveBeenCalledTimes(1) // credential only, no settings PUT
  })
})

describe('runSetup — local mode', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'intutic-setup-test-'))
    vi.mocked(findWorkspaceRoot).mockReturnValue(tmpDir)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('writes an env file with the credential and never calls the control plane', async () => {
    const io = new FakeIO([
      'local',
      'anthropic',
      'sk-ant-local-key-1234567890',
      false, // wantJudge
    ])

    await runSetup({}, io)

    expect(putMock).not.toHaveBeenCalled()
    const written = readFileSync(join(tmpDir, '.intutic.env'), 'utf-8')
    expect(written).toContain('INTUTIC_ANTHROPIC_APIKEY=sk-ant-local-key-1234567890')
    // The note shown to the operator must redact the value, even though the
    // file on disk necessarily has to contain it.
    const noteCall = io.calls.find((c) => c.method === 'note' && String((c.arg as { title?: string }).title).includes('.intutic.env'))
    expect(noteCall).toBeDefined()
    expect(JSON.stringify(noteCall)).not.toContain('sk-ant-local-key-1234567890')
  })
})
