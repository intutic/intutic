/**
 * gateSightings.test.ts — the per-machine record of when each harness's gate
 * last wrote an event, kept by the hook-event drain for the AI inventory.
 *
 * @module
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordGateSightings, readGateSightings, sideLogSightings, mergeSightings, GATE_SIGHTINGS_RELATIVE_PATH } from '../../src/harness/gateSightings.js'
import { drainHookEvents } from '../../src/harness/claudeCodeHooks.js'

let root: string

afterEach(() => {
  vi.unstubAllGlobals()
  if (root) rmSync(root, { recursive: true, force: true })
})

function fresh(): string {
  root = mkdtempSync(join(tmpdir(), 'intutic-gate-sightings-'))
  return root
}

const NOW = new Date('2026-10-08T12:00:00.000Z')

describe('recordGateSightings', () => {
  it('keeps the newest event time per harness, whatever the event', async () => {
    fresh()
    await recordGateSightings(root, [
      { event: 'tool_allowed', harnessType: 'cursor', timestamp: '2026-10-08T10:00:00.000Z' },
      { event: 'tool_blocked', harnessType: 'cursor', timestamp: '2026-10-08T11:00:00.000Z' },
      { event: 'tool_allowed', harnessType: 'claude-code', timestamp: '2026-10-07T09:00:00.000Z' },
    ], NOW)
    await recordGateSightings(root, [
      { event: 'tool_allowed', harnessType: 'cursor', timestamp: '2026-10-08T09:00:00.000Z' },
    ], NOW)

    expect(await readGateSightings(root)).toEqual({
      cursor: { lastEventAt: '2026-10-08T11:00:00.000Z' },
      'claude-code': { lastEventAt: '2026-10-07T09:00:00.000Z' },
    })
  })

  it('records a guards_disabled event separately, so a disabled gate is visible', async () => {
    fresh()
    await recordGateSightings(root, [
      { event: 'guards_disabled', harnessType: 'codex', timestamp: '2026-10-08T08:00:00.000Z' },
      { event: 'tool_allowed', harnessType: 'codex', timestamp: '2026-10-08T08:00:01.000Z' },
    ], NOW)
    expect((await readGateSightings(root)).codex).toEqual({
      lastEventAt: '2026-10-08T08:00:01.000Z',
      guardsDisabledAt: '2026-10-08T08:00:00.000Z',
    })
  })

  it('uses the drain time for a missing, unparseable or far-future timestamp', async () => {
    fresh()
    await recordGateSightings(root, [
      { event: 'tool_allowed', harnessType: 'a' },
      { event: 'tool_allowed', harnessType: 'b', timestamp: 'yesterday' },
      { event: 'tool_allowed', harnessType: 'c', timestamp: '2027-01-01T00:00:00.000Z' },
    ], NOW)
    const seen = await readGateSightings(root)
    expect(seen.a?.lastEventAt).toBe(NOW.toISOString())
    expect(seen.b?.lastEventAt).toBe(NOW.toISOString())
    expect(seen.c?.lastEventAt).toBe(NOW.toISOString())
  })

  it('skips records that name no harness and tolerates a corrupt sightings file', async () => {
    fresh()
    mkdirSync(join(root, '.intutic', 'events'), { recursive: true })
    writeFileSync(join(root, GATE_SIGHTINGS_RELATIVE_PATH), '{not json')
    await recordGateSightings(root, [{ event: 'tool_allowed' }, 'junk', null, { event: 'tool_allowed', harnessType: 'pi' }], NOW)
    expect(Object.keys(await readGateSightings(root))).toEqual(['pi'])
  })
})

describe('drainHookEvents', () => {
  it('records sightings from the drained log even when the control plane is unreachable', async () => {
    fresh()
    mkdirSync(join(root, '.intutic', 'events'), { recursive: true })
    const log = join(root, '.intutic', 'events', 'hook-events.jsonl')
    writeFileSync(log, JSON.stringify({ event: 'tool_allowed', harnessType: 'cursor', workspaceId: 'ws_1', timestamp: '2026-10-08T07:00:00.000Z' }) + '\n')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch)

    expect(await drainHookEvents(root, 'http://127.0.0.1:1', 'vk_test')).toBe(0)

    expect((await readGateSightings(root)).cursor?.lastEventAt).toBe('2026-10-08T07:00:00.000Z')
    // Delivery failed, so the log is retained for the next attempt.
    expect(readFileSync(log, 'utf-8')).toContain('tool_allowed')
  })
})

describe('sideLogSightings', () => {
  it('reads the newest event from the gates that keep their own log, from its tail only', async () => {
    fresh()
    mkdirSync(join(root, '.intutic', 'events'), { recursive: true })
    const filler = JSON.stringify({ event: 'tool_allowed', harnessType: 'cline', timestamp: '2026-10-01T00:00:00.000Z', pad: 'x'.repeat(200) })
    const lines = Array.from({ length: 400 }, () => filler)
    lines.push(JSON.stringify({ event: 'guards_disabled', harnessType: 'cline', timestamp: '2026-10-08T06:00:00.000Z' }))
    lines.push(JSON.stringify({ event: 'tool_allowed', harnessType: 'cline', timestamp: '2026-10-08T06:00:01.000Z' }))
    writeFileSync(join(root, '.intutic', 'events', 'cline-hook-events.jsonl'), lines.join('\n') + '\n')

    expect(await sideLogSightings(root, NOW)).toEqual({
      cline: { lastEventAt: '2026-10-08T06:00:01.000Z', guardsDisabledAt: '2026-10-08T06:00:00.000Z' },
    })
  })

  it('merges two sightings field by field', () => {
    expect(mergeSightings({ lastEventAt: '2026-10-08T01:00:00.000Z' }, { lastEventAt: '2026-10-07T01:00:00.000Z', guardsDisabledAt: '2026-10-07T00:00:00.000Z' }))
      .toEqual({ lastEventAt: '2026-10-08T01:00:00.000Z', guardsDisabledAt: '2026-10-07T00:00:00.000Z' })
    expect(mergeSightings(undefined, { lastEventAt: 'x' })).toEqual({ lastEventAt: 'x' })
  })
})
