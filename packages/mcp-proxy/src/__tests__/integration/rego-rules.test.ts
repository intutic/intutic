/**
 * integration/rego-rules.test.ts — Rego policies compiled by OPA, loaded from
 * a rules directory and evaluated through the real `worker_threads` worker.
 *
 * The modules are the Rust proxy's fixtures
 * (`packages/proxy/tests/fixtures/rego/`), so both hosts are tested on the
 * same OPA builds; the shared host's own conformance against `opa eval` is in
 * `packages/shared-types`.
 *
 * A rule returning something that is not a decision reaches no verdict and
 * refuses the call. The tests that load the machine or wait out a deadline are
 * in `load/ruleLimits.test.ts`, which runs on its own.
 *
 * @module
 */

import { describe, it, expect, afterEach } from 'vitest'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
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
    // No rerun: fuel is the limit this has to fit, and it fits the same way
    // on any machine; the deadline is a backstop far above the time it takes
    // on a loaded one (load/ruleLimits.test.ts).
    const verdict = await r.evaluate(bash(long))
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
    const verdict = await r.evaluate(bash(padded))
    expect(verdict).toMatchObject({ code: 'block', ruleId: 'local:10_shell.wasm' })
    expect(verdict.code === 'block' && verdict.reason).toContain('too long to check in full')
  }, 30_000)

  it('a Rego result that is not a decision reaches no verdict', async () => {
    // The conformance policy's entrypoint is an object of builtin results,
    // with no `decision`.
    const r = await runnerWith({ '10_conformance.wasm': fixture('conformance.wasm') })
    const verdict = await r.evaluate(bash('ls'))
    expect(verdict).toMatchObject({ code: 'unavailable', stop: 'result', ruleId: 'local:10_conformance.wasm' })
    expect(verdict.code === 'unavailable' && verdict.reason).toContain('without a known `decision`')
  }, 30_000)
})
