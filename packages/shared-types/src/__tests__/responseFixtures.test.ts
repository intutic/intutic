/**
 * Captured control-plane answers the Rust proxy's tests read
 * (`fixtures/responses/`), held to the response schemas.
 *
 * The proxy reads `GET /api/v1/auth/key-context` field by field and
 * deserializes `GET /api/v1/workspace/sops-policy` into a struct; neither can
 * import a zod schema. Each fixture here is an answer with every field set:
 * the schema must accept it with no field it does not declare, and it must
 * set every field the schema declares, so a field added to the schema reaches
 * the fixture, and through it the proxy's tests (`key_context.rs`,
 * `sops.rs`). The control plane's e2e suite holds the routes to the same
 * schemas.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import type { ZodTypeAny } from 'zod'
import { KeyContextResponse, SopsPolicyResponse } from '../responses/index.js'

const FIXTURES = fileURLToPath(new URL('../../fixtures/responses/', import.meta.url))

function fixture(name: string): Record<string, unknown> {
  const { $comment: _comment, ...body } = JSON.parse(readFileSync(`${FIXTURES}${name}`, 'utf8')) as Record<string, unknown>
  return body
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Paths of fields `input` carries that the parsed `output` dropped. */
function undeclared(input: unknown, output: unknown, path = '$'): string[] {
  if (Array.isArray(input) && Array.isArray(output)) return input.flatMap((v, i) => undeclared(v, output[i], `${path}[${i}]`))
  if (!isRecord(input) || !isRecord(output)) return []
  return Object.entries(input).flatMap(([k, v]) => (k in output ? undeclared(v, output[k], `${path}.${k}`) : [`${path}.${k}`]))
}

const CASES: Array<[file: string, schema: ZodTypeAny]> = [
  ['key-context.json', KeyContextResponse],
  ['sops-policy.json', SopsPolicyResponse],
]

describe('response fixtures', () => {
  it.each(CASES)('%s matches its schema, field for field', (file, schema) => {
    const body = fixture(file)
    const parsed = schema.safeParse(body)
    expect(parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)).toEqual([])
    expect(undeclared(body, parsed.success ? parsed.data : undefined)).toEqual([])
    const declared = Object.keys((schema as unknown as { shape: Record<string, unknown> }).shape)
    expect(declared.filter((key) => body[key] === undefined || body[key] === null), 'fields the fixture leaves unset').toEqual([])
  })
})
