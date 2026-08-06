import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildCompileArgs,
  installedFileName,
  instantiateAndEvaluate,
  parseRuleFileName,
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

/**
 * Builds a minimal, valid WASM module whose only content is one function import.
 *
 * Hand-encoded rather than compiled. A checked-in `.wasm` fixture is a binary
 * nobody can read in review, and compiling one with `asc` at test time would
 * make this depend on the SDK building — turning a toolchain problem into a
 * silent pass on the one assertion that stops a rule enforcing nothing.
 */
function moduleImporting(module: string, name: string): Uint8Array<ArrayBuffer> {
  const str = (v: string) => [v.length, ...[...v].map((c) => c.charCodeAt(0))]
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
