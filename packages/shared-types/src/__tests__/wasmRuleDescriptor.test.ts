import { describe, expect, it } from 'vitest'

import { parseWasmRuleDescriptors } from '../wasmRuleDescriptor.js'

const SHA = 'a'.repeat(64)

describe('parseWasmRuleDescriptors', () => {
  it('reads the list the control plane publishes', () => {
    expect(
      parseWasmRuleDescriptors([
        { ruleId: 'wasm_1', name: 'no-prod-db', sha256: SHA, priority: 10, mode: 'ENFORCE' },
        { ruleId: 'wasm_2', name: 'candidate', sha256: SHA, priority: 100, mode: 'SHADOW' },
      ]),
    ).toEqual({
      ok: true,
      rules: [
        { ruleId: 'wasm_1', name: 'no-prod-db', sha256: SHA, priority: 10, mode: 'ENFORCE' },
        { ruleId: 'wasm_2', name: 'candidate', sha256: SHA, priority: 100, mode: 'SHADOW' },
      ],
    })
  })

  it('reads a descriptor without a mode as enforcing, and either spelling of a mode', () => {
    const parsed = parseWasmRuleDescriptors([
      { ruleId: 'wasm_1', name: 'old', sha256: SHA, priority: 1 },
      { ruleId: 'wasm_2', name: 'lower', sha256: SHA, priority: 1, mode: 'shadow' },
    ])
    expect(parsed.ok && parsed.rules.map((r) => r.mode)).toEqual(['ENFORCE', 'SHADOW'])
  })

  it('makes the whole list unreadable when one entry is malformed, as the Rust proxy does', () => {
    for (const bad of [
      { ruleId: 'wasm_1', name: 'n', sha256: SHA, priority: 1, mode: 'MAYBE' },
      { ruleId: 'wasm_1', name: 'n', priority: 1 },
      { ruleId: '', name: 'n', sha256: SHA, priority: 1 },
      { ruleId: 'wasm_1', name: 'n', sha256: SHA, priority: -1 },
      { ruleId: 'wasm_1', sha256: SHA, priority: 1 },
      'wasm_1',
    ]) {
      const parsed = parseWasmRuleDescriptors([{ ruleId: 'wasm_ok', name: 'ok', sha256: SHA, priority: 1 }, bad])
      expect(parsed.ok).toBe(false)
    }
  })

  it('refuses anything that is not a list', () => {
    expect(parseWasmRuleDescriptors(undefined)).toEqual({ ok: false, reason: 'the rule list is not an array' })
    expect(parseWasmRuleDescriptors({ rules: [] }).ok).toBe(false)
  })
})
