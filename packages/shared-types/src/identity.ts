/**
 * Identity Federation types — LLD #11
 *
 * Cross-workspace user identity, SSO/OIDC provider configuration,
 * SCIM 2.0 provisioning resources, and offboarding cascade types.
 *
 * @module
 */

import { z } from 'zod'
import type { WorkspaceRole } from './enums.js'

// ── User (cross-workspace identity) ──

export interface User {
  userId: string
  email: string
  displayName: string | null
  avatarUrl: string | null
  authProvider: 'email' | 'okta' | 'entra_id'
  externalId: string | null
  isActive: boolean
  lastLoginAt: string | null
  createdAt: string
  updatedAt: string
}

export interface UserInfo {
  userId: string
  email: string
  displayName: string | null
  avatarUrl: string | null
  authProvider: string
  isActive: boolean
  lastLoginAt: string | null
  createdAt: string
}

// ── SSO Provider ──

export interface SsoProvider {
  providerId: string
  workspaceId: string
  name: string
  // TD-115: Added ping_identity. google and custom_oidc align with route validation.
  type: 'okta' | 'entra_id' | 'google' | 'custom_oidc' | 'ping_identity'
  issuer: string
  clientId: string
  scopes: string[]
  autoProvision: boolean
  defaultRole: string
  isEnabled: boolean
  createdAt: string
  updatedAt: string
}

export const CreateSsoProviderSchema = z.object({
  name: z.string().min(1).max(255),
  // TD-115: Added 'ping_identity' as the third standard OIDC adapter.
  type: z.enum(['okta', 'entra_id', 'google', 'custom_oidc', 'ping_identity']),
  issuer: z.string().url(),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  scopes: z.array(z.string()).default(['openid', 'profile', 'email']),
  autoProvision: z.boolean().default(false),
  defaultRole: z.enum(['ADMIN', 'EM', 'DEVELOPER', 'VIEWER']).default('DEVELOPER'),
})
export type CreateSsoProviderInput = z.infer<typeof CreateSsoProviderSchema>

// ── OIDC Claims ──

export interface OidcClaims {
  sub: string
  email: string
  email_verified?: boolean
  name?: string
  given_name?: string
  family_name?: string
  picture?: string
  groups?: string[]
  iss: string
  aud: string | string[]
  exp: number
  iat: number
  nonce?: string
}

// ── User management ──

export const UpdateUserProfileSchema = z.object({
  displayName: z.string().min(1).max(255).optional(),
  avatarUrl: z.string().url().optional(),
})
export type UpdateUserProfileInput = z.infer<typeof UpdateUserProfileSchema>
