/**
 * Posture presets — named bundles over knobs that already reach enforcement.
 *
 * A posture is one decision ("how should governance treat this workspace?")
 * expressed over several settings a user would otherwise have to correlate by
 * hand. Every key a preset writes has a verified consumer TODAY:
 *
 * - `featureFlags.*` sync to `workspace:feature_flags:{ws}` in Valkey on every
 *   settings write, and the proxy reads them per request (`store/valkey.rs`).
 * - `bypassEnforcementTier` drives the sync-daemon's drift watcher.
 * - `mcpProxyFailBehavior` decides whether a broken MCP proxy fails open or
 *   closed.
 *
 * A preset key without a consumer would make the posture selector the exact
 * inert control this product exists to remove, so adding one requires naming
 * its reader here.
 *
 * Presets are DATA, applied through the same settings pipeline as a manual
 * PUT — same merge semantics, same Valkey sync, same audit surface. Applying
 * one records its name; editing an underlying knob afterwards clears it,
 * because a posture that no longer matches its knobs is a label lying about
 * the configuration.
 */

export interface PosturePreset {
  name: string
  title: string
  description: string
  /** Scalar settings keys, merged shallowly. */
  settings: Record<string, string | boolean>
  /** Feature flags, merged one level deeper — like the PUT route does. */
  featureFlags: Record<string, boolean>
}

/**
 * Security postures: how enforcement behaves when a guard fires.
 */
export const SECURITY_POSTURES: readonly PosturePreset[] = [
  {
    name: 'strict',
    title: 'Strict',
    description:
      'Findings enforce in real time, harness configs are rewritten on drift and made ' +
      'immutable where the OS supports it, and a broken MCP proxy fails closed. ' +
      'The posture for regulated environments and production credentials.',
    settings: {
      bypassEnforcementTier: 'immutable',
      mcpProxyFailBehavior: 'closed',
    },
    featureFlags: { ff_shadow_enforcement: false },
  },
  {
    name: 'balanced',
    title: 'Balanced',
    description:
      'Findings enforce in real time and drifted harness configs are rewritten, but ' +
      'nothing is made immutable and a broken MCP proxy fails open rather than ' +
      'blocking work. The default.',
    settings: {
      bypassEnforcementTier: 'rewrite',
      mcpProxyFailBehavior: 'open',
    },
    featureFlags: { ff_shadow_enforcement: false },
  },
  {
    name: 'observe',
    title: 'Observe',
    description:
      'Every detector runs and every finding is recorded, but nothing blocks: shadow ' +
      'enforcement, drift creates incidents instead of rewrites, MCP fails open. The ' +
      'posture for evaluating Intutic against live traffic before letting it act.',
    settings: {
      bypassEnforcementTier: 'alert-only',
      mcpProxyFailBehavior: 'open',
    },
    featureFlags: { ff_shadow_enforcement: true },
  },
] as const

/**
 * Cost postures: how aggressively the workspace pursues savings.
 *
 * Deliberately conservative about what "savings" may claim: routing quality is
 * guarded against malformed/truncated/unusable responses (the Response
 * Integrity signal), not against worse-but-well-formed ones — so the
 * aggressive posture is named for what it does, not "no quality loss".
 */
export const COST_POSTURES: readonly PosturePreset[] = [
  {
    name: 'savings',
    title: 'Max savings',
    description:
      'Bandit routing enforces its selections, and both response caches serve ' +
      'repeats without an upstream call. Routing learns from measured integrity ' +
      'and cost; it detects malformed and truncated responses, not subtly worse ones.',
    settings: {},
    featureFlags: {
      ff_bandit_routing: true,
      ff_shadow_routing: false,
      ff_response_cache_exact: true,
      ff_response_cache_semantic: true,
    },
  },
  {
    name: 'balanced',
    title: 'Balanced',
    description:
      'Routing runs in shadow — it reports what it would have picked and what that ' +
      'would have saved, while every request is served by the model you asked for. ' +
      'Exact-match caching on; semantic caching off.',
    settings: {},
    featureFlags: {
      ff_bandit_routing: false,
      ff_shadow_routing: true,
      ff_response_cache_exact: true,
      ff_response_cache_semantic: false,
    },
  },
  {
    name: 'quality-first',
    title: 'Quality first',
    description:
      'No routing, no semantic cache: every request is served by the requested ' +
      'model, fresh, with only byte-identical repeats served from cache.',
    settings: {},
    featureFlags: {
      ff_bandit_routing: false,
      ff_shadow_routing: false,
      ff_response_cache_exact: true,
      ff_response_cache_semantic: false,
    },
  },
] as const

export type PostureKind = 'security' | 'cost'

/** Look up a preset, or nothing — the route turns nothing into a 400. */
export function findPosture(kind: PostureKind, name: string): PosturePreset | undefined {
  const set = kind === 'security' ? SECURITY_POSTURES : COST_POSTURES
  return set.find((p) => p.name === name)
}

/**
 * One captured pre-image, as the gate writes it and the CLI reads it.
 *
 * Declared once and imported by both sides deliberately. The writer is an
 * emitted JS string in the sync daemon and the reader is a CLI command in a
 * different package — two hand-kept copies of a record format across a
 * package boundary is precisely how a manifest starts describing restores it
 * cannot perform.
 */
export interface PreImageEntry {
  id: string
  capturedAt: string
  tool: string
  /** Absolute, resolved, and inside the workspace root — the gate enforces all three. */
  target: string
  /** False when the flagged call CREATED the file: restoring it means deleting it. */
  existed: boolean
  bytes: number
  ruleId: string
  workspaceId: string
}
