/**
 * A rule the MCP proxy cannot load is named by the same reasons the Rust
 * proxy files a refused control-plane rule under (`RULE_LOAD_FAILURE_REASONS`).
 */
import { describe, it, expect, afterAll } from 'vitest'
import * as node_os from 'node:os'
import * as node_path from 'node:path'
import { mkdtempSync } from 'node:fs'
import { RULE_LOAD_FAILURE_REASONS } from '@intutic/shared-types'
import { WasmRunner } from '../wasm/runner.js'

const runner = new WasmRunner(mkdtempSync(node_path.join(node_os.tmpdir(), 'intutic-load-failure-')))

afterAll(async () => {
  await runner.shutdown()
})

const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]
const str = (s: string) => [s.length, ...Buffer.from(s)]

/** Imports `env.seed`, which no host provides. */
const SEED = new Uint8Array([
  ...HEADER,
  0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7c, // type 0: () -> f64
  0x02, 0x0c, 0x01, ...str('env'), ...str('seed'), 0x00, 0x00, // import env.seed: type 0
])

describe('a rule the MCP proxy cannot load', () => {
  it.each([
    ['bytes that are not a module', new Uint8Array([...HEADER, 0xff, 0xff]), 'compile_error'],
    ['an import the host does not provide', SEED, 'unsupported_import'],
  ] as const)('%s is a %s', async (_what, bytes, reason) => {
    const outcome = await runner.compile('local:broken.wasm', bytes)
    expect(outcome).toMatchObject({ ok: false, reason })
    expect(RULE_LOAD_FAILURE_REASONS).toContain(reason)
  })
})
