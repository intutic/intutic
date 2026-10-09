/**
 * The workspace's MCP server registry decisions, as the gates apply them.
 *
 * An owner or admin approves or blocks each MCP server on the MCP Servers
 * page, disables tools within one, and sets what happens to a server nobody
 * has decided on (`mcpDefaultPolicy`); a high-risk tool-set change can send a
 * server back to the queue. The control plane serves those decisions as
 * `mcpRegistry` on `GET /api/v1/policy/resolve`. The MCP proxy applies them to
 * the servers it fronts; the sync daemon writes them into the policy snapshot
 * as an `@mcp_registry` record so the harness hook gates apply them to every
 * `mcp__<server>__<tool>` call, the servers no proxy fronts included.
 *
 * {@link evaluateMcpRegistry} is the one decision. The MCP proxy calls it, the
 * JavaScript hook gates embed its source ({@link MCP_REGISTRY_JS_SOURCE}), and
 * the bash gates run a Python transliteration in the sync daemon's
 * `gateBody.ts`; `fixtures/mcp-registry-vectors.json` holds all of them to
 * the same codes, rule ids and reasons.
 *
 * @module
 */

/** What the registry decides, per workspace. The MCP proxy's `McpRegistryPolicy` has the same shape. */
export interface McpRegistryRecord {
  defaultPolicy: 'allow' | 'deny'
  approvedServers: string[]
  blockedServers: string[]
  /** Servers a high-risk tool change returned to the approval queue; refused under either default. */
  heldServers: string[]
  /** Server name → tool names disabled within it. */
  disabledTools: Record<string, string[]>
}

/** A registry refusal: the code every MCP surface uses, the deciding rule, and why. */
export interface McpRegistryRefusal {
  code: 'SERVER_BLOCKED' | 'SERVER_HELD' | 'SERVER_NOT_APPROVED' | 'TOOL_DISABLED'
  ruleId: string
  reason: string
}

/**
 * Decides one MCP tool call against the registry: a blocked server, then a
 * held one, then — under `deny` — one not approved, then a disabled tool.
 * Null lets the call continue.
 *
 * Self-contained (no imports, no module state) because the JavaScript hook
 * gates run it as emitted source.
 */
export function evaluateMcpRegistry(
  registry: McpRegistryRecord,
  serverName: string,
  toolName: string,
): McpRegistryRefusal | null {
  if (registry.blockedServers.indexOf(serverName) !== -1) {
    return {
      code: 'SERVER_BLOCKED',
      ruleId: 'mcp_registry.' + serverName,
      reason:
        'MCP server "' + serverName + '" is blocked in this workspace\'s MCP server registry. ' +
        'An owner or admin can change that on the MCP Servers page.',
    }
  }
  if (registry.heldServers.indexOf(serverName) !== -1) {
    return {
      code: 'SERVER_HELD',
      ruleId: 'mcp_registry.' + serverName,
      reason:
        'MCP server "' + serverName + '" changed its tools in a way scored high risk, and this workspace ' +
        'holds such a server until it is approved again. It is waiting in the approval queue on the MCP ' +
        'Servers page for an owner or admin.',
    }
  }
  if (registry.defaultPolicy === 'deny' && registry.approvedServers.indexOf(serverName) === -1) {
    return {
      code: 'SERVER_NOT_APPROVED',
      ruleId: 'mcpDefaultPolicy',
      reason:
        'MCP server "' + serverName + '" is not approved in this workspace\'s MCP server registry, ' +
        'and the workspace refuses unapproved servers (mcpDefaultPolicy: deny). It is waiting in ' +
        'the approval queue on the MCP Servers page for an owner or admin.',
    }
  }
  const disabled = Object.prototype.hasOwnProperty.call(registry.disabledTools, serverName)
    ? registry.disabledTools[serverName]
    : undefined
  if (disabled && disabled.indexOf(toolName) !== -1) {
    return {
      code: 'TOOL_DISABLED',
      ruleId: 'mcp_registry.' + serverName + '.' + toolName,
      reason:
        'Tool "' + toolName + '" is disabled on MCP server "' + serverName + '" in this workspace\'s ' +
        'MCP server registry. An owner or admin can re-enable it on the MCP Servers page.',
    }
  }
  return null
}

/** {@link evaluateMcpRegistry} as source, for the JavaScript hook gates. */
export const MCP_REGISTRY_JS_SOURCE = evaluateMcpRegistry.toString()

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reads `mcpRegistry` as the control plane sends it. Null for anything that is
 * not a registry object; wrong-typed lists read as empty, and any default but
 * `deny` reads as `allow`, the control plane's own reading of the setting.
 */
export function parseMcpRegistryRecord(value: unknown): McpRegistryRecord | null {
  if (!isPlainObject(value)) return null
  const disabledTools: Record<string, string[]> = {}
  if (isPlainObject(value['disabledTools'])) {
    for (const [server, tools] of Object.entries(value['disabledTools'])) {
      const list = stringList(tools)
      if (list.length > 0) disabledTools[server] = list
    }
  }
  return {
    defaultPolicy: value['defaultPolicy'] === 'deny' ? 'deny' : 'allow',
    approvedServers: stringList(value['approvedServers']),
    blockedServers: stringList(value['blockedServers']),
    heldServers: stringList(value['heldServers']),
    disabledTools,
  }
}

/** Whether a registry refuses nothing: no snapshot record is written for one. */
export function isUnrestrictedMcpRegistry(registry: McpRegistryRecord): boolean {
  return (
    registry.defaultPolicy === 'allow' &&
    registry.blockedServers.length === 0 &&
    registry.heldServers.length === 0 &&
    Object.keys(registry.disabledTools).length === 0
  )
}

/**
 * First column of the record's line in `policy-snapshot.rules`. A data line,
 * like `@sso_groups`, so the digest every gate recomputes covers it; two
 * columns, so every rule parser (which needs six) skips it.
 */
export const MCP_REGISTRY_RECORD_TAG = '@mcp_registry'

function toBase64(text: string): string {
  let binary = ''
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromBase64(b64: string): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))
}

/** The record as one `.rules` line: the tag, a tab, base64 of its JSON. */
export function encodeMcpRegistryRecord(registry: McpRegistryRecord): string {
  return `${MCP_REGISTRY_RECORD_TAG}\t${toBase64(JSON.stringify(registry))}`
}

/** Reads a record line back; null for any other line or a damaged one. */
export function decodeMcpRegistryRecord(line: string): McpRegistryRecord | null {
  const [tag, b64, ...rest] = line.split('\t')
  if (tag !== MCP_REGISTRY_RECORD_TAG || !b64 || rest.length > 0) return null
  try {
    return parseMcpRegistryRecord(JSON.parse(fromBase64(b64)))
  } catch {
    return null
  }
}
