import { describe, expect, it } from 'vitest'
import { firstMatch, parseRules, serialiseToolInput, supportsArgPatterns, type SopRule } from '../soprules.js'

// Port of packages/intutic-clawde/tests/test_gate_soprules.py.

const APPLY = { command: 'kubectl apply -f k8s/catalogue-dep.yaml' }

const DIGEST_RULE = {
  id: 'sp_pin',
  toolPattern: '^shell$',
  argPattern: 'kubectl\\s+apply(?!.*@sha256:)',
  action: 'block',
  reason: 'deploy must reference a digest-pinned image',
}

function rules(...rows: Record<string, unknown>[]): SopRule[] {
  return parseRules({ rules: rows })
}

describe('parsing', () => {
  it('reads the documented envelope', () => {
    expect(rules(DIGEST_RULE)).toHaveLength(1)
  })

  it.each(['rules', 'items', 'data'])('accepts the %s envelope key', (key) => {
    expect(parseRules({ [key]: [DIGEST_RULE] })).toHaveLength(1)
  })

  it('accepts a bare list', () => {
    expect(parseRules([DIGEST_RULE])).toHaveLength(1)
  })

  it('ignores an unrecognised action', () => {
    expect(rules({ ...DIGEST_RULE, action: 'quarantine' })).toEqual([])
  })

  it('ignores a rule with no tool pattern', () => {
    expect(rules({ ...DIGEST_RULE, toolPattern: '' })).toEqual([])
  })

  it('keeps an absent argPattern as null, not empty string', () => {
    const { argPattern: _drop, ...rest } = DIGEST_RULE
    const r = rules(rest)[0]!
    expect(r.argPattern).toBeNull()
  })

  it('survives a non-object row', () => {
    expect(parseRules({ rules: ['nope', null, DIGEST_RULE] })).toHaveLength(1)
  })

  it('survives a garbage payload', () => {
    expect(parseRules('not json at all')).toEqual([])
  })
})

describe('serialisation', () => {
  it('matches the JSON.stringify shape', () => {
    expect(serialiseToolInput({ command: 'ls', ctx: 'prod-cluster', n: 1, s: 'café' })).toBe(
      '{"command":"ls","ctx":"prod-cluster","n":1,"s":"café"}',
    )
  })

  it('turns null/undefined into an empty object', () => {
    expect(serialiseToolInput(null)).toBe('{}')
    expect(serialiseToolInput(undefined)).toBe('{}')
  })
})

describe('matching', () => {
  it('the rule that was previously unsayable now matches', () => {
    expect(firstMatch(rules(DIGEST_RULE), 'shell', APPLY)).not.toBeNull()
  })

  it('a digest-pinned apply is allowed', () => {
    const pinned = { command: 'kubectl apply -f k8s/x.yaml  # img@sha256:abc' }
    expect(firstMatch(rules(DIGEST_RULE), 'shell', pinned)).toBeNull()
  })

  it('unrelated shell calls are untouched', () => {
    for (const cmd of ['make test', 'git status', 'ls -la']) {
      expect(firstMatch(rules(DIGEST_RULE), 'shell', { command: cmd })).toBeNull()
    }
  })

  it('the tool pattern still gates the match', () => {
    expect(firstMatch(rules(DIGEST_RULE), 'read_file', APPLY)).toBeNull()
  })

  it('the first rule wins in control-plane order', () => {
    const warn = { ...DIGEST_RULE, id: 'sp_first', action: 'warn' }
    expect(firstMatch(rules(warn, DIGEST_RULE), 'shell', APPLY)!.id).toBe('sp_first')
  })

  it('an uncompilable rule is skipped, not thrown', () => {
    const broken = { ...DIGEST_RULE, id: 'sp_old', toolPattern: '^shell$ WHERE kubectl\\s+apply(?!.*@sha256', argPattern: null }
    expect(firstMatch(rules(broken), 'shell', APPLY)).toBeNull()
  })

  it('a broken rule does not mask a later good one', () => {
    const broken = { ...DIGEST_RULE, id: 'sp_old', toolPattern: '([unclosed' }
    expect(firstMatch(rules(broken, DIGEST_RULE), 'shell', APPLY)!.id).toBe('sp_pin')
  })

  it('the arg pattern sees every field, not just command', () => {
    const r = rules({ ...DIGEST_RULE, argPattern: 'prod-cluster', id: 'sp_ctx' })
    expect(firstMatch(r, 'shell', { command: 'ls', ctx: 'prod-cluster' })).not.toBeNull()
  })
})

describe('capability probe', () => {
  it('reports support when a usable argPattern arrives', () => {
    expect(supportsArgPatterns(rules(DIGEST_RULE))).toBe(true)
  })

  it('reports no support for a tool-name-only rule', () => {
    const { argPattern: _drop, ...rest } = DIGEST_RULE
    expect(supportsArgPatterns(rules(rest))).toBe(false)
  })

  it('an uncompilable argPattern does not count as support', () => {
    expect(supportsArgPatterns(rules({ ...DIGEST_RULE, argPattern: '([unclosed' }))).toBe(false)
  })
})
