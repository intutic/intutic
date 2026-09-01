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
 * # The ` WHERE ` clause survives this pipeline now
 *
 * A SOP titled `BLOCK:^shell$ WHERE kubectl\s+apply(?!.*@sha256:):reason`
 * resolves to `{toolPattern, argPattern}` at `GET /api/v1/policy/resolve`
 * (the demo doctor's "argPattern served" check proves that half). This module
 * used to be where the other half died: `ResolvedPolicy` did not declare
 * `argPattern`, `toGuardPattern` did not carry it, and the rule reached all
 * twelve tool-call gates as "block `shell` unconditionally" — simultaneously
 * failing to enforce the argument condition and re-manufacturing the exact
 * over-blocking (`make test` refused) the WHERE grammar was invented to
 * eliminate. It now travels: verbatim in the JSON's `sopRules` and `rules`,
 * base64-encoded in the `.rules` projection's seventh column (see
 * `RULES_COLUMNS` in gateBody.ts for the encoding contract), and every gate
 * family conditions a name-matched rule on it before firing.
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
  SKILL_SURFACE_PATTERNS,
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

/**
 * Whether the skill-directory-write tier ships as `block` or as `warn`.
 *
 * `block` — deliberately not following `DESTRUCTIVE_TIER_SEVERITY`'s warn-first
 * ramp, because the thing that ramp is buying time for does not exist on this
 * surface. `DESTRUCTIVE_COMMAND_PATTERNS` rides at `warn` because those seven
 * families are unmeasured against real developer traffic and a false positive
 * has a real cost (see that constant's own comment). `SKILL_SURFACE_PATTERNS`
 * is not that kind of rule: it does not run `scanSkillContent` or judge
 * anything about what a skill file says, only WHERE a write's target path
 * points — `.agents/skills/**` or `.claude/skills/**`, a deterministic,
 * zero-ambiguity match. TD-358 (`docs/TECH_DEBT.md`) says this about exactly
 * that distinction: "Path-matching is the one exception, and it is not
 * actually an exception to the measurement requirement — it never needed
 * one." There is no false-positive rate to earn a promotion by measuring,
 * because there is nothing probabilistic here to measure in the first place.
 *
 * The second half of the argument is what `warn` actually buys on this
 * surface, and the answer is nothing. `SECRET_CONTENT_PATTERNS`
 * (`harness/protectedPaths.ts`) skips the warn-first ramp for the same reason
 * and states the principle this constant now follows: "A warn that lets the
 * write proceed IS the incident." A poisoned skill file written under
 * warn-only is not a near-miss sitting in telemetry waiting for a human to
 * notice — it is a file on disk that the very next agent session loads and
 * trusts as instructions, the same way it trusts its own system prompt. Warn
 * logs the write and lets it land anyway, so there is no window in which the
 * advisory tier protected anything. That is what makes this different from
 * `DESTRUCTIVE_COMMAND_PATTERNS`: a destructive *command*'s warn tier buys a
 * chance for a human to notice before the damage is done; a skill file, once
 * written, already is the damage.
 *
 * Shipped *through the snapshot* rather than promoted in place in
 * `staticFloorPatterns()`, for the same operational reason
 * `DESTRUCTIVE_TIER_SEVERITY` is: the rollout, not the mechanism, is the thing
 * still short on field time, and the snapshot channel is what makes it
 * retractable in one sync cycle instead of one release if that turns out
 * wrong. `staticFloorPatterns()` keeps its two `SKILL_SURFACE_PATTERNS`
 * entries at `warn` — unchanged by this constant — as the degraded-mode
 * baseline for a workspace with no snapshot, or an invalid one; this constant
 * is what promotes the steady state to `block` everywhere a valid snapshot has
 * landed. Flipping it back to `'warn'` is the retraction, exactly as it is for
 * `DESTRUCTIVE_TIER_SEVERITY`.
 */
