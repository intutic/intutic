/**
 * The instruction budgets every V8 host meters a rule against (the MCP proxy,
 * `intutic rules test`, `policy test` and `policy install`) are the Rust
 * proxy's, so a rule that runs out in one runs out in all of them.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { DEFAULT_FUEL_BUDGET, REGO_FUEL_BUDGET } from '../wasmFuel.js'

const LIMITS = readFileSync(fileURLToPath(new URL('../../../proxy/src/wasm/limits.rs', import.meta.url)), 'utf8')

/** The `fuel` of the Rust proxy's `pub const <name>: Budget`. */
function rustFuel(name: string): number {
  const m = new RegExp(`pub const ${name}: Budget = Budget \\{\\s*fuel: ([0-9_]+),`).exec(LIMITS)
  expect(m, `limits.rs has no ${name} budget`).not.toBeNull()
  return Number(m![1]!.replaceAll('_', ''))
}

describe('WASM rule instruction budgets', () => {
  it('a native rule gets the Rust proxy\'s budget', () => {
    expect(DEFAULT_FUEL_BUDGET).toBe(rustFuel('NATIVE'))
  })

  it('a Rego rule gets three times the Rust proxy\'s, since V8\'s meter counts each run in full', () => {
    expect(REGO_FUEL_BUDGET).toBe(3 * rustFuel('REGO'))
  })
})
