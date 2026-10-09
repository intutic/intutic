/**
 * meterFuel (TD-440): hand-assembled modules where the exact charge is known,
 * plus the tree-sitter grammars as large real-world modules the decoder must
 * walk without a single desync.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_FUEL_BUDGET, FUEL_EXPORT, meterFuel } from '@intutic/shared-types'

const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]
const I32 = 0x7f

function leb(n: number): number[] {
  const out: number[] = []
  do {
    let b = n & 0x7f
    n >>>= 7
    if (n !== 0) b |= 0x80
    out.push(b)
  } while (n !== 0)
  return out
}
const vec = (items: number[][]) => [...leb(items.length), ...items.flat()]
const str = (s: string) => vec([...Buffer.from(s)].map((b) => [b]))
const section = (id: number, payload: number[]) => [id, ...leb(payload.length), ...payload]
const funcType = (params: number[], results: number[]) => [0x60, ...vec(params.map((p) => [p])), ...vec(results.map((r) => [r]))]
const body = (locals: number[][], code: number[]) => {
  const b = [...vec(locals), ...code]
  return [...leb(b.length), ...b]
}
const mod = (...sections: number[][]) => new Uint8Array([...HEADER, ...sections.flat()])

// spin: loop br 0 end. count(n): i += 1 until i >= n, returns i.
const LOOPS = mod(
  section(1, vec([funcType([], []), funcType([I32], [I32])])),
  section(3, vec([[0], [1]])),
  section(7, vec([[...str('spin'), 0x00, 0], [...str('count'), 0x00, 1]])),
  section(10, vec([
    body([], [0x03, 0x40, 0x0c, 0x00, 0x0b, 0x0b]),
    body([[1, I32]], [
      0x03, 0x40, 0x20, 0x01, 0x41, 0x01, 0x6a, 0x22, 0x01, 0x20, 0x00, 0x48, 0x0d, 0x00, 0x0b, // 7 charged per iteration
      0x20, 0x01, 0x0b, // 1 charged at entry
    ]),
  ])),
)

type Loops = { spin: () => void; count: (n: number) => number } & Record<string, unknown>

function instantiate<T>(bytes: Uint8Array<ArrayBuffer>, imports: WebAssembly.Imports = {}): T {
  return new WebAssembly.Instance(new WebAssembly.Module(bytes), imports).exports as T
}

describe('meterFuel', () => {
  it('stops an infinite loop with a trap and leaves the counter below zero', () => {
    const e = instantiate<Loops>(meterFuel(LOOPS, DEFAULT_FUEL_BUDGET))
    const started = Date.now()
    expect(() => e.spin()).toThrow(WebAssembly.RuntimeError)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect((e[FUEL_EXPORT] as WebAssembly.Global).value).toBeLessThan(0)
  })

  it('charges exactly the instructions a bounded loop runs, and leaves its result alone', () => {
    expect(instantiate<Loops>(LOOPS).count(1000)).toBe(1000)
    const e = instantiate<Loops>(meterFuel(LOOPS, DEFAULT_FUEL_BUDGET))
    expect(e.count(1000)).toBe(1000)
    expect(DEFAULT_FUEL_BUDGET - (e[FUEL_EXPORT] as WebAssembly.Global).value).toBe(1 + 7 * 1000)
  })

  it('traps a loop that would run past the budget, and lets one just under it finish', () => {
    // (budget - 1 entry) / 7 per iteration
    const fits = Math.floor((DEFAULT_FUEL_BUDGET - 1) / 7)
    expect(instantiate<Loops>(meterFuel(LOOPS, DEFAULT_FUEL_BUDGET)).count(fits)).toBe(fits)
    expect(() => instantiate<Loops>(meterFuel(LOOPS, DEFAULT_FUEL_BUDGET)).count(fits + 1)).toThrow(WebAssembly.RuntimeError)
  })

  it('appends its global after imported and existing ones without moving their indices', () => {
    const bytes = mod(
      section(1, vec([funcType([], [I32])])),
      section(2, vec([[...str('env'), ...str('g'), 0x03, I32, 0x00]])),
      section(3, vec([[0]])),
      section(6, vec([[I32, 0x01, 0x41, 0x07, 0x0b]])),
      section(7, vec([[...str('get'), 0x00, 0]])),
      section(10, vec([body([], [0x23, 0x00, 0x23, 0x01, 0x6a, 0x0b])])),
    )
    const imports = { env: { g: new WebAssembly.Global({ value: 'i32' }, 42) } }
    const e = instantiate<{ get: () => number } & Record<string, unknown>>(meterFuel(bytes, 100), imports)
    expect(e.get()).toBe(49)
    expect((e[FUEL_EXPORT] as WebAssembly.Global).value).toBe(100 - 3)
  })

  it('refuses a module that already exports the reserved name, and instructions it cannot meter', () => {
    const reserved = mod(
      section(1, vec([funcType([], [])])),
      section(3, vec([[0]])),
      section(7, vec([[...str(FUEL_EXPORT), 0x00, 0]])),
      section(10, vec([body([], [0x0b])])),
    )
    expect(() => meterFuel(reserved, 100)).toThrow(/reserves/)

    const withTry = mod(
      section(1, vec([funcType([], [])])),
      section(3, vec([[0]])),
      section(10, vec([body([], [0x06, 0x40, 0x0b, 0x0b])])), // try ... end
    )
    expect(() => meterFuel(withTry, 100)).toThrow(/cannot meter/)
  })

  it('returns a module with no code as it was', () => {
    const bytes = mod(section(1, vec([funcType([], [])])))
    expect(meterFuel(bytes, 100)).toBe(bytes)
  })

  it('walks every function of the tree-sitter grammars and still validates', () => {
    const dir = join(__dirname, '../../../proxy/assets/grammars')
    const grammars = readdirSync(dir).filter((f) => f.endsWith('.wasm'))
    expect(grammars.length).toBeGreaterThan(0)
    for (const g of grammars) {
      const bytes = new Uint8Array(readFileSync(join(dir, g)))
      expect(WebAssembly.validate(bytes), g).toBe(true)
      const metered = meterFuel(bytes, DEFAULT_FUEL_BUDGET)
      expect(metered.length, g).toBeGreaterThan(bytes.length)
      expect(WebAssembly.validate(metered), g).toBe(true)
    }
  })
})
