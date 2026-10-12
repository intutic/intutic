// The offline trajectory spool keeps only what a retry could deliver.
//
// It used to keep every summary the control plane did not accept, and retry
// each line on every submit interval until the 16MB size cap. A summary the
// control plane refuses on its merits (403 for another workspace's summary, 400
// for a malformed one) is refused again on every retry, so those lines are now
// dropped with one warn naming the session and status. 401, 408, 429, 5xx and
// network errors keep retrying.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const warn = vi.hoisted(() => vi.fn())
vi.mock('@intutic/logger', () => ({
  createLogger: () => ({ warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}))

import { TrajectoryMonitor, TrajectoryBuffer, isRetryableRefusal, type TraceEvent } from '../src/trajectoryMonitor.js'

const CP = 'http://cp.test'

function event(sessionId: string): TraceEvent {
  return {
    sessionId,
    workspaceId: 'ws_t',
    toolName: 'coding',
    tools: ['Bash'],
    model: 'claude-sonnet-4-5',
    inputTokens: 100,
    outputTokens: 50,
    status: 'success',
    timestamp: new Date().toISOString(),
  }
}

/** Answers `/healthz` 200, and each analyze POST by the status the summary's session names (`ses_403` → 403); `ses_net` throws. */
function controlPlane() {
  return vi.fn(async (url: string, init?: { body?: string }) => {
    if (url === `${CP}/healthz`) return new Response('{}', { status: 200 })
    const { sessionId } = JSON.parse(init!.body!) as { sessionId: string }
    if (sessionId === 'ses_net') throw new TypeError('fetch failed')
    const status = Number(sessionId.slice('ses_'.length))
    return new Response('{}', { status })
  })
}

describe('offline trajectory spool', () => {
  let home: string
  let homeBefore: string | undefined
  let spool: string
  let monitor: TrajectoryMonitor

  beforeEach(() => {
    homeBefore = process.env.HOME
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'traj-spool-'))
    process.env.HOME = home
    spool = path.join(home, '.intutic', 'events', 'offline-trajectories.jsonl')
    monitor = new TrajectoryMonitor({ valkeyUrl: '', controlPlaneUrl: CP, apiKey: 'vk_test' })
    warn.mockClear()
    vi.stubGlobal('fetch', controlPlane())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    process.env.HOME = homeBefore
    fs.rmSync(home, { recursive: true, force: true })
  })

  const spooledSessions = () =>
    fs.existsSync(spool)
      ? fs.readFileSync(spool, 'utf-8').split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { sessionId: string }).sessionId)
      : []

  async function submit(sessionId: string) {
    const buffer = new TrajectoryBuffer(sessionId, 'ws_t')
    buffer.push(event(sessionId))
    await monitor['submitSummary'](buffer)
  }

  it('classifies statuses: 4xx is final except 401, 408 and 429', () => {
    for (const s of [400, 403, 404, 409, 410, 413, 422]) expect(isRetryableRefusal(s), String(s)).toBe(false)
    for (const s of [401, 408, 429, 500, 502, 503, 504]) expect(isRetryableRefusal(s), String(s)).toBe(true)
  })

  describe('a fresh submission', () => {
    it('refused 403 is not spooled, with one warn naming the session and status', async () => {
      await submit('ses_403')
      expect(spooledSessions()).toEqual([])
      expect(warn).toHaveBeenCalledTimes(1)
      const [fields, message] = warn.mock.calls[0]!
      expect(fields).toEqual({ sessionId: 'ses_403', status: 403 })
      expect(message).not.toContain('Bash')
    })

    it.each(['ses_429', 'ses_503', 'ses_401', 'ses_net'])('%s is spooled for a retry', async (sessionId) => {
      await submit(sessionId)
      expect(spooledSessions()).toEqual([sessionId])
    })
  })

  describe('the drain', () => {
    it('drops a 403 line with one warn and keeps 429, 503, 401 and network-error lines', async () => {
      const lines = ['ses_403', 'ses_429', 'ses_503', 'ses_401', 'ses_net'].map((sessionId) =>
        JSON.stringify({ sessionId, workspaceId: 'ws_t', uniqueTools: ['Bash'] }),
      )
      fs.mkdirSync(path.dirname(spool), { recursive: true })
      fs.writeFileSync(spool, lines.join('\n') + '\n')

      await monitor['drainOfflineTrajectories']()

      expect(spooledSessions()).toEqual(['ses_429', 'ses_503', 'ses_401', 'ses_net'])
      expect(warn).toHaveBeenCalledTimes(1)
      const [fields, message] = warn.mock.calls[0]!
      expect(fields).toEqual({ sessionId: 'ses_403', status: 403 })
      expect(JSON.stringify(fields) + String(message)).not.toContain('Bash')
    })

    it('removes the spool once every line is delivered or dropped', async () => {
      fs.mkdirSync(path.dirname(spool), { recursive: true })
      fs.writeFileSync(spool, JSON.stringify({ sessionId: 'ses_200' }) + '\n' + JSON.stringify({ sessionId: 'ses_400' }) + '\n')
      await monitor['drainOfflineTrajectories']()
      expect(fs.existsSync(spool)).toBe(false)
    })
  })
})
