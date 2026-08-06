/**
 * Every drop-in rule under `rules/` compiles on its own and is asserted both ways.
 *
 * The library already existed as functions inside `assembly/index.ts`, exercised
 * through the template's `runRules()`. That proves the *logic*, and proves
 * nothing about the thing a user actually does: take one directory, compile it,
 * and install it. A rule that only works when compiled as part of the template
 * is not a drop-in rule, and "copy this function out of a 700-line file" is the
 * adoption gap this library exists to close.
 *
 * So each rule is compiled here **standalone**, exactly as the README tells a
 * user to compile it, and evaluated against its own two mocks.
 *
 * The allow mock is the sharper half. Each is a near-miss — differing from the
 * block case in as few fields as possible — chosen to catch the specific
 * inversion that rule's fields invite: unknown read as dead, unknown read as
 * zero, an empty allowlist read as "permit nothing". An allow mock that differs
 * in everything proves only that the rule is not a constant.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync, existsSync, readdirSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WASM_HOST_IMPORTS } from '@intutic/shared-types'

const here = dirname(fileURLToPath(import.meta.url))
const sdkRoot = join(here, '..')
const rulesDir = join(sdkRoot, 'rules')

/** 0 allow · 1 block · 3 reask. 2 is deprecated and must not be produced. */
type Verdict = 0 | 1 | 3

/**
 * What each rule must return for its block mock.
 *
 * Block versus reask is a judgement, not a detail: reask is for findings that
 * produce false positives (pattern matches, and a tier describing the SOP
 * rather than the request), block is for facts the agent cannot correct.
 * Pinning it here means flipping one is a visible change.
 */
const EXPECTED: Record<string, Verdict> = {
  'tool-contract-pinned': 1,
  'orphaned-node': 1,
  'graph-budget-guard': 1,
  'harness-allowlist': 1,
  'injection-then-egress': 3,
  'risk-tier-ceiling': 3,
}

const HOST_IMPL: Record<string, (...a: number[]) => void> = {
  log_info: () => {},
  abort: (_m: number, _f: number, line: number, col: number) => {
    throw new Error(`AssemblyScript abort at ${line}:${col}`)
  },
  trace: () => {},
}

let outDir: string

beforeAll(() => {
  outDir = mkdtempSync(join(tmpdir(), 'intutic-dropin-'))
}, 240_000)

afterAll(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true })
})

function compile(slug: string): string {
  const out = join(outDir, `${slug}.wasm`)
  // The exact invocation `rule.ts` documents, and the same flags
  // `buildCompileArgs` in the CLI produces. If these drift, a rule that passes
  // here can still fail for a user following the README.
  const res = spawnSync(
    'npx',
    ['asc', join('rules', slug, 'rule.ts'), '-o', out, '--optimize', '--exportRuntime'],
    { cwd: sdkRoot, encoding: 'utf8' },
  )
  if (res.status !== 0 || !existsSync(out)) {
    throw new Error(`asc failed for ${slug}:\n${res.stdout}\n${res.stderr}`)
  }
  return out
}

function evaluate(wasmPath: string, mockPath: string): number {
  const mod = new WebAssembly.Module(readFileSync(wasmPath))
  const env: WebAssembly.ModuleImports = {}
  for (const name of WASM_HOST_IMPORTS) {
    const impl = HOST_IMPL[name]
    if (!impl) {
      throw new Error(
        `${name} is registered by the proxy and not implemented here — a rule using ` +
          'it would pass this harness and fail to link in the proxy.',
      )
    }
    env[name] = impl
  }
  const instance = new WebAssembly.Instance(mod, { env })
  const ex = instance.exports as Record<string, unknown>
  const allocate = ex.allocate as (n: number) => number
  const evaluateFn = ex.evaluate as (off: number, len: number) => number
  const memory = ex.memory as WebAssembly.Memory

  const bytes = Buffer.from(readFileSync(mockPath, 'utf8'))
  const offset = allocate(bytes.length)
  // Re-read the buffer after allocate: it can grow memory, which detaches any
  // view taken before the call.
  new Uint8Array(memory.buffer, offset, bytes.length).set(bytes)
  return evaluateFn(offset, bytes.length)
}

/** Every allow context a rule ships: `allow.json` plus any `allow-*.json`. */
function allowMocks(slug: string): string[] {
  return readdirSync(join(rulesDir, slug))
    .filter((f) => f === 'allow.json' || (f.startsWith('allow-') && f.endsWith('.json')))
    .sort()
}

