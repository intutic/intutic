/**
 * Graph identity derivation.
 *
 * The property that matters is the chain: a nested `intutic exec` must come out
 * as a child of the one that spawned it, with the graph held constant, because
 * that is the only thing that makes `graph_id != session_id` true at the proxy —
 * the gate guarding membership, graph spend and node counts, and with them
 * HALLUCINATION, SPAWN_BUDGET_BREACH and the fan-out and recursion inputs to
 * LOOP_DETECTED.
 */
import { describe, it, expect } from 'vitest'
import {
  deriveIdentity,
  identityEnv,
  identityPathPrefix,
  identityHeaders,
} from './graphIdentity.js'
import { buildProxyEnv } from '../commands/exec.js'

describe('graph identity', () => {
  it('starts a new graph when nothing was inherited', () => {
    const id = deriveIdentity({})
    expect(id.depth).toBe(0)
    expect(id.parentId).toBe('')
    expect(id.graphId).toBeTruthy()
    expect(id.nodeId).toBeTruthy()
  })

  it('makes a spawned process a child of the one that spawned it', () => {
    const parent = deriveIdentity({})
    const child = deriveIdentity(identityEnv(parent))

    expect(child.graphId, 'the graph is what the fleet shares').toBe(parent.graphId)
    expect(child.parentId).toBe(parent.nodeId)
    expect(child.nodeId).not.toBe(parent.nodeId)
    expect(child.depth).toBe(1)
  })

  it('keeps the chain across several levels', () => {
    let current = deriveIdentity({})
    const root = current.graphId
    for (let expected = 1; expected <= 4; expected++) {
      const next = deriveIdentity(identityEnv(current))
      expect(next.depth).toBe(expected)
      expect(next.parentId).toBe(current.nodeId)
      expect(next.graphId).toBe(root)
      current = next
    }
  })

  it('stops counting depth at the proxy’s clamp', () => {
    const id = deriveIdentity({
      INTUTIC_GRAPH_ID: 'g',
      INTUTIC_NODE_ID: 'n',
      INTUTIC_DEPTH: '99999',
    })
    expect(id.depth).toBe(1024)
  })

  it('survives a corrupted depth rather than producing NaN', () => {
    const id = deriveIdentity({
      INTUTIC_GRAPH_ID: 'g',
      INTUTIC_NODE_ID: 'n',
      INTUTIC_DEPTH: 'not-a-number',
    })
    expect(id.depth).toBe(1)
  })

  it('encodes a root with the placeholder segment, not an empty one', () => {
    // An empty path segment collapses, which would shift every later segment
    // and make the proxy read depth as the parent.
    const prefix = identityPathPrefix({ graphId: 'g1', nodeId: 'n1', parentId: '', depth: 0 })
    expect(prefix).toBe('/_i/g1/n1/-/0')
    expect(prefix.split('/')).toHaveLength(6)
  })

  it('puts the identity into the base URL every harness will send', () => {
    const identity = { graphId: 'g1', nodeId: 'n2', parentId: 'n1', depth: 2 }
    const env = buildProxyEnv('intk_test', false, identity)

    // Each of these is a different harness's way of naming the same thing, and
    // all of them append their own path to it.
    expect(env.ANTHROPIC_BASE_URL).toBe('http://localhost:4000/_i/g1/n2/n1/2')
    expect(env.OPENAI_BASE_URL).toBe('http://localhost:4000/_i/g1/n2/n1/2/v1')
    expect(env.OPENAI_API_BASE).toBe('http://localhost:4000/_i/g1/n2/n1/2/v1')
    expect(env.OPENAI_HOST).toBe('http://localhost:4000/_i/g1/n2/n1/2')

    // And passed down, so the next `intutic exec` continues the chain.
    expect(env.INTUTIC_GRAPH_ID).toBe('g1')
    expect(env.INTUTIC_NODE_ID).toBe('n2')
    expect(env.INTUTIC_DEPTH).toBe('2')
  })

  it('leaves the base URL alone when there is no identity', () => {
    const env = buildProxyEnv('intk_test', false)
    expect(env.ANTHROPIC_BASE_URL).toBe('http://localhost:4000')
    expect(env.OPENAI_BASE_URL).toBe('http://localhost:4000/v1')
    expect(env.INTUTIC_GRAPH_ID).toBeUndefined()
  })

  it('emits headers for the one harness that can send them', () => {
    const h = identityHeaders({ graphId: 'g1', nodeId: 'n2', parentId: 'n1', depth: 2 })
    expect(h['X-Intutic-Graph-Id']).toBe('g1')
    expect(h['X-Intutic-Parent-Session']).toBe('n1')
    expect(h['X-Intutic-Depth']).toBe('2')
  })
})
