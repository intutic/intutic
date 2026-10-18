/**
 * policySnapshot.ts — ships workspace policy *to* the machine, so the gate does
 * not have to ship the decision off it.
 *
 * # Why
 *
 * `POST /api/v1/hook-gate` was called by two of thirteen gates, so DLP,
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
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { createHash } from 'node:crypto'
import { createLogger } from '@intutic/logger'
import type { DecidePin, DecideRecord, DecideStamp, PolicyResolveResponse, SyncSopEntry, WireFields } from '@intutic/shared-types'
import {
  DECIDE_FALLBACK_PREFIX,
  DECIDE_SOP_TITLE_MAX_CHARS,
  TOOL_TOKEN_RE,
  decideFallbackId,
  decideFallbackReason,
  decideRuleHash,
  decideRuleRef,
  decideRuleText,
  encodeDecideRecord,
  encodeSnapshotFormatRecord,
  parseDecideLine,
  parseDecideLines,
  parseDecidePin,
  scrubReason,
  splitFrontMatter,
  parseFrontMatterEnforcing,
  encodeInterventionModeRecord,
  encodeMcpAllowlistRecord,
  isOpaqueInterventionMode,
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
import { writeFileAtomic } from './atomicWrite.js'
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
 * The subdirectory of the snapshot directory holding the last snapshot the
 * daemon wrote and so verified: both artifacts, byte for byte, read-only.
 * Inside `.intutic/hooks`, which every gate refuses to touch. The settings
 * guard compares the live snapshot with it and restores it when they differ
 * ({@link restoreVerifiedSnapshot}), the way a policy agent keeps its last
 * verified bundle active when a new one fails verification.
 */
export const VERIFIED_SNAPSHOT_DIR = 'verified'

/**
 * Whether a `.rules` text verifies: it carries a `#digest` line, and the
 * digest of its data lines matches it — the check every gate makes. A
 * missing digest fails, since the writer always writes one.
 */
export function snapshotRulesVerify(text: string): boolean {
  const lines = text.split('\n')
  const header = lines.find((l) => l.startsWith('#digest '))
  if (!header) return false
  const body = lines.filter((l) => l && !l.startsWith('#')).join('\n')
  return createHash('sha256').update(body).digest('hex').slice(0, 32) === header.slice(8).trim()
}

/**
 * Whether the destructive tier ships as `block` or as `warn`.
 *
 * `warn`. These eight patterns qualify for `block` on the merits — every one is
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
 * surface. `DESTRUCTIVE_COMMAND_PATTERNS` rides at `warn` because those eight
 * families are unmeasured against real developer traffic and a false positive
 * has a real cost (see that constant's own comment). `SKILL_SURFACE_PATTERNS`
 * is not that kind of rule: it does not run `scanSkillContent` or judge
 * anything about what a skill file says, only WHERE a write's target path
 * points — `.agents/skills/**` or `.claude/skills/**`, a deterministic,
 * zero-ambiguity match. Path-matching is the one exception, and it is not
 * actually an exception to the measurement requirement — it never needed
 * one. There is no false-positive rate to earn a promotion by measuring,
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
 * `SKILL_SURFACE_TIER_SEVERITY` above. Content enforcement was held at warn
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
     * `'guardrail'` on rules the control plane projects from a cited
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
  /**
   * The workspace's decide rules (`decideRules`), or the local SOPs' when no
   * control plane is connected ({@link localDecideRules}). Each is written as
   * an `@decide` record, and one stamped `enforce` also as a fallback line
   * that every older gate enforces. Absent or empty: no decide line is
   * written, and the snapshot is byte-identical to a format 1 one.
   */
  decideRules?: ServedDecideRule[]
}

/**
 * One `decide:` line, as `GET /api/v1/policy/resolve` serves it or as
 * {@link localDecideRules} reads it from a local SOP. The writer validates it
 * itself: a line it cannot read still refuses what it names.
 */
