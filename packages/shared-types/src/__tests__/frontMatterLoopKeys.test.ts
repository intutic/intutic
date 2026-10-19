/**
 * The newer front-matter keys, as the TypeScript mirror of
 * sops.rs reads them: where each is read, how several lines combine, and
 * that an unknown value enforces (a typo never switches a guard off).
 */
import { describe, expect, it } from 'vitest'
import { validateGuardrailIr, QUALIFIED_TOKENS } from '../guardrailIr.js'
import { frontMatterToIrs, isEnforceableFrontMatter, parseFrontMatterEnforcing, renderFrontMatterLines } from '../guardrailRender.js'

const fm = parseFrontMatterEnforcing

describe('requires_before: action:run_tests[ok]', () => {
  it('parses the qualified token on the left, kept as the literal the wire carries', () => {
    expect(fm('requires_before: action:run_tests[ok] -> action:deploy').requiresBefore).toEqual([['action:run_tests[ok]', 'action:deploy', false]])
    expect(fm('requires_before: action:run_tests[ok] ~> action:publish').requiresBefore).toEqual([['action:run_tests[ok]', 'action:publish', true]])
    expect(fm('requires_before: [action:run_tests[ok] -> action:deploy]').requiresBefore).toEqual([['action:run_tests[ok]', 'action:deploy', false]])
  })

  it('refuses a qualifier anywhere else, in one wording', () => {
    const wrong = (line: string) => fm(line).errors
    expect(wrong('requires_before: action:deploy -> action:run_tests[ok]')).toEqual([
      'requires_before: "action:run_tests[ok": [ok] qualifies only action:run_tests, on the left of ->',
    ])
    expect(wrong('requires_before: action:deploy[ok] -> action:publish')).toEqual([
      'requires_before: "action:deploy[ok]": [ok] qualifies only action:run_tests, on the left of ->',
    ])
    expect(wrong('forbid_after: action:run_tests[ok] -> action:deploy')).toEqual([
      'forbid_after: "action:run_tests[ok]": [ok] qualifies only action:run_tests, on the left of ->',
    ])
    expect(fm('requires_before: action:deploy -> action:run_tests[ok]').requiresBefore).toEqual([])
  })

  it('is in the IR on the left of requires_before only, and round-trips', () => {
    expect([...QUALIFIED_TOKENS]).toEqual(['action:run_tests[ok]'])
    const ir = { kind: 'requires_before', first: 'action:run_tests[ok]', then: 'action:deploy' } as const
    expect(validateGuardrailIr(ir)).toMatchObject({ ok: true })
    expect(validateGuardrailIr({ ...ir, first: 'action:deploy', then: 'action:run_tests[ok]' })).toMatchObject({ ok: false })
    expect(validateGuardrailIr({ kind: 'forbid_after', first: 'action:run_tests[ok]', then: 'action:deploy' })).toMatchObject({ ok: false })
    expect(validateGuardrailIr({ ...ir, first: 'action:deploy[ok]' })).toMatchObject({ ok: false })
    const lines = renderFrontMatterLines([ir])
    expect(lines).toBe('requires_before: action:run_tests[ok] -> action:deploy')
    expect(frontMatterToIrs(fm(lines))).toEqual([ir])
  })
})

describe('the mode keys: any indentation, strongest wins, unknown enforces', () => {
  it.each([
    ['scope_paths_mode:', 'scopePathsMode'],
    ['plan_steps_mode:', 'planStepsMode'],
    ['context_isolation:', 'contextIsolation'],
  ] as const)('%s', (key, field) => {
    expect(fm('deny_tools: x')[field]).toBe('advise')
    expect(fm(`${key} enforce`)[field]).toBe('enforce')
    expect(fm(`${key} "Advise"`)[field]).toBe('advise')
    expect(fm(`nested:\n  ${key} enforce`)[field]).toBe('enforce')
    expect(fm(`${key} enforce\n${key} advise`)[field]).toBe('enforce')
    const typo = fm(`${key} enforse`)
    expect(typo[field]).toBe('enforce')
    expect(typo.errors).toEqual([`${key} "enforse" is not advise or enforce, so it enforces`])
  })

  it('plan_approval: absent, required or strict; strict wins; unknown is strict', () => {
    expect(fm('deny_tools: x').planApproval).toBeNull()
    expect(fm('plan_approval: required').planApproval).toBe('required')
    expect(fm('plan_approval: required\n  plan_approval: strict').planApproval).toBe('strict')
    expect(fm('plan_approval: strict\nplan_approval: required').planApproval).toBe('strict')
    const typo = fm('plan_approval: yes')
    expect(typo.planApproval).toBe('strict')
    expect(typo.errors).toEqual(['plan_approval: "yes" is not required or strict, so it is strict'])
  })

  it('on_reask_exhausted: block by default, pause wins, unknown pauses', () => {
    expect(fm('deny_tools: x').onReaskExhausted).toBe('block')
    expect(fm('on_reask_exhausted: block\non_reask_exhausted: pause').onReaskExhausted).toBe('pause')
    expect(fm('on_reask_exhausted: halt')).toMatchObject({ onReaskExhausted: 'pause', errors: ['on_reask_exhausted: "halt" is not block or pause, so it pauses'] })
  })
})

