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
 * Host imports mirroring the proxy's set exactly — `log_info`, `abort`,
 * `trace`, and nothing else. Notably no `seed`: a rule reaching
 * `Math.random()` must fail here the same way it fails in the proxy, or this
 * harness would validate rules the proxy then silently bypasses.
 */
function evaluate(mockPath: string): number {
  const bytes = readFileSync(wasmPath)
  const mod = new WebAssembly.Module(bytes)
  let instance: WebAssembly.Instance | null = null
  const imports = {
    env: {
      log_info: () => {},
      abort: (_m: number, _f: number, line: number, col: number) => {
        throw new Error(`AssemblyScript abort at ${line}:${col}`)
      },
      trace: () => {},
    },
  }
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
