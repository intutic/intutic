/**
 * Every starter rule is asserted in both directions against the compiled WASM.
 *
 * This is the discipline `RULE_AUTHOR_SKILL.md` asks of anyone writing a rule —
 * author a should-block and a should-allow context, and verify both before
 * installing. The library models it rather than only describing it.
 *
 * It also makes each rule the coverage test for the context field family it
 * reads. Delete the parse line for `tool_contract_changed` and
 * `tool-contract-pinned` stops blocking its own block mock; the same holds for
 * `parent_alive`, the graph budget sentinels, `harness`, `injection_findings`
 * and `risk_tier`. That is the point of picking one rule per field family with
 * no other consumer — the example and the guard are the same artefact.
 *
 * The allow mocks are the sharper half. Each is a near-miss chosen to catch the
 * specific inversion that field invites: unknown read as dead, unknown read as
 * zero, an empty allowlist read as "permit nothing".
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WASM_HOST_IMPORTS } from '@intutic/shared-types'

const here = dirname(fileURLToPath(import.meta.url))
const sdkRoot = join(here, '..')
const mocks = join(sdkRoot, 'assembly', 'mocks')

/** 0 allow · 1 block · 3 reask. 2 is deprecated and must not be produced. */
type Verdict = 0 | 1 | 3

const RULES: Array<{ name: string; blockVerdict: Verdict; why: string }> = [
  { name: 'tool-contract-pinned', blockVerdict: 1, why: 'a server changing its contract is not something the agent can correct' },
  { name: 'orphaned-node', blockVerdict: 1, why: 'work nobody is waiting for should stop' },
  { name: 'graph-budget-guard', blockVerdict: 1, why: 'the graph is over its ceiling' },
  { name: 'harness-allowlist', blockVerdict: 1, why: 'the harness is not permitted for this role' },
  { name: 'injection-then-egress', blockVerdict: 3, why: 'injection findings are pattern matches and do produce false positives' },
  { name: 'risk-tier-ceiling', blockVerdict: 3, why: 'the tier describes the SOP, not this request' },
]

let wasmPath: string

/**
 * Host imports built from `WASM_HOST_IMPORTS`, not listed again here.
 *
 * This harness used to hardcode `{ log_info, abort, trace }` under a docstring
 * claiming it "mirrors the proxy's set exactly" — the fifth such copy, and one
 * the parity linter did not read. Any of them could have re-added `seed` with
 * no signal, which is exactly how the original bypass happened: a rule reaching
 * `Math.random()` validated here and then failed to link in the proxy, where a
 * link error becomes a silent allow.
 *
 * Deriving the set means a host import added in Rust makes this fail loudly
 * (missing implementation) rather than quietly validating rules the proxy
 * cannot run.
 */
const HOST_IMPL: Record<string, (...a: number[]) => void | number> = {
  log_info: () => {},
  abort: (_m: number, _f: number, line: number, col: number) => {
    throw new Error(`AssemblyScript abort at ${line}:${col}`)
  },
  trace: () => {},
  // Refuses every read (-2 is ERR_REFUSED in the proxy). There is no live tool
  // call behind a fixture context, so there is no set of referenced files to
  // serve — and inventing one off this machine's disk would make the harness
  // disagree with production in the permissive direction, which is the one that
  // ships rules that never fire.
  read_referenced_file: () => -2,
}

function evaluate(mockPath: string): number {
  const bytes = readFileSync(wasmPath)
  const mod = new WebAssembly.Module(bytes)
  let instance: WebAssembly.Instance | null = null
  const env: WebAssembly.ModuleImports = {}
  for (const name of WASM_HOST_IMPORTS) {
    const impl = HOST_IMPL[name]
    if (!impl) {
      throw new Error(
        `${name} is a host import the proxy registers and this harness does not implement. ` +
          'Add it to HOST_IMPL — a rule using it would validate here and fail to link in the proxy.',
      )
    }
    env[name] = impl
  }
  const imports = { env }
  instance = new WebAssembly.Instance(mod, imports)
  const ex = instance.exports as Record<string, unknown>

  const json = readFileSync(mockPath, 'utf8')
  const encoded = new TextEncoder().encode(json)
  const alloc = (ex.allocate ?? ex.__new) as (n: number, id?: number) => number
  const offset = ex.allocate ? alloc(encoded.length) : alloc(encoded.length, 1)
  const mem = new Uint8Array((ex.memory as WebAssembly.Memory).buffer)
  mem.set(encoded, offset)

  return (ex.evaluate as (o: number, l: number) => number)(offset, encoded.length)
}

describe('starter rule library', () => {
  beforeAll(() => {
    wasmPath = join(tmpdir(), `starter-rules-${process.pid}.wasm`)
    const res = spawnSync(
      'npx',
      ['--no-install', 'asc', 'assembly/index.ts', '-o', wasmPath, '--optimize', '--exportRuntime'],
      { cwd: sdkRoot, encoding: 'utf8' },
    )
    if (res.status !== 0) throw new Error(`asc failed:\n${res.stderr}`)
  }, 180_000)

  it('ships the rules it claims to', () => {
    // Guard against the list silently emptying, which would make every
    // assertion below vacuous.
    expect(RULES.length).toBeGreaterThanOrEqual(6)
    for (const r of RULES) {
      expect(existsSync(join(mocks, `${r.name}.block.json`)), `${r.name}.block.json missing`).toBe(true)
      expect(existsSync(join(mocks, `${r.name}.allow.json`)), `${r.name}.allow.json missing`).toBe(true)
    }
  })

  for (const rule of RULES) {
    it(`${rule.name} refuses its block case (${rule.blockVerdict === 3 ? 'reask' : 'block'} — ${rule.why})`, () => {
      expect(evaluate(join(mocks, `${rule.name}.block.json`))).toBe(rule.blockVerdict)
    })

    it(`${rule.name} allows its near-miss`, () => {
      expect(
        evaluate(join(mocks, `${rule.name}.allow.json`)),
        `${rule.name} fired on a context it should not — the allow mocks are the ` +
          `near-misses each field invites, so this is the assertion that catches an inverted sentinel`,
      ).toBe(0)
    })
  }

  it('no rule returns the deprecated code 2', () => {
    for (const rule of RULES) {
      for (const kind of ['block', 'allow']) {
        expect(evaluate(join(mocks, `${rule.name}.${kind}.json`))).not.toBe(2)
      }
    }
  })

  afterAll(() => {
    if (wasmPath && existsSync(wasmPath)) rmSync(wasmPath)
  })
})
