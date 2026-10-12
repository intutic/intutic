/**
 * Every surface tells an OPAQUE workspace's agent the same sentence.
 *
 * The hook gates emit `OPAQUE_REFUSAL_MESSAGE` from this package; the control
 * plane's hook gate imports it; `@intutic/gate` carries a byte-identical copy
 * of the module; the Python SDK and the Rust proxy each have their own literal.
 * `refusal-codes.json` (`opaqueMessage`) is the one list, as it is for the
 * refusal codes, and this holds each copy to it. A copy that drifted would
 * leave one surface telling the agent something the docs do not say.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  encodeInterventionModeRecord,
  INTERVENTION_MODE_RECORD_TAG,
  isOpaqueInterventionMode,
  isOpaqueInterventionModeRecord,
  OPAQUE_REFUSAL_MESSAGE,
} from '../opaqueRefusal.js'

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (rel: string) => readFileSync(join(PACKAGES, rel), 'utf8')
const SHARED = JSON.parse(read('shared-types/fixtures/refusal-codes.json')).opaqueMessage as string

/** The one string literal `pattern` captures in `source`. */
function literal(source: string, pattern: RegExp, where: string): string {
  const m = source.match(pattern)
  expect(m, `the sentence was not found in ${where}`).not.toBeNull()
  return m![1]!
}

describe('the OPAQUE refusal sentence', () => {
  it('is the shared one in this package', () => {
    expect(OPAQUE_REFUSAL_MESSAGE).toBe(SHARED)
  })

  it('is the shared one in @intutic/gate', () => {
    expect(read('gate-js/src/opaqueRefusal.ts')).toBe(read('shared-types/src/opaqueRefusal.ts'))
  })

  it('is the shared one in the Python SDK', () => {
    const py = read('intutic-clawde/intutic_clawde/gate/opaque.py')
    expect(literal(py, /^OPAQUE_REFUSAL_MESSAGE = "([^"]*)"$/m, 'opaque.py')).toBe(SHARED)
    expect(literal(py, /^INTERVENTION_MODE_RECORD_TAG = "([^"]*)"$/m, 'opaque.py')).toBe(INTERVENTION_MODE_RECORD_TAG)
  })

  it('is the shared one in the Rust proxy', () => {
    const rs = read('proxy/src/refusal.rs')
    expect(literal(rs, /pub const OPAQUE_MESSAGE: &str =\s*"([^"]*)";/, 'refusal.rs')).toBe(SHARED)
  })

  it('can be embedded in generated shell inside single quotes', () => {
    expect(SHARED).not.toMatch(/['"$`\\]/)
  })
})

describe('the @intervention_mode record', () => {
  it('round-trips, and only an OPAQUE line reads as OPAQUE', () => {
    expect(encodeInterventionModeRecord()).toBe('@intervention_mode\tOPAQUE')
    expect(isOpaqueInterventionModeRecord(encodeInterventionModeRecord())).toBe(true)
    expect(isOpaqueInterventionModeRecord('@intervention_mode\tTRANSPARENT')).toBe(false)
    expect(isOpaqueInterventionModeRecord('@intervention_mode\tOPAQUE\textra')).toBe(false)
    expect(isOpaqueInterventionModeRecord('@mcp_allowlist\tOPAQUE')).toBe(false)
  })

  it('reads the mode in any case, and nothing else as OPAQUE', () => {
    expect(isOpaqueInterventionMode('OPAQUE')).toBe(true)
    expect(isOpaqueInterventionMode('opaque')).toBe(true)
    for (const m of ['TRANSPARENT', 'SILENT_LOG', '', null, undefined, 1]) expect(isOpaqueInterventionMode(m)).toBe(false)
  })
})
