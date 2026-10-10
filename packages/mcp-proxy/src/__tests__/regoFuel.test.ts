/**
 * regoFuel.test.ts — the shipped Rego policies fit the Rego instruction budget
 * on the largest input, with room for a heavier policy.
 *
 * Fuel is the limit a rule is held to because it is deterministic: this
 * passes or fails the same way on an idle laptop and a loaded CI runner. The
 * deadline is only a backstop (see wasm/runner.ts).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { REGO_MAX_INPUT_BYTES, boundedRegoInput, evaluateRegoRule, loadRegoRule } from '@intutic/shared-types'
import { FUEL_EXPORT, REGO_FUEL_BUDGET, meterFuel } from '@intutic/shared-types'

const fixture = (name: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../../../proxy/tests/fixtures/rego/${name}`, import.meta.url))))
const host = { digest: (algorithm: string, data: Uint8Array) => createHash(algorithm).update(data).digest('hex') }

/** Chained commands just under the cap: the costliest realistic shape to match. */
const unit = 'cd /workspace/app && npm test; '
const LARGEST = boundedRegoInput({
  v: 1,
  host: 'mcp',
  tool: 'Bash',
  args: { command: unit.repeat(Math.floor((REGO_MAX_INPUT_BYTES - 1024) / unit.length)) },
})

describe('the Rego instruction budget', () => {
  it.each([
    'examples/block_destructive_shell.wasm',
    'examples/hold_prod_deploys.wasm',
    'examples/deny_writes_outside_repo.wasm',
    'conformance.wasm',
  ])('%s uses at most a third of it on the largest input', (name) => {
    expect(new TextEncoder().encode(LARGEST).length).toBeGreaterThan(REGO_MAX_INPUT_BYTES - 1024)
    const bytes = fixture(name)
    const rule = loadRegoRule(bytes, new WebAssembly.Module(meterFuel(bytes, REGO_FUEL_BUDGET)), host)
    let fuel: WebAssembly.Global | undefined
    evaluateRegoRule(rule!, LARGEST, {
      ...host,
      onInstance: (exports) => {
        fuel = exports[FUEL_EXPORT] as WebAssembly.Global
      },
    })
    const used = REGO_FUEL_BUDGET - (fuel!.value as number)
    expect(used, `${used} of ${REGO_FUEL_BUDGET}`).toBeLessThanOrEqual(REGO_FUEL_BUDGET / 3)
  })
})
