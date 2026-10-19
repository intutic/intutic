/**
 * Which proxy version reads each newer SOP front-matter key.
 *
 * The proxy reads keys as line prefixes and ignores the ones it does not know
 * (`sops.rs`), so an older proxy cannot fail closed on a new key: a
 * `scope_paths_mode: enforce` it does not read stays advisory there, and a
 * `closed_lanes:` holds nothing. Where a SOP is validated, the control plane
 * compares a workspace's `gateways.proxyVersion` with these and warns
 * (`sop_key_needs_newer_gateway`). Hook gates and SDKs fail closed on the
 * keys they evaluate through fallback lines instead (gateRuleRecord.ts).
 *
 * `null`: the proxy never reads the key; it is a gate-only rule
 * (`plan_approval:`), so no proxy version is too old for it.
 *
 * @module
 */

/** The proxy release that first reads the newer keys. */
export const LOOP_GRAPH_GATE_PROXY_VERSION = '3.0.0'

/**
 * Each key, as written at the start of its line, and the proxy version that
 * reads it. `requires_before:[ok]` stands for a qualified `requires_before:`
 * (`action:run_tests[ok]` on its left): an older proxy compares the literal,
 * which never appears in a sequence, so it refuses the gated call always.
 */
export const SOP_KEY_SINCE: Readonly<Record<string, string | null>> = {
  'requires_before:[ok]': LOOP_GRAPH_GATE_PROXY_VERSION,
  'scope_paths_mode:': LOOP_GRAPH_GATE_PROXY_VERSION,
  'plan_steps_mode:': LOOP_GRAPH_GATE_PROXY_VERSION,
  'plan_approval:': null,
  'closed_lanes:': LOOP_GRAPH_GATE_PROXY_VERSION,
  'open_actions:': LOOP_GRAPH_GATE_PROXY_VERSION,
  'on_reask_exhausted:': LOOP_GRAPH_GATE_PROXY_VERSION,
  'context_isolation:': LOOP_GRAPH_GATE_PROXY_VERSION,
  'node_kind:': LOOP_GRAPH_GATE_PROXY_VERSION,
  'node_kind_allow:': LOOP_GRAPH_GATE_PROXY_VERSION,
}

/** `major.minor.patch` (a `v` prefix and any `-pre` or `+build` suffix ignored) as three numbers, or null. */
export function parseProxyVersion(version: string | null | undefined): [number, number, number] | null {
  const m = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:[-+].*)?$/.exec((version ?? '').trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** Whether `version` is older than `since`. An unreadable or unknown version is not known to be older: the caller says it could not tell. */
export function proxyVersionOlder(version: string | null | undefined, since: string): boolean | null {
  const v = parseProxyVersion(version)
  const s = parseProxyVersion(since)
  if (!v || !s) return null
  for (let i = 0; i < 3; i++) if (v[i] !== s[i]) return v[i]! < s[i]!
  return false
}

/**
 * The keys the SOP's front matter (the text between the fences) uses that a
 * proxy at `proxyVersion` does not read, each with the version that does, in
 * {@link SOP_KEY_SINCE} order. A key is used when a line, at any
 * indentation, starts with it; a qualified `requires_before:` when such a
 * line holds `[ok]`. A proxy whose version is unknown gets every used key.
 */
export function sopKeysNeedingNewerProxy(front: string, proxyVersion: string | null | undefined): Array<{ key: string; since: string }> {
  const lines = front.split('\n').map((l) => l.trim())
  const out: Array<{ key: string; since: string }> = []
  for (const key of Object.keys(SOP_KEY_SINCE)) {
    const since = SOP_KEY_SINCE[key]
    if (since === null || since === undefined) continue
    const used =
      key === 'requires_before:[ok]'
        ? lines.some((l) => l.startsWith('requires_before:') && l.includes('[ok]'))
        : lines.some((l) => l.startsWith(key))
    if (used && proxyVersionOlder(proxyVersion, since) !== false) out.push({ key, since })
  }
  return out
}
