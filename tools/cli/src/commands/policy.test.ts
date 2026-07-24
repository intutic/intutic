import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildCompileArgs,
  installedFileName,
  instantiateAndEvaluate,
  parseRuleFileName,
  DEFAULT_ALLOW_MOCK
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