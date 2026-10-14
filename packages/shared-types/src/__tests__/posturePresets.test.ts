import { describe, expect, it } from 'vitest'
import { COST_POSTURES, SECURITY_POSTURES } from '../posturePresets.js'

describe('posture presets', () => {
  // A response cache is stored data: prompt text and answer, for a day. The
  // posture description is the only text the dashboard shows where a cache is
  // switched on by a preset, so it has to say so.
  it('every preset that turns a response cache on says what the cache keeps', () => {
    for (const p of [...SECURITY_POSTURES, ...COST_POSTURES]) {
      const caches = p.featureFlags.ff_response_cache_exact === true || p.featureFlags.ff_response_cache_semantic === true
      if (!caches) continue
      expect(p.description, p.name).toMatch(/24 hours/)
      expect(p.description, p.name).toMatch(/never cached/)
    }
  })
})
