/**
 * This client's position in the agent graph.
 *
 * A multi-agent run is a graph — a lead spawns workers, workers spawn their own —
 * and the proxy can only reason about its shape (fan-out, recursion depth,
 * orphaned children, fleet spend) if each request says which node it came from.
 * Nothing set that: the proxy read `baggage` and `x-intutic-*` headers no
 * component emitted, so `graph_id` always fell back to `session_id` and every
 * request looked like a graph of one.
 *
 * Identity is inherited through the environment, because that is what a spawned
 * child process gets for free. An agent that runs another agent is recorded as
 * its parent without either of them being told anything.
 *
 * Client-supplied and unverifiable, like the headers it complements: it describes
 * shape for observability, never authorisation. The proxy clamps depth so a
 * caller cannot fake a recursion breach.
 *
 * @module
 */

/** Environment carriers, shared with the `intutic` CLI. */
const ENV_GRAPH_ID = 'INTUTIC_GRAPH_ID'
const ENV_NODE_ID = 'INTUTIC_NODE_ID'
const ENV_DEPTH = 'INTUTIC_DEPTH'

/** Matches the proxy's clamp: a graph this deep is a runaway to detect, not a number to keep. */
const MAX_DEPTH = 1024

export interface GraphIdentity {
  graphId: string
  nodeId: string
  /** Empty for a root node. */
  parentId: string
  depth: number
}

function newIdentifier(prefix: string): string {
  return `${prefix}${Math.random().toString(16).slice(2, 10)}${Date.now().toString(16).slice(-6)}`
}

/**
 * Derive this client's identity, preferring one supplied explicitly.
 *
 * An explicit identity is how a host application that manages its own fan-out —
 * one process, many logical agents — describes a graph the environment cannot.
 */
export function deriveIdentity(explicit?: Partial<GraphIdentity>): GraphIdentity {
  const env = typeof process !== 'undefined' ? process.env : {}

  const inheritedGraph = explicit?.graphId ?? env[ENV_GRAPH_ID]
  const inheritedNode = env[ENV_NODE_ID]

  if (!inheritedGraph) {
    return {
      graphId: newIdentifier('g_'),
      nodeId: explicit?.nodeId ?? newIdentifier('n_'),
      parentId: explicit?.parentId ?? '',
      depth: explicit?.depth ?? 0,
    }
  }

  const parsed = Number.parseInt(env[ENV_DEPTH] ?? '0', 10)
  const inheritedDepth = Number.isFinite(parsed) ? Math.max(0, parsed) : 0

  return {
    graphId: inheritedGraph,
    nodeId: explicit?.nodeId ?? newIdentifier('n_'),
    // The process that spawned this one is the parent, by definition.
    parentId: explicit?.parentId ?? inheritedNode ?? '',
    depth: explicit?.depth ?? Math.min(inheritedDepth + 1, MAX_DEPTH),
  }
}

/** The headers the proxy reads. The SDK controls its own requests, so no path prefix is needed. */
export function identityHeaders(identity: GraphIdentity): Record<string, string> {
  return {
    'X-Intutic-Graph-Id': identity.graphId,
    'X-Intutic-Node-Id': identity.nodeId,
    'X-Intutic-Parent-Session': identity.parentId,
    'X-Intutic-Depth': String(identity.depth),
  }
}
