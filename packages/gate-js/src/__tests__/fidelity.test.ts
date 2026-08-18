/**
 * Cross-implementation fidelity suite.
 *
 * Proves `snapshot.evaluate()` — this package's Tier A1 — reproduces the
 * SAME block/warn/shadow verdict the shipped gate contract
 * (`services/sync-daemon/src/harness/gateBody.ts`'s `intuticGate()`, and by
 * extension every emitted shell/JS harness gate) would reach for the exact
 * pattern tables and `matches`/`notMatches` fixtures authored in
 * `services/sync-daemon/src/harness/protectedPaths.ts`.
 *
 * Scope: `evaluate()`, not the full `Gate.guard()`. The pattern tables here
 * (`GOVERNANCE_BYPASS_PATTERNS`, `SKILL_SURFACE_PATTERNS`,
 * `DESTRUCTIVE_COMMAND_PATTERNS`, the derived protected-path shell guards)
 * are exactly Tier A1's concern — SOP rules (A3), image integrity (A2), and
 * the control-plane call (B) are independently unit-tested in
 * `gate.test.ts`/`soprules.test.ts`/`imagecheck.test.ts` and have no
 * upstream fixture table to compare against.
 *
 * Each pattern is loaded into an ISOLATED one-rule `.rules` snapshot file
 * (round-tripped through the real tab-separated wire format this reader
 * parses) so a `matches`/`notMatches` assertion can never be satisfied or
 * defeated by a DIFFERENT pattern firing first — the same isolation
 * `assertGuardTableSane` gets for free by testing the compiled `RegExp`
 * directly. See `fixtures/protectedPathsFixtures.ts` for where this data
 * comes from and why it's a copy rather than a live import.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { evaluate, loadSnapshot, SEV_BLOCK, SEV_SHADOW, SEV_WARN } from '../snapshot.js'
import { allFloorFixtures, type FixturePattern } from './fixtures/protectedPathsFixtures.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'intutic-gate-fidelity-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Writes a one-rule `.rules` file (no header, so no digest/workspace check
 *  gets in the way of an isolated fidelity check) and loads it. */
function loadIsolated(p: FixturePattern) {
  const line = [p.id, p.severity, p.ignoreCase ? 'i' : '-', p.subject ?? 'any', p.reason, p.source].join('\t')
  const file = join(dir, 'policy-snapshot.rules')
  writeFileSync(file, line + '\n', 'utf-8')
  return loadSnapshot('', file)
}

function severityConst(s: 'block' | 'warn' | 'shadow'): string {
  return s === 'block' ? SEV_BLOCK : s === 'warn' ? SEV_WARN : SEV_SHADOW
}

/** Runs `evaluate()` with the fixture string as whichever subject the
 *  pattern targets — `command`/`target`/`tool`, or both for `'any'`. */
function evaluateAgainst(p: FixturePattern, snap: ReturnType<typeof loadSnapshot>, fixture: string) {
  const subject = p.subject ?? 'any'
  const toolName = subject === 'tool' ? fixture : 'shell'
  const target = subject === 'target' ? fixture : ''
  const command = subject === 'command' || subject === 'any' ? fixture : ''
  return evaluate(toolName, target, command, snap)
}

describe('fidelity: protectedPaths.ts pattern tables', () => {
  const fixtures = allFloorFixtures()

  it('loaded a non-trivial number of patterns from the fixture copy', () => {
    // A regression guard on the fixture file itself: if this drops to zero,
    // the whole suite would pass vacuously.
    expect(fixtures.length).toBeGreaterThan(15)
  })

  describe.each(fixtures.map((p) => [p.id, p] as const))('%s', (_id, p) => {
    it('fires (with the pattern-declared severity) on every `matches` fixture', () => {
      const snap = loadIsolated(p)
      expect(snap.state).toBe('ok')
      for (const fixture of p.matches) {
        const d = evaluateAgainst(p, snap, fixture)
        expect(d.severity, `expected ${p.id} to match ${JSON.stringify(fixture)}`).toBe(severityConst(p.severity))
        expect(d.ruleId).toBe(p.id)
      }
    })

    it('does NOT fire on any `notMatches` fixture', () => {
      const snap = loadIsolated(p)
      for (const fixture of p.notMatches) {
        const d = evaluateAgainst(p, snap, fixture)
        expect(d.severity, `expected ${p.id} NOT to match ${JSON.stringify(fixture)}`).toBeNull()
      }
    })
  })
})
