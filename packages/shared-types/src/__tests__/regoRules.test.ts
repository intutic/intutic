import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  REGO_MAX_INPUT_BYTES,
  boundedRegoInput,
  evaluateRegoRule,
  importedMemoryPages,
  isOpaModule,
  loadRegoRule,
  readRegoMetadata,
  regoDecision,
  withRegoMetadata,
  type RegoHostOptions,
} from '../regoRules.js'
import { REGO_HOST_BUILTINS, REGO_HOST_BUILTIN_NAMES } from '../regoBuiltins.js'

// The Rust host's fixtures: one set of policies and one `opa eval` oracle for
// both hosts, so they cannot drift apart unnoticed.
const fixture = (name: string): Buffer =>
  readFileSync(fileURLToPath(new URL(`../../../proxy/tests/fixtures/rego/${name}`, import.meta.url)))

const options: RegoHostOptions = {
  digest: (algorithm, data) => createHash(algorithm).update(data).digest('hex'),
}

function load(name: string) {
  const bytes = fixture(name)
  const rule = loadRegoRule(bytes, undefined, options)
  if (!rule) throw new Error(`${name} is not an OPA build`)
  return rule
}

function decide(name: string, input: Record<string, unknown>) {
  const rule = load(name)
  return regoDecision(evaluateRegoRule(rule, boundedRegoInput({ v: 1, host: 'mcp', ...input }), options), rule.entrypoint)
}

