import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import {
  PII_ACTIONS,
  PII_DEFINITION,
  PII_DETECTOR_IDS,
  PiiDetectorSettingsSchema,
  effectivePiiActions,
  parseWorkspacePiiDetectors,
  type PiiDetectorSettings,
} from '../piiDetectors.js'

interface PrecedenceVector {
  name: string
  local: PiiDetectorSettings
  field?: unknown
  actions?: Record<string, string>
  unreadable?: true
}

const precedence: PrecedenceVector[] = JSON.parse(
  readFileSync(new URL('../../fixtures/pii-precedence-vectors.json', import.meta.url), 'utf8'),
).cases

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

describe('workspace setting and local config, the vectors both proxies run', () => {
  it('has the cases', () => {
    expect(precedence.length).toBeGreaterThanOrEqual(15)
  })

  it.each(precedence.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    const workspace = parseWorkspacePiiDetectors('field' in v ? v.field : undefined)
    if (v.unreadable) {
      expect(workspace.kind).toBe('unreadable')
      return
    }
    expect(workspace.kind).not.toBe('unreadable')
    const actions = effectivePiiActions(v.local, workspace.kind === 'set' ? workspace.actions : null)
    expect(actions).toEqual(v.actions)
  })

  it('says why a field is unreadable', () => {
    const bad = parseWorkspacePiiDetectors({ 'pii.card': 'warn' })
    expect(bad.kind === 'unreadable' && bad.reason).toContain("'pii.card'")
    expect(bad.kind === 'unreadable' && bad.reason).toContain('"warn"')
  })
})