export const SKILL_SURFACE_TIER_SEVERITY: 'block' | 'warn' = 'block'

/** Rules the control plane resolved for this workspace. Mirrors the
 *  `GET /api/v1/policy/resolve` response — including `argPattern`, the
 *  ` WHERE ` clause of a SOP title. This type is where that field used to
 *  fall on the floor: resolve served it, the type did not declare it, and the
 *  gates enforced the rule as an unconditional tool-name block. */
export interface ResolvedPolicy {
  workspaceId: string
  sopRules: Array<{ id: string; toolPattern: string; argPattern?: string; action: string; reason: string }>
  interventionMode: string
  /**
   * Per-server MCP allowlist, absorbed verbatim from `allowedServers` on
   * `GET /api/v1/policy/resolve` (confirmed against `evaluate.ts` and
   * `lib/mcpCuration.ts` — both the daemon-mode and stdio-mode routes read
   * this same field name off `workspaces.settings`, so this is not a new
   * name invented for the snapshot). Absent/empty means unrestricted — the
   * MCP proxy already reads it that way (`packages/mcp-proxy/src/policy.ts`),
   * and the gate-side `#mcpservers` header this field feeds
   * (`writePolicySnapshot` below) preserves the same convention: an empty
   * list omits the header entirely rather than shipping a deny-everything one.
   */
  mcpAllowedServers: string[]
  /**
   * Wave 7 (audit-remediation): promotes `destructive.sql_drop` from `warn`
   * to `block` in `buildSnapshotRules` below — a per-rule override, not a
   * flip of `DESTRUCTIVE_TIER_SEVERITY`. Absent/wrongly-typed degrades to
   * `false` (stays `warn`), the same fail-safe direction every other field
   * here degrades in.
   */
  sqlDropStrictBlock: boolean
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
  // M3: two `mcp__<server>__<tool>`-shaped canaries, so a rule that is
  // scoped to one MCP server (e.g. `mcp__github__.*`) is exercised against
  // this same threshold check as every other tool-name pattern, and a rule
  // that reaches all the way into MCP-tool-shaped names (not just the
  // native tool names above) is still caught as a catch-all.
  'mcp__github__create_issue', 'mcp__filesystem__read_file',
]

/**
 * Strips a repeated character from one end of a string, in linear time.
 *
 * `s.replace(/\$+$/, '')` is the obvious spelling and it is quadratic. The
 * quantifier is greedy and the anchor is at the *end*, so on a string that does
 * not finish with the character, every start offset consumes the whole run and
 * then backtracks through it: measured on `'$'.repeat(n) + 'a'`, 20 KB took
 * 130 ms and 80 KB took 2 seconds. A string that *does* end with it matches at
 * the first offset and returns instantly, which is why the obvious test for
 * this passes — CodeQL flagged all three call sites as `js/polynomial-redos`.
 *
 * Two of them run over `toolPattern`, which arrives from the control plane and
 * is authored per workspace, on the path that decides whether a policy rule
 * ships to the blocking gate.
 */
function stripEnd(s: string, ch: string): string {
  let end = s.length
  while (end > 0 && s[end - 1] === ch) end -= 1
  return s.slice(0, end)
}

