import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildCompileArgs,
  installedFileName,
  instantiateAndEvaluate,
  parseRuleFileName,
  runPolicyInstall,
  DEFAULT_ALLOW_MOCK,
  HOST_IMPORT_NAMES,
  unsupportedImports,
  explainUnsupportedImport
} from './policy.js'

describe('parseRuleFileName', () => {
  it('parses NN_name.wasm into priority and name', () => {
    expect(parseRuleFileName('10_block-prod-db.wasm')).toEqual({
      priority: 10,
      name: 'block-prod-db'
    })
    expect(parseRuleFileName('05_a.wasm')).toEqual({ priority: 5, name: 'a' })
  })

  it('defaults to priority 100 without a numeric prefix', () => {
    expect(parseRuleFileName('my-rule.wasm')).toEqual({ priority: 100, name: 'my-rule' })
    expect(parseRuleFileName('block_prod.wasm')).toEqual({ priority: 100, name: 'block_prod' })
    expect(parseRuleFileName('_hidden.wasm')).toEqual({ priority: 100, name: '_hidden' })
  })
})

describe('installedFileName', () => {
  it('formats priority_name.wasm and sanitizes unsafe characters', () => {
    expect(installedFileName(10, 'block-prod-db')).toBe('10_block-prod-db.wasm')
    expect(installedFileName(100, 'my rule.wasm')).toBe('100_my-rule.wasm')
    expect(installedFileName(5, 'a/b\\c')).toBe('5_a-b-c.wasm')
  })

  it('round-trips through parseRuleFileName', () => {
    const file = installedFileName(42, 'budget-guard')
    expect(parseRuleFileName(file)).toEqual({ priority: 42, name: 'budget-guard' })
  })

  it('preserves leading underscores so names round-trip', () => {
    expect(installedFileName(100, '_hidden')).toBe('100__hidden.wasm')
    expect(parseRuleFileName('100__hidden.wasm')).toEqual({ priority: 100, name: '_hidden' })
  })
})

describe('buildCompileArgs', () => {
  it('mirrors the wasm-sdk build flags with defaults', () => {
    expect(buildCompileArgs({})).toEqual([
      '--no-install',
      'asc',
      'assembly/index.ts',
      '-o',
      'build/rule.wasm',
      '--optimize',
      '--exportRuntime'
    ])
  })

  it('honors src/out overrides and adds debug flags only on demand', () => {
    const args = buildCompileArgs({ src: 'rules/main.ts', out: 'out/r.wasm', debug: true })
    expect(args).toContain('rules/main.ts')
    expect(args).toContain('out/r.wasm')
    expect(args).toContain('--debug')
    expect(args).toContain('--sourceMap')
    expect(buildCompileArgs({})).not.toContain('--sourceMap')
  })
})

describe('instantiateAndEvaluate', () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const sdkWasm = path.resolve(here, '../../../../packages/wasm-sdk/build/rule.wasm')

  it('rejects a buffer that is not a WASM module', async () => {
    await expect(
      instantiateAndEvaluate(Buffer.from('not wasm'), DEFAULT_ALLOW_MOCK)
    ).rejects.toThrow()
  })

  it('evaluates the checked-in wasm-sdk rule against the allow mock', async () => {
    // Monorepo-only fixture: skip when the built SDK rule is absent.
    let wasmBuffer: Buffer
    try {
      wasmBuffer = await fs.readFile(sdkWasm)
    } catch {
      console.log('skipping: packages/wasm-sdk/build/rule.wasm not present')
      return
    }
    const verdict = await instantiateAndEvaluate(wasmBuffer, DEFAULT_ALLOW_MOCK)
    expect(verdict).toBe(0)
  })
})

/** LEB128-length-prefixed UTF-8 bytes of a name, shared by every hand-encoded fixture below. */
const str = (v: string) => [v.length, ...[...v].map((c) => c.charCodeAt(0))]

/**
 * Builds a minimal, valid WASM module whose only content is one function import.
 *
 * Hand-encoded rather than compiled. A checked-in `.wasm` fixture is a binary
 * nobody can read in review, and compiling one with `asc` at test time would
 * make this depend on the SDK building — turning a toolchain problem into a
 * silent pass on the one assertion that stops a rule enforcing nothing.
 */
