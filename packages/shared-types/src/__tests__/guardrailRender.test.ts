/**
 * The Guardrail IR's renderers and their parser mirror (LLD #71).
 *
 * What is pinned: `parse(render(ir))` is the IR, over thousands of seeded
 * random IRs; the render is byte-stable; the parser never throws on any
 * input; single-token mutations of a rendered line are refused by the parser
 * in the Rust parser's own wording, never silently accepted as a different
 * rule; hook rules render to patterns both regex engines read the same way;
 * and the grammar refuses the shapes it exists to refuse.
 */

import { describe, it, expect } from 'vitest'
import {
  validateGuardrailIr,
  canonicalizeIr,
  ACTION_TOKENS,
  MAX_HOOK_TOOLS,
  type GuardrailIr,
  type FrontMatterIr,
  type HookRuleIr,
} from '../guardrailIr.js'
import {
  renderHookRule,
  renderToolPattern,
  renderArgPattern,
  escapeRegexLiteral,
  renderHookReason,
  renderFrontMatterLines,
  parseFrontMatterEnforcing,
  splitFrontMatter,
  frontMatterToIrs,
  isEnforceableFrontMatter,
  MAX_REASON_CHARS,
} from '../guardrailRender.js'

// ─── Seeded generator ─────────────────────────────────────────────────

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s >>>= 0
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return s / 0xffffffff
  }
}

const TOKENS = ['Bash', 'Write', 'Edit', 'mcp__github__create_issue', 'developer__shell', 'kubectl', 'terraform.apply', 'run_command', ...ACTION_TOKENS]
const ROLES = ['deployer', 'reviewer', 'sre']

function pick<T>(next: () => number, xs: readonly T[]): T {
  return xs[Math.floor(next() * xs.length)]!
}

function genFrontMatterIr(next: () => number, used: Set<string>): FrontMatterIr {
  const roles = next() < 0.3 ? { roles: [pick(next, ROLES)] } : {}
  const kind = pick(next, ['deny_tools', 'review_before', 'requires_before', 'forbid_after', 'max_calls', 'forbid_with'] as const)
  const fresh = (): string => {
    for (let i = 0; i < 50; i++) {
      const t = pick(next, TOKENS)
      if (!used.has(`${kind}:${t}`)) {
        used.add(`${kind}:${t}`)
        return t
      }
    }
    return pick(next, TOKENS)
  }
  switch (kind) {
    case 'deny_tools':
      return { kind, tools: [fresh(), ...(next() < 0.5 ? [fresh()] : [])], ...roles }
    case 'review_before':
      return { kind, tokens: [fresh()], ...roles }
    case 'requires_before':
    case 'forbid_after': {
      const first = fresh()
      let then = pick(next, TOKENS)
      while (then === first) then = pick(next, TOKENS)
      return { kind, first, then, ...roles }
    }
    case 'max_calls':
      return { kind, token: fresh(), limit: 1 + Math.floor(next() * 1000), ...roles }
    case 'forbid_with':
      return { kind, taint: next() < 0.5 ? 'secrets()' : 'pii()', token: fresh(), ...roles }
  }
}

function canonicalSet(irs: readonly GuardrailIr[]): string[] {
  return [...new Set(irs.map(canonicalizeIr))].sort()
}

/**
 * A document has one `deny_tools:` line and one `review_before:` line, so two
 * single-token list rules render together and parse back as one rule with
 * two tokens. Comparing sets of *tokens* per list kind (one IR per token)
 * makes the round trip well-defined without weakening what is asserted: the
 * same tokens under the same key, and nothing else.
 */
function flattenLists(irs: readonly GuardrailIr[]): GuardrailIr[] {
  return irs.flatMap((ir) => {
    if (ir.kind === 'deny_tools') return ir.tools.map((t) => ({ ...ir, tools: [t] }))
    if (ir.kind === 'review_before') return ir.tokens.map((t) => ({ ...ir, tokens: [t] }))
    return [ir]
  })
}

// ─── Round trip ───────────────────────────────────────────────────────