export interface ServedDecideRule {
  /** The control plane's SOP id, or `local:<file>` / `local:<folder>:<file>`. */
  sopId: string
  /** The SOP's title, as the record and the fallback line's reason name it. */
  sopTitle: string
  /** The SOP's body; the record carries its first 4,096 bytes. */
  ruleText: string
  /** The line's JSON value, or a local line's text after `decide:`. */
  ir: unknown
  /**
   * The policy source's stamp: `shadow` under the server's kill switch, for a
   * SHADOW guardrail, or for an SOP whose front matter says `mode: shadow`
   * (the server's resolve and {@link localDecideRules} alike). Absent otherwise.
   */
  rollout?: 'shadow' | 'enforce'
  /** The hash the server computed. When it is not this writer's, the pins were earned by another rule and are dropped. */
  ruleHash?: string
  /** The calibrations the rule may enforce under. */
  pins: DecidePin[]
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
   * the Claude Code hook that used to bake them in.
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
  // One exception: a rule the control plane projects from a cited
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
      ? 'Projected from a cited policy guardrail by the control plane.'
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
  const p = value as WireFields<NonNullable<PolicyResolveResponse['principal']>>
  if (typeof p.memberId !== 'string' || !p.memberId) return null
  return {
    memberId: p.memberId,
    ssoGroups: Array.isArray(p.ssoGroups) ? p.ssoGroups.filter((g): g is string => typeof g === 'string') : [],
  }
}

/**
 * The `decideRules` of a resolve response, or of a snapshot's JSON. Every
 * object is kept, with its wrongly-typed fields defaulted: a rule dropped
 * here would be a rule no gate refuses for. Invalid pins are dropped, which
 * can only stamp a rule shadow.
 */
function parseServedDecideRules(value: unknown): ServedDecideRule[] {
  if (!Array.isArray(value)) return []
  const text = (v: unknown) => (typeof v === 'string' ? v : '')
  return value
    .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null && !Array.isArray(r))
    .map((r) => ({
      sopId: text(r.sopId),
      sopTitle: text(r.sopTitle),
      ruleText: text(r.ruleText),
      ir: r.ir,
      ...(r.rollout === 'shadow' || r.rollout === 'enforce' ? { rollout: r.rollout } : {}),
      ...(typeof r.ruleHash === 'string' ? { ruleHash: r.ruleHash } : {}),
      pins: Array.isArray(r.pins) ? r.pins.filter((p): p is DecidePin => parseDecidePin(p) !== null) : [],
    }))
}

/** What the snapshot carries for its decide rules: one record per readable tool-call rule, and the fallback lines. */
interface CompiledDecideRules {
  records: DecideRecord[]
  fallbacks: GuardPattern[]
}

const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

function jsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

/** A reason, scrubbed for the `.rules` projection and at most `max` characters. */
function boundedText(text: string, max: number): string {
  return Array.from(scrubReason(text)).slice(0, max).join('')
}

/** A fallback line refusing `tools`, or every tool when none could be read. */
function decideFallbackPattern(id: string, tools: readonly string[], severity: 'block' | 'shadow', reason: string): GuardPattern {
  const names = [...new Set(tools)].sort().map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const source = names.length > 0 ? ` (${names.join('|')}) ` : ' [^ ]+ '
  assertPortableEre(source, id)
  return {
    id,
    source,
    subject: 'tool',
    severity: severity as GuardPattern['severity'],
    reason: boundedText(reason, 300),
    rationale: 'A decide rule a gate that cannot evaluate it refuses: it covers these tools.',
    matches: [],
    notMatches: [],
  }
}

/**
 * Why a readable rule is stamped as it is: its own
 * rollout, then `intutic decide disable` on this machine, then the policy
 * source's shadow stamp (the server's kill switch, a SHADOW guardrail, or an
 * SOP in `mode: shadow`), then SILENT_LOG, then pins. Only a
 * rule that clears all of them is stamped `enforce`.
 */
