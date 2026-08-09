// One list, one evaluator — enforced structurally.
//
// This file used to read each harness's own `const PROTECTED_PATHS` out of its
// source and check it was a superset of the shared list. That was the right test
// for a world with eleven hand-maintained copies, and it had a bug that world
// made invisible: coverage was keyed on *finding* the constant, so a harness
// that declared none was indistinguishable from a file that was not a harness.
// `clineHooks` hand-rolled `PROTECTED_PATH_FRAGMENTS` with four of the twelve
// paths missing and never appeared in the results. Its `.endsWith('Hooks.ts')`
// filter separately excluded both `*HooksWriter.ts` files.
//
// There is now one list and one emitted evaluator, so the superset question is
// gone. What replaces it is the inverse: **no writer may reintroduce a private
// copy**. That is a negative assertion, and a negative assertion cannot be
// defeated by failing to match — which is exactly how the old one failed.
//
// Whether the gates actually *behave* is `generatedGateBehaviour.test.ts`, which
// runs every emitted artifact against every fixture. This file is only about
// structure.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  GOVERNANCE_BYPASS_PATTERNS,
  protectedPathShellPatterns,
} from '../src/harness/protectedPaths.js'
import { GATES, NO_GATE } from './harness/gateRegistry.js'

const HARNESS_DIR = join(__dirname, '../src/harness')

/**
 * Every file in the harness directory, minus the shared machinery.
 *
 * Deliberately NOT `*Hooks.ts`-shaped. A filename filter is how the previous
 * version of this suite went blind: it excluded both `*HooksWriter.ts` files, so
 * neither half of the double-gate defect was ever scanned, and it also missed
 * `aiderConfigMerger.ts`, `gooseHardener.ts`, `mcpAutoWrite.ts` and
 * `cursorHooksJson.ts` — one of which turned out to be writing another writer's
 * artifact. Everything is in scope unless it is named here as shared code.
 */
const SHARED_MACHINERY = new Set(['protectedPaths.ts', 'gateBody.ts'])

function harnessFiles(): string[] {
  return readdirSync(HARNESS_DIR).filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.d.ts') && !SHARED_MACHINERY.has(f),
  )
}

describe('harness protected paths', () => {
  it('finds the harness writers at all', () => {
    // Guards the filter above. If it stopped matching, every assertion below
    // would iterate nothing and report perfect compliance — a green build
    // asserting that files nobody read are correct.
    expect(harnessFiles().length, 'no harness writers found — the filter broke').toBeGreaterThanOrEqual(12)
  })

  it('no writer keeps a private protected-path or bypass list', () => {
    // The whole point. Eleven copies of a security control is eleven chances for
    // one to be wrong, and every one of them was.
    const banned: Array<[RegExp, string]> = [
      [/const\s+PROTECTED_PATH/, 'a private protected-path list'],
      [/const\s+BYPASS_PATTERNS/, 'a private bypass-pattern list'],
      [/const\s+dangerPatterns/, 'a private danger-pattern list'],
    ]
    const offenders: string[] = []
    for (const file of harnessFiles()) {
      const src = readFileSync(join(HARNESS_DIR, file), 'utf-8')
      for (const [probe, what] of banned) {
        if (probe.test(src)) offenders.push(`${file} declares ${what}`)
      }
    }
    expect(
      offenders,
      `These writers hold their own copy of a shared security control. Use ` +
        `staticFloorPatterns() via harness/gateBody.ts instead — a second copy ` +
        `is how the first eleven drifted.`,
    ).toEqual([])
  })

  it('every gate writer emits the shared evaluator', () => {
    // The positive half. Without it, a writer could satisfy the negative
    // assertion above by having no guard at all.
    // Every gate, with no exemptions — including the Python one. openWebui
    // enforces less than the others by design, but it enforces *the same table*,
    // and an exemption here is how a harness stops being checked at all.
    const missing: string[] = []
    for (const g of GATES) {
      const file = g.module.split('/').pop()!.replace(/\.js$/, '.ts')
      const src = readFileSync(join(HARNESS_DIR, file), 'utf-8')
      if (!/emitShellGate|emitJsGate|emitPythonGate|emitN8nWorkflowGate/.test(src)) missing.push(file)
    }
    expect(
      missing,
      `These writers emit a gate that does not come from harness/gateBody.ts.`,
    ).toEqual([])
  })

  it('accounts for every harness writer in the registry', () => {
    const covered = new Set([
      ...GATES.map((g) => g.module.split('/').pop()!.replace(/\.js$/, '.ts')),
      ...NO_GATE.map((n) => n.file),
    ])
    expect(harnessFiles().filter((f) => !covered.has(f))).toEqual([])
  })

  /**
   * The block reason must carry the words the severity classifier keys on.
   *
   * `hookEvents.ts:412` resolves severity with
   * `if (reason.toLowerCase().includes('governance-protected')) return 'CRITICAL'`,
   * and `:420` classifies the anomaly kind on that or on "bypass pattern". This
   * was already a live defect once: `windsurfHooks` emitted "Attempt to modify
   * protected path" — one word short — so a Windsurf agent caught tampering with
   * governance config was filed MEDIUM, and whatever routes on CRITICAL never
   * saw it.
   *
   * The coupling survived the rewrite in a new form. Reasons now travel with the
   * rule through the `.rules` wire format instead of being built at block time,
   * so this asserts on the rule table — one place, thirteen gates.
   */
  it('every rule reason carries the keyword the severity classifier reads', () => {
    for (const p of protectedPathShellPatterns()) {
      expect(
        p.reason.toLowerCase(),
        `${p.id} would be filed MEDIUM instead of CRITICAL by hookEvents.resolveSeverity`,
      ).toContain('governance-protected')
    }
    for (const p of GOVERNANCE_BYPASS_PATTERNS) {
      expect(
        p.reason.toLowerCase(),
        `${p.id} would not be classified UNAUTHORIZED_TOOL by hookEvents.resolveSeverity`,
      ).toContain('bypass pattern')
    }
  })

  /**
   * A reason containing a tab would silently truncate the rule.
   *
   * The `.rules` projection is tab-separated with `source` last, so a tab in the
   * reason shifts the source into the reason column and the rule stops matching
   * anything. `toRulesLine` strips them; this asserts nobody is relying on that.
   */
  it('no rule reason contains a tab', () => {
    for (const p of [...protectedPathShellPatterns(), ...GOVERNANCE_BYPASS_PATTERNS]) {
      expect(p.reason, `${p.id} has a tab in its reason`).not.toMatch(/\t/)
    }
  })
})