/** The same, from the front. Anchored at the start, so this one is linear. */
function stripStart(s: string, ch: string): string {
  let i = 0
  while (i < s.length && s[i] === ch) i += 1
  return s.slice(i)
}

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
  const stripped = stripEnd(stripStart(raw, '^'), '$')
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
  // these fourteen — it misses only the four with an underscore — and shipping
  // it to a blocking path would stop essentially every tool call. Requiring a
  // clean sweep would have let it through on a technicality.
  //
  // The ratio is 0.7, not 0.8, and that is a deliberate M3 adjustment, not a
  // drive-by tweak. Before M3, CANARY_TOOLS held 12 entries, 2 of them
  // underscored (`run_command`, `str_replace_editor`), so `[A-Za-z]*` hit 10 of
  // 12 (83%) — above an 0.8 threshold, correctly rejected. M3 added two more
  // *underscored* canaries (`mcp__github__create_issue`,
  // `mcp__filesystem__read_file`, both required by name — see CANARY_TOOLS)
  // without adding any non-underscored ones, so the same `[A-Za-z]*` pattern
  // now hits 10 of 14 (71%): still every alphabetic-only tool name there is,
  // but under an unchanged 0.8 threshold that stops being "a catch-all" and
  // starts being "accepted" — silently weakening a case
  // `harnessProtectedPaths`... `policySnapshot.test.ts` pins by name. Lowering
  // the ratio to 0.7 keeps the absolute hit-count threshold at 10 (`Math.ceil`
  // of both 12*0.8 and 14*0.7), so `[A-Za-z]*` is rejected exactly as before —
  // the ratio moved so the THRESHOLD would not.
  const hits = CANARY_TOOLS.filter((t) => re.test(` ${t} `)).length
  const limit = Math.ceil(CANARY_TOOLS.length * 0.7)
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

  // The ` WHERE ` clause travels with the rule. It is validated only for JS
  // compilability — it is a JS regex matched against serialized tool input,
  // never a grep pattern, so `validateRule`'s portable-ERE discipline does not
  // apply to it. One that does not compile is stripped (the rule ships
  // name-only, today's behaviour) and logged, NOT dropped with its rule: the
  // clause narrows a block, so losing the clause must widen enforcement, and
  // losing the rule would open it.
  let argPattern: string | undefined
  if (rule.argPattern) {
    try {
      new RegExp(rule.argPattern)
      argPattern = rule.argPattern
    } catch {
      log.warn(
        { action: 'policy_rule_arg_pattern_dropped', ruleId: rule.id, argPattern: rule.argPattern },
        'argPattern does not compile as a JS RegExp — rule shipped name-only',
      )
    }
  }

  const stripped = stripEnd(stripStart(rule.toolPattern.trim(), '^'), '$')
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
    // Collapsing them makes a SILENT_LOG rollout unmeasurable, because you
    // cannot tell which flags would have been blocks.
    severity: shadow ? ('shadow' as GuardPattern['severity']) : 'block',
    reason: rule.reason || `Blocked by SOP ${rule.id}`,
    rationale: 'Resolved from a BLOCK: SOP title by the control plane.',
    matches: [],
    notMatches: [],
    ...(argPattern ? { argPattern } : {}),
  }
}

/** Fetches resolved policy for the workspace. Returns null on any failure —
 *  the caller keeps the previous snapshot rather than replacing it with nothing. */
export async function fetchResolvedPolicy(
  opts: PolicySnapshotOptions,
): Promise<ResolvedPolicy | null> {
  const url =
    `${stripEnd(opts.controlPlaneUrl, '/')}/api/v1/policy/resolve` +
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
        return (
          typeof x.id === 'string' &&
          typeof x.toolPattern === 'string' &&
          typeof x.action === 'string' &&
          // Optional, but if present it must be a string — a non-string here
          // would flow into `new RegExp` and the base64 encoder downstream.
          (x.argPattern === undefined || typeof x.argPattern === 'string')
        )
      }),
      // `allowedServers` — the exact field name `evaluate.ts` and
      // `lib/mcpCuration.ts` both use. Absent or wrongly-typed degrades to
      // `[]`, same as `sopRules` above: unrestricted, not a fetch failure.
      mcpAllowedServers: Array.isArray(rec.allowedServers)
        ? rec.allowedServers.filter((s): s is string => typeof s === 'string')
        : [],
      sqlDropStrictBlock: rec.sqlDropStrictBlock === true,
    }
  } catch (err) {
    log.warn({ action: 'policy_fetch_failed', err }, 'Policy resolve unreachable')
    return null
  }
}

