/**
 * resolveSecurityProbeSampleRate (Wave 7, audit-remediation) — clamps a
 * stored `securityProbeSampleRate` to the safe (unblinded) side of any bad
 * value. See the field's doc comment in workspaceSettings.ts.
 */
import { describe, it, expect } from 'vitest'
import { resolveSecurityProbeSampleRate, DEFAULT_WORKSPACE_SETTINGS } from '../workspaceSettings.js'

describe('resolveSecurityProbeSampleRate', () => {
  it('defaults to 1.0 for a workspace that never configured this', () => {
    expect(resolveSecurityProbeSampleRate(DEFAULT_WORKSPACE_SETTINGS)).toBe(1.0)
  })

  it('returns a genuine in-range value verbatim', () => {
    expect(
      resolveSecurityProbeSampleRate({ ...DEFAULT_WORKSPACE_SETTINGS, securityProbeSampleRate: 0.25 }),
    ).toBe(0.25)
    expect(
      resolveSecurityProbeSampleRate({ ...DEFAULT_WORKSPACE_SETTINGS, securityProbeSampleRate: 0 }),
    ).toBe(0)
  })

  it('resolves an out-of-range value to 1.0, never to 0 (must not silently blind detection)', () => {
    expect(
      resolveSecurityProbeSampleRate({ ...DEFAULT_WORKSPACE_SETTINGS, securityProbeSampleRate: -1 }),
    ).toBe(1.0)
    expect(
      resolveSecurityProbeSampleRate({ ...DEFAULT_WORKSPACE_SETTINGS, securityProbeSampleRate: 1.5 }),
    ).toBe(1.0)
  })

  it('resolves a non-finite or malformed value to 1.0', () => {
    expect(
      resolveSecurityProbeSampleRate({ ...DEFAULT_WORKSPACE_SETTINGS, securityProbeSampleRate: NaN }),
    ).toBe(1.0)
    expect(
      resolveSecurityProbeSampleRate({
        ...DEFAULT_WORKSPACE_SETTINGS,
        securityProbeSampleRate: 'not-a-number' as unknown as number,
      }),
    ).toBe(1.0)
  })
})
