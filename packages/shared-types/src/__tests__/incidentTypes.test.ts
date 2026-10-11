import { describe, it, expect } from 'vitest'
import { ALL_ANOMALY_TYPES } from '@intutic/anomaly-taxonomy'
import { INCIDENT_TYPES, SystemIncidentType, isIncidentType } from '../enums.js'
import { INCIDENT_NOTIFICATION_SEVERITY, incidentNotificationSeverity } from '../notifications.js'

describe('incident types', () => {
  it('are the anomaly categories and the system incident types, nothing else', () => {
    expect([...INCIDENT_TYPES].sort()).toEqual([...ALL_ANOMALY_TYPES, ...Object.values(SystemIncidentType)].sort())
    expect(isIncidentType('SYSTEM_ANOMALY')).toBe(true)
    expect(isIncidentType('WASM_RULE_REFUSED')).toBe(true)
    expect(isIncidentType('SCOPE_VIOLATION')).toBe(true)
    expect(isIncidentType('system_anomaly')).toBe(false)
    expect(isIncidentType(undefined)).toBe(false)
  })

  it('keeps the system types out of the anomaly taxonomy', () => {
    for (const t of Object.values(SystemIncidentType)) expect(ALL_ANOMALY_TYPES as string[]).not.toContain(t)
  })
})

describe('incident notification severity', () => {
  it('is the incident\'s own severity', () => {
    for (const sev of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const) {
      expect(incidentNotificationSeverity(sev)).toBe(sev)
      expect(INCIDENT_NOTIFICATION_SEVERITY[sev]).toBe(sev)
    }
  })

  it('is CRITICAL for a severity it does not know, so a malformed event never alerts quieter', () => {
    for (const sev of [undefined, null, '', 'high', 'INFORMATIONAL', 'toString', 42]) {
      expect(incidentNotificationSeverity(sev)).toBe('CRITICAL')
    }
  })
})