/**
 * SILENT_LOG means observe, do not intervene (docs/guides/policies.md: the
 * call is permitted to run, the trace is tagged for audit). It demotes the
 * dynamic tier to the advisory severity — it does NOT reach the static floor,
 * which stays enforced. If one settings string could disarm the floor, the
 * floor would not be a floor.
 *
 * This used to compare against 'SHADOW', a value intervention_mode_type
 * (TRANSPARENT|OPAQUE|SILENT_LOG — packages/db/src/enums.ts) can never
 * produce, so the observe-only branch was dead and a SILENT_LOG workspace
 * shipped fully-blocking snapshots.
 *
 * Extracted so `buildSnapshotRules` and `writePolicySnapshot`'s `#mcpservers`
 * header compute "is this workspace observe-only" the same way once, rather
 * than as two copies of the comparison that could drift.
 */
function isSilentLogMode(policy: ResolvedPolicy): boolean {
  return policy.interventionMode.toUpperCase() === 'SILENT_LOG'
}

/**
 * Drops MCP server names that would corrupt the comma-joined `#mcpservers`
 * `.rules` header line — a name carrying a comma would be misread as two
 * server names, and a tab or other whitespace would collide with the
 * `.rules` file's own column separator the moment anyone looked at the line
 * next to a rule row. Logged, not silently dropped: a server an operator
 * configured and then watched vanish from enforcement needs to know why,
 * the same discipline `validateRule` follows for a rejected SOP pattern.
 */
function sanitizeMcpServerNames(names: readonly string[]): string[] {
  const out: string[] = []
  // Defensive against a caller that built a ResolvedPolicy by hand without
  // TypeScript actually checking it — this repo's test files are outside
  // `tsconfig.json`'s `include`, so `tsc --noEmit` does not catch a test
  // constructing one with `mcpAllowedServers` omitted, and a JS consumer of
  // this exported function is not checked at all. `Array.isArray` costs
  // nothing on the real path, where `fetchResolvedPolicy` already guarantees
  // an array.
  if (!Array.isArray(names)) return out
  for (const raw of names) {
    if (typeof raw !== 'string') continue
    const name = raw.trim()
    if (!name) continue
    if (/[\s,]/.test(name)) {
      log.warn(
        { action: 'mcp_server_name_rejected', name: raw },
        'MCP server name contains whitespace or a comma — dropped rather than corrupting the .rules #mcpservers header',
      )
      continue
    }
    out.push(name)
  }
  return out
}

/** Builds the rule set a snapshot would carry, without writing it. Exported so
 *  a test can assert the contents rather than re-deriving them. */
