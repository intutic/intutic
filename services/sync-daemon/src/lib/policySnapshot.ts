/**
 * policySnapshot.ts — ships workspace policy *to* the machine, so the gate does
 * not have to ship the decision off it.
 *
 * # Why
 *
 * TD-307: `POST /api/v1/hook-gate` was called by two of thirteen gates, so DLP,
 * `BLOCK:` SOPs, SSO policy and promoted findings reached two of thirteen. The
 * obvious repair — route the other eleven through the gate — is the wrong one:
 * those eleven enforce locally and **fail closed**, the two network callers were
 * the only ones that **fail open**, and the gate's allow path is five or six
 * sequential Postgres round-trips. Routing everyone through it would trade
 * fail-closed for fail-open and put a control-plane outage on every `Bash`.
 *
 * Almost none of that decision needs the network. So the daemon resolves policy
 * once per sync cycle and writes it here; every gate reads a local file.
 *
 * # Two tiers, one invariant
 *
 * The **static floor** (`staticFloorPatterns()`) is compiled into each gate and
 * always enforced. The **dynamic tier** is this file, and it is *additive only*:
 *
 * > For every harness and every snapshot state, the set of calls blocked after
 * > this change is a superset of the set blocked before.
 *
 * That is what makes the failure modes tractable. A missing or corrupt snapshot
 * costs only rules that, for eleven of the thirteen gates, did not exist at all
 * before — so degrading returns to yesterday's behaviour rather than opening a
 * new hole. It is also why an absent snapshot does **not** fail closed: that
 * would brick every agent on every machine at install time, to replace
 * protection the floor already provides.
 *
 * # Where it lives, and why that matters
 *
 * `~/.intutic/hooks/policy-snapshot.{json,rules}`. The directory is load-bearing:
 * `.intutic/hooks` is already in `UNIVERSAL_PROTECTED_PATHS`, so all thirteen
 * gates refuse an agent's attempt to write the snapshot on day one, with no new
 * entry and no new code.
 *
 * @module
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { createHash } from 'node:crypto'
import { createLogger } from '@intutic/logger'
import { toRulesLine, GATE_VERSION, RULES_COLUMNS } from '../harness/gateBody.js'
import {
  DESTRUCTIVE_COMMAND_PATTERNS,
  assertPortableEre,
  type GuardPattern,
} from '../harness/protectedPaths.js'

const log = createLogger('sync-policy-snapshot')

/** Directory every gate looks in. Inside `.intutic/hooks`, which is already
 *  protected — see the module note. */
export const DEFAULT_SNAPSHOT_DIR = path.join(os.homedir(), '.intutic', 'hooks')
export const SNAPSHOT_JSON = 'policy-snapshot.json'
export const SNAPSHOT_RULES = 'policy-snapshot.rules'

/**
 * Whether the destructive tier ships as `block` or as `warn`.
 *
 * `warn`. These seven patterns qualify for `block` on the merits — every one is
 * unrecoverable without a reinstall or a backup — but they have never run
 * against real developer traffic, and they would land on thirteen harnesses at
 * once. A false positive here does not merely annoy: the fastest workaround
 * available to a blocked developer is `chflags nouchg` on the hook, which is the
 * exact bypass `GOVERNANCE_BYPASS_PATTERNS` exists to stop. Shipping too hard
 * manufactures our own adversary.
 *
 * So they ride the advisory tier first and earn promotion from
 * `tool_flagged` telemetry — the same discipline `sslGateEvaluator.ts` follows
 * for SSL enforcement, and the same one `packages/proxy/src/plugins/anomaly`
 * states as the promotion rule. Flipping this constant is the promotion, and it
 * belongs in a commit alongside the measurement that licenses it.
 *
 * Shipping them *through the snapshot* rather than compiling them into the gate
 * is the other half: the set we are least sure about is the set we can retract
 * in one sync cycle instead of one release.
 */
export const DESTRUCTIVE_TIER_SEVERITY: 'block' | 'warn' = 'warn'

/** Rules the control plane resolved for this workspace. Mirrors the
 *  `GET /api/v1/policy/resolve` response. */
