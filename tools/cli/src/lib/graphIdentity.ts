/**
 * Graph identity for spawned agents.
 *
 * A multi-agent run is a graph: a lead agent spawns workers, workers spawn their
 * own. The proxy can only reason about that shape — fan-out, recursion depth,
 * orphaned children, fleet spend — if each request says which node it came from.
 * Nothing set that. `identity_from_headers` read W3C `baggage` and `x-intutic-*`
 * headers that only its own tests ever wrote, so `graph_id` always fell back to
 * `session_id`, and the gate at `proxy.rs` (`node.graph_id == session_id` → "a
 * graph of one") made the whole membership and spend block unreachable.
 *
 * # Why environment variables, and why a path prefix
 *
 * A spawned agent is a child *process*, and the one thing a child process
 * inherits for free is the environment. So identity lives in env vars, and each
 * `intutic exec` derives its own position from what it inherited: same graph, new
 * node, parent = whoever spawned me, depth + 1. Nesting `intutic exec` inside an
 * agent is precisely the "an agent spawned an agent" event, so no harness needs
 * to cooperate for the shape to be recorded.
 *
 * Getting that identity onto the wire is the harder half. Env vars are not HTTP
 * headers, and almost no harness lets you add headers — Claude Code has
 * `ANTHROPIC_CUSTOM_HEADERS` and the rest of the ecosystem has nothing. What they
 * all accept is a base URL, which they append their own path to. So identity
 * rides in the base URL as `/_i/{graph}/{node}/{parent}/{depth}`, which the proxy
 * strips before anything else looks at the path.
 *
 * # Trust
 *
 * Client-supplied and unverifiable, exactly like the headers it complements. It
 * describes shape for observability and self-consistency, and is never an input
 * to authorisation. The proxy clamps depth so a caller cannot fake a recursion
 * breach.
 *
 * @module
 */

import { randomBytes } from 'node:crypto'

/** Set on every process under a governed run; absent means this is the root. */
export const ENV_GRAPH_ID = 'INTUTIC_GRAPH_ID'
export const ENV_NODE_ID = 'INTUTIC_NODE_ID'
export const ENV_PARENT_ID = 'INTUTIC_PARENT_ID'
export const ENV_DEPTH = 'INTUTIC_DEPTH'

/** Stands in for "no parent" — an empty path segment would collapse. */
const EMPTY_SEGMENT = '-'

/**
 * Depth beyond which we stop counting.
 *
 * Matches the proxy's clamp. A graph this deep is a runaway, which is a thing to
 * detect rather than a number to keep incrementing.
 */
const MAX_DEPTH = 1024

export interface GraphIdentity {
  graphId: string
  nodeId: string
  /** Empty for a root node. */
  parentId: string
  depth: number
}

/** Short, URL-safe, and readable in a log line. */
function newIdentifier(prefix: string): string {
  return `${prefix}${randomBytes(8).toString('hex')}`
}

/**
 * Work out this process's position from the environment it inherited.
 *
 * With no inherited identity this process is a root: it starts a new graph and is
 * its own first node. With one, it is a child of whatever spawned it.
 */
export function deriveIdentity(env: NodeJS.ProcessEnv = process.env): GraphIdentity {
  const inheritedGraph = env[ENV_GRAPH_ID]
  const inheritedNode = env[ENV_NODE_ID]

  if (!inheritedGraph || !inheritedNode) {
    const graphId = newIdentifier('g_')
    return { graphId, nodeId: newIdentifier('n_'), parentId: '', depth: 0 }
  }

  const inheritedDepth = Number.parseInt(env[ENV_DEPTH] ?? '0', 10)
  const depth = Number.isFinite(inheritedDepth) ? Math.max(0, inheritedDepth) : 0

  return {
    graphId: inheritedGraph,
    nodeId: newIdentifier('n_'),
    // The process that spawned us is our parent, by definition.
    parentId: inheritedNode,
    depth: Math.min(depth + 1, MAX_DEPTH),
  }
}

/**
 * The env a child process should inherit.
 *
 * Merged into the child's environment so that if it in turn runs `intutic exec`,
 * `deriveIdentity` sees this node as its parent and the chain continues without
 * anyone tracking it centrally.
 */
export function identityEnv(identity: GraphIdentity): Record<string, string> {
  return {
    [ENV_GRAPH_ID]: identity.graphId,
    [ENV_NODE_ID]: identity.nodeId,
    [ENV_PARENT_ID]: identity.parentId,
    [ENV_DEPTH]: String(identity.depth),
  }
}

/**
 * The base-URL prefix carrying this identity.
 *
 * Appended to the proxy host so every harness sends it without knowing it exists:
 * they concatenate their own path onto the base URL, and the proxy strips the
 * prefix back off before routing.
 */
export function identityPathPrefix(identity: GraphIdentity): string {
  const seg = (value: string) => (value === '' ? EMPTY_SEGMENT : encodeURIComponent(value))
  return `/_i/${seg(identity.graphId)}/${seg(identity.nodeId)}/${seg(identity.parentId)}/${identity.depth}`
}

/**
 * Headers for harnesses that can send them.
 *
 * Redundant with the path prefix and deliberately so — the proxy prefers headers,
 * and a harness with real OpenTelemetry instrumentation will already be emitting
 * `baggage` that supersedes both.
 */
export function identityHeaders(identity: GraphIdentity): Record<string, string> {
  return {
    'X-Intutic-Graph-Id': identity.graphId,
    'X-Intutic-Node-Id': identity.nodeId,
    'X-Intutic-Parent-Session': identity.parentId,
    'X-Intutic-Depth': String(identity.depth),
  }
}
