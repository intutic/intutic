/**
 * anomaly/index.ts — Public entry point for Phase 2 anomaly detection:
 * disposition resolution (the config promotion-invariant) and the reask
 * escalation constant, layered on top of `detectors.ts`'s pure detector
 * functions.
 *
 * @module
 */

import type { AnomalyFinding, Disposition } from './detectors.js'

export * from './detectors.js'

/**
 * Ported from `packages/proxy/src/plugins/anomaly/mod.rs`'s
 * `REASK_MAX_ATTEMPTS` (confirmed: `pub const REASK_MAX_ATTEMPTS: u32 = 3;`).
 * How many times one session may trip the same reask finding before it
 * hardens into an unconditional block.
 */
export const REASK_MAX_ATTEMPTS = 3

/**
 * The Rust-source-declared disposition CEILING for each of the 7 ported
 * detectors — copied from the `disposition` field each `detectors.ts`
 * function's own finding already carries, restated here as a lookup table
 * so `resolveEffectiveDisposition` can validate a config override against it
 * even when no finding fired yet (an `'off'` override skips evaluation
 * entirely — see `resolveEffectiveDisposition`).
 */
export const DETECTOR_BASE_DISPOSITION: Readonly<Record<string, Disposition>> = {
  consecutive_repeat: 'reask',
  ping_pong_cycle: 'reask',
  landmark_cycle: 'steer',
  tool_diversity_collapse: 'steer',
  code_as_action: 'kill',
  tool_poisoning: 'steer',
  dlp_escalation: 'kill',
}

const SEVERITY: Readonly<Record<Disposition | 'off', number>> = { off: 0, steer: 1, reask: 2, kill: 3 }

export type AnomalyMode = 'enforce' | 'warn' | 'off'

/**
 * Resolves the EFFECTIVE disposition for one finding, honoring:
 *
 * 1. `mode: 'off'` — this detector class is disabled outright (caller should
 *    skip evaluation before this is even called, but `'off'` is handled here
 *    too as a defensive floor).
 * 2. `mode: 'warn'` — every finding is capped at `'steer'` (report, never
 *    block), regardless of what the detector itself declared.
 * 3. A per-detector override (`mcpAnomalyOverrides`) — capped at
 *    `min(override, the detector's own Rust-declared disposition)`.
 *
 * **The invariant this function exists to enforce, mirrored from
 * `plugins/anomaly/mod.rs`'s promotion rule**: config may only ever DEMOTE a
 * finding toward `steer`/`off`, never promote it past what
 * `DETECTOR_BASE_DISPOSITION` (or, equivalently, `finding.disposition`
 * itself — the two must always agree, since `detectors.ts` never emits a
 * disposition other than each function's declared one) already declares. An
 * override of `'kill'` on `landmark_cycle` (whose Rust source only ever
 * disposes `steer`) has no effect — `min(kill, steer) = steer` — because the
 * Rust proxy has never measured `landmark_cycle`'s false-positive rate at
 * `kill` severity, and this proxy inherits that same unmeasured status
 * rather than re-deciding it locally.
 */
export function resolveEffectiveDisposition(
  finding: AnomalyFinding,
  mode: AnomalyMode,
  overrides: Readonly<Record<string, Disposition | 'off'>>,
): Disposition | 'off' {
  if (mode === 'off') return 'off'

  const modeCeiling: Disposition | 'off' = mode === 'warn' ? 'steer' : finding.disposition
  const override = overrides[finding.detectorId]

  const candidates: (Disposition | 'off')[] = [finding.disposition, modeCeiling]
  if (override !== undefined) candidates.push(override)

  // The lowest severity among: what the detector declared, what the global
  // mode ceils at, and any per-detector override — never higher than any of
  // the three, which is exactly the "only demote" guarantee.
  return candidates.reduce((min, c) => (SEVERITY[c] < SEVERITY[min] ? c : min))
}
