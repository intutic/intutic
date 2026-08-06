/**
 * drainHookEvents.test.ts — Unit tests for the FSEvents-driven hook event drain.
 *
 * Verifies that `drainHookEvents` correctly:
 *  - Reads `.intutic/events/hook-events.jsonl` from the workspace root
 *  - Parses and validates each JSON line
 *  - POSTs parsed events to the control plane (mocked via a local HTTP server)
 *  - Truncates the file after a successful drain
 *  - Handles an empty file gracefully (0 drained)
 *  - Handles malformed JSON lines (skips them without crashing)
 *  - Handles a non-existent events file gracefully (0 drained)
 *  - Returns the count of drained events
 *
 * Uses a real tmpdir and a real in-process HTTP server (no vi.mock).
 *
 * LLD #14 — Dual-path hook telemetry drain
 * HLD §3.14 — Hook event drain cycle
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as node_fs from 'node:fs/promises'
import * as node_path from 'node:path'
import * as node_os from 'node:os'
import * as node_http from 'node:http'
import { drainHookEvents } from '../../src/harness/claudeCodeHooks.js'

// ─── Local HTTP server (absorbs POST /api/v1/hook-events) ──────────────────

interface CapturedRequest {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  body: string
}

function createMockServer(): {
  server: node_http.Server
  captured: CapturedRequest[]
  close: () => Promise<void>
  url: string
  /** Status the next responses carry. Mutable so a test can make the control
   *  plane reject, which is the condition the retry logic turns on. */
  status: number
} {
  const captured: CapturedRequest[] = []

  const state = { status: 200 }

  const server = node_http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString() })
    req.on('end', () => {
      captured.push({
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: req.headers as Record<string, string | string[] | undefined>,
        body,
      })
      if (state.status !== 200) {
        res.writeHead(state.status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Invalid request body' }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ingested: JSON.parse(body || '{}').events?.length ?? 0 }))
    })
  })

  return {
    server,
    captured,
    url: '',
    get status() { return state.status },
    set status(v: number) { state.status = v },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

async function writeEventsLog(logPath: string, events: object[]): Promise<void> {
  await node_fs.mkdir(node_path.dirname(logPath), { recursive: true })
  const content = events.map((e) => JSON.stringify(e)).join('\n') + '\n'
  await node_fs.writeFile(logPath, content, 'utf-8')
}

async function readEventsLog(logPath: string): Promise<string> {
  try { return await node_fs.readFile(logPath, 'utf-8') } catch { return '' }
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('drainHookEvents', () => {
  let tmpRoot: string
  let eventsLog: string
  let mockCtx: ReturnType<typeof createMockServer>
  let controlPlaneUrl: string

  beforeEach(async () => {
    tmpRoot = await node_fs.mkdtemp(node_path.join(node_os.tmpdir(), 'intutic-drain-test-'))
    eventsLog = node_path.join(tmpRoot, '.intutic', 'events', 'hook-events.jsonl')

    mockCtx = createMockServer()
    await new Promise<void>((resolve) => {
      mockCtx.server.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = mockCtx.server.address() as { port: number }
    ;(mockCtx as { url: string }).url = `http://127.0.0.1:${addr.port}`
    controlPlaneUrl = mockCtx.url
  })

  afterEach(async () => {
    await mockCtx.close()
    await node_fs.rm(tmpRoot, { recursive: true, force: true })
  })

  // ── Happy path ─────────────────────────────────────────────────────

  it('returns 0 when events file does not exist', async () => {
    const count = await drainHookEvents(tmpRoot, controlPlaneUrl, 'test-api-key')
    expect(count).toBe(0)
    expect(mockCtx.captured).toHaveLength(0)
  })

  it('returns 0 when events file is empty', async () => {
    await node_fs.mkdir(node_path.dirname(eventsLog), { recursive: true })
    await node_fs.writeFile(eventsLog, '', 'utf-8')

    const count = await drainHookEvents(tmpRoot, controlPlaneUrl, 'test-api-key')
    expect(count).toBe(0)
  })

  it('drains a single tool_blocked event and truncates the file', async () => {
    const event = {
      event: 'tool_blocked',
      toolName: 'Bash',
      reason: 'SOP rule',
      workspaceId: 'ws_test_001',
      harnessType: 'claude-code',
      timestamp: new Date().toISOString(),
      incidentId: 'test-incident-01',
    }
    await writeEventsLog(eventsLog, [event])

    const count = await drainHookEvents(tmpRoot, controlPlaneUrl, 'test-api-key')

    expect(count).toBe(1)

    // File should be empty (truncated) after successful drain
    const remaining = await readEventsLog(eventsLog)
    expect(remaining.trim()).toBe('')

    // Server should have received exactly 1 POST with the event
    expect(mockCtx.captured).toHaveLength(1)
    const req = mockCtx.captured[0]!
    expect(req.method).toBe('POST')
    expect(req.url).toBe('/api/v1/hook-events')
    expect(req.headers['authorization']).toBe('Bearer test-api-key')

    const parsed = JSON.parse(req.body) as { events: object[] }
    expect(parsed.events).toHaveLength(1)
    expect((parsed.events[0] as { toolName: string }).toolName).toBe('Bash')
  })

  it('drains multiple events in a single batch POST', async () => {
    const events = [
      { event: 'tool_blocked', toolName: 'Write', reason: 'Protected file', workspaceId: 'ws_test', harnessType: 'claude-code', timestamp: new Date().toISOString() },
      { event: 'tool_allowed', toolName: 'Read', reason: '', workspaceId: 'ws_test', harnessType: 'claude-code', timestamp: new Date().toISOString() },
      { event: 'tool_blocked', toolName: 'Bash', reason: 'rm -rf pattern', workspaceId: 'ws_test', harnessType: 'cline', timestamp: new Date().toISOString() },
    ]
    await writeEventsLog(eventsLog, events)

    const count = await drainHookEvents(tmpRoot, controlPlaneUrl, 'test-api-key')
    expect(count).toBe(3)

    // File truncated
    const remaining = await readEventsLog(eventsLog)
    expect(remaining.trim()).toBe('')
  })

  it('skips malformed JSON lines without crashing, drains valid ones', async () => {
    await node_fs.mkdir(node_path.dirname(eventsLog), { recursive: true })
    await node_fs.writeFile(
      eventsLog,
      [
        JSON.stringify({ event: 'tool_blocked', toolName: 'Bash', workspaceId: 'ws_test', timestamp: new Date().toISOString() }),
        'NOT VALID JSON{{{{',
        JSON.stringify({ event: 'tool_allowed', toolName: 'Read', workspaceId: 'ws_test', timestamp: new Date().toISOString() }),
        '',
      ].join('\n'),
      'utf-8',
    )

    const count = await drainHookEvents(tmpRoot, controlPlaneUrl, 'test-api-key')
    // Should drain 2 valid events, skip 1 malformed line
    expect(count).toBe(2)
  })

  it('sends Authorization header with the provided api key', async () => {
    const event = { event: 'tool_blocked', toolName: 'Write', workspaceId: 'ws_test', timestamp: new Date().toISOString() }
    await writeEventsLog(eventsLog, [event])

    await drainHookEvents(tmpRoot, controlPlaneUrl, 'sk-test-key-abc')

    expect(mockCtx.captured[0]?.headers['authorization']).toBe('Bearer sk-test-key-abc')
  })

  it('does NOT truncate the file if no events were found', async () => {
    await node_fs.mkdir(node_path.dirname(eventsLog), { recursive: true })
    await node_fs.writeFile(eventsLog, '\n\n', 'utf-8') // only blank lines

    const count = await drainHookEvents(tmpRoot, controlPlaneUrl, 'test-api-key')
    expect(count).toBe(0)
    // File exists but is empty/blank — not deleted
    const stat = await node_fs.stat(eventsLog).catch(() => null)
    expect(stat).not.toBeNull()
  })

  // ── Rejection handling ─────────────────────────────────────────────
  //
  // The failure these exist for: a 4xx will never succeed on retry, so
  // retaining the log means re-sending the identical rejected batch forever.
  // That does not delay these events — it stops delivery of every *later* event
  // too, because the log never drains again. It happened: adding `tool_flagged`
  // to the gates without adding it to the control plane's event enum made one
  // ordinary advisory event poison every batch behind it, silently.

  it('quarantines a batch the control plane rejects with 4xx, and keeps draining', async () => {
    mockCtx.status = 400
    await writeEventsLog(eventsLog, [
      { event: 'tool_flagged', toolName: 'Bash', reason: 'flagged', workspaceId: 'ws_1' },
    ])

    const count = await drainHookEvents(tmpRoot, controlPlaneUrl, 'k')
    expect(count).toBe(0)

    // The live log is empty, so the NEXT event is not stuck behind this one.
    expect((await readEventsLog(eventsLog)).trim()).toBe('')

    // And nothing was thrown away — it is set aside for inspection.
    const rejected = await readEventsLog(eventsLog.replace(/\.jsonl$/, '.rejected.jsonl'))
    expect(rejected, 'the rejected batch was lost rather than quarantined').toContain('tool_flagged')

    // The load-bearing assertion: a later event drains normally rather than
    // being re-poisoned by the retained one.
    mockCtx.status = 200
    mockCtx.captured.length = 0
    await writeEventsLog(eventsLog, [
      { event: 'tool_blocked', toolName: 'Bash', reason: 'blocked', workspaceId: 'ws_1' },
    ])
    const second = await drainHookEvents(tmpRoot, controlPlaneUrl, 'k')
    expect(second, 'the pipeline stayed wedged after a 4xx').toBe(1)
    expect(mockCtx.captured[0]?.body).toContain('tool_blocked')
    expect(mockCtx.captured[0]?.body, 'the rejected batch was re-sent').not.toContain('tool_flagged')
  })

  it('retains the log on 5xx, because that one is worth retrying', async () => {
    mockCtx.status = 503
    await writeEventsLog(eventsLog, [
      { event: 'tool_blocked', toolName: 'Bash', reason: 'x', workspaceId: 'ws_1' },
    ])

    const count = await drainHookEvents(tmpRoot, controlPlaneUrl, 'k')
    expect(count).toBe(0)
    expect(
      await readEventsLog(eventsLog),
      'a transient server error must not discard the batch',
    ).toContain('tool_blocked')
    expect(
      await readEventsLog(eventsLog.replace(/\.jsonl$/, '.rejected.jsonl')),
      'a 5xx must not quarantine — it is retryable',
    ).toBe('')
  })
})
