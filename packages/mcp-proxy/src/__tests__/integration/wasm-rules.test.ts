/**
 * integration/wasm-rules.test.ts — End-to-end Phase 3 coverage: real
 * AssemblyScript rules, compiled with `asc` (the same compiler
 * `intutic policy compile` uses), loaded from a real `~/.intutic/wasm/`-
 * shaped directory, evaluated through the real `worker_threads` worker.
 *
 * Two purpose-built fixtures exercise paths no shipped rule needs to:
 * `infinite-loop` (stopped by the instruction budget) and `math-random` (the
 * import-validation-at-load-time rejection — `Math.random()` compiles to
 * `env.seed`, outside the frozen 4-import set).
 *
 * `asc` is invoked with the SAME async `spawn`-based `runProcess` pattern
 * `dropInRules.test.ts` (packages/wasm-sdk) uses, for the reason its own
 * comment documents: `spawnSync` blocks the event loop long enough that
 * vitest's worker RPC (birpc) times out replying to the runner, which fails
 * the suite with a green result printed first. `spawnSync` must not be used
 * here either.
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WasmRunner, type WasmVerdict } from '../../wasm/runner.js'
import type { WasmContextInput } from '../../wasm/context.js'

const here = dirname(fileURLToPath(import.meta.url))
// packages/mcp-proxy/src/__tests__/integration -> packages/wasm-sdk
const sdkRoot = join(here, '..', '..', '..', '..', 'wasm-sdk')
// Scratch AssemblyScript sources live inside the SDK root, like
// generatedRules.test.ts's `.gen-test` — `asc` must run with the SDK's own
// node_modules (assemblyscript) resolvable, and a source importing nothing
// from `../../assembly/index` still needs to live somewhere `npx asc`
// resolves from.
const genDir = join(sdkRoot, '.gen-test-mcp')

/** Same async-spawn pattern as `dropInRules.test.ts` / `generatedRules.test.ts` — never `spawnSync`. */
function runProcess(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => { stdout += d })
    child.stderr.on('data', (d: string) => { stderr += d })
    child.on('error', reject)
    child.on('close', (code) => resolve({ status: code ?? -1, stdout, stderr }))
  })
}

async function compileScratchRule(name: string, source: string, outDir: string): Promise<string> {
  const srcPath = join(genDir, `${name}.ts`)
  writeFileSync(srcPath, source)
  const out = join(outDir, `${name}.wasm`)
  const res = await runProcess(
    'npx',
    ['asc', join('.gen-test-mcp', `${name}.ts`), '-o', out, '--optimize', '--exportRuntime'],
    sdkRoot,
  )
  if (res.status !== 0 || !existsSync(out)) {
    throw new Error(`asc failed to compile ${name}:\n${source}\n${res.stdout}\n${res.stderr}`)
  }
  return out
}

async function compileSdkRule(slug: string, outDir: string): Promise<string> {
  const out = join(outDir, `${slug}.wasm`)
  const res = await runProcess(
    'npx',
    ['asc', join('rules', slug, 'rule.ts'), '-o', out, '--optimize', '--exportRuntime'],
    sdkRoot,
  )
  if (res.status !== 0 || !existsSync(out)) {
    throw new Error(`asc failed to compile wasm-sdk rule ${slug}:\n${res.stdout}\n${res.stderr}`)
  }
  return out
}

/** Never returns: the instruction budget stops it. */
const INFINITE_LOOP = `export function allocate(size: i32): i32 {\n  return 1024;\n}\nexport function evaluate(offset: i32, len: i32): i32 {\n  while (true) {}\n}\n`

const baseContext: WasmContextInput = {
  sessionId: 'ses_test',
  workspaceId: 'ws_test',
  tools: [],
  toolCallId: 'call_test',
  toolName: 'Bash',
  toolArguments: { command: 'ls' },
  toolSequence: ['Bash'],
  callsLast60s: 1,
  dlpFindingDescriptions: [],
  injectionFindings: [],
  injectionSources: [],
  corroboratingDetectors: 0,
  toolContractChanged: undefined,
}

