/**
 * Which proxy reads the newer front-matter keys, and which keys a SOP
 * uses that an older gateway would ignore.
 */
import { describe, expect, it } from 'vitest'
import { LOOP_GRAPH_GATE_PROXY_VERSION, SOP_KEY_SINCE, parseProxyVersion, proxyVersionOlder, sopKeysNeedingNewerProxy } from '../sopKeySince.js'

describe('SOP_KEY_SINCE', () => {
  it('names every newer key, and plan_approval as gate-only', () => {
    expect(Object.keys(SOP_KEY_SINCE)).toEqual([
      'requires_before:[ok]',
      'scope_paths_mode:',
      'plan_steps_mode:',
      'plan_approval:',
      'closed_lanes:',
      'open_actions:',
      'on_reask_exhausted:',
      'context_isolation:',
      'node_kind:',
      'node_kind_allow:',
    ])
    expect(SOP_KEY_SINCE['plan_approval:']).toBeNull()
  })
})

describe('versions', () => {
  it('parses and compares', () => {
    expect(parseProxyVersion('v3.1.0-rc.1')).toEqual([3, 1, 0])
    expect(parseProxyVersion('dev')).toBeNull()
    expect(proxyVersionOlder('3.0.9', '3.1.0')).toBe(true)
    expect(proxyVersionOlder('3.1.0', '3.1.0')).toBe(false)
    expect(proxyVersionOlder('10.0.0', '3.1.0')).toBe(false)
    expect(proxyVersionOlder(null, '3.1.0')).toBeNull()
  })
})

describe('sopKeysNeedingNewerProxy', () => {
  const front = '\nrequires_before: action:run_tests[ok] -> action:deploy\nscope_paths_mode: enforce\nplan_approval: strict\n  closed_lanes: irreversible\nnode_kind_allow: spawn\n'
  it('lists the keys an older proxy ignores', () => {
    expect(sopKeysNeedingNewerProxy(front, '2.9.1')).toEqual([
      { key: 'requires_before:[ok]', since: LOOP_GRAPH_GATE_PROXY_VERSION },
      { key: 'scope_paths_mode:', since: LOOP_GRAPH_GATE_PROXY_VERSION },
      { key: 'closed_lanes:', since: LOOP_GRAPH_GATE_PROXY_VERSION },
      { key: 'node_kind_allow:', since: LOOP_GRAPH_GATE_PROXY_VERSION },
    ])
  })

  it('lists none for a proxy that reads them, and all for one of unknown version', () => {
    expect(sopKeysNeedingNewerProxy(front, LOOP_GRAPH_GATE_PROXY_VERSION)).toEqual([])
    expect(sopKeysNeedingNewerProxy(front, null)).toHaveLength(4)
  })

  it('does not count an unqualified requires_before', () => {
    expect(sopKeysNeedingNewerProxy('requires_before: action:run_tests -> action:deploy', '2.9.1')).toEqual([])
  })
})
