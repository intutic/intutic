/**
 * A rendered predicate must compile, link, and decide correctly.
 *
 * Everything upstream of this is string manipulation. The DSL tests assert the
 * renderer emits the right *text*; this asserts the text is a working rule — it
 * compiles with the same `asc` invocation a user runs, links against exactly the
 * host imports the proxy provides, and returns the verdict the predicate meant
 * when handed a real context.
 *
 * It lives in the SDK package because that is where the toolchain is, and it
 * imports the renderer from `@intutic/shared-types` — the same definition the
 * control plane renders from. Asserting against a copy would prove only that the
 * copy is self-consistent, which is the failure this pipeline is designed
 * around.
 *
 * ## The gate this replaces
 *
 * Without it, a generated rule's only evidence would be that its predicate
 * validated. A predicate can validate and still render source that reads a field
 * the guest fills with a default — and a rule that compiles, installs, and never
 * fires is indistinguishable from one that works until something needed it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WASM_HOST_IMPORTS, renderRule, type Predicate } from '@intutic/shared-types'

const here = dirname(fileURLToPath(import.meta.url))
const sdkRoot = join(here, '..')

/**
 * Scratch space for rendered rules — two levels below the SDK root, and
 * deliberately **not** under `rules/`.
 *
 * `renderRule` emits `import … from "../../assembly/index"`, so the depth is
 * fixed; the parent is not. This used to be `rules/__generated_test__`, which
 * put a directory into the very tree `dropInRules.test.ts` enumerates at module
 * load to build its slug list — and `vitest.config.ts` sets no `fileParallelism`,
 * so the two files run in parallel forks. Whenever this `beforeAll` won the race,
 * `__generated_test__` became a seventh "rule" with no `block.json` and no
 * pinned expectation, and two of that file's assertions failed for reasons
 * nothing in either file would explain.
 *
 * Filtering `__`-prefixed names out of the slug list would have hidden it at the
 * cost of the pinning gate, whose entire job is to notice an unasserted rule.
 * Moving the scratch directory costs nothing and removes the interaction.
 */
const genDir = join(sdkRoot, '.gen-test', 'rules')
/** The same path relative to `sdkRoot`, which is `asc`'s working directory. */
const genDirRel = join('.gen-test', 'rules')

let outDir: string

beforeAll(() => {
  outDir = mkdtempSync(join(tmpdir(), 'intutic-gen-'))
  mkdirSync(genDir, { recursive: true })
}, 240_000)

afterAll(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true })
  // The whole scratch root, not just the `rules/` level inside it, or an empty
  // `.gen-test` is left in the working tree after every run.
  rmSync(join(sdkRoot, '.gen-test'), { recursive: true, force: true })
})

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

/**
 * Runs a child process without blocking the event loop.
 *
 * `spawnSync` is what this used to call, and it made the suite fail while all
 * 104 assertions passed. Vitest's worker answers the runner over birpc, and an
 * in-flight `onTaskUpdate` reply is only read once the loop reaches its poll
 * phase — which consecutive synchronous test bodies never let it do. A file
 * whose compiles cumulatively block past birpc's hardcoded 60s reports
 * `Timeout calling "onTaskUpdate"` as an unhandled error *after* printing a
 * green result, and vitest 3.2.6 passes no timeout to either RPC factory, so
 * there is nothing to configure.
 *
 * Invisible locally, fatal in CI: one `asc` compile is ~1.4s here and 8–38s on a
 * two-core runner, which put this file at 267s and `dropInRules` at 171s. Those
 * were the only two of four to cross the line, and exactly two errors were
 * reported.
 */
function runProcess(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<{ status: number; stdout: string; stderr: string; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => { stdout += d })
    child.stderr.on('data', (d: string) => { stderr += d })
    child.on('error', reject)
    // Signal death becomes -1 plus the signal rather than a flattened number, so
    // "killed" can never read as a compiler verdict.
    child.on('close', (code, signal) =>
      resolve({ status: code === null ? -1 : code, stdout, stderr, signal }),
    )
  })
}