export interface ResolvedPolicy {
  workspaceId: string
  sopRules: Array<{ id: string; toolPattern: string; action: string; reason: string }>
  interventionMode: string
}

export interface PolicySnapshotOptions {
  controlPlaneUrl: string
  apiKey: string
  workspaceId: string
  /** Override the directory (tests). */
  snapshotDir?: string
}

/**
 * Tool names used to detect a rule that blocks everything.
 *
 * A pattern matching all of these is a catch-all whatever it looks like, so this
 * catches `.*`, `.+`, `[A-Za-z]*` and anything else someone reaches for — rather
 * than a denylist of the three spellings we happened to think of.
 */
const CANARY_TOOLS = [
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Task', 'WebFetch',
  'NotebookEdit', 'TodoWrite', 'run_command', 'str_replace_editor',
]

/**
 * Decides whether a control-plane rule is safe to put on a blocking path.
 *
 * Returns the reason for rejection, or `null` if the rule is fine. Rejections
 * are logged rather than thrown: one bad SOP must not cost the workspace every
 * other rule.
 */
export function validateRule(toolPattern: string, ruleId: string): string | null {
  const raw = (toolPattern ?? '').trim()
  if (!raw) return 'empty toolPattern'

  // Anchors are meaningless once wrapped for token matching, and are the most
  // common thing a SOP author writes out of habit.
  const stripped = raw.replace(/^\^+/, '').replace(/\$+$/, '')
  if (!stripped) return 'toolPattern was only anchors'

  const wrapped = ` (${stripped}) `
  try {
    assertPortableEre(wrapped, ruleId)
  } catch (err) {
    return `not portable across grep and JS — ${err instanceof Error ? err.message : String(err)}`
  }

  let re: RegExp
  try {
    re = new RegExp(wrapped)
  } catch {
    return 'does not compile'
  }

  // A threshold rather than "matches all of them". `[A-Za-z]*` matches ten of
  // these twelve — it misses only the two with an underscore — and shipping it
  // to a blocking path would stop essentially every tool call. Requiring a clean
  // sweep would have let it through on a technicality.
  const hits = CANARY_TOOLS.filter((t) => re.test(` ${t} `)).length
  const limit = Math.ceil(CANARY_TOOLS.length * 0.8)
  if (hits >= limit) {
    return (
      `matches ${hits} of ${CANARY_TOOLS.length} common tool names — this is a ` +
      `catch-all and would block the workspace`
    )
  }
  return null
}

/** Converts one resolved SOP rule into a gate pattern, or null if unusable. */
function toGuardPattern(
  rule: ResolvedPolicy['sopRules'][number],
  shadow: boolean,
): GuardPattern | null {
  // Only `block`. The control plane also emits `{toolPattern: '.*', action:
  // 'warn'}` for every HIGH/CRITICAL-risk SOP (evaluate.ts) — a live landmine
  // for anything that ships rules to a blocking path, and the reason this filter
  // is the first line rather than an afterthought.
  if (rule.action !== 'block') return null

  const why = validateRule(rule.toolPattern, rule.id)
  if (why) {
    log.warn(
      { action: 'policy_rule_rejected', ruleId: rule.id, toolPattern: rule.toolPattern, reason: why },
      `Policy rule rejected and NOT shipped to the gate: ${why}`,
    )
    return null
  }

  const stripped = rule.toolPattern.trim().replace(/^\^+/, '').replace(/\$+$/, '')
  return {
    id: `sop.${rule.id}`,
    // Wrapped in spaces so the pattern matches a whole tool token: the gate
    // tests against a space-padded string, so ` (Bash) ` matches the tool `Bash`
    // and not a tool called `BashHistory`.
    source: ` (${stripped}) `,
    subject: 'tool',
    // `shadow`, not `warn`. Both allow the call, but they mean different
    // things: `warn` is "this rule has not earned the right to block yet",
    // `shadow` is "this rule is certain and the workspace asked us not to act".
    // Collapsing them makes a SHADOW rollout unmeasurable, because you cannot
    // tell which flags would have been blocks.
    severity: shadow ? ('shadow' as GuardPattern['severity']) : 'block',
    reason: rule.reason || `Blocked by SOP ${rule.id}`,
    rationale: 'Resolved from a BLOCK: SOP title by the control plane.',
    matches: [],
    notMatches: [],
  }
}

