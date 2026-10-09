/**
 * load/ruleLimits.test.ts — the rule limits on a busy machine, and the
 * deadline backstop.
 *
 * A rule that reaches no verdict refuses the call, so fuel is the limit a rule
 * is held to and the wall-clock deadline only a backstop for stalls fuel
 * cannot see. These tests load every core, or leave a stuck worker burning one
 * for seconds after it is abandoned, so they run on their own
 * (`pnpm test:load`, `vitest.load.config.ts`), after the package suites,
 * rather than beside other packages' timing.
 *
 * @module
 */

import { describe, it, expect, afterEach } from 'vitest'
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EVALUATE_TIMEOUT_MS, WasmRunner } from '../../wasm/runner.js'
import type { WasmContextInput } from '../../wasm/context.js'

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../../../../proxy/tests/fixtures/rego/${name}`, import.meta.url))

const bash = (command: string): WasmContextInput => ({
  sessionId: 'ses_load',
  workspaceId: 'ws_load',
  tools: [],
  toolCallId: 'call_load',
  toolName: 'Bash',
  toolArguments: { command },
  toolSequence: ['Bash'],
  callsLast60s: 1,
  dlpFindingDescriptions: [],
  injectionFindings: [],
  injectionSources: [],
  corroboratingDetectors: 0,
  toolContractChanged: undefined,
  serverName: 'shell',
})

let runner: WasmRunner | undefined
let dir: string | undefined

afterEach(async () => {
  await runner?.shutdown()
  runner = undefined
  if (dir) rmSync(dir, { recursive: true, force: true })
})

async function runnerWith(files: Record<string, string>): Promise<WasmRunner> {
  dir = mkdtempSync(join(tmpdir(), 'intutic-mcp-load-'))
  for (const [name, source] of Object.entries(files)) copyFileSync(source, join(dir, name))
  runner = new WasmRunner(dir)
  await runner.rescan()
  return runner
}

describe('a legitimate rule on a busy machine', () => {
  it('reaches its verdict on the largest input while every core is busy', async () => {
    const r = await runnerWith({ '10_shell.wasm': fixture('examples/block_destructive_shell.wasm') })
    const long = `${'cd /workspace/app && npm test; '.repeat(2050)}rm -rf /`
    // Eight busy threads per core: about what a 4-vCPU CI runner sees running
    // every package's tests at once. At the old 100 ms deadline this refused
    // legitimate evaluations. A rule within its fuel must not
    // be refused because the machine is busy.
    const burners = Array.from({ length: availableParallelism() * 8 }, () => new Worker('for (;;) {}', { eval: true }))
    await Promise.all(burners.map((b) => new Promise((resolve) => b.once('online', resolve))))
    try {
      const verdicts: string[] = []
      for (let i = 0; i < 100; i++) {
        const v = await r.evaluate(bash(long))
        verdicts.push(v.code === 'unavailable' ? `unavailable (${v.stop}): ${v.reason}` : v.code)
      }
      expect(verdicts).toEqual(Array(100).fill('block'))
    } finally {
      await Promise.all(burners.map((b) => b.terminate()))
    }
  }, 120_000)

})

/** `(module (memory (export "memory") 17) (func (export "allocate") …) (func (export "evaluate") … loop of memory.fill …))`. */
function slowLoopRule(): Uint8Array {
  const section = (id: number, body: number[]): number[] => [id, body.length, ...body]
  const name = (s: string): number[] => [s.length, ...Buffer.from(s)]
  const allocate = [0x00, 0x41, 0x00, 0x0b]
  const evaluate = [
    0x00,
    0x03, 0x40, // loop
    0x41, 0x80, 0x80, 0x04, // i32.const 65536
    0x41, 0x07, // i32.const 7
    0x41, 0x80, 0x80, 0xc0, 0x00, // i32.const 1048576
    0xfc, 0x0b, 0x00, // memory.fill
    0x0c, 0x00, // br 0
    0x0b, // end loop
    0x41, 0x01, // i32.const 1
    0x0b,
  ]
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, [2, 0x60, 1, 0x7f, 1, 0x7f, 0x60, 2, 0x7f, 0x7f, 1, 0x7f]),
    ...section(3, [2, 0, 1]),
    ...section(5, [1, 0x00, 17]),
    ...section(7, [3, ...name('memory'), 0x02, 0, ...name('allocate'), 0x00, 0, ...name('evaluate'), 0x00, 1]),
    ...section(10, [2, allocate.length, ...allocate, evaluate.length, ...evaluate]),
  ])
}

describe('the per-rule deadline', () => {
  it('stops a rule that never returns while spending little fuel, and refuses the call', async () => {
    dir = mkdtempSync(join(tmpdir(), 'intutic-mcp-deadline-'))
    writeFileSync(join(dir, '10_slow.wasm'), slowLoopRule())
    runner = new WasmRunner(dir)
    await runner.rescan()
    expect(runner.getLoadedRuleIds()).toEqual(['local:10_slow.wasm'])

    // Each iteration fills a megabyte for one instruction of fuel, so the
    // 1,000,000-instruction budget alone would let it run for most of a minute:
    // the stall the deadline is the backstop for. The refusal comes at the
    // deadline, not after the stuck worker stops — V8 can take seconds to stop
    // this loop, and the replacement worker is not waited for.
    const started = Date.now()
    const verdict = await runner.evaluate(bash('ls'))
    const elapsed = Date.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(EVALUATE_TIMEOUT_MS)
    // The timer fires late on a starved event loop, never early.
    expect(elapsed).toBeLessThan(EVALUATE_TIMEOUT_MS + 9_000)
    expect(verdict).toMatchObject({ code: 'unavailable', stop: 'deadline', ruleId: 'local:10_slow.wasm' })
    expect(verdict.code === 'unavailable' && verdict.reason).toContain(`ran past its ${EVALUATE_TIMEOUT_MS} ms deadline`)

    // The next evaluation runs in the replacement worker.
    expect(await runner.evaluate(bash('ls'))).toMatchObject({ code: 'unavailable', stop: 'deadline' })
  }, 30_000)
})