/** Renders, compiles, and returns the path to the built module. */
async function build(predicate: Predicate, verdict: number, name: string): Promise<string> {
  const src = renderRule({
    predicate,
    verdict,
    title: `test ${name}`,
    rationale: 'generated in a test',
    candidateId: `rc_${name}`,
  })
  const srcPath = join(genDir, `${name}.ts`)
  writeFileSync(srcPath, src)

  const out = join(outDir, `${name}.wasm`)
  const res = await runProcess(
    'npx',
    ['asc', join(genDirRel, `${name}.ts`), '-o', out, '--optimize', '--exportRuntime'],
    sdkRoot,
  )
  if (res.status !== 0 || !existsSync(out)) {
    throw new Error(
      `generated rule ${name} did not compile${res.signal ? ` (killed by ${res.signal})` : ''}:\n` +
        `${src}\n${res.stdout}\n${res.stderr}`,
    )
  }
  return out
}

function evaluate(wasmPath: string, ctx: Record<string, unknown>): number {
  const mod = new WebAssembly.Module(readFileSync(wasmPath))
  // Exactly the proxy's host set. A rule that needs more must fail here the way
  // it fails there, or this harness validates rules the proxy silently bypasses.
  const env: WebAssembly.ModuleImports = {}
  for (const n of WASM_HOST_IMPORTS) env[n] = HOST_IMPL[n]
  const instance = new WebAssembly.Instance(mod, { env })
  const ex = instance.exports as Record<string, unknown>
  const allocate = ex.allocate as (n: number) => number
  const evaluateFn = ex.evaluate as (o: number, l: number) => number
  const memory = ex.memory as WebAssembly.Memory

  const bytes = Buffer.from(JSON.stringify(ctx))
  const offset = allocate(bytes.length)
  new Uint8Array(memory.buffer, offset, bytes.length).set(bytes)
  return evaluateFn(offset, bytes.length)
}

