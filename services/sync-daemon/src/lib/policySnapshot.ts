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
import {
  encodeMcpAllowlistRecord,
  encodeMcpRegistryRecord,
  encodeSsoGroupRecord,
  evaluateSsoGroupClearance,
  isUnrestrictedMcpRegistry,
  parseMcpRegistryRecord,
  parseSsoGroupPolicy,
  type McpRegistryRecord,
  type SsoGroupPolicy,
} from '@intutic/shared-types'
import { toRulesLine, GATE_VERSION, RULES_COLUMNS } from '../harness/gateBody.js'
import {
  DESTRUCTIVE_COMMAND_PATTERNS,
  SKILL_CONTENT_PATTERNS,
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

/**
 * Whether the skill-CONTENT tier (`SKILL_CONTENT_PATTERNS`, `skill_content.*`)
 * ships as `block` or as `warn`.
 *
 * `block`, licensed by a measurement rather than by argument, unlike
 * `SKILL_SURFACE_TIER_SEVERITY` above. TD-358 held content enforcement at warn
 * until `scanSkillContent`'s false-positive rate on real benign skills had been
 * measured. It now has: 350 vendored SKILL.md files
 * (`packages/shared-types/src/__tests__/corpus/skills/`), and the nine patterns
 * in this tier fire on none of them. The tenth, `read-sensitive-path`, fired on
 * 11 and is not in the tier. Zero of 350 is a bound (about 0.86% at 95%), not
 * a proof, which is why this ships here, where flipping the constant to
 * `'warn'` retracts it in one sync cycle, and never in `staticFloorPatterns()`.
 *
 * The same argument `SKILL_SURFACE_TIER_SEVERITY` makes about what `warn`
 * buys holds here: a poisoned skill file written under warn is already on
 * disk for the next session to load and trust.
 */
export const SKILL_CONTENT_TIER_SEVERITY: 'block' | 'warn' = 'block'

/** Rules the control plane resolved for this workspace. Mirrors the
 *  `GET /api/v1/policy/resolve` response — including `argPattern`, the
 *  ` WHERE ` clause of a SOP title. This type is where that field used to
 *  fall on the floor: resolve served it, the type did not declare it, and the
 *  gates enforced the rule as an unconditional tool-name block. */
export interface ResolvedPolicy {
  workspaceId: string
  sopRules: Array<{
    id: string
    toolPattern: string
    argPattern?: string
    action: string
    reason: string
    /**
     * LLD #71: `'guardrail'` on rules the control plane projects from a cited
     * policy guardrail. The only origin for which `action: 'warn'` is shipped
     * (at severity `warn`, report-only); every other warn rule is still
     * dropped, the HIGH/CRITICAL catch-all included.
     */
    origin?: string
  }>
  interventionMode: string
  /**
   * Per-server MCP allowlist, absorbed verbatim from `allowedServers` on
   * `GET /api/v1/policy/resolve` (confirmed against `evaluate.ts` and
   * `lib/mcpCuration.ts` — both the daemon-mode and stdio-mode routes read
   * this same field name off `workspaces.settings`, so this is not a new
   * name invented for the snapshot). Absent/empty means unrestricted — the
   * MCP proxy already reads it that way (`packages/mcp-proxy/src/policy.ts`),
   * and the gate-side `@mcp_allowlist` record this field feeds
   * (`writePolicySnapshot` below) preserves the same convention: an empty
   * list writes no record rather than a deny-everything one.
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
  /**
   * The workspace's `sso_group_policy`, as `GET /api/v1/policy/resolve`
   * serves it (`ssoGroupPolicy`). Absent or null: the workspace has none, and
   * the snapshot is byte-identical to one written before group rules existed.
   */
  ssoGroupPolicy?: SsoGroupPolicy | null
  /**
   * The member the daemon's API key resolves to, with their SSO groups as the
   * control plane read them for this response (`principal`). Null when the
   * control plane named no member, which every gate reads as "groups unknown".
   */
  principal?: { memberId: string; ssoGroups: string[] } | null
  /**
   * The workspace's MCP server registry decisions (`mcpRegistry`): blocked,
   * held and approved servers, disabled tools and `mcpDefaultPolicy`. Written
   * as an `@mcp_registry` record so the hook gates apply them to every
   * `mcp__<server>__<tool>` call, not only the calls an MCP proxy fronts.
   * Absent or null: an older control plane, and no record is written.
   */
  mcpRegistry?: McpRegistryRecord | null
}

export interface PolicySnapshotOptions {
  controlPlaneUrl: string
  apiKey: string
  workspaceId: string
  /** Override the directory (tests). */
  snapshotDir?: string
  /**
   * `review_before:` tokens from the workspace's local SOPs and settings
   * (`parseSopConstraints(...).reviewBefore`). Each becomes a `hold` rule,
   * `sop.local.review_before.<token>`, so every gate holds on them — not only
   * the Claude Code hook that used to bake them in (TD-474 item 4).
   */
  localHoldTokens?: readonly string[]
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
  //
  // One exception (LLD #71): a rule the control plane projects from a cited
  // policy guardrail in SHADOW carries `origin: 'guardrail'` and `action:
  // 'warn'`. It ships at severity `warn` — the gate logs `tool_flagged` and
  // allows — so the rule can earn its evidence. That is the documented meaning
  // of `warn` ("has not earned the right to block yet"), and it is still
  // additive: a warn rule blocks nothing. `validateRule` below still applies,
  // so a catch-all guardrail is refused the same way.
  //
  // And `require_approval` (a `REQUIRE_APPROVAL:` SOP title): shipped at
  // severity `hold` since gate body v8. Refuses like block, records the call
  // for review, and an approved bypass lets the exact call through once.
  const guardrail = rule.origin === 'guardrail'
  const hold = rule.action === 'require_approval'
  if (rule.action !== 'block' && !hold && !(guardrail && rule.action === 'warn')) return null

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
    // cannot tell which flags would have been blocks. A guardrail in SHADOW
    // is the one rule that ships as `warn` on purpose (see above); under
    // SILENT_LOG it demotes to `shadow` with everything else.
    severity: shadow
      ? ('shadow' as GuardPattern['severity'])
      : hold
        ? ('hold' as GuardPattern['severity'])
        : rule.action === 'warn'
          ? ('warn' as GuardPattern['severity'])
          : 'block',
    reason: hold
      ? `Held for human review: ${rule.reason || `SOP ${rule.id}`}`
      : rule.reason || `Blocked by SOP ${rule.id}`,
    rationale: guardrail
      ? 'Projected from a cited policy guardrail by the control plane (LLD #71).'
      : hold
        ? 'Resolved from a REQUIRE_APPROVAL: SOP title by the control plane.'
        : 'Resolved from a BLOCK: SOP title by the control plane.',
    matches: [],
    notMatches: [],
    ...(argPattern ? { argPattern } : {}),
  }
}