export function buildSnapshotRules(policy: ResolvedPolicy): GuardPattern[] {
  // `shadow` names the advisory GuardPattern severity these rules are demoted
  // to; the workspace-level trigger is intervention mode SILENT_LOG.
  const shadow = isSilentLogMode(policy)

  const sopRules = policy.sopRules
    .map((r) => toGuardPattern(r, shadow))
    .filter((r): r is GuardPattern => r !== null)

  const destructive = DESTRUCTIVE_COMMAND_PATTERNS.map((p) => {
    // Wave 7 (audit-remediation): `destructive.sql_drop` is a per-rule
    // override, evaluated BEFORE the tier-wide ramp below — it was never
    // part of `DESTRUCTIVE_TIER_SEVERITY`'s promotion (its own static
    // `severity` is `'warn'`, not `'block'`, so that ternary never reaches
    // it), and this flag is opt-in per workspace, not evidence-gated the way
    // the six-pattern ramp is. Shadow mode still wins over both: SILENT_LOG
    // means observe-only across the whole dynamic tier, no exceptions.
    if (p.id === 'destructive.sql_drop' && !shadow && policy.sqlDropStrictBlock) {
      return { ...p, severity: 'block' as const }
    }
    return {
      ...p,
      // A `warn` pattern stays `warn` regardless; only the `block` ones are held
      // back by the tier gate.
      severity:
        shadow
          ? ('shadow' as GuardPattern['severity'])
          : p.severity === 'block'
            ? DESTRUCTIVE_TIER_SEVERITY
            : ('warn' as const),
    }
  })

  // The snapshot-delivered promotion of the skill-directory-write floor rules
  // to `block` — see SKILL_SURFACE_TIER_SEVERITY. `.tier` suffixed onto the
  // floor's own id (`skill_surface.agents_skills_write` ->
  // `skill_surface.agents_skills_write.tier`) so this entry can never collide
  // with `staticFloorPatterns()`'s compiled-in copy of the same pattern: both
  // are meant to be present and matching the same path at once, one warn (the
  // degraded-mode baseline) and one block (the steady state), and
  // `assertGuardTableSane`'s uniqueness check would reject an accidental
  // duplicate id the moment either table tried to load. Mirrors the
  // destructive tier's own shadow handling: SILENT_LOG means observe, don't
  // act, on the dynamic tier only — the floor's warn rule is unaffected
  // either way.
  const skillSurface = SKILL_SURFACE_PATTERNS.map((p) => ({
    ...p,
    id: `${p.id}.tier`,
    severity: shadow ? ('shadow' as GuardPattern['severity']) : SKILL_SURFACE_TIER_SEVERITY,
  }))

  return [...sopRules, ...destructive, ...skillSurface]
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

  // M3: the per-server MCP allowlist, sanitised once and reused for both
  // artifacts so the JSON and the `.rules` header can never disagree about
  // which names survived. Severity follows SILENT_LOG the same way the
  // dynamic tier's rules do: certain, just not acted on.
  //
  // Deliberately OUTSIDE `lines`/`digest` above — the digest covers RULE lines
  // only, matching the trust model the `#workspace` header already has (parsed
  // and integrity-checked by workspace-id comparison, not by the digest). A
  // `#mcpservers` header is the same kind of metadata line, not a rule, so it
  // must not change what `lines.join('\n')` hashes to.
  const mcpServers = sanitizeMcpServerNames(policy.mcpAllowedServers)
  const mcpSeverity: 'shadow' | 'block' = isSilentLogMode(policy) ? 'shadow' : 'block'

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
      // M3: sanitised, not `policy.mcpAllowedServers` verbatim — a name this
      // module rejected for the `.rules` header must not silently survive in
      // the JSON, or the two artifacts would disagree about what is enforced.
      // Empty means unrestricted, same convention as `allowedServers` at the
      // control plane (`readMcpCurationSettings`).
      mcpAllowedServers: mcpServers,
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
        // Plain text here; base64 only in the `.rules` projection, where a tab
        // separator forces the encoding. JSON needs no such armour.
        ...(r.argPattern ? { argPattern: r.argPattern } : {}),
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
  // `#mcpservers <severity> <comma-joined-server-names>` — OMITTED entirely
  // when the (sanitised) list is empty. This is the mandatory-mechanism/
  // opt-in-effect split M3 is built on: the header-parsing and per-call
  // allowlist check ship to every gate unconditionally, but they are a no-op
  // until a workspace actually configures `mcpAllowedServers` — and "no
  // header line" is how a v6 gate (and, for forward-compat, a hypothetical
  // v5-reading-a-v6-file) tells "unrestricted" apart from "restricted to
  // zero servers", which would otherwise block every MCP call by omission.
  const mcpHeader = mcpServers.length > 0 ? `#mcpservers ${mcpSeverity} ${mcpServers.join(',')}\n` : ''

  const rulesText =
    `# Intutic policy snapshot (projection of ${SNAPSHOT_JSON}) — DO NOT EDIT.\n` +
    `# Columns: ${RULES_COLUMNS.join('\t')}\n` +
    `#digest ${digest}\n` +
    `#workspace ${policy.workspaceId}\n` +
    `#generated ${generatedAt}\n` +
    mcpHeader +
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
