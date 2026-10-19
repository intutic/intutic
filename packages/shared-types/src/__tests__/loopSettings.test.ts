/**
 * The loop, lane and revert-lane workspace settings: their defaults, the readers the control
 * plane serves from, and the response schema that reads stored settings back.
 */
import { describe, expect, it } from 'vitest'
import { ResolvedWorkspaceSettings } from '../responses/gateways.js'
import { DEFAULT_WORKSPACE_SETTINGS, REVERT_LANE_DEFAULTS, readClosedLanes, readRequireVerifiedCompletion, readRevertLane, resolveWorkspaceSettings } from '../workspaceSettings.js'

describe('loop, lane and revert-lane settings', () => {
  it('default off', () => {
    expect(DEFAULT_WORKSPACE_SETTINGS.loop_review).toEqual({ requireDistinctApprover: false, requireVerifiedCompletion: false })
    expect(DEFAULT_WORKSPACE_SETTINGS.revertLane).toEqual({ mode: 'off' })
    expect(DEFAULT_WORKSPACE_SETTINGS.closedLanes).toBeUndefined()
    expect(readRequireVerifiedCompletion(DEFAULT_WORKSPACE_SETTINGS)).toBe(false)
    expect(readClosedLanes(DEFAULT_WORKSPACE_SETTINGS)).toBeUndefined()
    expect(readRevertLane(DEFAULT_WORKSPACE_SETTINGS)).toEqual(REVERT_LANE_DEFAULTS)
  })

  it('reads what is stored, only when it is valid', () => {
    expect(readRequireVerifiedCompletion({ loop_review: { requireVerifiedCompletion: true } })).toBe(true)
    expect(readRequireVerifiedCompletion({ loop_review: { requireVerifiedCompletion: 'true' } })).toBe(false)
    expect(readClosedLanes({ closedLanes: ['reversible_wide', 'bogus', 'irreversible'] })).toEqual(['irreversible', 'reversible_wide'])
    expect(readRevertLane({ revertLane: { mode: 'enforce', threshold: 0.5, minExecutions: 0, windowDays: 400 } })).toEqual({
      mode: 'enforce',
      threshold: 0.5,
      minExecutions: 20,
      minReversals: 3,
      windowDays: 30,
    })
    expect(readRevertLane({ revertLane: { mode: 'on' } }).mode).toBe('off')
  })

  it('round-trips through the response schema', () => {
    const settings = resolveWorkspaceSettings({
      loop_review: { requireDistinctApprover: true, requireVerifiedCompletion: true },
      closedLanes: ['irreversible'],
      revertLane: { mode: 'shadow', threshold: 0.3 },
    })
    const parsed = ResolvedWorkspaceSettings.safeParse(settings)
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
    expect(ResolvedWorkspaceSettings.safeParse({ ...settings, closedLanes: ['reversible_contained'] }).success).toBe(false)
  })
})