function stampDecideRule(
  rollout: 'shadow' | 'enforce' | undefined,
  served: ServedDecideRule['rollout'],
  silentLog: boolean,
  pins: readonly DecidePin[],
  localDisable: boolean,
): { rollout: 'shadow' | 'enforce'; stampedBy: DecideStamp } {
  if (rollout !== 'enforce') return { rollout: 'shadow', stampedBy: 'rule' }
  if (localDisable) return { rollout: 'shadow', stampedBy: 'local-disable' }
  if (served === 'shadow') return { rollout: 'shadow', stampedBy: 'server-shadow' }
  if (silentLog) return { rollout: 'shadow', stampedBy: 'silent-log' }
  if (pins.length === 0) return { rollout: 'shadow', stampedBy: 'no-pins' }
  return { rollout: 'enforce', stampedBy: 'rule' }
}

/**
 * Compiles the policy's decide rules, in order. A readable `on: tool_call`
 * rule becomes a record, and a fallback line when it is stamped `enforce`;
 * an `on: response` rule is the gateway's and is not written. A line that
 * does not read (or reuses an earlier line's id in its SOP) gets a fallback
 * line and no record, so every gate refuses the tools it names, or every
 * tool when it names none it can read; `unreadable.<n>` (its place among the
 * SOP's decide lines) keeps that id apart from any rule's.
 */
function compileDecideRules(policy: ResolvedPolicy): CompiledDecideRules {
  const served = policy.decideRules ?? []
  const silentLog = isSilentLogMode(policy)
  const localDisable = served.length > 0 && decideLocallyDisabled()
  // Each SOP's lines parsed together, so an id used twice is caught as the
  // proxy catches it.
  const bySop = new Map<string, number[]>()
  served.forEach((r, i) => bySop.set(r.sopId, [...(bySop.get(r.sopId) ?? []), i]))
  const decls = new Map<number, { decl: ReturnType<typeof parseDecideLine>; line: number }>()
  for (const indices of bySop.values()) {
    const parsed = parseDecideLines(indices.map((i) => {
      const ir = served[i]!.ir
      return typeof ir === 'string' ? ir : (JSON.stringify(ir) ?? '')
    }))
    indices.forEach((i, k) => decls.set(i, { decl: parsed[k]!, line: k + 1 }))
  }

  const out: CompiledDecideRules = { records: [], fallbacks: [] }
  served.forEach((r, i) => {
    const { decl, line } = decls.get(i)!
    const sopTitle = boundedText(r.sopTitle, DECIDE_SOP_TITLE_MAX_CHARS)
    if (decl.kind === 'unreadable') {
      log.warn(
        { action: 'decide_rule_unreadable', sopId: r.sopId, ruleId: decl.id, error: decl.error },
        'A decide rule does not read; the snapshot refuses the tools it names until it is fixed',
      )
      const raw = typeof r.ir === 'string' ? jsonOrNull(r.ir) : r.ir
      const named = raw !== null && typeof raw === 'object' && Array.isArray((raw as { tools?: unknown }).tools) ? (raw as { tools: unknown[] }).tools : []
      const tools = named.filter((t): t is string => typeof t === 'string' && TOOL_TOKEN_RE.test(t))
      out.fallbacks.push(
        decideFallbackPattern(
          `${DECIDE_FALLBACK_PREFIX}unreadable.${line}@${sha256Hex(r.sopId).slice(0, 12)}`,
          tools,
          silentLog ? 'shadow' : 'block',
          `Decide rule ${decl.id ?? `on decide line ${line}`} (${sopTitle}) does not read, so the calls it covers are refused: ${decl.error}`,
        ),
      )
      return
    }
    const rule = decl.rule
    if (rule.on !== 'tool_call') return
    const ruleHash = decideRuleHash(rule, sha256Hex)
    const pins = r.ruleHash !== undefined && r.ruleHash !== ruleHash ? [] : r.pins
    const stamp = stampDecideRule(rule.rollout, r.rollout, silentLog, pins, localDisable)
    const fallbackId = stamp.rollout === 'enforce' ? decideFallbackId(rule.id, r.sopId, sha256Hex) : null
    out.records.push({
      v: 1,
      ref: decideRuleRef(r.sopId, rule.id),
      ruleHash,
      fallbackId,
      rollout: stamp.rollout,
      stampedBy: stamp.stampedBy,
      ir: rule,
      sopTitle,
      ruleText: decideRuleText(r.ruleText),
      pins,
    })
    if (fallbackId) out.fallbacks.push(decideFallbackPattern(fallbackId, rule.tools ?? [], 'block', decideFallbackReason(rule.id, sopTitle)))
  })
  return out
}