const slugs = existsSync(rulesDir)
  ? readdirSync(rulesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  : []

describe('drop-in rule library', () => {
  it('ships rules at all', () => {
    // Guards against the directory being emptied or renamed, which would turn
    // every it.each below into zero silently-passing tests.
    expect(slugs.length, 'packages/wasm-sdk/rules/ is empty').toBeGreaterThanOrEqual(6)
  })

  it('has an expectation pinned for every rule present', () => {
    // A new rule added without an entry in EXPECTED would otherwise be compiled
    // and never asserted.
    const unpinned = slugs.filter((s) => !(s in EXPECTED))
    expect(unpinned, `add these to EXPECTED with their intended verdict`).toEqual([])
  })

  it.each(slugs)('%s ships both mocks and a rule', (slug) => {
    for (const f of ['rule.ts', 'block.json', 'allow.json']) {
      expect(existsSync(join(rulesDir, slug, f)), `${slug}/${f} is missing`).toBe(true)
    }
  })

  it.each(slugs)('%s compiles on its own and refuses its block case', (slug) => {
    const wasm = compile(slug)
    const verdict = evaluate(wasm, join(rulesDir, slug, 'block.json'))
    expect(verdict, `${slug} allowed the context it exists to refuse`).toBe(EXPECTED[slug])
  }, 120_000)

  it.each(slugs)('%s allows every near-miss it ships', (slug) => {
    const wasm = compile(slug)
    for (const mock of allowMocks(slug)) {
      const verdict = evaluate(wasm, join(rulesDir, slug, mock))
      expect(
        verdict,
        `${slug} refused ${mock}, a context it should permit — this is the ` +
          'inversion the near-miss exists to catch (unknown read as zero, or an ' +
          'empty list read as "permit nothing")',
      ).toBe(0)
    }
  }, 180_000)

  /**
   * A rule whose only allow case is its sentinel guard is not actually pinned.
   *
   * Three of these shipped that way. `graph-budget-guard`'s single allow mock
   * set `graph_spend_usd: -1`, exercising the unknown guard and nothing else —
   * so a rule reading `spend >= 0 ? block : allow`, ignoring the budget
   * entirely, passed both mocks. `harness-allowlist` allowed only on an EMPTY
   * allowlist, so `allowed.length === 0 ? allow : block` passed. And
   * `risk-tier-ceiling` allowed only by lowering the tier, so a rule reading the
   * tier alone and never looking at `new_tool_calls` passed — which is exactly
   * the over-fire its docstring warns about.
   *
   * Each of those needs a second allow case: the ordinary permitted request,
   * with the sentinel absent.
   */
  it.each(slugs)('%s pins the ordinary permit, not only its sentinel guard', (slug) => {
    const mocks = allowMocks(slug)
    const block = JSON.parse(readFileSync(join(rulesDir, slug, 'block.json'), 'utf8'))
    const sentinelOnly = mocks.every((m) => {
      const allow = JSON.parse(readFileSync(join(rulesDir, slug, m), 'utf8'))
      // A sentinel case is one that differs from the block context only by
      // removing information: an unknown marker, or an emptied list.
      return Object.keys(block).some((k) => {
        const b = block[k]
        const a = allow[k]
        if (JSON.stringify(b) === JSON.stringify(a)) return false
        return a === -1 || (Array.isArray(a) && a.length === 0) || a === '' || a === null
      })
    })
    expect(
      sentinelOnly,
      `every allow mock for ${slug} works by removing information (-1, [], ''). ` +
        'Add one where the rule permits a fully-populated, ordinary request — ' +
        'otherwise a rule that blocks whenever the data is present passes.',
    ).toBe(false)
  })

  it.each(slugs)('%s allow mocks differ from the block mock in few fields', (slug) => {
    // A near-miss that differs in everything proves only that the rule is not
    // constant. Keeping them close is what makes the allow case an assertion
    // about this rule's specific failure mode.
    const block = JSON.parse(readFileSync(join(rulesDir, slug, 'block.json'), 'utf8'))
    const allow = JSON.parse(readFileSync(join(rulesDir, slug, 'allow.json'), 'utf8'))
    const keys = new Set([...Object.keys(block), ...Object.keys(allow)])
    const differing = [...keys].filter(
      (k) => JSON.stringify(block[k]) !== JSON.stringify(allow[k]),
    )
    expect(differing.length, `${slug} differs in ${differing.join(', ')}`).toBeGreaterThan(0)
    expect(
      differing.length,
      `${slug}'s allow mock differs in ${differing.length} fields (${differing.join(', ')}) — ` +
        'too far from the block case to isolate what this rule actually reads',
    ).toBeLessThanOrEqual(4)
  })

  it.each(slugs)('%s never returns the deprecated code 2', (slug) => {
    const wasm = compile(slug)
    for (const mock of ['block.json', ...allowMocks(slug)]) {
      const v = evaluate(wasm, join(rulesDir, slug, mock))
      expect(v, `${slug} returned 2 on ${mock}; the proxy maps 2 to a block`).not.toBe(2)
    }
  }, 120_000)
})
