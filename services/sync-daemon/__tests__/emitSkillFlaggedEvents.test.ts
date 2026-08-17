/**
 * emitSkillFlaggedEvents.test.ts — TD-358: skill-content scan findings
 * surfaced as `skill_flagged` hook events.
 *
 * `emitSkillFlaggedEvents` is a pure-ish side-effecting function extracted
 * from `syncLoop.ts`'s per-cycle harness loop specifically so this can be
 * tested without mocking the whole sync cycle (control-plane fetch, config
 * writing, session reporting, …) — it only needs a workspace root and a
 * `facets.skills` array, the same shape `collectAgentReport` already
 * produces (see `agentReporterSkills.test.ts`).
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { emitSkillFlaggedEvents } from '../src/syncLoop.js'
import type { AgentReport } from '../src/agentReporter.js'

type Skill = AgentReport['facets']['skills'][number]

function skill(overrides: Partial<Skill>): Skill {
  return {
    name: 'my-skill',
    source: '.agents/skills',
    scanned: true,
    clean: true,
    findingsCount: 0,
    ...overrides,
  }
}

describe('emitSkillFlaggedEvents', () => {
  let workspaceRoot: string
  let eventsLog: string

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(join(tmpdir(), 'intutic-skill-flagged-'))
    eventsLog = join(workspaceRoot, '.intutic', 'events', 'hook-events.jsonl')
    await fs.mkdir(join(workspaceRoot, '.intutic', 'events'), { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true })
  })

  async function readEvents(): Promise<Array<Record<string, unknown>>> {
    if (!existsSync(eventsLog)) return []
    const text = await fs.readFile(eventsLog, 'utf8')
    return text
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l))
  }

  it('emits nothing for a clean skill', async () => {
    emitSkillFlaggedEvents({
      workspaceRoot,
      workspaceId: 'ws_1',
      harnessType: 'claude-code' as any,
      skills: [skill({ clean: true })],
      alreadyEmitted: new Set(),
    })
    expect(await readEvents()).toEqual([])
  })

  it('emits nothing for an unscanned skill (refusal-not-pass: scanned:false must not be treated as a finding)', async () => {
    emitSkillFlaggedEvents({
      workspaceRoot,
      workspaceId: 'ws_1',
      harnessType: 'claude-code' as any,
      skills: [skill({ scanned: false, clean: false, findingsCount: 0 })],
      alreadyEmitted: new Set(),
    })
    expect(await readEvents()).toEqual([])
  })

  it('emits a skill_flagged event with the correct shape for a non-clean, scanned skill', async () => {
    emitSkillFlaggedEvents({
      workspaceRoot,
      workspaceId: 'ws_1',
      harnessType: 'claude-code' as any,
      skills: [skill({ name: 'poisoned', clean: false, findingsCount: 2 })],
      alreadyEmitted: new Set(),
    })
    const events = await readEvents()
    expect(events).toHaveLength(1)
    const evt = events[0]!
    expect(evt.event).toBe('skill_flagged')
    expect(evt.workspaceId).toBe('ws_1')
    expect(evt.harnessType).toBe('claude-code')
    expect(evt.toolName).toBe('skill:poisoned')
    expect(evt.filePath).toBe('.agents/skills/poisoned/SKILL.md')
    expect(String(evt.reason)).toContain('2 finding(s)')
    expect(typeof evt.timestamp).toBe('string')
    expect(typeof evt.incidentId).toBe('string')
  })

  it('is a valid JSON line the shared drain can parse (matches HookEventSchema field names)', async () => {
    emitSkillFlaggedEvents({
      workspaceRoot,
      workspaceId: 'ws_1',
      harnessType: 'claude-code' as any,
      skills: [skill({ clean: false, findingsCount: 1 })],
      alreadyEmitted: new Set(),
    })
    const raw = await fs.readFile(eventsLog, 'utf8')
    const lines = raw.split('\n').filter((l) => l.trim())
    expect(lines).toHaveLength(1)
    expect(() => JSON.parse(lines[0]!)).not.toThrow()
  })

  it('dedupes within one cycle via the shared alreadyEmitted set, across repeated calls', async () => {
    const alreadyEmitted = new Set<string>()
    const flagged = [skill({ name: 'dup', clean: false, findingsCount: 1 })]
    // Simulates the syncLoop caller invoking this once per active harness in
    // the workspace — the same skill, scanned identically each time.
    emitSkillFlaggedEvents({ workspaceRoot, workspaceId: 'ws_1', harnessType: 'claude-code' as any, skills: flagged, alreadyEmitted })
    emitSkillFlaggedEvents({ workspaceRoot, workspaceId: 'ws_1', harnessType: 'cursor' as any, skills: flagged, alreadyEmitted })
    expect(await readEvents()).toHaveLength(1)
  })

  it('emits one event per distinct flagged skill, and skips clean ones interleaved with them', async () => {
    emitSkillFlaggedEvents({
      workspaceRoot,
      workspaceId: 'ws_1',
      harnessType: 'claude-code' as any,
      skills: [
        skill({ name: 'a', clean: false, findingsCount: 1 }),
        skill({ name: 'b', clean: true }),
        skill({ name: 'c', clean: false, findingsCount: 3 }),
      ],
      alreadyEmitted: new Set(),
    })
    const events = await readEvents()
    expect(events.map((e) => e.toolName).sort()).toEqual(['skill:a', 'skill:c'])
  })

  it('never throws when the events directory does not exist (non-fatal by design)', async () => {
    const bareRoot = await fs.mkdtemp(join(tmpdir(), 'intutic-skill-flagged-bare-'))
    try {
      expect(() =>
        emitSkillFlaggedEvents({
          workspaceRoot: bareRoot,
          workspaceId: 'ws_1',
          harnessType: 'claude-code' as any,
          skills: [skill({ clean: false, findingsCount: 1 })],
          alreadyEmitted: new Set(),
        }),
      ).not.toThrow()
    } finally {
      await fs.rm(bareRoot, { recursive: true, force: true })
    }
  })
})