/** The `principal` of a resolve response, or null when it names no member. */
function parsePrincipal(value: unknown): ResolvedPolicy['principal'] {
  if (typeof value !== 'object' || value === null) return null
  const p = value as Record<string, unknown>
  if (typeof p.memberId !== 'string' || !p.memberId) return null
  return {
    memberId: p.memberId,
    ssoGroups: Array.isArray(p.ssoGroups) ? p.ssoGroups.filter((g): g is string => typeof g === 'string') : [],
  }
}

/** Fetches resolved policy for the workspace. Returns null on any failure —
 *  the caller keeps the previous snapshot rather than replacing it with nothing. */
export async function fetchResolvedPolicy(
  opts: PolicySnapshotOptions,
): Promise<ResolvedPolicy | null> {
  const result = await requestResolvedPolicy(opts)
  return result === 'refused' ? null : result
}

/** As {@link fetchResolvedPolicy}, but says when the control plane refused the key (401/403). */
async function requestResolvedPolicy(
  opts: PolicySnapshotOptions,
): Promise<ResolvedPolicy | 'refused' | null> {
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
      return res.status === 401 || res.status === 403 ? 'refused' : null
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
      // Parsed by the server's own parser, so the snapshot compiles exactly
      // the policy `resolveSsoGroupPrivilege` enforces.
      ssoGroupPolicy: parseSsoGroupPolicy(rec.ssoGroupPolicy),
      principal: parsePrincipal(rec.principal),
      mcpRegistry: parseMcpRegistryRecord(rec.mcpRegistry),
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
 * Extracted so `buildSnapshotRules` and `writePolicySnapshot`'s `@mcp_allowlist`
 * record compute "is this workspace observe-only" the same way once, rather
 * than as two copies of the comparison that could drift.
 */
function isSilentLogMode(policy: ResolvedPolicy): boolean {
  return policy.interventionMode.toUpperCase() === 'SILENT_LOG'
}

/**
 * Drops MCP server names that would corrupt the comma-joined `@mcp_allowlist`
 * `.rules` line — a name carrying a comma would be misread as two server
 * names, and a tab or other whitespace would collide with the `.rules`
 * file's own column separator. Logged, not silently dropped: a server an operator
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
        'MCP server name contains whitespace or a comma — dropped rather than corrupting the .rules @mcp_allowlist record',
      )
      continue
    }
    out.push(name)
  }
  return out
}

/** Builds the rule set a snapshot would carry, without writing it. Exported so
 *  a test can assert the contents rather than re-deriving them. */
export function buildSnapshotRules(policy: ResolvedPolicy, localHoldTokens: readonly string[] = []): GuardPattern[] {
  // `shadow` names the advisory GuardPattern severity these rules are demoted
  // to; the workspace-level trigger is intervention mode SILENT_LOG.
  const shadow = isSilentLogMode(policy)

  const sopRules = policy.sopRules
    .map((r) => toGuardPattern(r, shadow))
    .filter((r): r is GuardPattern => r !== null)

  const localHolds = [...new Set(localHoldTokens.map((t) => t.trim()).filter(Boolean))]
    .map((t) => localHoldPattern(t, shadow))
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

  // Skill-CONTENT tier (TD-358): a skill-directory write whose written text
  // matches a pattern measured at zero benign-corpus false positives. No
  // floor copy exists, so no `.tier` suffix is needed; SILENT_LOG demotes it
  // to shadow like every other dynamic-tier rule.
  const skillContent = SKILL_CONTENT_PATTERNS.map((p) => ({
    ...p,
    severity: shadow ? ('shadow' as GuardPattern['severity']) : SKILL_CONTENT_TIER_SEVERITY,
  }))

  // SSO-group refusals first. Every gate stops at the first rule that refuses,
  // and a `hold` rule earlier in the list could otherwise let an approved
  // bypass through a call the group policy refuses outright.
  return [...ssoGroupPatterns(policy), ...sopRules, ...localHolds, ...destructive, ...skillSurface, ...skillContent]
}

/**
 * The workspace's SSO-group policy, decided for the member this snapshot is
 * issued to and compiled into one `block` rule per tool they may not call.
 *
 * The decision is `evaluateSsoGroupClearance` — the function the hook gate's
 * `resolveSsoGroupPrivilege` and the MCP proxy run — so a harness gate refuses
 * exactly what the server refuses, without any gate carrying an evaluator of
 * its own. A tool the member is cleared for gets no rule. With no member named
 * the groups are unknown, and every high-risk tool is refused.
 *
 * Not demoted under SILENT_LOG, unlike the rest of the dynamic tier: the hook
 * gate and the MCP proxy refuse these calls in every intervention mode, and a
 * local gate that only observed them would be the one place the policy did
 * not hold.
 */
function ssoGroupPatterns(policy: ResolvedPolicy): GuardPattern[] {
  const groupPolicy = policy.ssoGroupPolicy
  if (!groupPolicy) return []
  const groups = policy.principal ? policy.principal.ssoGroups : null
  const out: GuardPattern[] = []
  // The gates stop at the first rule that refuses, and the evaluator prefers
  // an entry naming the call exactly: so within each list, the entries that
  // already name the harness form (`mcp__…`) go before the ones that name an
  // MCP tool by its own name and also match it on any server.
  const harnessFormFirst = (list: readonly string[]) => [
    ...list.filter((t) => t.startsWith('mcp__')),
    ...list.filter((t) => !t.startsWith('mcp__')),
  ]
  const entries = new Set([...harnessFormFirst(groupPolicy.requireOboFor), ...harnessFormFirst(groupPolicy.highRiskTools)])
  const compiled = new Set<string>()
  for (const tool of entries) {
    const decision = evaluateSsoGroupClearance(groupPolicy, tool, groups)
    if (decision.clearance === 'GRANTED' || !decision.ruleId) continue
    // An entry another entry already refuses (`mcp__pg__x` beside an
    // on-behalf-of `x`) decides to that entry's rule, which already matches it.
    if (compiled.has(decision.ruleId)) continue
    compiled.add(decision.ruleId)
    // The gates match a whitespace-collapsed, space-padded tool name, so the
    // name is collapsed the same way and escaped to a literal. An entry that
    // is an MCP tool's own name also matches the name a harness gives that
    // tool on any server, `mcp__<server>__<tool>` (ssoGroupToolMatches).
    const name = tool.replace(/\s+/g, ' ').trim()
    if (!name) continue
    const literal = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const source = name.startsWith('mcp__') ? ` (${literal}) ` : ` (${literal}|mcp__.+__${literal}) `
    try {
      assertPortableEre(source, decision.ruleId)
    } catch (err) {
      log.warn(
        { action: 'sso_group_rule_rejected', ruleId: decision.ruleId, tool, err: err instanceof Error ? err.message : String(err) },
        'SSO group policy names a tool the gates cannot match — not compiled into the snapshot',
      )
      continue
    }
    out.push({
      id: decision.ruleId,
      source,
      subject: 'tool',
      severity: 'block',
      reason: decision.reason,
      rationale:
        "Compiled from the workspace's sso_group_policy for the member the snapshot was issued to, " +
        'by the evaluator the control plane hook gate uses.',
      matches: [],
      notMatches: [],
    })
  }
  return out
}

/**
 * A local `review_before:` token as a hold rule. `action:*` tokens match the
 * gate's action subject (the tokens it classifies a shell command to);
 * anything else is a tool name. Case-insensitive, as the bespoke Claude Code
 * hold was. A token that is not a plain identifier is refused with a log line
 * rather than escaped into a regex nobody can read back.
 */
function localHoldPattern(token: string, shadow: boolean): GuardPattern | null {
  if (!/^[A-Za-z0-9_:.-]+$/.test(token)) {
    log.warn({ action: 'local_hold_token_rejected', token }, 'review_before token is not a plain identifier — not shipped to the gate')
    return null
  }
  // The identifier check above already excludes every metacharacter; the
  // full escape is still applied so the pattern is safe by construction and
  // not by the guard three lines up.
  const source = ` (${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}) `
  return {
    id: `sop.local.review_before.${token}`,
    source,
    subject: token.startsWith('action:') ? 'action' : 'tool',
    ignoreCase: true,
    severity: shadow ? 'shadow' : 'hold',
    reason: `Held for human review: ${token} — declared in review_before:`,
    rationale: 'A local SOP or the workspace settings asked to see this action before it runs.',
    matches: [],
    notMatches: [],
  }
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
  localHoldTokens: readonly string[] = [],
): Promise<{ digest: string; ruleCount: number }> {
  const rules = buildSnapshotRules(policy, localHoldTokens)
  // One timestamp shared by both artifacts. Two `new Date()` calls would put
  // different values in the JSON and the .rules, so a reader comparing them
  // would see drift that is not there.
  const generatedAt = new Date().toISOString()
  // The SSO-group record — the policy and the member's groups the rules above
  // were compiled from — rides as the first data line, so the digest every
  // gate already recomputes covers it: an edited group list fails the check.
  const ssoGroups = policy.ssoGroupPolicy
    ? {
        policy: policy.ssoGroupPolicy,
        member: policy.principal ? { memberId: policy.principal.memberId, ssoGroups: policy.principal.ssoGroups } : null,
        issuedAt: generatedAt,
      }
    : null
  // The MCP registry record rides the same way, so an edited registry fails
  // the digest too. A registry that refuses nothing writes no line, which
  // keeps the snapshot of a workspace that never used the registry unchanged.
  const mcpRegistry = policy.mcpRegistry && !isUnrestrictedMcpRegistry(policy.mcpRegistry) ? policy.mcpRegistry : null
  // And the per-server MCP allowlist, sanitised once and reused for both
  // artifacts so the JSON and the `.rules` record can never disagree about
  // which names survived. Inside the digest, so a server added to it by hand
  // fails the check. Severity follows SILENT_LOG the same way the dynamic
  // tier's rules do: certain, just not acted on. An empty list writes no
  // record: no record is "unrestricted", where a record with no servers
  // would admit none.
  const mcpServers = sanitizeMcpServerNames(policy.mcpAllowedServers)
  const mcpSeverity: 'shadow' | 'block' = isSilentLogMode(policy) ? 'shadow' : 'block'
  const lines = [
    ...(ssoGroups ? [encodeSsoGroupRecord(ssoGroups)] : []),
    ...(mcpRegistry ? [encodeMcpRegistryRecord(mcpRegistry)] : []),
    ...(mcpServers.length > 0 ? [encodeMcpAllowlistRecord({ severity: mcpSeverity, servers: mcpServers })] : []),
    ...rules.map(toRulesLine),
  ]
  const digest = createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 32)

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
      // Sanitised, not `policy.mcpAllowedServers` verbatim — a name this
      // module rejected for the `.rules` record must not silently survive in
      // the JSON, or the two artifacts would disagree about what is enforced.
      // Empty means unrestricted, same convention as `allowedServers` at the
      // control plane (`readMcpCurationSettings`).
      mcpAllowedServers: mcpServers,
      // The same record as the `.rules` file's `@sso_groups` line, readable.
      ...(ssoGroups ? { ssoGroups } : {}),
      // The same record as the `.rules` file's `@mcp_registry` line.
      ...(mcpRegistry ? { mcpRegistry } : {}),
      // With `sopRules`, `interventionMode`, `mcpAllowedServers` and
      // `mcpRegistry`, enough to rebuild this snapshot without the control
      // plane (`forgetSnapshotMember`).
      sqlDropStrictBlock: policy.sqlDropStrictBlock,
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
 * The one thing a failed fetch does change: when the control plane refuses
 * the key itself, the member's SSO groups are forgotten (`forgetSnapshotMember`).
 */
export async function refreshPolicySnapshot(
  opts: PolicySnapshotOptions,
): Promise<{ digest: string; ruleCount: number } | null> {
  const dir = opts.snapshotDir ?? DEFAULT_SNAPSHOT_DIR
  const result = await requestResolvedPolicy(opts)
  if (result === 'refused') {
    await forgetSnapshotMember(dir, opts.localHoldTokens ?? [])
    return null
  }
  if (!result) return null
  try {
    return await writePolicySnapshot(result, dir, opts.localHoldTokens ?? [])
  } catch (err) {
    log.warn({ action: 'policy_snapshot_write_failed', err }, 'Could not write policy snapshot')
    return null
  }
}

/**
 * The control plane refused this machine's key — revoked, its member
 * deactivated or offboarded, or past the workspace's SSO idle window. Every
 * other rule in the snapshot stays as it is (see above), but the member's SSO
 * groups were vouched for by that key, and keeping them would let a removed
 * member keep every high-risk tool their groups cleared for as long as the
 * machine stays offline from a working key. So the snapshot is rewritten from
 * its own JSON with the member unknown, which refuses every high-risk tool.
 *
 * A snapshot with no group policy, or no member already, is left untouched.
 * Never throws.
 */
async function forgetSnapshotMember(dir: string, localHoldTokens: readonly string[]): Promise<void> {
  try {
    const doc = JSON.parse(await fs.readFile(path.join(dir, SNAPSHOT_JSON), 'utf-8')) as Record<string, unknown>
    const record = doc.ssoGroups as { policy?: unknown; member?: unknown } | undefined
    const ssoGroupPolicy = parseSsoGroupPolicy(record?.policy)
    if (!ssoGroupPolicy || !record?.member || typeof doc.workspaceId !== 'string') return
    await writePolicySnapshot(
      {
        workspaceId: doc.workspaceId,
        interventionMode: typeof doc.interventionMode === 'string' ? doc.interventionMode : 'TRANSPARENT',
        sopRules: Array.isArray(doc.sopRules) ? (doc.sopRules as ResolvedPolicy['sopRules']) : [],
        mcpAllowedServers: Array.isArray(doc.mcpAllowedServers)
          ? doc.mcpAllowedServers.filter((s): s is string => typeof s === 'string')
          : [],
        sqlDropStrictBlock: doc.sqlDropStrictBlock === true,
        ssoGroupPolicy,
        principal: null,
        mcpRegistry: parseMcpRegistryRecord(doc.mcpRegistry),
      },
      dir,
      localHoldTokens,
    )
    log.warn(
      { action: 'policy_snapshot_member_forgotten', workspaceId: doc.workspaceId },
      "The control plane refused this machine's key; the snapshot now treats the member's SSO groups as unknown",
    )
  } catch (err) {
    log.debug({ action: 'policy_snapshot_member_forget_skipped', err }, 'No snapshot member to forget')
  }
}
