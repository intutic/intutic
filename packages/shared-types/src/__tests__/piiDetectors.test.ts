import { describe, it, expect } from 'vitest'
import { PII_ACTIONS, PII_DEFINITION, PII_DETECTOR_IDS, PiiDetectorSettingsSchema } from '../piiDetectors.js'

describe('PII detector settings', () => {
  it('names the detectors the definition ships, in its order', () => {
    expect([...PII_DETECTOR_IDS]).toEqual(PII_DEFINITION.detectors.map((d) => d.id))
    for (const d of PII_DEFINITION.detectors) expect(PII_ACTIONS).toContain(d.default_action)
  })

  it('accepts an action per detector, any subset of detectors', () => {
    expect(PiiDetectorSettingsSchema.parse({ 'pii.card': 'block', 'pii.email': 'redact' })).toEqual({
      'pii.card': 'block',
      'pii.email': 'redact',
    })
    expect(PiiDetectorSettingsSchema.parse({})).toEqual({})
  })

  it('refuses an unknown detector or action', () => {
    for (const bad of [{ 'pii.passport': 'redact' }, { 'pii.card': 'warn' }, { 'pii.card': true }, ['pii.card']]) {
      expect(PiiDetectorSettingsSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })
})