/** Fetches resolved policy for the workspace. Returns null on any failure —
 *  the caller keeps the previous snapshot rather than replacing it with nothing. */
export async function fetchResolvedPolicy(
  opts: PolicySnapshotOptions,
): Promise<ResolvedPolicy | null> {
  const url =
    `${opts.controlPlaneUrl.replace(/\/+$/, '')}/api/v1/policy/resolve` +
    `?workspaceId=${encodeURIComponent(opts.workspaceId)}`
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${opts.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      log.warn({ action: 'policy_fetch_failed', status: res.status }, 'Policy resolve returned non-OK')
      return null
    }
    const body = (await res.json()) as unknown
    if (typeof body !== 'object' || body === null) return null
    const rec = body as Record<string, unknown>
    const rules = Array.isArray(rec.sopRules) ? rec.sopRules : []
    return {
      workspaceId: typeof rec.workspaceId === 'string' ? rec.workspaceId : opts.workspaceId,
      interventionMode: typeof rec.interventionMode === 'string' ? rec.interventionMode : 'TRANSPARENT',
      sopRules: rules.filter((r): r is ResolvedPolicy['sopRules'][number] => {
        if (typeof r !== 'object' || r === null) return false
        const x = r as Record<string, unknown>
        return typeof x.id === 'string' && typeof x.toolPattern === 'string' && typeof x.action === 'string'
      }),
    }
  } catch (err) {
    log.warn({ action: 'policy_fetch_failed', err }, 'Policy resolve unreachable')
    return null
  }
}

/** Builds the rule set a snapshot would carry, without writing it. Exported so
 *  a test can assert the contents rather than re-deriving them. */
export function buildSnapshotRules(policy: ResolvedPolicy): GuardPattern[] {
  // SHADOW means observe, do not intervene. It demotes the dynamic tier to the
  // advisory severity — it does NOT reach the static floor, which stays
  // enforced. If one settings string could disarm the floor, the floor would
  // not be a floor.
  const shadow = policy.interventionMode.toUpperCase() === 'SHADOW'

  const sopRules = policy.sopRules
    .map((r) => toGuardPattern(r, shadow))
    .filter((r): r is GuardPattern => r !== null)

  const destructive = DESTRUCTIVE_COMMAND_PATTERNS.map((p) => ({
    ...p,
    // A `warn` pattern stays `warn` regardless; only the `block` ones are held
    // back by the tier gate.
    severity:
      shadow
        ? ('shadow' as GuardPattern['severity'])
        : p.severity === 'block'
          ? DESTRUCTIVE_TIER_SEVERITY
          : ('warn' as const),
  }))

  return [...sopRules, ...destructive]
}

/**
 * Writes the snapshot atomically.
 *
 * Two artifacts from one source: the canonical JSON, and a tab-separated
 * `.rules` projection so the five bash gates need no JSON parser on the decision
 * path. Both carry the same digest, so a test — and the gate — can tell that the
 * projection really came from the JSON.
 */
