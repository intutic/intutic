/**
 * Decide log housekeeping: 30-day rotation, the opt-in upload with its
 * cursor, and the trace upload leaving decide logs alone.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pruneDecideLogs, uploadDecideLogs, DECIDE_UPLOAD_CURSOR, DECIDE_UPLOAD_BATCH } from '../../src/lib/decideLogs.js'
import { syncOfflineTraces } from '../../src/syncCycle.js'

const dirs: string[] = []
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'intutic-decide-logs-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  vi.unstubAllEnvs()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const NOW = Date.parse('2026-10-31T12:00:00.000Z')
const row = (i: number) => JSON.stringify({ v: 1, event: 'decide.decision', at: `2026-10-20T09:00:${String(i % 60).padStart(2, '0')}.000Z`, argsExcerpt: `{"command":"echo ${i}"}`, outcome: 'allow' })

describe('pruneDecideLogs', () => {
  it('deletes decide and state logs whose day ended more than 30 days ago, and nothing else', async () => {
    const dir = tempDir()
    const names = [
      'decide-2026-09-30.jsonl', // ended 2026-10-01T00:00Z, 30.5 days before NOW: deleted
      'decide-2026-10-01.jsonl', // ended 2026-10-02: kept
      'decide-state-2026-09-01.jsonl',
      'decide-2026-10-31.jsonl',
      'traces-2026-09-01.jsonl',
      'decide-upload.cursor',
      'decide-notes.txt',
    ]
    for (const n of names) writeFileSync(join(dir, n), 'x\n')
    expect((await pruneDecideLogs({ logsDir: dir, nowMs: NOW })).sort()).toEqual(['decide-2026-09-30.jsonl', 'decide-state-2026-09-01.jsonl'])
    expect(readdirSync(dir).sort()).toEqual(['decide-2026-10-01.jsonl', 'decide-2026-10-31.jsonl', 'decide-notes.txt', 'decide-upload.cursor', 'traces-2026-09-01.jsonl'])
  })

  it('is a no-op without a logs directory', async () => {
    expect(await pruneDecideLogs({ logsDir: join(tempDir(), 'missing'), nowMs: NOW })).toEqual([])
  })
})

describe('uploadDecideLogs', () => {
  function server(status = 200) {
    const calls: Array<{ url: string; body: { events: Array<Record<string, unknown>> }; auth: string | null }> = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init!.body)), auth: new Headers(init!.headers).get('authorization') })
      return new Response('{}', { status })
    }) as unknown as typeof fetch
    return { calls, fetchImpl }
  }

  it('sends nothing unless the workspace opted in', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'decide-2026-10-20.jsonl'), row(1) + '\n')
    const s = server()
    for (const settings of [undefined, {}, { decideLogUploadEnabled: false }, { decideLogUploadEnabled: 'true' }]) {
      expect(await uploadDecideLogs({ controlPlaneUrl: 'http://cp.test', apiKey: 'k', settings, logsDir: dir, fetchImpl: s.fetchImpl })).toBeNull()
    }
    expect(s.calls).toEqual([])
    expect(existsSync(join(dir, DECIDE_UPLOAD_CURSOR))).toBe(false)
  })

  it('uploads new whole lines once, in batches, without the excerpt unless asked, and never deletes the log', async () => {
    const dir = tempDir()
    const file = join(dir, 'decide-2026-10-20.jsonl')
    const n = DECIDE_UPLOAD_BATCH + 3
    writeFileSync(file, Array.from({ length: n }, (_, i) => row(i)).join('\n') + '\n' + '{"v":1,"half":')
    const s = server()
    const settings = { decideLogUploadEnabled: true }
    expect(await uploadDecideLogs({ controlPlaneUrl: 'http://cp.test/', apiKey: 'k', settings, logsDir: dir, fetchImpl: s.fetchImpl })).toBe(n)
    expect(s.calls.map((c) => c.body.events.length)).toEqual([DECIDE_UPLOAD_BATCH, 3])
    expect(s.calls[0]!.url).toBe('http://cp.test/api/v1/decide/events')
    expect(s.calls[0]!.auth).toBe('Bearer k')
    expect(s.calls.flatMap((c) => c.body.events).some((e) => 'argsExcerpt' in e)).toBe(false)
    expect(existsSync(file)).toBe(true)
    expect((await import('node:fs')).statSync(join(dir, DECIDE_UPLOAD_CURSOR)).mode & 0o777).toBe(0o600)

    // Nothing new: nothing sent. The half-written line, once finished, goes with the next ones.
    expect(await uploadDecideLogs({ controlPlaneUrl: 'http://cp.test', apiKey: 'k', settings, logsDir: dir, fetchImpl: s.fetchImpl })).toBe(0)
    appendFileSync(file, '"x"}\n' + row(9) + '\n')
    writeFileSync(join(dir, 'decide-2026-10-21.jsonl'), row(10) + '\n')
    const t = server()
    expect(await uploadDecideLogs({ controlPlaneUrl: 'http://cp.test', apiKey: 'k', settings: { ...settings, decideLogUploadArgs: true }, logsDir: dir, fetchImpl: t.fetchImpl })).toBe(3)
    expect(t.calls.flatMap((c) => c.body.events).map((e) => e.argsExcerpt ?? null)).toEqual([null, '{"command":"echo 9"}', '{"command":"echo 10"}'])
    expect(JSON.parse(readFileSync(join(dir, DECIDE_UPLOAD_CURSOR), 'utf8')).file).toBe('decide-2026-10-21.jsonl')
  })

  it('leaves the cursor where it was when the control plane refuses', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'decide-2026-10-20.jsonl'), row(1) + '\n')
    const refused = server(404)
    expect(await uploadDecideLogs({ controlPlaneUrl: 'http://cp.test', apiKey: 'k', settings: { decideLogUploadEnabled: true }, logsDir: dir, fetchImpl: refused.fetchImpl })).toBe(0)
    expect(existsSync(join(dir, DECIDE_UPLOAD_CURSOR))).toBe(false)
    const ok = server()
    expect(await uploadDecideLogs({ controlPlaneUrl: 'http://cp.test', apiKey: 'k', settings: { decideLogUploadEnabled: true }, logsDir: dir, fetchImpl: ok.fetchImpl })).toBe(1)
  })
})

describe('the trace upload', () => {
  it('neither sends nor deletes a decide log', async () => {
    const home = tempDir()
    vi.stubEnv('HOME', home)
    const logs = join(home, '.intutic', 'logs')
    mkdirSync(logs, { recursive: true })
    writeFileSync(join(logs, 'decide-2026-10-20.jsonl'), row(1) + '\n')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await syncOfflineTraces('http://cp.test', 'k')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(readdirSync(logs)).toEqual(['decide-2026-10-20.jsonl'])
    fetchSpy.mockRestore()
  })
})
