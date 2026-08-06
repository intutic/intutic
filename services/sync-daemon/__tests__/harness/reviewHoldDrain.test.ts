/**
 * The daemon half of the review-hold seam.
 *
 * Two things are being pinned here, and the second is the one that has already
 * cost a production outage.
 *
 * **Append, do not overwrite.** The hook wrote a single `review-request.json`
 * with `writeFileSync`, so a second hold inside one drain window destroyed the
 * first. Holds cluster — an agent that trips a review rule usually trips it
 * again on its next step — so the common case was the lossy one.
 *
 * **A 4xx must quarantine, not retain.** TD-310: the drain treats any non-2xx as
 * "keep the log and retry", which for a permanently-unacceptable batch means
 * re-sending it every cycle forever. The log never drains again and every later
 * record behind it is lost, silently. That logic is now shared with the hook
 * event drain rather than copied, because a second hand-written copy is a second
 * chance to get it wrong.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  drainReviewRequests,
  REVIEW_REQUESTS_LOG,
  REVIEW_REQUEST_VERSION,
} from '../../src/harness/claudeCodeHooks.js'

let root: string
let logPath: string
const CP = 'https://cp.test'

const hold = (n: number) =>
  JSON.stringify({
    v: REVIEW_REQUEST_VERSION,
    holdId: `hold_${n}`,
    reason: 'action:deploy',
    tool: 'Bash',
    sessionId: 'ses_1',
    at: new Date('2026-08-05T12:00:00.000Z').toISOString(),
    context: { tool: 'Bash', reason: 'action:deploy', toolInput: { command: 'git push' } },
  })

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'intutic-holds-'))
  logPath = join(root, REVIEW_REQUESTS_LOG)
  await mkdir(join(root, '.intutic', 'events'), { recursive: true })
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(root, { recursive: true, force: true })
})

describe('draining review holds', () => {
  it('is a no-op when nothing has been held', async () => {
    expect(await drainReviewRequests(root, CP, 'k')).toBe(0)
  })

  it('delivers every line, not just the last', async () => {
    await writeFile(logPath, [hold(1), hold(2), hold(3)].join('\n') + '\n')

    let sent: { holds: unknown[] } | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        sent = JSON.parse(init.body)
        return { ok: true, status: 200, text: async () => '' }
      }),
    )

    const drained = await drainReviewRequests(root, CP, 'k')
    expect(drained, 'a single-file writer would have delivered one').toBe(3)
    expect(sent!.holds).toHaveLength(3)
    expect(await readFile(logPath, 'utf-8'), 'the log must be truncated on success').toBe('')
  })

  it('posts to the decisions endpoint under the holds key', async () => {
    await writeFile(logPath, hold(1) + '\n')
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }))
    vi.stubGlobal('fetch', fetchMock)

    await drainReviewRequests(root, CP, 'secret-key')

    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string>; body: string }]
    expect(url).toBe(`${CP}/api/v1/decisions`)
    expect(init.headers['Authorization']).toBe('Bearer secret-key')
    expect(Object.keys(JSON.parse(init.body))).toEqual(['holds'])
  })

  it('quarantines a 4xx instead of wedging the log forever', async () => {
    await writeFile(logPath, [hold(1), hold(2)].join('\n') + '\n')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 422, text: async () => 'unprocessable' })),
    )

    expect(await drainReviewRequests(root, CP, 'k')).toBe(0)
    expect(
      await readFile(logPath, 'utf-8'),
      'retaining a batch that can never be accepted stops every later hold too',
    ).toBe('')
    const quarantined = logPath.replace(/\.jsonl$/, '.rejected.jsonl')
    expect(existsSync(quarantined), 'the batch must be recoverable, not dropped').toBe(true)
    expect((await readFile(quarantined, 'utf-8')).trim().split('\n')).toHaveLength(2)
  })

  it('retains a 5xx, because that one really is transient', async () => {
    await writeFile(logPath, hold(1) + '\n')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503, text: async () => 'later' })),
    )

    expect(await drainReviewRequests(root, CP, 'k')).toBe(0)
    expect(await readFile(logPath, 'utf-8'), 'a retryable failure must keep the record').not.toBe('')
  })

  it('retains on a network failure', async () => {
    await writeFile(logPath, hold(1) + '\n')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      }),
    )

    expect(await drainReviewRequests(root, CP, 'k')).toBe(0)
    expect(await readFile(logPath, 'utf-8')).not.toBe('')
  })

  it('skips a malformed line without losing the good ones', async () => {
    await writeFile(logPath, [hold(1), '{not json', hold(2)].join('\n') + '\n')
    let sent: { holds: unknown[] } | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, init: { body: string }) => {
        sent = JSON.parse(init.body)
        return { ok: true, status: 200, text: async () => '' }
      }),
    )

    expect(await drainReviewRequests(root, CP, 'k')).toBe(2)
    expect(sent!.holds).toHaveLength(2)
  })

  it('does not call the control plane when every line is garbage', async () => {
    await writeFile(logPath, '{oops\n{also oops\n')
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }))
    vi.stubGlobal('fetch', fetchMock)

    expect(await drainReviewRequests(root, CP, 'k')).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await readFile(logPath, 'utf-8'), 'garbage must still clear, or it wedges').toBe('')
  })
})