describe('front matter: parse(render(ir)) is the IR', () => {
  it('holds for 2,000 seeded single-rule renders, and the render is byte-stable', () => {
    for (let seed = 1; seed <= 2000; seed++) {
      const next = rng(seed * 104729)
      const ir = genFrontMatterIr(next, new Set())
      try {
        expect(validateGuardrailIr(ir).ok).toBe(true)
        const lines = renderFrontMatterLines([ir])
        expect(renderFrontMatterLines([ir])).toBe(lines)
        const parsed = parseFrontMatterEnforcing(lines)
        expect(parsed.errors).toEqual([])
        expect(isEnforceableFrontMatter(parsed)).toBe(true)
        const back = frontMatterToIrs(parsed)
        expect(canonicalSet(back)).toEqual(canonicalSet([ir]))
        expect(renderFrontMatterLines(back)).toBe(lines)
      } catch (err) {
        throw new Error(`seed ${seed}: ${err instanceof Error ? err.message : String(err)}\nIR: ${JSON.stringify(ir)}`, { cause: err })
      }
    }
  })

  it('holds for 300 seeded multi-rule renders (sets compared, since a shared roles line applies to every rule)', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const next = rng(seed * 7919)
      const used = new Set<string>()
      const irs: FrontMatterIr[] = []
      const n = 2 + Math.floor(next() * 5)
      // One roles set per document: the front matter has a single roles: line.
      const roles = next() < 0.5 ? [pick(next, ROLES)] : undefined
      for (let i = 0; i < n; i++) {
        const ir = genFrontMatterIr(next, used)
        const withRoles = roles ? { ...ir, roles } : { ...ir, roles: undefined }
        if (withRoles.roles === undefined) delete (withRoles as { roles?: string[] }).roles
        irs.push(withRoles as FrontMatterIr)
      }
      try {
        const lines = renderFrontMatterLines(irs)
        const parsed = parseFrontMatterEnforcing(lines)
        expect(parsed.errors).toEqual([])
        const back = frontMatterToIrs(parsed)
        expect(canonicalSet(flattenLists(back))).toEqual(canonicalSet(flattenLists(irs)))
        expect(renderFrontMatterLines(back)).toBe(lines)
      } catch (err) {
        throw new Error(`seed ${seed}: ${err instanceof Error ? err.message : String(err)}\nIRs: ${JSON.stringify(irs)}`, { cause: err })
      }
    }
  })

  it('renders the six keys in the shapes the Rust parser documents', () => {
    const lines = renderFrontMatterLines([
      { kind: 'forbid_with', taint: 'secrets()', token: 'action:http_post' },
      { kind: 'max_calls', token: 'action:deploy', limit: 3 },
      { kind: 'deny_tools', tools: ['WebFetch', 'Bash'], roles: ['Deployer'] },
      { kind: 'requires_before', first: 'action:run_tests', then: 'action:deploy' },
      { kind: 'review_before', tokens: ['action:deploy'] },
      { kind: 'forbid_after', first: 'action:secret_read', then: 'action:http_post' },
    ])
    expect(lines).toBe(
      [
        'roles: deployer',
        'deny_tools: Bash, WebFetch',
        'review_before: action:deploy',
        'requires_before: action:run_tests -> action:deploy',
        'forbid_after: action:secret_read -> action:http_post',
        'max_calls: action:deploy <= 3',
        'forbid_with: secrets(), action:http_post',
      ].join('\n'),
    )
  })

  it('collapses two bounds on one token to the tighter one', () => {
    const lines = renderFrontMatterLines([
      { kind: 'max_calls', token: 'Bash', limit: 20 },
      { kind: 'max_calls', token: 'Bash', limit: 5 },
    ])
    expect(lines).toBe('max_calls: Bash <= 5')
  })
})

