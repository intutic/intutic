/**
 * dlpPii.test.ts — the PII detectors against the vectors the Rust proxy runs.
 *
 * `packages/shared-types/fixtures/pii-detector-vectors.json` is read here and
 * by `packages/proxy/tests/pii_conformance_test.rs`. Matches are compared as
 * text, not offsets: this side counts UTF-16 units, the Rust side bytes.
 *
 * @module
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { PII_DETECTORS, detectPii, resolvePiiActions } from '../dlpPii.js'
import { configurePii, redactText, scanToolInput } from '../dlp.js'

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), '../../..')

interface Vector {
  name: string
  parts: string[]
  expect: Array<{ id: string; parts: [number, number] }>
}

const vectors: Vector[] = JSON.parse(
  readFileSync(join(PACKAGES, 'shared-types/fixtures/pii-detector-vectors.json'), 'utf8'),
).cases

const visaTestPan = (): string => ['4111', '1111', '1111', '1111'].join(' ')

describe('PII conformance vectors', () => {
  it('has a meaningful number of cases', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(50)
  })

  it.each(vectors.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    const input = v.parts.join('')
    const want = v.expect.map((e) => [e.id, v.parts.slice(e.parts[0], e.parts[1] + 1).join('')])
    const got = detectPii(input).map((f) => [f.id, input.slice(f.start, f.end)])
    expect(got).toEqual(want)
  })
})

describe('the shared definition', () => {
  it('is byte-identical to the copy the Rust proxy embeds', () => {
    const rust = readFileSync(join(PACKAGES, 'proxy/src/dlp/pii_detectors.json'), 'utf8')
    const ts = readFileSync(join(PACKAGES, 'shared-types/src/piiDetectors.json'), 'utf8')
    // Copy the edited one over the other; dlp/pii.rs checks the same thing.
    expect(ts).toBe(rust)
  })

  it('defaults card, IBAN and SSN to redact, email and phone to off', () => {
    expect(PII_DETECTORS.map((d) => [d.id, d.defaultAction])).toEqual([
      ['pii.card', 'redact'],
      ['pii.iban', 'redact'],
      ['pii.ssn', 'redact'],
      ['pii.email', 'off'],
      ['pii.phone', 'off'],
    ])
  })
})

describe('INTUTIC_MCP_DLP_DETECTORS', () => {
  afterEach(() => {
    configurePii(undefined)
  })

  it('overrides the defaults detector by detector', () => {
    const { actions, problems } = resolvePiiActions('{"pii.email":"redact","pii.card":"off"}')
    expect(problems).toEqual([])
    expect(actions.get('pii.email')).toBe('redact')
    expect(actions.get('pii.card')).toBe('off')
    expect(actions.get('pii.iban')).toBe('redact')
  })

  it('keeps the default for an unknown id or action and says so', () => {
    const { actions, problems } = resolvePiiActions('{"pii.passport":"redact","pii.card":"warn"}')
    expect(actions.get('pii.card')).toBe('redact')
    expect(problems).toHaveLength(2)
    expect(problems[0]).toContain('pii.passport')
    expect(problems[1]).toContain('warn')
  })

  it('keeps every default when the value is not a JSON object', () => {
    for (const raw of ['not json', '["pii.card"]']) {
      const { actions, problems } = resolvePiiActions(raw)
      expect(problems).toHaveLength(1)
      expect([...actions.values()]).toEqual(['redact', 'redact', 'redact', 'off', 'off'])
    }
  })

  it('turns email on for both directions', () => {
    const address = ['jane.doe', 'corp.io'].join('@')
    expect(scanToolInput({ to: address }).hasFinding).toBe(false)
    configurePii('{"pii.email":"redact"}')
    expect(scanToolInput({ to: address }).findings).toEqual([{ pattern: 'pii.email', description: 'Email address' }])
    expect(redactText(`write to ${address}`).redacted).toBe('write to [REDACTED_PII]')
  })
})

describe('PII in the scanner', () => {
  it('blocks a tool call carrying a card number and redacts one in a result', () => {
    const input = scanToolInput({ note: `refund ${visaTestPan()}` })
    expect(input.findings).toEqual([{ pattern: 'pii.card', description: 'Payment card number' }])
    const { redacted, findings } = redactText(`card ${visaTestPan()} on file`)
    expect(redacted).toBe('card [REDACTED_PII] on file')
    expect(findings.map((f) => f.pattern)).toEqual(['pii.card'])
  })

  it('does not treat a Luhn failure as a card', () => {
    const almost = ['4111', '1111', '1111', '1112'].join(' ')
    expect(scanToolInput({ note: almost }).hasFinding).toBe(false)
  })

  it('redacts every match in a result, keeping the JSON valid', () => {
    const second = ['5555', '5555', '5555', '4444'].join('')
    const serialized = JSON.stringify({ text: `a\n${visaTestPan()}\nb ${second}` })
    const { redacted } = redactText(serialized)
    expect(JSON.parse(redacted)).toEqual({ text: 'a\n[REDACTED_PII]\nb [REDACTED_PII]' })
  })
})

describe('the coding-agent corpus', () => {
  // packages/proxy/tests/pii_corpus_test.rs gates the same file on the Rust
  // side: nothing but email fires, and email on exactly these rows.
  const rows: Array<{ id: string; text: string }> = readFileSync(
    join(PACKAGES, 'proxy/tests/corpus/pii/coding_agent.jsonl'),
    'utf8',
  )
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))

  it('fires nothing but email, on the rows the Rust side pins', () => {
    const emailRows: string[] = []
    for (const { id, text } of rows) {
      const ids = new Set(detectPii(text.replaceAll('{at}', '@')).map((f) => f.id))
      expect([...ids].filter((d) => d !== 'pii.email'), id).toEqual([])
      if (ids.has('pii.email')) emailRows.push(id)
    }
    expect(emailRows).toEqual([
      'coding_0001',
      'coding_0002',
      'coding_0003',
      'coding_0004',
      'coding_0014',
      'coding_0016',
      'coding_0020',
    ])
  })
})
