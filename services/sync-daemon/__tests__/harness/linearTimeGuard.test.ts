import { describe, it, expect } from 'vitest'
import { expectLinearTime } from './linearTime.js'

/** `expectLinearTime` re-measures a noisy result, so it must still refuse a matcher that is not linear. */
describe('expectLinearTime', () => {
  const input = (scale: 1 | 4) => 'a'.repeat(4000 * scale)

  it('passes a linear scan', () => {
    expectLinearTime('linear scan', (scale) => {
      const s = input(scale)
      let n = 0
      for (let i = 0; i < s.length; i++) n += s.charCodeAt(i)
      expect(n).toBeGreaterThan(0)
    })
  })

  it('fails a quadratic scan, on every attempt', () => {
    expect(() =>
      expectLinearTime('quadratic scan', (scale) => {
        const s = input(scale)
        let n = 0
        for (let i = 0; i < s.length; i++) for (let j = 0; j < s.length; j++) n += s.charCodeAt(i) ^ s.charCodeAt(j)
        expect(n).toBeGreaterThanOrEqual(0)
      }),
    ).toThrow(/quadratic scan: .* ms at n, .* ms at 4n/)
  })
})