describe('front matter parser: never throws, and refuses mutations in the Rust wording', () => {
  it('survives 500 seeded random documents', () => {
    const PIECES = ['---', '\n', 'deny_tools:', 'requires_before:', 'max_calls:', 'forbid_with:', 'mode:', 'A -> B', 'A ~> B', '<=', ',', '"', "'", '[', ']', 'secrets()', 'pii()', 'rm -rf', 'café', '\t', 'shadow', 'x']
    for (let seed = 1; seed <= 500; seed++) {
      const next = rng(seed * 31337)
      const doc = Array.from({ length: Math.floor(next() * 40) }, () => pick(next, PIECES)).join(next() < 0.3 ? '' : ' ')
      const { front } = splitFrontMatter(doc)
      expect(() => parseFrontMatterEnforcing(front)).not.toThrow()
      expect(() => parseFrontMatterEnforcing(doc)).not.toThrow()
    }
  })

  it('`~>` is read as adjacency, `- >` is an error, a shell command is an error', () => {
    expect(parseFrontMatterEnforcing('requires_before: A ~> B').requiresBefore).toEqual([['A', 'B', true]])
    const broken = parseFrontMatterEnforcing('requires_before: A - > B')
    expect(broken.requiresBefore).toEqual([])
    expect(broken.errors[0]).toMatch(/expected `A -> B`/)
    const command = parseFrontMatterEnforcing('forbid_after: action:secret_read -> git push origin')
    expect(command.forbidAfter).toEqual([])
    expect(command.errors[0]).toMatch(/looks like a shell command/)
  })

  it('`max_calls` needs a whole number; `forbid_with` needs a known taint and one token', () => {
    expect(parseFrontMatterEnforcing('max_calls: Bash <= many').errors[0]).toMatch(/not a whole number/)
    expect(parseFrontMatterEnforcing('max_calls: Bash <= 3, Write <= 1').maxCalls).toEqual([['Bash', 3], ['Write', 1]])
    expect(parseFrontMatterEnforcing('forbid_with: creds(), Bash').errors[0]).toMatch(/must be `secrets\(\)` or `pii\(\)`/)
    expect(parseFrontMatterEnforcing('forbid_with: secrets(), action:http_post, pii(), action:http_post').errors[0]).toMatch(/one rule per line/)
    expect(parseFrontMatterEnforcing('forbid_with: PII(), action:pii_export').forbidWith).toEqual([['pii()', 'action:pii_export']])
  })

  it('list keys split on commas, strip quotes and brackets, and lower-case only roles and harnesses', () => {
    const fm = parseFrontMatterEnforcing('deny_tools: ["Bash", \'WebFetch\']\nroles: Deployer, SRE\nallow_harnesses: Claude-Code')
    expect(fm.denyTools).toEqual(['Bash', 'WebFetch'])
    expect(fm.roles).toEqual(['deployer', 'sre'])
    expect(fm.allowHarnesses).toEqual(['claude-code'])
  })

  it('mode: shadow is read; anything else, including a typo, is enforce', () => {
    expect(parseFrontMatterEnforcing('mode: shadow').mode).toBe('shadow')
    expect(parseFrontMatterEnforcing('mode: "Shadow"').mode).toBe('shadow')
    expect(parseFrontMatterEnforcing('mode: shaddow').mode).toBe('enforce')
    expect(parseFrontMatterEnforcing('deny_tools: Bash').mode).toBe('enforce')
  })

  it('a lifted list token the IR would refuse is refused by the IR, not silently kept', () => {
    const fm = parseFrontMatterEnforcing('deny_tools: rm -rf')
    expect(fm.denyTools).toEqual(['rm -rf'])
    const [ir] = frontMatterToIrs(fm)
    expect(validateGuardrailIr(ir).ok).toBe(false)
  })

  it('splits fences with the Rust fallback: no fence or an unterminated one is all body', () => {
    expect(splitFrontMatter('# Title\nbody')).toEqual({ front: '', body: '# Title\nbody' })
    expect(splitFrontMatter('---\ndeny_tools: Bash\nno closing fence')).toEqual({ front: '', body: '---\ndeny_tools: Bash\nno closing fence' })
    expect(splitFrontMatter('---\ndeny_tools: Bash\n---\n# T\nbody')).toEqual({ front: '\ndeny_tools: Bash', body: '# T\nbody' })
  })
})

// ─── The grammar refuses what it exists to refuse ─────────────────────

