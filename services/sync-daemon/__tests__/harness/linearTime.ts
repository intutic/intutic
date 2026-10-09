import { expect } from 'vitest'

/**
 * Asserts that `run` takes time linear in its input, on any machine.
 *
 * An absolute bound (under 200 ms on 200 KB) failed a linear matcher on a busy
 * CI runner and would pass a quadratic one on a fast laptop. So this times the
 * input at size n and at 4n, the best of three runs each, and asserts the
 * ratio: about 4 for a linear implementation, 16 for a quadratic one. The
 * smaller time is floored, so timer noise on a sub-millisecond run cannot
 * fail it, and a 2 s ceiling still catches anything pathological.
 *
 * CPU time, not wall time: on a saturated runner a run longer than a
 * scheduler slice is descheduled and a shorter one is not, which inflated the
 * ratio of a linear matcher to 9 under load.
 *
 * `run(scale)` runs the input built at `scale` times the base size (1 or 4).
 */
export function expectLinearTime(label: string, run: (scale: 1 | 4) => void): void {
  const best = (scale: 1 | 4): number => {
    run(scale) // warm up the JIT
    let ms = Infinity
    for (let k = 0; k < 3; k++) {
      const t0 = process.cpuUsage()
      run(scale)
      const used = process.cpuUsage(t0)
      ms = Math.min(ms, (used.user + used.system) / 1000)
    }
    return ms
  }
  expectLinearTimes(label, best(1), best(4))
}

/** The same check on CPU times measured elsewhere (in a Python process), at n and at 4n. */
export function expectLinearTimes(label: string, small: number, large: number): void {
  const why = `${label}: ${small.toFixed(1)} ms at n, ${large.toFixed(1)} ms at 4n`
  expect(large, why).toBeLessThan(LINEAR_TIME_CEILING_MS)
  expect(large / Math.max(small, LINEAR_TIME_FLOOR_MS), why).toBeLessThan(LINEAR_TIME_RATIO)
}

/** Above this, 4× the input took more than linear time (linear: 4, quadratic: 16). */
export const LINEAR_TIME_RATIO = 6
/**
 * The time at n is counted as at least this, so noise on a fast run cannot
 * fail it: a saturated machine thrashes the caches a 4n run needs more of. A
 * quadratic matcher is still caught, since at these sizes its time at n is far
 * above it.
 */
export const LINEAR_TIME_FLOOR_MS = 5
/** No input of these sizes may take this long, however the ratio comes out. */
export const LINEAR_TIME_CEILING_MS = 2000