describe('a rendered predicate is a working rule', () => {
  it('compiles and links against exactly the proxy host imports', async () => {
    const wasm = await build({ all: [{ field: 'harness', op: 'equals', value: 'cursor' }] }, 1, 'harness')
    const imports = WebAssembly.Module.imports(new WebAssembly.Module(readFileSync(wasm)))
      .filter((i) => i.kind === 'function')
      .map((i) => `${i.module}.${i.name}`)
    for (const i of imports) {
      expect(
        WASM_HOST_IMPORTS.some((n) => i === `env.${n}`),
        `${i} is not provided by the proxy; this rule would fail open on every request`,
      ).toBe(true)
    }
  }, 120_000)

  it('blocks the matching context and allows the near-miss', async () => {
    const wasm = await build({ all: [{ field: 'harness', op: 'equals', value: 'cursor' }] }, 1, 'nearmiss')
    expect(evaluate(wasm, { harness: 'cursor' })).toBe(1)
    expect(evaluate(wasm, { harness: 'claude-code' })).toBe(0)
  }, 120_000)

  it('allows the SDK default context, which asserts nothing about the rule’s field', async () => {
    // The DEFAULT_ALLOW gate: a rule that blocks an empty context blocks
    // everything, and would have been caught by nothing else here.
    const wasm = await build({ all: [{ field: 'harness', op: 'equals', value: 'cursor' }] }, 1, 'default')
    expect(evaluate(wasm, {})).toBe(0)
  }, 120_000)

  it('reads unknown as unknown, not as under the limit', async () => {
    // The inversion the DSL exists to make impossible. -1 is what the host sends
    // when there is no workflow; a rule that reads it as "spent nothing" is
    // wrong in the direction that lets real overspend through, and one that
    // reads it as "over budget" blocks every request outside a workflow.
    const wasm = await build(
      { all: [{ field: 'workflow_spend_usd', op: 'atLeast', value: 10 }] },
      1,
      'unknown',
    )
    expect(evaluate(wasm, { workflow_spend_usd: 50 }), 'over the limit').toBe(1)
    expect(evaluate(wasm, { workflow_spend_usd: 1 }), 'under the limit').toBe(0)
    expect(
      evaluate(wasm, {}),
      'absent means unknown; blocking here stops every request outside a workflow',
    ).toBe(0)
    expect(evaluate(wasm, { workflow_spend_usd: -1 }), 'the explicit sentinel').toBe(0)
  }, 120_000)

  it('reads an empty allowlist as unrestricted', async () => {
    const wasm = await build(
      { all: [{ field: 'allowed_harnesses', op: 'notContains', value: 'cursor' }] },
      1,
      'allowlist',
    )
    expect(evaluate(wasm, { allowed_harnesses: ['claude-code'] }), 'not permitted').toBe(1)
    expect(evaluate(wasm, { allowed_harnesses: ['cursor'] }), 'permitted').toBe(0)
    // An empty list is the case that matters: it means nobody restricted
    // anything, and `notContains` on it is trivially true.
    const explicit = await build(
      {
        all: [
          { field: 'allowed_harnesses', op: 'listNotEmpty' },
          { field: 'allowed_harnesses', op: 'notContains', value: 'cursor' },
        ],
      },
      1,
      'allowlist2',
    )
    expect(
      evaluate(explicit, {}),
      'an unrestricted workspace must not be blocked by an allowlist rule',
    ).toBe(0)
  }, 120_000)

  it('distinguishes this turn from the whole session', async () => {
    const turn = await build(
      { all: [{ field: 'new_tool_calls', op: 'contains', value: 'action:deploy' }] },
      3,
      'turn',
    )
    expect(evaluate(turn, { new_tool_calls: ['action:deploy'] })).toBe(3)
    // The re-fire bug: history still contains the deploy on every later turn.
    expect(
      evaluate(turn, { new_tool_calls: ['Read'], tool_sequence: ['action:deploy', 'Read'] }),
      'matching history would hold every later turn of the session, forever',
    ).toBe(0)
  }, 120_000)

  it('ANDs its conditions', async () => {
    const wasm = await build(
      {
        all: [
          { field: 'harness', op: 'equals', value: 'cursor' },
          { field: 'depth', op: 'atLeast', value: 2 },
        ],
      },
      1,
      'and',
    )
    expect(evaluate(wasm, { harness: 'cursor', depth: 3 })).toBe(1)
    expect(evaluate(wasm, { harness: 'cursor', depth: 1 })).toBe(0)
    expect(evaluate(wasm, { harness: 'claude-code', depth: 3 })).toBe(0)
  }, 120_000)

  it('emits the reask rung when the predicate asks for it', async () => {
    const wasm = await build(
      { all: [{ field: 'injection_findings', op: 'listNotEmpty' }] },
      3,
      'reask',
    )
    expect(evaluate(wasm, { injection_findings: ['ignore previous'] })).toBe(3)
    expect(evaluate(wasm, { injection_findings: [] })).toBe(0)
  }, 120_000)
})

describe('numeric fields arrive in either JSON form', () => {
  /**
   * The bug this pins, found by the test above rather than by reading:
   * `getFloat` returns null for a value the JSON parser typed as an Integer,
   * and JSON cannot mark `50` as a float. So every WHOLE-NUMBER budget, spend
   * and cost silently read as the -1 unknown sentinel.
   *
   * The consequence is worse than a rounding error. A rule gating on
   * `workflow_budget_usd` did nothing whenever the budget happened to be a round
   * number — which is most of the time, because a human sets it. The rule
   * compiled, installed, passed its mocks if they used decimals, and enforced
   * nothing in production.
   */
  it.each([
    ['whole number', 50, 1],
    ['decimal', 50.5, 1],
    ['whole number under the limit', 1, 0],
    ['decimal under the limit', 1.5, 0],
  ])('reads a %s budget', async (_label, value, expected) => {
    const wasm = await build(
      { all: [{ field: 'workflow_spend_usd', op: 'atLeast', value: 10 }] },
      1,
      `numeric_${String(value).replace('.', '_')}`,
    )
    expect(
      evaluate(wasm, { workflow_spend_usd: value }),
      `${value} was read as the unknown sentinel, so the rule did nothing`,
    ).toBe(expected)
  }, 120_000)

  it('still treats a genuinely absent field as unknown', async () => {
    const wasm = await build(
      { all: [{ field: 'graph_budget_usd', op: 'atLeast', value: 1 }] },
      1,
      'numeric_absent',
    )
    expect(evaluate(wasm, {}), 'absent must stay unknown, not become 0').toBe(0)
  }, 120_000)
})