describe('validateGuardrailIr', () => {
  const ok = (ir: unknown) => validateGuardrailIr(ir).ok
  const reason = (ir: unknown) => {
    const v = validateGuardrailIr(ir)
    return v.ok ? '' : v.reason
  }

  it('accepts every kind in its documented shape', () => {
    expect(ok({ kind: 'hook_rule', title: 't', tools: ['Bash'], argContains: ['terraform apply'] })).toBe(true)
    expect(ok({ kind: 'deny_tools', tools: ['Bash'] })).toBe(true)
    expect(ok({ kind: 'review_before', tokens: ['action:deploy'] })).toBe(true)
    expect(ok({ kind: 'requires_before', first: 'action:run_tests', then: 'action:deploy' })).toBe(true)
    expect(ok({ kind: 'max_calls', token: 'Bash', limit: 3 })).toBe(true)
    expect(ok({ kind: 'forbid_with', taint: 'pii()', token: 'action:http_post' })).toBe(true)
    expect(ok({ kind: 'wasm_predicate', title: 't', rationale: 'r', verdict: 3, predicate: { all: [{ field: 'harness', op: 'equals', value: 'cursor' }] } })).toBe(true)
    expect(ok({ kind: 'none', reason: 'no rule here' })).toBe(true)
  })

  it('refuses a token with whitespace — a command is not a tool', () => {
    expect(reason({ kind: 'deny_tools', tools: ['rm -rf'] })).toMatch(/never a command/)
  })

  it('refuses verdict 1 — a generated rule can never originate a block', () => {
    expect(ok({ kind: 'wasm_predicate', title: 't', rationale: 'r', verdict: 1, predicate: { all: [{ field: 'harness', op: 'equals', value: 'x' }] } })).toBe(false)
  })

  it('refuses an unknown kind, an unknown key, and a predicate outside the DSL', () => {
    expect(ok({ kind: 'ssl_graph' })).toBe(false)
    expect(ok({ kind: 'deny_tools', tools: ['Bash'], regex: '.*' })).toBe(false)
    expect(reason({ kind: 'wasm_predicate', title: 't', rationale: 'r', verdict: 3, predicate: { all: [{ field: 'prompt_text', op: 'equals', value: 'x' }] } })).toMatch(/predicate/)
  })

  it('refuses an ordering rule whose two tokens are the same, and more hook tools than the cap', () => {
    expect(reason({ kind: 'forbid_after', first: 'Bash', then: 'Bash' })).toMatch(/two different tokens/)
    expect(ok({ kind: 'hook_rule', title: 't', tools: Array.from({ length: MAX_HOOK_TOOLS + 1 }, (_, i) => `Tool${i}`) })).toBe(false)
  })

  it('refuses a literal the JSON haystack could never contain verbatim, and an upper-case role', () => {
    expect(ok({ kind: 'hook_rule', title: 't', tools: ['Bash'], argContains: ['say "hi"'] })).toBe(false)
    expect(ok({ kind: 'hook_rule', title: 't', tools: ['Bash'], argContains: ['C:\\temp'] })).toBe(false)
    expect(ok({ kind: 'deny_tools', tools: ['Bash'], roles: ['Deployer'] })).toBe(false)
  })
})

describe('canonicalizeIr', () => {
  it('ignores the title and list order, lower-cases roles, and separates kinds', () => {
    const a = canonicalizeIr({ kind: 'hook_rule', title: 'one', tools: ['Write', 'Bash'], roles: ['SRE'] } as HookRuleIr)
    const b = canonicalizeIr({ kind: 'hook_rule', title: 'two', tools: ['Bash', 'Write', 'Bash'], roles: ['sre'] })
    expect(a).toBe(b)
    expect(canonicalizeIr({ kind: 'deny_tools', tools: ['Bash'] })).not.toBe(canonicalizeIr({ kind: 'review_before', tokens: ['Bash'] }))
  })
})

// ─── Hook rules ───────────────────────────────────────────────────────

