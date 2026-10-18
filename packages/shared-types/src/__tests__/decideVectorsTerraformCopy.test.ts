/**
 * The Terraform provider validates and hashes a decide rule in Go and runs
 * the decide vectors from its own copy (its module cannot read this
 * package), so the copy must be these bytes.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const FIXTURE = fileURLToPath(new URL('../../fixtures/decide-vectors.json', import.meta.url))
const TERRAFORM_COPY = fileURLToPath(new URL('../../../terraform-provider-intutic/internal/provider/decide_vectors.json', import.meta.url))

describe('decide vectors', () => {
  it("are byte-identical to the Terraform provider's copy", () => {
    // On a mismatch, copy fixtures/decide-vectors.json over the provider's file.
    expect(readFileSync(TERRAFORM_COPY, 'utf8')).toBe(readFileSync(FIXTURE, 'utf8'))
  })

  it('name go for the groups the provider runs', () => {
    const v = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { layers: Record<string, string[]> }
    expect(v.layers.validate).toContain('go')
    expect(v.layers.hash).toContain('go')
  })
})
