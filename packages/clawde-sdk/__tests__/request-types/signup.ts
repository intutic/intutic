/**
 * Compile-time checks on request parameter types, run by `tsc -p
 * tsconfig.test.json`. Each pins a field the control plane requires, so a
 * type that lets a caller leave it out fails here instead of at the server.
 */
import type { OrgSignupParams } from '../../src/types'

// The signup routes refuse a body without `acceptTerms: true` (400 TERMS_NOT_ACCEPTED).
export const withTerms: OrgSignupParams = { email: 'a@b.com', password: 'password123', name: 'A', orgName: 'Acme', acceptTerms: true }

// @ts-expect-error acceptTerms is required
export const withoutTerms: OrgSignupParams = { email: 'a@b.com', password: 'password123', name: 'A', orgName: 'Acme' }