function moduleImporting(module: string, name: string): Uint8Array<ArrayBuffer> {
  // One type: () -> f64, which is `seed`'s signature. The import section is all
  // this reads; the type only has to be valid.
  const typeSection = [0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7c]
  const entry = [...str(module), ...str(name), 0x00, 0x00]
  const importSection = [0x02, entry.length + 1, 0x01, ...entry]
  return Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, // \0asm
    0x01, 0x00, 0x00, 0x00, // version 1
    ...typeSection,
    ...importSection,
  ])
}

/**
 * Builds a minimal, valid, IMPORT-FREE rule module that ignores its input and
 * always returns `verdictCode` — for testing what `runPolicyInstall` does with
 * a verdict the proxy does not map, without depending on `asc` or a real rule.
 *
 * Exports exactly what `resolveGuestAbi` requires: `memory`, `allocate`
 * (i32 -> i32, body ignored — the caller's `evaluate` never reads what it
 * wrote), and `evaluate` (i32, i32 -> i32, body ignores both params and
 * returns the constant).
 */
function moduleReturningVerdict(verdictCode: number): Uint8Array<ArrayBuffer> {
  const typeSection = [
    0x01, // section id
    0x0c, // byte length
    0x02, // 2 types
    0x60, 0x01, 0x7f, 0x01, 0x7f, // type 0: (i32) -> i32        [allocate]
    0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f, // type 1: (i32, i32) -> i32   [evaluate]
  ]
  const functionSection = [0x03, 0x03, 0x02, 0x00, 0x01] // 2 funcs: type 0, type 1
  const memorySection = [0x05, 0x03, 0x01, 0x00, 0x01] // 1 memory, min 1 page
  const exports = [
    ...str('memory'), 0x02, 0x00, // memory export, index 0
    ...str('allocate'), 0x00, 0x00, // func export, index 0
    ...str('evaluate'), 0x00, 0x01, // func export, index 1
  ]
  const exportSection = [0x07, exports.length + 1, 0x03, ...exports]
  const allocateBody = [0x00, 0x41, 0x00, 0x0b] // locals: none; i32.const 0; end
  const evaluateBody = [0x00, 0x41, verdictCode, 0x0b] // locals: none; i32.const <code>; end
  const code = [
    0x02, // 2 function bodies
    allocateBody.length, ...allocateBody,
    evaluateBody.length, ...evaluateBody,
  ]
  const codeSection = [0x0a, code.length, ...code]
  return Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, // \0asm
    0x01, 0x00, 0x00, 0x00, // version 1
    ...typeSection,
    ...functionSection,
    ...memorySection,
    ...exportSection,
    ...codeSection,
  ])
}

describe('host import enforcement', () => {
  /**
   * The bypass this closes: `env.seed` was offered by the CLI's validation shim
   * and never registered by the proxy. A rule reaching `Math.random()` — which
   * AssemblyScript compiles to `env.seed` — passed `policy test` and
   * `policy install`, then failed to instantiate in the proxy. The proxy's WASM
   * runner fails OPEN on every error path, so the rule enforced nothing and
   * nothing said so.
   */
  it('names an import the sandbox does not provide', async () => {
    const mod = await WebAssembly.compile(moduleImporting('env', 'seed'))
    expect(unsupportedImports(mod)).toEqual(['env.seed'])
  })

  it.each([...HOST_IMPORT_NAMES])('accepts env.%s, which the proxy registers', async (name) => {
    const mod = await WebAssembly.compile(moduleImporting('env', name))
    expect(unsupportedImports(mod)).toEqual([])
  })

  it('rejects an import from a module other than env', async () => {
    const mod = await WebAssembly.compile(moduleImporting('wasi_snapshot_preview1', 'fd_write'))
    expect(unsupportedImports(mod)).toEqual(['wasi_snapshot_preview1.fd_write'])
  })

  it('fails validation naming the import, not with a V8 LinkError', async () => {
    // The outcome was already a rejection — instantiation cannot succeed without
    // the import. What was missing is any way for the author to learn the cause
    // was `Math.random()`.
    await expect(
      instantiateAndEvaluate(moduleImporting('env', 'seed'), DEFAULT_ALLOW_MOCK)
    ).rejects.toThrow(/env\.seed/)
  })

  it('explains why randomness in particular is refused', () => {
    const why = explainUnsupportedImport('env.seed')
    expect(why).toMatch(/Math\.random/)
    expect(why, 'the reason must be stated, or it reads as an oversight').toMatch(/audit/i)
  })

  it('offers the available imports in the failure', async () => {
    await expect(
      instantiateAndEvaluate(moduleImporting('env', 'seed'), DEFAULT_ALLOW_MOCK)
    ).rejects.toThrow(/env\.log_info/)
  })
})