export async function writePolicySnapshot(
  policy: ResolvedPolicy,
  snapshotDir: string = DEFAULT_SNAPSHOT_DIR,
): Promise<{ digest: string; ruleCount: number }> {
  const rules = buildSnapshotRules(policy)
  const lines = rules.map(toRulesLine)
  const digest = createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 32)
  // One timestamp shared by both artifacts. Two `new Date()` calls would put
  // different values in the JSON and the .rules, so a reader comparing them
  // would see drift that is not there.
  const generatedAt = new Date().toISOString()

  await fs.mkdir(snapshotDir, { recursive: true })

  const json = JSON.stringify(
    {
      _comment: 'Intutic policy snapshot — auto-generated. DO NOT EDIT.',
      version: 1,
      /**
       * Which emitted evaluator these rules were compiled for.
       *
       * The `.rules` column layout and the normalisation contract are part of
       * the gate body, not of this file, so a snapshot is only meaningful to a
       * gate of the same generation. Recording it here is what lets a support
       * conversation start from "which gate wrote this" instead of guessing —
       * and it is the reason `GATE_VERSION` exists at all rather than being a
       * constant nothing reads.
       */
      gateVersion: GATE_VERSION,
      workspaceId: policy.workspaceId,
      generatedAt,
      interventionMode: policy.interventionMode,
      digest,
      /**
       * The resolve response verbatim, alongside the gate projection below.
       *
       * These two are **not** interchangeable and the difference has teeth.
       * `rules` is a *gate artifact*: patterns rewritten into space-padded EREs,
       * `warn` and `require_approval` already discarded, ids prefixed `sop.`.
       * `sopRules` is what the control plane actually said — `{id, toolPattern,
       * action, reason}`, every action.
       *
       * Carrying both exists because the MCP proxy's policy cache consumes
       * `{toolPattern, action}` and its `isSopRule` guard drops anything else.
       * Feeding it `rules` would pass the outer parse and then silently yield
       * *zero* enforceable rules — a cache that reports entries and enforces
       * nothing, which is worse than the cold fetch it replaced. This field is
       * what makes seeding safe; see `seedFromSnapshot` in policyCache.ts.
       */
      sopRules: policy.sopRules,
      rules: rules.map((r) => ({
        id: r.id,
        source: r.source,
        subject: r.subject ?? 'any',
        severity: r.severity,
        ignoreCase: r.ignoreCase === true,
        reason: r.reason,
      })),
    },
    null,
    2,
  )

  // `#generated` is not decoration. Without it the five bash gates and the
  // Python one physically cannot compute the snapshot's age from the file they
  // read — only the JSON carries a timestamp, and they never open the JSON. A
  // snapshot from last year enforced identically to one written a second ago,
  // and nothing anywhere could say so.
  const rulesText =
    `# Intutic policy snapshot (projection of ${SNAPSHOT_JSON}) — DO NOT EDIT.\n` +
    `# Columns: ${RULES_COLUMNS.join('\t')}\n` +
    `#digest ${digest}\n` +
    `#workspace ${policy.workspaceId}\n` +
    `#generated ${generatedAt}\n` +
    lines.join('\n') +
    '\n'

  await writeAtomic(path.join(snapshotDir, SNAPSHOT_JSON), json)
  await writeAtomic(path.join(snapshotDir, SNAPSHOT_RULES), rulesText)

  log.debug(
    { action: 'policy_snapshot_written', digest, ruleCount: rules.length, dir: snapshotDir },
    'Policy snapshot refreshed',
  )
  return { digest, ruleCount: rules.length }
}

async function writeAtomic(target: string, content: string): Promise<void> {
  const tmp = target + '.tmp'
  await fs.writeFile(tmp, content, { encoding: 'utf-8' })
  // 0444: the daemon replaces this by rename, so it never needs write access to
  // the file itself, and a read-only file is one more small obstacle to an agent
  // editing it in place. The real protection is that every gate refuses to touch
  // `.intutic/hooks` at all.
  await fs.chmod(tmp, 0o444)
  await fs.rename(tmp, target)
}

/**
 * Fetch and write in one call. Safe to run on every sync cycle.
 *
 * Never throws: policy refresh must not be able to take down the sync loop. A
 * failed fetch leaves the previous snapshot in place, which is the correct
 * degradation — stale rules stay enforced. If they expired into permissiveness,
 * "kill the daemon and wait" would be a supported way to disarm governance.
 */
export async function refreshPolicySnapshot(
  opts: PolicySnapshotOptions,
): Promise<{ digest: string; ruleCount: number } | null> {
  const policy = await fetchResolvedPolicy(opts)
  if (!policy) return null
  try {
    return await writePolicySnapshot(policy, opts.snapshotDir ?? DEFAULT_SNAPSHOT_DIR)
  } catch (err) {
    log.warn({ action: 'policy_snapshot_write_failed', err }, 'Could not write policy snapshot')
    return null
  }
}