/**
 * The marker `intutic decide disable` leaves in `~/.intutic/decide/`: while
 * it exists, every decide rule this machine writes into a snapshot is
 * stamped `local-disable`, so it runs as shadow and gets no fallback line.
 * A line that does not read still refuses: that refusal is not the engine's.
 */
export const DECIDE_DISABLED_FILE = 'disabled'

/** Whether `intutic decide disable` is in force on this machine. Read at each write, from the home directory then. */
export function decideLocallyDisabled(): boolean {
  return existsSync(path.join(os.homedir(), '.intutic', 'decide', DECIDE_DISABLED_FILE))
}

/** Where an `intutic decide eval` pass leaves the pins it earned: `evals/<ruleHash>/<digest>.json`, each a pin. */
export const DEFAULT_DECIDE_DIR = path.join(os.homedir(), '.intutic', 'decide')

/**
 * The `decide:` lines of the workspace's local SOPs, for a snapshot written
 * with no control plane. Each line's text is kept as written, so the writer
 * reads it exactly as the proxy does, unreadable lines included. A readable
 * rule's pins are the ones `decideDir/evals/<ruleHash>/` holds; a file that is
 * not a pin is ignored. An SOP whose front matter says `mode: shadow` has its
 * rules stamped shadow, as the control plane's resolve stamps them
 * (`listServedDecideRules`): the record says `server-shadow`, and no fallback
 * line is written.
 */
export async function localDecideRules(
  entries: readonly SyncSopEntry[],
  opts: { decideDir?: string } = {},
): Promise<ServedDecideRule[]> {
  const dir = opts.decideDir ?? DEFAULT_DECIDE_DIR
  const out: ServedDecideRule[] = []
  for (const entry of entries) {
    const { front, body } = splitFrontMatter(entry.content)
    const lines = front
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('decide:'))
      .map((l) => l.slice('decide:'.length))
    if (lines.length === 0) continue
    const heading = body.split('\n').find((l) => l.startsWith('# '))
    const sopTitle = heading ? heading.slice(2) : entry.title
    const sopShadow = parseFrontMatterEnforcing(front).mode === 'shadow'
    for (const line of lines) {
      const decl = parseDecideLine(line)
      const pins = decl.kind === 'rule' ? await readLocalPins(path.join(dir, 'evals', decideRuleHash(decl.rule, sha256Hex))) : []
      out.push({ sopId: entry.sopId, sopTitle, ruleText: body, ir: line, ...(sopShadow ? { rollout: 'shadow' as const } : {}), pins })
    }
  }
  return out
}

async function readLocalPins(dir: string): Promise<DecidePin[]> {
  const names = await fs.readdir(dir).catch(() => [] as string[])
  const pins: DecidePin[] = []
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    try {
      const pin = parseDecidePin(JSON.parse(await fs.readFile(path.join(dir, name), 'utf-8')))
      if (pin) pins.push(pin)
    } catch {
      // Not a pin: the rule runs as shadow without it, which refuses nothing new.
    }
  }
  return pins
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
    const rec = body as WireFields<PolicyResolveResponse>
    const rules = Array.isArray(rec.sopRules) ? rec.sopRules : []
    return {
      workspaceId: typeof rec.workspaceId === 'string' ? rec.workspaceId : opts.workspaceId,
      interventionMode: typeof rec.interventionMode === 'string' ? rec.interventionMode : 'TRANSPARENT',
      sopRules: rules.filter((r): r is ResolvedPolicy['sopRules'][number] => {
        if (typeof r !== 'object' || r === null) return false
        const x = r as WireFields<PolicyResolveResponse['sopRules'][number]>
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
      decideRules: parseServedDecideRules((body as { decideRules?: unknown }).decideRules),
    }
  } catch (err) {
    log.warn({ action: 'policy_fetch_failed', err }, 'Policy resolve unreachable')
    return null
  }
}