describe('hook rule rendering', () => {
  it('escapes a dotted tool, sorts and alternates several, and anchors the whole name', () => {
    expect(renderToolPattern(['terraform.apply'])).toBe('^terraform\\.apply$')
    expect(renderToolPattern(['Write', 'Bash', 'Write'])).toBe('^(Bash|Write)$')
    expect(renderToolPattern(['Bash'])).toBe('^Bash$')
    expect(new RegExp(renderToolPattern(['Bash'])).test('BashHistory')).toBe(false)
  })

  it('renders literals as lookaheads both engines read the same way', () => {
    expect(escapeRegexLiteral('kubectl apply --auto-approve')).toBe('kubectl\\ apply\\ \\-\\-auto\\-approve')
    expect(escapeRegexLiteral('image:latest')).toBe('image\\:latest')
    expect(renderArgPattern(['terraform apply'], ['-plan'])).toBe('(?=[\\s\\S]*terraform\\ apply)(?![\\s\\S]*\\-plan)')
    expect(renderArgPattern([], [])).toBeUndefined()
  })

  it('the argument pattern matches the serialised input the gates match against', () => {
    const argPattern = renderArgPattern(['kubectl apply'], ['@sha256:'])!
    const re = new RegExp(argPattern)
    expect(re.test(JSON.stringify({ command: 'kubectl apply -f unpinned.yaml' }))).toBe(true)
    expect(re.test(JSON.stringify({ command: 'kubectl apply -f x.yaml # img@sha256:abc' }))).toBe(false)
    expect(re.test(JSON.stringify({ command: 'make test' }))).toBe(false)
    expect(re.test(JSON.stringify({ command: 'kubectl\napply' }))).toBe(false)
  })

  it('puts the citation in the reason, scrubs line breaks, and caps the length', () => {
    const ir: HookRuleIr = { kind: 'hook_rule', title: 'No\tunpinned\nimages', tools: ['Bash'] }
    const rendered = renderHookRule(ir, { quote: 'Every image\nmust be pinned by digest.', sourceUrl: 'https://wiki.acme.dev/pages/viewpage.action?pageId=1' })
    expect(rendered.reason).toBe('No unpinned images — policy: "Every image must be pinned by digest." (https://wiki.acme.dev/pages/viewpage.action?pageId=1)')
    expect(rendered.reason).not.toMatch(/[\t\n]/)
    expect(renderHookRule(ir, { quote: 'x'.repeat(1000), sourceUrl: null }).reason.length).toBeLessThanOrEqual(MAX_REASON_CHARS)
    expect(renderHookReason('t', { quote: 'q'.repeat(1000), sourceUrl: null })).toMatch(/…"$/)
    expect(renderHookRule(ir, { quote: 'q', sourceUrl: null })).toEqual(renderHookRule(ir, { quote: 'q', sourceUrl: null }))
  })
})

describe('guardrail SOP titles on the wire and on disk (Wave 9)', async () => {
  const { guardrailIdFromSopTitle, guardrailFileStem, GUARDRAIL_SOP_TITLE_PREFIX } = await import('../policyGuardrails.js')
  it('credits the served title form and the pulled file stem, and nothing else', () => {
    expect(GUARDRAIL_SOP_TITLE_PREFIX).toBe('GUARDRAIL:')
    expect(guardrailIdFromSopTitle('GUARDRAIL:pgr_abc123 deny_tools: WebFetch')).toBe('pgr_abc123')
    expect(guardrailIdFromSopTitle('GUARDRAIL:pgr_abc123')).toBe('pgr_abc123')
    expect(guardrailIdFromSopTitle(guardrailFileStem('pgr_abc123'))).toBe('pgr_abc123')
    expect(guardrailFileStem('pgr_abc123')).toBe('guardrail-pgr_abc123')
    expect(guardrailIdFromSopTitle('guardrail-pgr_abc123 extra')).toBeNull()
    expect(guardrailIdFromSopTitle('Guardrail-pgr_abc123')).toBeNull()
    expect(guardrailIdFromSopTitle('GUARDRAIL:x')).toBeNull()
    expect(guardrailIdFromSopTitle('Deploy checklist')).toBeNull()
  })
  it('the stem is legal on every platform: no colon, no space', () => {
    expect(guardrailFileStem('pgr_1')).not.toMatch(/[:\s\\/]/)
  })
})
