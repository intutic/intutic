/**
 * The API key scope registry: what each scope grants, how a key's stored
 * scopes are read, and the Terraform provider's copy of the list.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import {
  API_KEY_SCOPE_NAMES,
  compactScopes,
  effectiveApiKeyScopes,
  intersectScopes,
  scopeGrants,
  unknownApiKeyScopes,
} from '../apiKeyScopes.js'
import { CreateApiKeyInputSchema, UpdateApiKeyInputSchema } from '../auth.js'
import { AttenuateTokenInputSchema } from '../attenuation.js'

const TERRAFORM_COPY = fileURLToPath(
  new URL('../../../terraform-provider-intutic/internal/provider/api_key_scopes.json', import.meta.url),
)

describe('API key scopes', () => {
  it('is a small fixed vocabulary: *, gateway:use and <area>:<read|write>', () => {
    expect(new Set(API_KEY_SCOPE_NAMES).size).toBe(API_KEY_SCOPE_NAMES.length)
    expect(API_KEY_SCOPE_NAMES.slice(0, 2)).toEqual(['*', 'gateway:use'])
    for (const s of API_KEY_SCOPE_NAMES.slice(2)) expect(s).toMatch(/^[a-z]+:(read|write)$/)
  })

  it('grants: * covers all, write covers read, nothing else', () => {
    expect(scopeGrants(['*'], 'settings:write')).toBe(true)
    expect(scopeGrants(['*'], 'gateway:use')).toBe(true)
    expect(scopeGrants(['traces:write'], 'traces:read')).toBe(true)
    expect(scopeGrants(['traces:read'], 'traces:write')).toBe(false)
    expect(scopeGrants(['traces:write'], 'usage:read')).toBe(false)
    expect(scopeGrants(['gateway:use'], 'traces:read')).toBe(false)
    expect(scopeGrants(['traces:read'], '*')).toBe(false)
  })

  it('reads stored scopes: known as-is, all-unknown as * flagged legacy, mixed ignoring the unknown', () => {
    expect(effectiveApiKeyScopes(['traces:read'])).toEqual({ scopes: ['traces:read'], legacy: false, ignored: [] })
    expect(effectiveApiKeyScopes(['read', 'write'])).toEqual({ scopes: ['*'], legacy: true, ignored: ['read', 'write'] })
    expect(effectiveApiKeyScopes(['traces:read', 'bash'])).toEqual({ scopes: ['traces:read'], legacy: false, ignored: ['bash'] })
    expect(effectiveApiKeyScopes(null)).toEqual({ scopes: ['*'], legacy: false, ignored: [] })
  })

  it('intersects a child with its parent: a child can only narrow', () => {
    expect(intersectScopes(['*'], ['traces:read'])).toEqual(['traces:read'])
    expect(intersectScopes(['traces:read'], ['traces:write', 'usage:read'])).toEqual(['traces:read'])
    expect(intersectScopes(['traces:write'], ['traces:write'])).toEqual(['traces:write'])
    expect(intersectScopes(['gateway:use'], ['traces:read'])).toEqual([])
    expect(intersectScopes(['*'], ['*'])).toEqual(['*'])
    expect(compactScopes(['traces:read', 'traces:write', 'gateway:use'])).toEqual(['gateway:use', 'traces:write'])
  })

  it('refuses an unknown scope on create, update and attenuation, naming the valid ones', () => {
    const created = CreateApiKeyInputSchema.safeParse({ label: 'k', scopes: ['traces:read', 'admin'] })
    expect(created.success).toBe(false)
    expect(created.error!.issues[0]!.message).toMatch(/^Unknown scope "admin"\. Valid scopes: \*, gateway:use, traces:read/)
    expect(CreateApiKeyInputSchema.parse({ label: 'k' }).scopes).toEqual(['*'])
    expect(CreateApiKeyInputSchema.safeParse({ label: 'k', scopes: [] }).success).toBe(false)
    expect(UpdateApiKeyInputSchema.safeParse({ scopes: ['nope'] }).success).toBe(false)
    expect(UpdateApiKeyInputSchema.safeParse({ scopes: ['gateway:use'] }).success).toBe(true)
    expect(AttenuateTokenInputSchema.safeParse({ parentKeyId: 'key_1', requestedCaps: ['bash'] }).success).toBe(false)
    expect(unknownApiKeyScopes(['*', 'x'])).toEqual(['x'])
  })

  it("matches the Terraform provider's copy", () => {
    const copy = JSON.parse(readFileSync(TERRAFORM_COPY, 'utf8')) as { scopes: string[] }
    // On a mismatch, write `{ "scopes": API_KEY_SCOPE_NAMES }` to the file, two-space indented.
    expect(copy.scopes).toEqual([...API_KEY_SCOPE_NAMES])
  })
})
