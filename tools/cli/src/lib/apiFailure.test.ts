/**
 * What a member sees when the control plane refuses a call for their role:
 * the server's `detail` (which roles may make it), not the raw JSON body.
 */
import { describe, it, expect } from 'vitest'
import { apiFailure } from './api.js'

describe('apiFailure', () => {
  it("tells a 403 caller which role may make the call", () => {
    const body = JSON.stringify({ error: 'Forbidden', code: 'E_FORBIDDEN', detail: 'Requires the OWNER or ADMIN role' })
    expect(apiFailure('PUT', '/api/v1/sops/sop_1', 403, body).message).toBe(
      'API PUT /api/v1/sops/sop_1 refused (403): Requires the OWNER or ADMIN role',
    )
  })

  it('keeps the raw body for a 403 without a detail, and for every other failure', () => {
    expect(apiFailure('POST', '/x', 403, 'nope').message).toBe('API POST /x failed (403): nope')
    expect(apiFailure('POST', '/x', 500, '{"error":"boom"}').message).toBe('API POST /x failed (500): {"error":"boom"}')
  })
})
