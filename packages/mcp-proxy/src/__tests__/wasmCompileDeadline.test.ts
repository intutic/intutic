// The compile deadline a WasmRunner applies to each rule. Tests on a loaded CI
// runner may pass a longer one; production must keep the 3 s default, so a
// pathological rule file still cannot hang a rescan.
import { describe, it, expect } from 'vitest'
import { COMPILE_TIMEOUT_MS, WasmRunner } from '../wasm/runner.js'

describe('WasmRunner compile deadline', () => {
  it('is 3 s unless a caller asks for longer', () => {
    expect(COMPILE_TIMEOUT_MS).toBe(3_000)
    expect(new WasmRunner('/nonexistent-intutic-wasm-dir').compileTimeoutMs).toBe(3_000)
    expect(new WasmRunner('/nonexistent-intutic-wasm-dir', undefined, { compileTimeoutMs: 9_000 }).compileTimeoutMs).toBe(9_000)
  })
})