/**
 * SILENT_LOG means observe, do not intervene (docs/guides/policies.md: the
 * call runs and the gate reports it as `tool_would_block`). It demotes the
 * dynamic tier to the advisory severity — it does NOT reach the static floor,
 * which stays enforced. If one settings string could disarm the floor, the
 * floor would not be a floor.
 *
 * This used to compare against 'SHADOW', which no intervention mode
 * (TRANSPARENT|OPAQUE|SILENT_LOG — the interventionMode workspace setting) can
 * ever be, so the observe-only branch was dead and a SILENT_LOG workspace
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
export function buildSnapshotRules(
  policy: ResolvedPolicy,
  localHoldTokens: readonly string[] = [],
  localHoldMode: LocalHoldMode = 'hold',
): GuardPattern[] {
  return snapshotRules(policy, localHoldTokens, localHoldMode, compileDecideRules(policy).fallbacks)
}

function snapshotRules(
  policy: ResolvedPolicy,
  localHoldTokens: readonly string[],
  localHoldMode: LocalHoldMode,
  decideFallbacks: readonly GuardPattern[],
): GuardPattern[] {
  // `shadow` names the advisory GuardPattern severity these rules are demoted
  // to; the workspace-level trigger is intervention mode SILENT_LOG.
  const shadow = isSilentLogMode(policy)

  const sopRules = policy.sopRules
    .map((r) => toGuardPattern(r, shadow))
    .filter((r): r is GuardPattern => r !== null)

  const localHolds = [...new Set(localHoldTokens.map((t) => t.trim()).filter(Boolean))]
    .map((t) => localHoldPattern(t, shadow, localHoldMode))
    .filter((r): r is GuardPattern => r !== null)

  const destructive = DESTRUCTIVE_COMMAND_PATTERNS.map((p) => {
    // Wave 7 (audit-remediation): `destructive.sql_drop` is a per-rule
    // override, evaluated BEFORE the tier-wide ramp below — it was never
    // part of `DESTRUCTIVE_TIER_SEVERITY`'s promotion (its own static
    // `severity` is `'warn'`, not `'block'`, so that ternary never reaches
    // it), and this flag is opt-in per workspace, not evidence-gated the way
    // the block-pattern ramp is. Shadow mode still wins over both: SILENT_LOG
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

  // Skill-CONTENT tier: a skill-directory write whose written text
  // matches a pattern measured at zero benign-corpus false positives. No
  // floor copy exists, so no `.tier` suffix is needed; SILENT_LOG demotes it
  // to shadow like every other dynamic-tier rule.
  const skillContent = SKILL_CONTENT_PATTERNS.map((p) => ({
    ...p,
    severity: shadow ? ('shadow' as GuardPattern['severity']) : SKILL_CONTENT_TIER_SEVERITY,
  }))

  // SSO-group refusals first. Every gate stops at the first rule that refuses,
  // and a `hold` rule earlier in the list could otherwise let an approved
  // bypass through a call the group policy refuses outright. The decide
  // fallback lines next, ahead of every shadow and warn rule: a 2.9.0 SDK
  // gate returns at the first of those that matches, and would never reach a
  // fallback line after one.
  return [...ssoGroupPatterns(policy), ...decideFallbacks, ...sopRules, ...localHolds, ...destructive, ...skillSurface, ...skillContent]
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
 * What a local `review_before:` token compiles to. `hold`: refused, recorded
 * for review, and let through once when approved — which needs a control
 * plane to approve it. `block`: refused outright, for a snapshot written with
 * no control plane (`writeLocalPolicySnapshot`), where a hold could never be
 * approved and would only pile up requests nobody can see.
 */