let outDir: string

beforeAll(() => {
  outDir = mkdtempSync(join(tmpdir(), 'intutic-mcp-wasm-out-'))
  mkdirSync(genDir, { recursive: true })
}, 240_000)

afterAll(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true })
  rmSync(genDir, { recursive: true, force: true })
})

describe('WasmRunner + real wasm-sdk drop-in rules', () => {
  it('loads two real, shipped rules without any unsupported-import rejection', async () => {
    const wasmDir = mkdtempSync(join(tmpdir(), 'intutic-mcp-wasm-dir-'))
    try {
      const harnessWasm = await compileSdkRule('harness-allowlist', outDir)
      const callRateWasm = await compileSdkRule('call-rate-guard', outDir)
      copyFileSync(harnessWasm, join(wasmDir, '10_harness-allowlist.wasm'))
      copyFileSync(callRateWasm, join(wasmDir, '20_call-rate-guard.wasm'))

      const runner = new WasmRunner(wasmDir)
      try {
        await runner.rescan()
        const ids = runner.getLoadedRuleIds()
        expect(ids).toContain('local:10_harness-allowlist.wasm')
        expect(ids).toContain('local:20_call-rate-guard.wasm')

        // Neither rule reads a field this proxy's context sends (harness,
        // new_tool_calls) — both degrade to their "nothing declared, nothing
        // to enforce" branch, which is itself the property worth proving:
        // a real production rule against an honestly incomplete MCP context
        // must not crash, hang, or fail closed on missing data.
        const verdict = await runner.evaluate(baseContext)
        expect(verdict).toEqual({ code: 'allow' })
      } finally {
        await runner.shutdown()
      }
    } finally {
      rmSync(wasmDir, { recursive: true, force: true })
    }
  }, 120_000)
})