describe('the TypeScript Rego host', () => {
  it('runs every host builtin exactly as opa eval does', () => {
    const rule = load('conformance.wasm')
    const input = fixture('conformance.input.json').toString('utf8')
    const expected = JSON.parse(fixture('conformance.expected.json').toString('utf8')) as Record<
      string,
      Record<string, unknown>
    >
    const got = (evaluateRegoRule(rule, input, options) as Array<{ result: Record<string, Record<string, unknown>> }>)[0]!
      .result
    // JavaScript numbers are doubles: the one integer above 2^53 cannot
    // survive JSON.parse, here or in any JavaScript host.
    delete expected['sprintf']!['big_int']
    delete got['sprintf']!['big_int']
    for (const builtin of Object.keys(expected)) {
      expect(got[builtin], builtin).toEqual(expected[builtin])
    }
    expect(got).toEqual(expected)
  })

  it('provides the same builtins as the Rust host', () => {
    expect(REGO_HOST_BUILTIN_NAMES).toEqual([
      'crypto.sha1',
      'crypto.sha256',
      'indexof_n',
      'json.marshal_with_options',
      'json.patch',
      'regex.find_n',
      'regex.replace',
      'regex.split',
      'sprintf',
      'strings.any_prefix_match',
      'strings.any_suffix_match',
      'strings.count',
      'time.now_ns',
    ])
  })

  it('json.patch stores a __proto__ key as a member, as OPA does, and leaves prototypes alone', () => {
    const patch = (doc: unknown, ops: unknown[]) =>
      REGO_HOST_BUILTINS['json.patch']!({} as never, [doc, ops]) as Record<string, unknown>
    const added = patch({ a: 1 }, [{ op: 'add', path: '/__proto__', value: { polluted: true } }])
    expect(Object.keys(added)).toEqual(['a', '__proto__'])
    expect(Object.getPrototypeOf(added)).toBe(Object.prototype)
    expect(JSON.stringify(added)).toBe('{"a":1,"__proto__":{"polluted":true}}')
    const replaced = patch(JSON.parse('{"__proto__":{"x":1}}'), [{ op: 'replace', path: '/__proto__', value: 2 }])
    expect(JSON.stringify(replaced)).toBe('{"__proto__":2}')
    expect(patch(added, [{ op: 'remove', path: '/__proto__' }])).toEqual({ a: 1 })
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })

  it('refuses a policy needing a builtin it lacks, by name', () => {
    expect(() => loadRegoRule(fixture('unsupported_builtin.wasm'), undefined, options)).toThrow(/crypto\.md5/)
    // The hash builtins need the host's digest.
    expect(() => loadRegoRule(fixture('conformance.wasm'))).toThrow(/crypto\.sha1, crypto\.sha256/)
  })

  it('tells an OPA build from a native rule', () => {
    expect(isOpaModule(new WebAssembly.Module(fixture('conformance.wasm')))).toBe(true)
    const native = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0])
    expect(isOpaModule(new WebAssembly.Module(native))).toBe(false)
    expect(loadRegoRule(native)).toBeNull()
    expect(() => loadRegoRule(withRegoMetadata(native, { v: 1, abi: 'opa' }))).toThrow(/not an OPA build/)
  })

  it('reads the entrypoint and risk tier from the metadata section', () => {
    const bytes = withRegoMetadata(fixture('conformance.wasm'), {
      v: 1,
      abi: 'opa',
      entrypoint: 'conformance/results',
      risk_tier: 'critical',
    })
    expect(readRegoMetadata(new WebAssembly.Module(bytes as Uint8Array<ArrayBuffer>))?.entrypoint).toBe('conformance/results')
    expect(loadRegoRule(bytes, undefined, options)?.riskTier).toBe('critical')
    const wrong = withRegoMetadata(fixture('conformance.wasm'), { v: 1, abi: 'opa', entrypoint: 'conformance/nope' })
    expect(() => loadRegoRule(wrong, undefined, options)).toThrow(/no `conformance\/nope` entrypoint/)
    expect(importedMemoryPages(fixture('conformance.wasm'))).toBeGreaterThan(0)
  })

  it('decides the example policies the way the Rust host does', () => {
    const bash = (command: string) => ({ tool: 'Bash', args: { command } })
    expect(decide('examples/block_destructive_shell.wasm', bash('rm -rf /'))).toEqual({
      decision: 'deny',
      reason: 'destructive shell command blocked: rm -rf /',
    })
    expect(decide('examples/block_destructive_shell.wasm', bash('rm -rf ./build'))).toEqual({ decision: 'allow' })
    expect(decide('examples/hold_prod_deploys.wasm', bash('helm upgrade api ./chart -n prod'))).toEqual({
      decision: 'hold',
      reason: 'production deploy needs approval: helm upgrade api ./chart -n prod',
      riskTier: 'high',
    })
    expect(
      decide('examples/deny_writes_outside_repo.wasm', { tool: 'Write', args: { file_path: '/etc/hosts', content: '' } }),
    ).toMatchObject({ decision: 'deny' })
  })

  it('maps every documented result shape', () => {
    const ep = 'p/r'
    expect(regoDecision([], ep)).toEqual({ decision: 'allow' })
    expect(regoDecision([{ result: true }], ep)).toEqual({ decision: 'deny', reason: 'Denied by Rego policy p/r' })
    expect(regoDecision([{ result: ['no\nthanks'] }], ep)).toEqual({ decision: 'deny', reason: 'nothanks' })
    expect(regoDecision([{ result: { decision: 'reask' } }], ep)).toEqual({
      decision: 'reask',
      reason: 'Refused by Rego policy p/r',
    })
    expect(regoDecision([{ result: { decision: 'maybe' } }], ep)).toEqual({ decision: 'allow' })
    expect(regoDecision([{ result: 7 }], ep)).toEqual({ decision: 'allow' })
  })

  it('cuts an oversized input to fit and flags it, the same way as the Rust host', () => {
    const text = boundedRegoInput({ v: 1, tool: 'Write', args: { file_path: '/repo/x', content: 'x'.repeat(500_000) } })
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(REGO_MAX_INPUT_BYTES)
    const doc = JSON.parse(text) as { truncated: boolean; args: { file_path: string; content: string } }
    expect(doc.truncated).toBe(true)
    expect(doc.args.file_path).toBe('/repo/x')
    expect(doc.args.content).toHaveLength(16 * 1024)
    expect(JSON.parse(boundedRegoInput({ v: 1, tool: 'Bash' })).truncated).toBe(false)
  })
})