/**
 * `runPolicyInstall` end to end: everything above tests the two primitives it
 * calls, never the command itself. The gap that leaves is real — a regression
 * in how `runPolicyInstall` wires `instantiateAndEvaluate`'s rejection to
 * `process.exit` (an unwrapped call, a swallowed catch, an `if` that only
 * warns) would pass every test above and still let a `seed`-importing or
 * unmapped-verdict rule install clean.
 */
describe('runPolicyInstall end to end', () => {
  let wasmDir: string
  let exitCode: number | null
  let envDirBefore: string | undefined

  beforeEach(async () => {
    wasmDir = await fs.mkdtemp(path.join(os.tmpdir(), 'intutic-policy-install-'))
    envDirBefore = process.env.INTUTIC_WASM_DIR
    process.env.INTUTIC_WASM_DIR = wasmDir
    exitCode = null
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCode = code ?? 0
      throw new Error(`process.exit(${code})`)
    }) as never)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    if (envDirBefore === undefined) delete process.env.INTUTIC_WASM_DIR
    else process.env.INTUTIC_WASM_DIR = envDirBefore
    await fs.rm(wasmDir, { recursive: true, force: true })
  })

  /** Runs `runPolicyInstall`, converting the mocked `process.exit` throw into a plain result. */
  async function install(wasmPath: string): Promise<void> {
    try {
      await runPolicyInstall({ wasm: wasmPath })
    } catch (err) {
      if (!(err instanceof Error) || !err.message.startsWith('process.exit(')) throw err
    }
  }

  it('refuses to install a rule importing env.seed', async () => {
    const wasmPath = path.join(wasmDir, 'seed-rule.wasm')
    await fs.writeFile(wasmPath, moduleImporting('env', 'seed'))

    await install(wasmPath)

    expect(exitCode, 'a seed-importing rule must not install').toBe(1)
    const installed = (await fs.readdir(wasmDir)).filter((f) => f !== 'seed-rule.wasm')
    expect(installed, 'nothing should have been written to the local rules directory').toEqual([])
  })

  it('installs a rule that only imports what the proxy registers', async () => {
    // Positive control: confirms the fixture above is refused for importing
    // `seed`, not for some unrelated reason (a malformed module, a bad path).
    const wasmPath = path.join(wasmDir, 'clean-rule.wasm')
    await fs.writeFile(wasmPath, moduleReturningVerdict(1))

    await install(wasmPath)

    expect(exitCode, 'a rule using only registered imports must install').toBeNull()
    const installed = await fs.readdir(wasmDir)
    expect(installed.some((f) => f.endsWith('.wasm') && f !== 'clean-rule.wasm')).toBe(true)
  })

  it('refuses to install a rule returning a verdict code the proxy does not map', async () => {
    // The bypass this closes: outside {0,1,2,3}, the proxy's runner logs a
    // warning and falls through to Bypass — so a rule that ships believing in
    // a rung it can never reach (an author inventing "4 = escalate to human")
    // would install clean and then allow every request it thinks it refuses.
    const wasmPath = path.join(wasmDir, 'unmapped-verdict-rule.wasm')
    await fs.writeFile(wasmPath, moduleReturningVerdict(5))

    await install(wasmPath)

    expect(exitCode, 'a rule returning an unmapped verdict code must not install').toBe(1)
    const installed = (await fs.readdir(wasmDir)).filter((f) => f !== 'unmapped-verdict-rule.wasm')
    expect(installed, 'nothing should have been written to the local rules directory').toEqual([])
  })

  it('accepts the deprecated verdict code 2 with a warning, since it already shipped', async () => {
    const wasmPath = path.join(wasmDir, 'legacy-redact-rule.wasm')
    await fs.writeFile(wasmPath, moduleReturningVerdict(2))

    await install(wasmPath)

    expect(exitCode, 'code 2 is deprecated, not refused — already-installed rules use it').toBeNull()
  })
})