export type LocalHoldMode = 'hold' | 'block'

/** The reason a `block`-mode local hold gives the agent. */
export function offlineHoldReason(token: string): string {
  return (
    `Refused: ${token} is declared in review_before:. Holding for approval needs a control plane, ` +
    'and none is connected — run it yourself, or remove the token.'
  )
}

/**
 * A local `review_before:` token as a hold rule. `action:*` tokens match the
 * gate's action subject (the tokens it classifies a shell command to);
 * anything else is a tool name. Case-insensitive, as the bespoke Claude Code
 * hold was. A token that is not a plain identifier is refused with a log line
 * rather than escaped into a regex nobody can read back.
 */
function localHoldPattern(token: string, shadow: boolean, mode: LocalHoldMode): GuardPattern | null {
  if (!/^[A-Za-z0-9_:.-]+$/.test(token)) {
    log.warn({ action: 'local_hold_token_rejected', token }, 'review_before token is not a plain identifier — not shipped to the gate')
    return null
  }
  // The identifier check above already excludes every metacharacter; the
  // full escape is still applied so the pattern is safe by construction and
  // not by the guard three lines up.
  const source = ` (${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}) `
  const offline = mode === 'block'
  return {
    id: `sop.local.review_before.${token}`,
    source,
    subject: token.startsWith('action:') ? 'action' : 'tool',
    ignoreCase: true,
    severity: shadow ? 'shadow' : offline ? 'block' : 'hold',
    reason: offline ? offlineHoldReason(token) : `Held for human review: ${token} — declared in review_before:`,
    rationale: offline
      ? 'A local SOP asked to see this action before it runs, and no control plane is connected to approve it.'
      : 'A local SOP or the workspace settings asked to see this action before it runs.',
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
  localHolds: LocalHoldMode = 'hold',
): Promise<{ digest: string; ruleCount: number }> {
  return oneAtATime(() => writeSnapshotFiles(policy, snapshotDir, localHoldTokens, { localHolds }))
}

async function writeSnapshotFiles(
  policy: ResolvedPolicy,
  snapshotDir: string,
  localHoldTokens: readonly string[],
  opts: { localHolds?: LocalHoldMode; source?: 'local' } = {},
): Promise<{ digest: string; ruleCount: number }> {
  const decide = compileDecideRules(policy)
  const rules = snapshotRules(policy, localHoldTokens, opts.localHolds ?? 'hold', decide.fallbacks)
  // Format 2 once any decide line is written: an `@decide` record, or a
  // fallback line. Without one the snapshot stays byte-identical to format 1.
  const decideFormat = decide.records.length > 0 || decide.fallbacks.length > 0
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
  // An OPAQUE workspace: every gate refuses on workspace policy without
  // naming the rule (OPAQUE_REFUSAL_MESSAGE in @intutic/shared-types). One
  // line inside the digest, written only for OPAQUE, so a TRANSPARENT or
  // SILENT_LOG snapshot is byte-identical to one written before the mode
  // existed. Unlike SILENT_LOG it changes no rule's severity: what is refused
  // is unchanged, only what the agent is told.
  const opaque = isOpaqueInterventionMode(policy.interventionMode)
  // Each decide rule's record rides inside the digest too, in SOP order: an
  // edited record fails the check, and an invalid snapshot drops the records
  // with the fallback lines, as it drops the rest of the dynamic tier.
  const lines = [
    ...(decideFormat ? [encodeSnapshotFormatRecord()] : []),
    ...(opaque ? [encodeInterventionModeRecord()] : []),
    ...(ssoGroups ? [encodeSsoGroupRecord(ssoGroups)] : []),
    ...(mcpRegistry ? [encodeMcpRegistryRecord(mcpRegistry)] : []),
    ...(mcpServers.length > 0 ? [encodeMcpAllowlistRecord({ severity: mcpSeverity, servers: mcpServers })] : []),
    ...decide.records.map(encodeDecideRecord),
    ...rules.map(toRulesLine),
  ]
  const digest = createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 32)

  await fs.mkdir(snapshotDir, { recursive: true })

  const json = JSON.stringify(
    {
      _comment: 'Intutic policy snapshot — auto-generated. DO NOT EDIT.',
      version: decideFormat ? 2 : 1,
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
      // `local`: written by `intutic gates install` (or `intutic start`) with
      // no control plane. Absent on a snapshot connect wrote.
      ...(opts.source ? { source: opts.source } : {}),
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
      // The decide rules as resolve served them (or the local SOPs held
      // them), which the `@decide` records and fallback lines were compiled
      // from: readable, and enough to compile them again.
      ...(policy.decideRules && policy.decideRules.length > 0 ? { decideRules: policy.decideRules } : {}),
      // With `sopRules`, `interventionMode`, `mcpAllowedServers`,
      // `mcpRegistry` and `decideRules`, enough to rebuild this snapshot
      // without the control plane (`forgetSnapshotMember`).
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
    // A comment line, so outside the digest, and every gate skips a `#` line
    // it does not know.
    (opts.source ? `#source ${opts.source}\n` : '') +
    lines.join('\n') +
    '\n'

  // The verified copy first, then the live one. The settings guard restores
  // the copy whenever the two differ, so this order means an interrupted
  // write ends with the new snapshot in force, never the old one.
  const verifiedDir = path.join(snapshotDir, VERIFIED_SNAPSHOT_DIR)
  await fs.mkdir(verifiedDir, { recursive: true, mode: 0o700 })
  await writeFileAtomic(path.join(verifiedDir, SNAPSHOT_JSON), json, READ_ONLY)
  await writeFileAtomic(path.join(verifiedDir, SNAPSHOT_RULES), rulesText, READ_ONLY)
  await writeFileAtomic(path.join(snapshotDir, SNAPSHOT_JSON), json, READ_ONLY)
  await writeFileAtomic(path.join(snapshotDir, SNAPSHOT_RULES), rulesText, READ_ONLY)

  log.debug(
    { action: 'policy_snapshot_written', digest, ruleCount: rules.length, dir: snapshotDir },
    'Policy snapshot refreshed',
  )
  return { digest, ruleCount: rules.length }
}

// 0444: the daemon replaces these by rename, so it never needs write access to
// the file itself, and a read-only file is one more small obstacle to an agent
// editing it in place. The real protection is that every gate refuses to touch
// `.intutic/hooks` at all.
const READ_ONLY = { mode: 0o444 } as const

/**
 * Snapshot writes and the self-heal below run one at a time. A write replaces
 * the verified copy before the live one, so a self-heal run between the two
 * (the drift watcher starts one whenever the live snapshot changes, and the
 * next sync can be writing by then) found them different, put the copy back
 * and reported the daemon's own refresh as tampering.
 */
let snapshotQueue: Promise<unknown> = Promise.resolve()
function oneAtATime<T>(run: () => Promise<T>): Promise<T> {
  const next = snapshotQueue.then(run, run)
  snapshotQueue = next.catch(() => undefined)
  return next
}

/**
 * The policy a machine with no control plane enforces: no workspace rules, no
 * MCP allowlist or registry, TRANSPARENT. Its snapshot still carries the
 * destructive-command tier, the skill tiers and the local `review_before:`
 * tokens.
 *
 * `workspaceId` is empty on purpose. Every gate compares the snapshot's
 * `#workspace` with its own only when both are set, and a gate generated
 * while connected (or reading a stale `runtime.env`) carries a workspace id:
 * a local snapshot naming any id would fail that comparison, and an invalid
 * snapshot refuses every MCP call.
 */
export function localResolvedPolicy(): ResolvedPolicy {
  return {
    workspaceId: '',
    sopRules: [],
    interventionMode: 'TRANSPARENT',
    mcpAllowedServers: [],
    sqlDropStrictBlock: false,
  }
}

/**
 * Writes the snapshot of {@link localResolvedPolicy}, marked `source: local`,
 * with the local SOPs' decide rules ({@link localDecideRules}) when given.
 * The local holds refuse (`block`) rather than hold: with no control plane
 * nothing could approve them. Never fetches.
 */
export async function writeLocalPolicySnapshot(
  opts: { localHoldTokens?: readonly string[]; snapshotDir?: string; decideRules?: ServedDecideRule[] } = {},
): Promise<{ digest: string; ruleCount: number }> {
  const dir = opts.snapshotDir ?? DEFAULT_SNAPSHOT_DIR
  const policy = { ...localResolvedPolicy(), ...(opts.decideRules ? { decideRules: opts.decideRules } : {}) }
  return oneAtATime(() =>
    writeSnapshotFiles(policy, dir, opts.localHoldTokens ?? [], { localHolds: 'block', source: 'local' }),
  )
}

/**
 * Puts the last verified snapshot back when the live one differs from it.
 *
 * `'intact'`: the live snapshot is the verified one, or there is nothing to
 * compare (no snapshot written yet, or a live one from before the verified
 * copy existed that still verifies). `'restored'`: either live artifact was
 * edited, replaced or deleted, and both are the verified copy again.
 * `'unverifiable'`: the live `.rules` fails its digest and there is no
 * verified copy to restore, so the caller fetches a fresh snapshot. Any
 * difference counts, a valid-looking one included: the daemon is the only
 * writer of these files, so an older snapshot copied back in is tampering
 * too. Never throws.
 */
export async function restoreVerifiedSnapshot(
  snapshotDir: string = DEFAULT_SNAPSHOT_DIR,
): Promise<'intact' | 'restored' | 'unverifiable'> {
  return oneAtATime(() => restoreVerifiedFiles(snapshotDir))
}

async function restoreVerifiedFiles(snapshotDir: string): Promise<'intact' | 'restored' | 'unverifiable'> {
  const read = (file: string) => fs.readFile(file, 'utf-8').catch(() => null)
  const verifiedDir = path.join(snapshotDir, VERIFIED_SNAPSHOT_DIR)
  const [liveRules, liveJson, keptRules, keptJson] = await Promise.all([
    read(path.join(snapshotDir, SNAPSHOT_RULES)),
    read(path.join(snapshotDir, SNAPSHOT_JSON)),
    read(path.join(verifiedDir, SNAPSHOT_RULES)),
    read(path.join(verifiedDir, SNAPSHOT_JSON)),
  ])
  if (keptRules === null || keptJson === null || !snapshotRulesVerify(keptRules)) {
    return liveRules !== null && !snapshotRulesVerify(liveRules) ? 'unverifiable' : 'intact'
  }
  if (liveRules === keptRules && liveJson === keptJson) return 'intact'
  try {
    await writeFileAtomic(path.join(snapshotDir, SNAPSHOT_JSON), keptJson, READ_ONLY)
    await writeFileAtomic(path.join(snapshotDir, SNAPSHOT_RULES), keptRules, READ_ONLY)
  } catch (err) {
    log.warn({ action: 'policy_snapshot_restore_failed', err }, 'Could not restore the verified policy snapshot')
    return liveRules !== null && snapshotRulesVerify(liveRules) ? 'intact' : 'unverifiable'
  }
  log.warn({ action: 'policy_snapshot_restored' }, 'The policy snapshot was changed outside the sync daemon; restored the last verified copy')
  return 'restored'
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
    // Rebuilt from the verified copy, not the live JSON, which no digest
    // covers: an edit to it must not come back as a valid snapshot. A machine
    // whose last write predates the verified copy has only the live one.
    const verified = path.join(dir, VERIFIED_SNAPSHOT_DIR, SNAPSHOT_JSON)
    const source = await fs.readFile(verified, 'utf-8').catch(() => fs.readFile(path.join(dir, SNAPSHOT_JSON), 'utf-8'))
    const doc = JSON.parse(source) as Record<string, unknown>
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
        decideRules: parseServedDecideRules(doc.decideRules),
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
