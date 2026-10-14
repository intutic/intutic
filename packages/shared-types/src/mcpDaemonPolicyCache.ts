/**
 * The keys of the MCP daemon's shared (Valkey) resolved-policy cache, built
 * here so the daemon that reads and writes them
 * (`packages/mcp-proxy/src/daemon/policyCache.ts`) and the control plane that
 * invalidates them (`lib/policyCacheInvalidation.ts`) cannot disagree.
 *
 * What `GET /api/v1/policy/resolve` answers depends on who asks: the
 * hook-rule guardrails served are those of the calling key's member role, and
 * the `principal` (the member, their role and SSO groups) is that member. So
 * an entry is keyed by the workspace AND the caller — a tag derived from the
 * daemon's API key, which is what the control plane resolves the member from.
 * Two daemons on one Valkey with different members' keys each get their own
 * entry; neither can be served the other's, possibly less restrictive, set.
 *
 * Invalidation cannot name every caller's entry, so each key also carries the
 * workspace's generation: the control plane bumps `mcpDaemonPolicyGenKey` on
 * every policy change, which orphans every caller's entry at once (they expire
 * on their own TTL), with no SCAN. A daemon reads the generation BEFORE it
 * fetches, so a change that lands during the fetch files the result under the
 * old generation, where no one reads it.
 */

/** The workspace's policy generation, bumped on every invalidation. Absent reads as `0`. */
export function mcpDaemonPolicyGenKey(workspaceId: string): string {
  return `mcp_daemon:policy_gen:${workspaceId}`
}

/** One caller's resolved policy for a workspace, at one generation. */
export function mcpDaemonPolicyKey(workspaceId: string, generation: string, callerTag: string): string {
  return `mcp_daemon:policy:${workspaceId}:g${generation}:${callerTag}`
}

/**
 * The workspace-only key daemons wrote before entries were keyed by caller.
 * No current daemon reads it; the control plane still deletes it on every
 * change so an older daemon sharing the Valkey is not served a stale entry.
 */
export function legacyMcpDaemonPolicyKey(workspaceId: string): string {
  return `mcp_daemon:policy:${workspaceId}`
}