describe('WasmRunner + read_referenced_file and the memory ceiling', () => {
  // A rule that asks for the manifest the command names and blocks on a marker.
  const MANIFEST_RULE = [
    '@external("env", "read_referenced_file")',
    'declare function read_referenced_file(pathPtr: usize, pathLen: usize, outPtr: usize, outCap: i32): i32;',
    'const reasonBytes: ArrayBuffer = String.UTF8.encode("manifest pins :latest");',
    'const ctxBuf: ArrayBuffer = new ArrayBuffer(65536);',
    'export function allocate(size: i32): i32 { return changetype<i32>(ctxBuf); }',
    'export function evaluate(offset: i32, len: i32): i32 {',
    '  const path = String.UTF8.encode("k8s/deploy.yaml");',
    '  const size = read_referenced_file(changetype<usize>(path), path.byteLength, 0, 0);',
    '  if (size < 0) return 0;',
    '  const out = new ArrayBuffer(size);',
    '  const got = read_referenced_file(changetype<usize>(path), path.byteLength, changetype<usize>(out), size);',
    '  if (got != size) return 0;',
    '  const text = String.UTF8.decode(out);',
    '  return text.includes(":latest") ? 1 : 0;',
    '}',
    'export function reason_ptr(): i32 { return changetype<i32>(reasonBytes); }',
    'export function reason_len(): i32 { return reasonBytes.byteLength; }',
  ].join('\n')

  const ORIGINAL_ROOT = process.env['INTUTIC_WASM_MANIFEST_ROOT']
  afterEach(() => {
    if (ORIGINAL_ROOT === undefined) delete process.env['INTUTIC_WASM_MANIFEST_ROOT']
    else process.env['INTUTIC_WASM_MANIFEST_ROOT'] = ORIGINAL_ROOT
  })

  it('an asc-compiled rule reads a manifest under the root and blocks on its marker; without a root it cannot', async () => {
    const wasmDir = mkdtempSync(join(tmpdir(), 'intutic-mcp-wasm-reffile-'))
    const root = mkdtempSync(join(tmpdir(), 'intutic-mcp-manifest-root-'))
    try {
      const wasmPath = await compileScratchRule('reads-manifest', MANIFEST_RULE, outDir)
      copyFileSync(wasmPath, join(wasmDir, '10_reads-manifest.wasm'))
      mkdirSync(join(root, 'k8s'))
      writeFileSync(join(root, 'k8s', 'deploy.yaml'), 'image: app:latest\n')

      const runner = new WasmRunner(wasmDir)
      try {
        await runner.rescan()
        const input: WasmContextInput = { ...baseContext, toolArguments: { command: 'kubectl apply -f k8s/deploy.yaml' } }

        delete process.env['INTUTIC_WASM_MANIFEST_ROOT']
        expect((await runner.evaluate(input)).code).toBe('allow') // every read refuses: nothing to judge

        process.env['INTUTIC_WASM_MANIFEST_ROOT'] = root
        const verdict = await runner.evaluate(input)
        expect(verdict.code).toBe('block')
        if (verdict.code === 'block') expect(verdict.reason).toBe('manifest pins :latest')

        // A command that never named the file: refused, so allow.
        expect((await runner.evaluate({ ...baseContext, toolArguments: { command: 'ls' } })).code).toBe('allow')

        writeFileSync(join(root, 'k8s', 'deploy.yaml'), 'image: app@sha256:abc\n')
        expect((await runner.evaluate(input)).code).toBe('allow')
      } finally {
        await runner.shutdown()
      }
    } finally {
      rmSync(wasmDir, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('a rule cannot grow guest memory past 16MB: the grow is refused and its verdict stands', async () => {
    const wasmDir = mkdtempSync(join(tmpdir(), 'intutic-mcp-wasm-memory-'))
    try {
      const wasmPath = await compileScratchRule(
        'memory-hog',
        [
          'export function allocate(size: i32): i32 { return 1024; }',
          'export function evaluate(offset: i32, len: i32): i32 {',
          // 300 pages = 18.75MB, over the 16MB ceiling: V8 returns -1 and
          // memory stays put, so the rule blocks only if the grow was refused.
          '  return memory.grow(300) == -1 ? 1 : 0;',
          '}',
        ].join('\n'),
        outDir,
      )
      copyFileSync(wasmPath, join(wasmDir, '10_memory-hog.wasm'))
      const runner = new WasmRunner(wasmDir)
      try {
        await runner.rescan()
        expect((await runner.evaluate(baseContext)).code).toBe('block')
      } finally {
        await runner.shutdown()
      }
    } finally {
      rmSync(wasmDir, { recursive: true, force: true })
    }
  }, 60_000)
})

describe('WasmRunner + purpose-built fixtures', () => {
  it('an infinite-loop rule is stopped by its instruction budget, without waiting out the deadline, and refuses the call', async () => {
    const wasmDir = mkdtempSync(join(tmpdir(), 'intutic-mcp-wasm-loop-'))
    try {
      const wasmPath = await compileScratchRule('infinite-loop', INFINITE_LOOP, outDir)
      copyFileSync(wasmPath, join(wasmDir, '10_infinite-loop.wasm'))

      const runner = new WasmRunner(wasmDir)
      try {
        await runner.rescan()
        expect(runner.getLoadedRuleIds()).toContain('local:10_infinite-loop.wasm')

        // The deadline path terminates and respawns the worker; the budget
        // path traps inside a healthy worker and never does. So no respawn
        // proves the budget stopped the loop, without a timing assertion.
        const respawn = vi.spyOn(runner as unknown as { respawnWorker: () => Promise<void> }, 'respawnWorker')
        const verdict: WasmVerdict = await runner.evaluate(baseContext)
        expect(verdict).toMatchObject({ code: 'unavailable', stop: 'budget', ruleId: 'local:10_infinite-loop.wasm' })
        if (verdict.code === 'unavailable') {
          expect(verdict.reason).toContain('Custom rule local:10_infinite-loop.wasm reached no verdict (budget)')
        }
        expect(respawn).not.toHaveBeenCalled()
      } finally {
        await runner.shutdown()
      }
    } finally {
      rmSync(wasmDir, { recursive: true, force: true })
    }
  }, 30_000)

  it('quarantines a rule after 3 runaways in a row, then refuses without evaluating it until the next rescan', async () => {
    const wasmDir = mkdtempSync(join(tmpdir(), 'intutic-mcp-wasm-loop3-'))
    try {
      const wasmPath = await compileScratchRule('infinite-loop-3x', INFINITE_LOOP, outDir)
      copyFileSync(wasmPath, join(wasmDir, '10_loop3.wasm'))

      const runner = new WasmRunner(wasmDir)
      try {
        await runner.rescan()
        const verdicts: WasmVerdict[] = []
        for (let i = 0; i < 3; i++) verdicts.push(await runner.evaluate(baseContext))
        expect(verdicts.map((v) => (v.code === 'unavailable' ? v.stop : v.code))).toEqual(['budget', 'budget', 'budget'])
        // The third runaway is the one that quarantines it, and says so.
        expect(verdicts[2]?.code === 'unavailable' && verdicts[2].reason).toContain('now quarantined')

        // Quarantined: refused without running anything, so three padded
        // calls cannot switch the rule off.
        const evaluateOne = vi.spyOn(runner as unknown as { evaluateOne: () => Promise<unknown> }, 'evaluateOne')
        const fourth = await runner.evaluate(baseContext)
        expect(evaluateOne).not.toHaveBeenCalled()
        expect(fourth).toMatchObject({ code: 'unavailable', stop: 'quarantined', ruleId: 'local:10_loop3.wasm' })
        expect(fourth.code === 'unavailable' && fourth.reason).toContain('quarantined')

        // The next rescan releases it: evaluated again, and stopped again.
        await runner.rescan()
        const released = await runner.evaluate(baseContext)
        expect(evaluateOne).toHaveBeenCalledTimes(1)
        expect(released).toMatchObject({ code: 'unavailable', stop: 'budget' })
      } finally {
        await runner.shutdown()
      }
    } finally {
      rmSync(wasmDir, { recursive: true, force: true })
    }
  }, 30_000)

  it.each([
    { name: 'traps', source: 'export function evaluate(offset: i32, len: i32): i32 {\n  unreachable();\n  return 0;\n}\n', stop: 'error' },
    { name: 'returns a code that is not a verdict', source: 'export function evaluate(offset: i32, len: i32): i32 {\n  return 7;\n}\n', stop: 'result' },
  ])('a rule that $name reaches no verdict and refuses the call', async ({ name, source, stop }) => {
    const wasmDir = mkdtempSync(join(tmpdir(), 'intutic-mcp-wasm-noverdict-'))
    try {
      const wasmPath = await compileScratchRule(
        `no-verdict-${stop}`,
        `export function allocate(size: i32): i32 {\n  return 1024;\n}\n${source}`,
        outDir,
      )
      copyFileSync(wasmPath, join(wasmDir, '10_no-verdict.wasm'))

      const runner = new WasmRunner(wasmDir)
      try {
        await runner.rescan()
        const verdict = await runner.evaluate(baseContext)
        expect(verdict, name).toMatchObject({ code: 'unavailable', stop, ruleId: 'local:10_no-verdict.wasm' })
        expect(verdict.code === 'unavailable' && verdict.reason).toContain(`(${stop})`)
      } finally {
        await runner.shutdown()
      }
    } finally {
      rmSync(wasmDir, { recursive: true, force: true })
    }
  }, 30_000)

  it('a rule reaching Math.random() (env.seed) is refused at LOAD time, not evaluated', async () => {
    const wasmDir = mkdtempSync(join(tmpdir(), 'intutic-mcp-wasm-seed-'))
    try {
      const wasmPath = await compileScratchRule(
        'math-random',
        `export function allocate(size: i32): i32 {\n  return 1024;\n}\nexport function evaluate(offset: i32, len: i32): i32 {\n  return Math.random() > 0.5 ? 1 : 0;\n}\n`,
        outDir,
      )
      // Confirm the compiled module actually imports env.seed — otherwise
      // this test would prove nothing about import validation.
      const { readFileSync } = await import('node:fs')
      const mod = new WebAssembly.Module(readFileSync(wasmPath))
      const imports = WebAssembly.Module.imports(mod).map((i) => `${i.module}.${i.name}`)
      expect(imports, 'Math.random() must compile to env.seed for this test to be meaningful').toContain('env.seed')

      copyFileSync(wasmPath, join(wasmDir, '10_math-random.wasm'))

      const runner = new WasmRunner(wasmDir)
      try {
        await runner.rescan()
        expect(runner.getLoadedRuleIds()).not.toContain('local:10_math-random.wasm')
        expect(runner.getLoadedRuleIds()).toEqual([])

        // With nothing loaded, evaluate() must allow — never crash, never
        // silently block on a rule that never linked.
        const verdict = await runner.evaluate(baseContext)
        expect(verdict).toEqual({ code: 'allow' })
      } finally {
        await runner.shutdown()
      }
    } finally {
      rmSync(wasmDir, { recursive: true, force: true })
    }
  }, 30_000)

  it('a rule that returns block (1) is enforced, with its reason surfaced', async () => {
    const wasmDir = mkdtempSync(join(tmpdir(), 'intutic-mcp-wasm-block-'))
    try {
      const wasmPath = await compileScratchRule(
        'always-block-with-reason',
        [
          // `reason_ptr`/`reason_len` must supply UTF-8 bytes (runner.rs's
          // `read_guest_reason` decodes with `std::str::from_utf8`) —
          // AssemblyScript's native `string` is UTF-16, so the reason is
          // encoded explicitly via `String.UTF8.encode` rather than pointing
          // at the string object directly.
          'const reasonBytes: ArrayBuffer = String.UTF8.encode("destructive command blocked by test rule");',
          'export function allocate(size: i32): i32 {',
          '  return 1024;',
          '}',
          'export function evaluate(offset: i32, len: i32): i32 {',
          '  return 1;',
          '}',
          'export function reason_ptr(): i32 {',
          '  return changetype<i32>(reasonBytes);',
          '}',
          'export function reason_len(): i32 {',
          '  return reasonBytes.byteLength;',
          '}',
        ].join('\n'),
        outDir,
      )
      copyFileSync(wasmPath, join(wasmDir, '10_always-block.wasm'))

      const runner = new WasmRunner(wasmDir)
      try {
        await runner.rescan()
        const verdict = await runner.evaluate(baseContext)
        expect(verdict.code).toBe('block')
        if (verdict.code === 'block') {
          expect(verdict.ruleId).toBe('local:10_always-block.wasm')
          expect(verdict.reason).toBe('destructive command blocked by test rule')
        }
      } finally {
        await runner.shutdown()
      }
    } finally {
      rmSync(wasmDir, { recursive: true, force: true })
    }
  }, 30_000)

  it('a rule that returns reask (3) routes through the reask ladder, not a kill', async () => {
    const wasmDir = mkdtempSync(join(tmpdir(), 'intutic-mcp-wasm-reask-'))
    try {
      const wasmPath = await compileScratchRule(
        'always-reask',
        `export function allocate(size: i32): i32 {\n  return 1024;\n}\nexport function evaluate(offset: i32, len: i32): i32 {\n  return 3;\n}\n`,
        outDir,
      )
      copyFileSync(wasmPath, join(wasmDir, '10_always-reask.wasm'))

      const runner = new WasmRunner(wasmDir)
      try {
        await runner.rescan()
        const verdict = await runner.evaluate(baseContext)
        expect(verdict.code).toBe('reask')
      } finally {
        await runner.shutdown()
      }
    } finally {
      rmSync(wasmDir, { recursive: true, force: true })
    }
  }, 30_000)
})
