/**
 * The descriptor of a custom rule uploaded to the control plane — one shape
 * for every proxy that enforces it.
 *
 * The control plane publishes the workspace's active rules as a list of these:
 * to Valkey for the LLM proxy (`wasm:plugins:{workspaceId}`, read by
 * `packages/proxy/src/wasm/registry.rs` as `WasmPluginDescriptor`), and as
 * `wasmRules` on the MCP proxy's policy responses (`GET /api/v1/sop/rules`,
 * `GET /api/v1/policy/resolve`). The binary is fetched separately, by the
 * SHA-256 the descriptor names, and checked against it before it loads.
 *
 * {@link parseWasmRuleDescriptors} reads the list the way the Rust proxy's
 * serde does: one malformed entry makes the whole list unreadable, and a
 * proxy keeps the rules it already enforces rather than applying part of a
 * list — dropping the entry would silently stop enforcing that rule.
 *
 * @module
 */

/** `ENFORCE` decides calls; `SHADOW` is evaluated and reported, and never changes one. */
export type WasmRuleMode = 'ENFORCE' | 'SHADOW'

export interface WasmRuleDescriptor {
  /** The control plane's rule id (`wasm_…`), the id both proxies report the rule by. */
  ruleId: string
  name: string
  /** Lowercase hex SHA-256 of the binary; the binary is fetched and verified by it. */
  sha256: string
  /** Ascending: lower runs first. Local rules default to 100. */
  priority: number
  mode: WasmRuleMode
}

export type WasmRuleDescriptorsParse =
  | { ok: true; rules: WasmRuleDescriptor[] }
  | { ok: false; reason: string }

function parseMode(value: unknown): WasmRuleMode | undefined {
  // Absent on a descriptor written before modes existed, which must keep
  // enforcing — the same default `registry.rs` gives `RuleMode`.
  if (value === undefined) return 'ENFORCE'
  if (value === 'ENFORCE' || value === 'enforce') return 'ENFORCE'
  if (value === 'SHADOW' || value === 'shadow') return 'SHADOW'
  return undefined
}

/**
 * Reads a descriptor list. Anything but an array of well-formed descriptors is
 * unreadable, with the first problem as the reason.
 */
export function parseWasmRuleDescriptors(value: unknown): WasmRuleDescriptorsParse {
  if (!Array.isArray(value)) return { ok: false, reason: 'the rule list is not an array' }
  const rules: WasmRuleDescriptor[] = []
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { ok: false, reason: `entry ${index} is not an object` }
    }
    const e = entry as Record<string, unknown>
    const { ruleId, name, sha256, priority } = e
    if (typeof ruleId !== 'string' || ruleId.length === 0) return { ok: false, reason: `entry ${index} has no ruleId` }
    if (typeof name !== 'string') return { ok: false, reason: `rule ${ruleId} has no name` }
    // Any string, as serde reads it: a hash that names no binary is refused
    // per rule when the binary is fetched, with an incident, not here.
    if (typeof sha256 !== 'string') return { ok: false, reason: `rule ${ruleId} has no SHA-256` }
    if (typeof priority !== 'number' || !Number.isInteger(priority) || priority < 0) {
      return { ok: false, reason: `rule ${ruleId} has no priority` }
    }
    const mode = parseMode(e['mode'])
    if (!mode) return { ok: false, reason: `rule ${ruleId} has an unknown mode` }
    rules.push({ ruleId, name, sha256, priority, mode })
  }
  return { ok: true, rules }
}