describe('the list keys', () => {
  it('closed_lanes: any indentation, union, unknown entry dropped and reported', () => {
    expect(fm('closed_lanes: irreversible\n  closed_lanes: reversible_wide, irreversible').closedLanes).toEqual(['irreversible', 'reversible_wide'])
    expect(fm('closed_lanes: reversible_contained')).toMatchObject({
      closedLanes: [],
      errors: ['closed_lanes: "reversible_contained" is not a lane (irreversible, reversible_wide)'],
    })
  })

  it('open_actions: top level only', () => {
    expect(fm('open_actions: action:publish, action:destroy').openActions).toEqual(['action:publish', 'action:destroy'])
    expect(fm('x:\n  open_actions: action:publish').openActions).toEqual([])
    expect(fm('open_actions: Bash').errors).toEqual(['open_actions: "bash" is not an action token'])
  })

  it('node_kind: any indentation; node_kind_allow: top level only', () => {
    expect(fm('node_kind: worker\n  node_kind: gate, worker').nodeKinds).toEqual(['worker', 'gate'])
    expect(fm('node_kind: manager').errors).toEqual(['node_kind: "manager" is not a node kind (splitter, worker, code, gate)'])
    expect(fm('node_kind_allow: spawn, shell').nodeKindAllow).toEqual(['spawn', 'shell'])
    expect(fm('x:\n  node_kind_allow: spawn').nodeKindAllow).toEqual([])
    expect(fm('node_kind_allow: network').errors).toEqual(['node_kind_allow: "network" is not a limit (model, write, shell, spawn)'])
  })

  it('does not read scope_paths_mode as scope_paths, nor node_kind_allow as node_kind', () => {
    expect(fm('scope_paths_mode: enforce').scopePaths).toEqual([])
    expect(fm('plan_steps_mode: enforce').planSteps).toEqual([])
    expect(fm('node_kind_allow: spawn').nodeKinds).toEqual([])
  })

  it('reads risk_tier at the top level only', () => {
    expect(fm('risk_tier: High').riskTier).toBe('HIGH')
    expect(fm('x:\n  risk_tier: high').riskTier).toBeNull()
    expect(fm('risk_tier: hgih').riskTier).toBeNull()
  })
})

describe('what makes a SOP enforceable', () => {
  it('counts closed_lanes, plan_approval and node_kind, and not the modifier keys', () => {
    expect(isEnforceableFrontMatter(fm('closed_lanes: irreversible'))).toBe(true)
    expect(isEnforceableFrontMatter(fm('plan_approval: required'))).toBe(true)
    expect(isEnforceableFrontMatter(fm('node_kind: code'))).toBe(true)
    for (const modifier of ['scope_paths_mode: enforce', 'plan_steps_mode: enforce', 'open_actions: action:publish', 'on_reask_exhausted: pause', 'context_isolation: enforce', 'node_kind_allow: spawn']) {
      expect(isEnforceableFrontMatter(fm(modifier)), modifier).toBe(false)
    }
  })
})

describe('the Terraform provider grammar', () => {
  it('carries the action tokens and the qualified token', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { ACTION_TOKENS } = await import('../guardrailIr.js')
    const g = JSON.parse(readFileSync(join(__dirname, '../../../terraform-provider-intutic/internal/provider/guardrail_ir_grammar.json'), 'utf-8'))
    expect(g.actionTokens).toEqual([...ACTION_TOKENS])
    expect(g.qualifiedTokens).toEqual([...QUALIFIED_TOKENS])
    expect(g.kinds.requires_before.first.item).toBe('orderingFirst')
  })
})
