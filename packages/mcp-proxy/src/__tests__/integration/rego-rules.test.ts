/**
 * integration/rego-rules.test.ts — Rego policies compiled by OPA, loaded from
 * a rules directory and evaluated through the real `worker_threads` worker.
 *
 * The modules are the Rust proxy's fixtures
 * (`packages/proxy/tests/fixtures/rego/`), so both hosts are tested on the
 * same OPA builds; the shared host's own conformance against `opa eval` is in
 * `packages/shared-types`.
 *
 * Also here: the per-rule deadline actually stopping a rule. The Rust proxy's
 * deadline used to be read only after the guest returned; this host's never
 * was, because it races the worker from the main thread and terminates it.
 * A rule stopped by it, or returning something that is not a decision,
 * reaches no verdict: refused fail-closed, allowed fail-open.
 *
 * @module
 */

import { describe, it, expect, afterEach } from 'vitest'
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WasmRunner } from '../../wasm/runner.js'
import type { WasmContextInput } from '../../wasm/context.js'

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../../../../proxy/tests/fixtures/rego/${name}`, import.meta.url))

const bash = (command: string): WasmContextInput => ({
  sessionId: 'ses_rego',
  workspaceId: 'ws_rego',
  tools: [],
  toolCallId: 'call_rego',
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
  delete process.env['INTUTIC_DISABLE_REGO_RULES']
})

async function runnerWith(files: Record<string, string>): Promise<WasmRunner> {
  dir = mkdtempSync(join(tmpdir(), 'intutic-mcp-rego-'))
  for (const [name, source] of Object.entries(files)) copyFileSync(source, join(dir, name))
  runner = new WasmRunner(dir)
  await runner.rescan()
  return runner
}

describe('Rego rules in the MCP proxy', () => {
  it('loads OPA builds by default, refusing one that needs a builtin the host lacks', async () => {
    const r = await runnerWith({
      '10_shell.wasm': fixture('examples/block_destructive_shell.wasm'),
      '20_deploy.wasm': fixture('examples/hold_prod_deploys.wasm'),
      '30_unsupported.wasm': fixture('unsupported_builtin.wasm'),
    })
    expect(r.getLoadedRuleIds()).toEqual(['local:10_shell.wasm', 'local:20_deploy.wasm'])

    expect(await r.evaluate(bash('rm -rf /'))).toEqual({
      code: 'block',
      reason: 'destructive shell command blocked: rm -rf /',
      ruleId: 'local:10_shell.wasm',
    })
    expect(await r.evaluate(bash('kubectl apply -f k8s/ --context=prod-eu'))).toEqual({
      code: 'hold',
      reason: 'production deploy needs approval: kubectl apply -f k8s/ --context=prod-eu',
      ruleId: 'local:20_deploy.wasm',
      riskTier: 'high',
    })
    expect(await r.evaluate(bash('ls -la'))).toEqual({ code: 'allow' })
  }, 30_000)

  it('refuses Rego rules when INTUTIC_DISABLE_REGO_RULES=1', async () => {
    process.env['INTUTIC_DISABLE_REGO_RULES'] = '1'
    const r = await runnerWith({ '10_shell.wasm': fixture('examples/block_destructive_shell.wasm') })
    expect(r.getLoadedRuleIds()).toEqual([])
    expect(await r.evaluate(bash('rm -rf /'))).toEqual({ code: 'allow' })
  }, 30_000)

  it('evaluates the largest input the builder produces within the Rego budget', async () => {
    const r = await runnerWith({ '10_shell.wasm': fixture('examples/block_destructive_shell.wasm') })
    // Just under the input cap, so nothing is cut, with the match at the end:
    // only the rule matching the whole command can block it.
    const long = `${'cd /workspace/app && npm test; '.repeat(2050)}rm -rf /`
    // It takes about 3 ms against a 100 ms deadline, but CI runs every
    // package's suite at once and a starved worker can miss the deadline,
    // which fail-closed refuses as `unavailable`. One rerun separates that
    // from a rule too slow for its budget, which misses it every time.
    let verdict = await r.evaluate(bash(long))
    if (verdict.code === 'unavailable' && verdict.stop === 'deadline') verdict = await r.evaluate(bash(long))
    // The pattern matched, not the truncation guard: the reason is the
    // command's own, cut to the 480 characters a reason may have.
    expect(verdict).toMatchObject({ code: 'block', ruleId: 'local:10_shell.wasm' })
    expect(verdict.code === 'block' && verdict.reason).toMatch(/^destructive shell command blocked: cd \/workspace\/app/)
  }, 30_000)

  it('refuses a destructive command padded past the input cap, where the cut hides it', async () => {
    const r = await runnerWith({ '10_shell.wasm': fixture('examples/block_destructive_shell.wasm') })
    // Over 64 KB: the command is cut to fit and `truncated` is set, so the
    // `rm -rf /` at the end never reaches the policy. The shipped example
    // refuses a shell command it could not see in full.
    const padded = `${'echo ok; '.repeat(8_000)}rm -rf /`
    let verdict = await r.evaluate(bash(padded))
    if (verdict.code === 'unavailable' && verdict.stop === 'deadline') verdict = await r.evaluate(bash(padded))
    expect(verdict).toMatchObject({ code: 'block', ruleId: 'local:10_shell.wasm' })
    expect(verdict.code === 'block' && verdict.reason).toContain('too long to check in full')
  }, 30_000)

  it('a Rego result that is not a decision reaches no verdict', async () => {
    // The conformance policy's entrypoint is an object of builtin results,
    // with no `decision`.
    const r = await runnerWith({ '10_conformance.wasm': fixture('conformance.wasm') })
    const closed = await r.evaluate(bash('ls'))
    expect(closed).toMatchObject({ code: 'unavailable', stop: 'result', ruleId: 'local:10_conformance.wasm' })
    expect(closed.code === 'unavailable' && closed.reason).toContain('without a known `decision`')
    expect(await r.evaluate(bash('ls'), { failOpen: true })).toEqual({ code: 'allow' })
  }, 30_000)
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
  it('stops a rule that never returns while spending little fuel: refused fail-closed, allowed fail-open', async () => {
    dir = mkdtempSync(join(tmpdir(), 'intutic-mcp-deadline-'))
    writeFileSync(join(dir, '10_slow.wasm'), slowLoopRule())
    runner = new WasmRunner(dir)
    await runner.rescan()
    expect(runner.getLoadedRuleIds()).toEqual(['local:10_slow.wasm'])

    // Each iteration fills a megabyte for one instruction of fuel, so the
    // 1,000,000-instruction budget alone would let it run for most of a minute.
    const started = Date.now()
    const closed = await runner.evaluate(bash('ls'))
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(closed).toMatchObject({ code: 'unavailable', stop: 'deadline', ruleId: 'local:10_slow.wasm' })
    expect(closed.code === 'unavailable' && closed.reason).toContain('ran past its 50 ms deadline')

    expect(await runner.evaluate(bash('ls'), { failOpen: true })).toEqual({ code: 'allow' })
  }, 30_000)
})
