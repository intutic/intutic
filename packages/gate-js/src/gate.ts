/**
 * The enforcement point.
 *
 * Port of `packages/intutic-clawde/intutic_clawde/gate/gate.py`.
 *
 * Intutic ships PreToolUse hooks for the harnesses it has a native adapter
 * for; frameworks outside that list (Mastra, the Vercel AI SDK, LangChain.js,
 * a hand-rolled loop) have no adapter, and the sync-daemon writes no
 * PreToolUse hook for them. This package is that enforcement point: the
 * missing adapter, written against Intutic's own published gate contract.
 *
 * Eight tiers, in order — identical precedence to the Python SDK:
 *
 *   A0  SSO group policy  from the policy snapshot       unknown groups refused
 *   A1  policy snapshot   port of intuticGate()          fails CLOSED
 *   R   rule records      the snapshot's @rule records   fails CLOSED (a rule failure)
 *   M   MCP registry      from the policy snapshot       unverified snapshot admits none
 *   A3  SOP rules         authored in the product        fails OPEN (A2 covers it)
 *   A2  image integrity   local check                    fails CLOSED
 *   D   decide rules      the self-hosted decide engine  fails CLOSED when enforcing
 *   B   POST /hook-gate   control-plane check             fail posture set by GateClient
 *
 * Tier R evaluates the snapshot's `@rule` records (gateRuleRecord.ts,
 * a byte-identical copy of `@intutic/shared-types`' module): a qualified
 * `requires_before: action:run_tests[ok] -> X` refuses X with
 * `PREREQUISITE_UNMET` unless the latest test run this gate recorded for the
 * session ({@link Gate.recordOutcome}, which {@link wrapTool} calls) passed
 * and no file changed since; `scope_paths_mode: enforce` refuses a file
 * change outside the scope with `OUT_OF_SCOPE`; `plan_approval:` refuses
 * with `PLAN_NOT_APPROVED` until the session's plan is approved
 * (`GET /api/v1/plans/session/:id`, cached {@link PLAN_CACHE_MS}), and under
 * `strict` a tool off the plan with `OFF_PLAN`. A plan that cannot be read
 * refuses whatever `failClosed` says: rule failures always fail closed.
 *
 * Tier D runs only on a call every deterministic tier allowed: the snapshot's
 * decide rules on the tool, asked of the self-hosted engine configured in
 * `~/.intutic/decide/engine.json` and `INTUTIC_DECIDE_*`, within
 * `INTUTIC_DECIDE_BUDGET_MS` (default {@link DECIDE_BUDGET_MS}). A rule refuses
 * with `DECIDE_REFUSED`; one that cannot decide throws
 * {@link IntuticGateEscalation} (`DECIDE_ESCALATED`), which a caller that can
 * ask its user turns into a question; an engine that cannot answer refuses an
 * enforcing rule with `GOVERNANCE_UNAVAILABLE` and lets a shadow rule's call
 * on (decideEvaluate.ts, a byte-identical copy of `@intutic/shared-types`'
 * module, holds the protections).
 *
 * Tier M applies the workspace's MCP server registry and `mcpAllowedServers`
 * list to an `mcp__<server>__<tool>` call, from the snapshot's
 * `@mcp_registry` and `@mcp_allowlist` records, with the decision, codes,
 * rule ids and reasons the hook gates and the MCP proxy use
 * (`mcpRegistryRecord.ts`, a byte-identical copy of `@intutic/shared-types`'
 * module). On a snapshot that fails its integrity check, Tier M refuses
 * every MCP call with `POLICY_SNAPSHOT_UNVERIFIED`, observe-only or not: a
 * deleted or edited record cannot be told from the workspace's own. A
 * refusal of an unapproved server reaches the control plane as a
 * `tool_blocked` event whose reason ends `[mcpDefaultPolicy]`, which puts the
 * server in the approval queue, as a hook gate's refusal does.
 *
 * A hold rule in A1 or A3 (a `REQUIRE_APPROVAL:` SOP, or a local
 * `review_before:` token) refuses with {@link IntuticGateHold} after
 * recording the hold for review, unless an approved bypass lets this exact
 * call through — the hook gates' and the MCP proxy's mechanism, through the
 * same decisions API. See hold.ts.
 *
 * Under a chaos run (`intutic chaos run`, which sets `INTUTIC_CHAOS_PLAN` and
 * `INTUTIC_CHAOS_EVENTS`), {@link Gate.guard} reports each call to the run's
 * events file and injects the plan's `tool.error` and
 * `permission.deny_or_delay` faults into a call every tier allowed, exactly
 * as the hook gates do: the same plan decoding and counter files
 * (`chaosGate.ts`, a byte-identical copy of `@intutic/shared-types`'
 * module). A fault refuses with `CHAOS_FAULT`; a held call throws
 * {@link IntuticGateHold} with no `holdId`, until its identical retry is
 * let through or denied.
 *
 * A1 and A2 are load-bearing and local. Tier B contributes the DLP regexes
 * and workspace policy from the control plane; whether an unreachable control
 * plane, or one whose checks could not run (`GOVERNANCE_UNAVAILABLE`), blocks
 * is the client's `failClosed` setting (default true). A client with no API
 * key is local-only (`GateClient.localOnly`): A3 and B are skipped and the
 * hook-gate answer says so (code `LOCAL_ONLY`), while A0, A1, M and A2 run.
 *
 * Tier A3 applies rules written in the SOP register rather than in code. It
 * runs BEFORE A2 so that a block, when both would fire, is attributed to the
 * authored policy rather than to the hardcoded one. It fails open because A2
 * covers the identical case and fails closed: A3 moves where the policy is
 * *written*, and is not what makes the run safe. See soprules.ts.
 *
 * ## Naming note for callers porting from other Intutic SDKs
 *
 * This is NOT the "static floor" tier the compiled shell/JS gate emitters
 * carry (`staticFloorPatterns()` in
 * `services/sync-daemon/src/harness/protectedPaths.ts`, concatenated ahead of
 * the snapshot's own rules in `gateBody.ts`'s `intuticGate()`). Like the
 * Python SDK it ports, this package's Tier A1 reads ONLY
 * `~/.intutic/hooks/policy-snapshot.rules` — the compiled-in bypass/secret/
 * skill-surface patterns never reach that file (only SOP-authored rules, the
 * destructive-command tier, and the tier-promoted skill-surface rules do, via
 * `buildSnapshotRules` in `services/sync-daemon/src/lib/policySnapshot.ts`).
 * A workspace relying on this SDK for governance therefore gets a strict
 * SUBSET of what a shipped shell/JS harness gate enforces. That gap already
 * exists in the Python SDK this package ports; it is not introduced here. See
 * `src/__tests__/fidelity.test.ts` for the parts of the shipped contract this
 * package's Tier A1 DOES reproduce exactly (the destructive-command and
 * skill-surface pattern tables, as they would arrive via a real snapshot).
 */

import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { classify, isDeploy, touchesInfra } from './actions.js'
import { evaluateGateRuleRecords, gateRulePlanFromResponse, type GateRulePlan } from './gateRuleRecord.js'
import { laneOf } from './lanes.js'
import { refusalDetailForMode } from './refusalDetail.js'
import { isFileWriteCall } from './scopeMatch.js'
import { decideTestOutcome, emptyOutcomeState, extractExitCode, noteCompletedCall, recordTestOutcome, type OutcomeState } from './testOutcome.js'
import { chaosGateCall, chaosGateDecode, type ChaosGateFaultOutcome, type ChaosGatePlan } from './chaosGate.js'
import { IntuticGateEscalation, IntuticGateHold, IntuticGateRefusal, type GateRefusalCode } from './errors.js'
import { holdKey, holdMessage, requestHold } from './hold.js'
import { DECIDE_BUDGET_MS, tooLargeReason } from './limits.js'
import { GateClient } from './client.js'
import { evaluateMcpAllowlist, evaluateMcpRegistry, mcpSnapshotUnverifiedRefusal } from './mcpRegistryRecord.js'
import { OPAQUE_REFUSAL_MESSAGE } from './opaqueRefusal.js'
import * as imagecheck from './imagecheck.js'
import * as snapshot from './snapshot.js'
import { SNAPSHOT_FORMAT } from './decideRecord.js'
import { createDecideEngine, DecideEngineError, resolveDecideEngineConfig, type DecideEngine, type DecideEngineConfig } from './decideEngine.js'
import {
  createDecideCanaryFileStore,
  decideDecision,
  decideShadowFindings,
  decideStoredQ95Ms,
  decideUnavailableDecision,
  evaluateDecideCall,
  type DecideDecision,
  type DecideEvaluateDeps,
  type DecideEvaluation,
  type DecideRuleEntry,
} from './decideEvaluate.js'
import { decideLogDeps, decideLogEngine, writeDecideCallLog } from './decideLog.js'
import { DECIDE_LOG_REDACTION_SOURCES } from './decideLogRedaction.js'
import * as soprules from './soprules.js'
import { evaluateSsoGroupClearance } from './ssoGroups.js'

/**
 * Whether this gate evaluates the decide rules a snapshot carries (Tier D).
 * Only a gate that does skips a decide rule's fallback line, and only when
 * the rule's record decoded; otherwise the fallback line refuses its tools,
 * as in a gate that reads no `@decide` records.
 */
export const CAN_EVALUATE_DECIDE = true

/**
 * Whether this gate evaluates the `@rule` records a snapshot carries (Tier
 * R). Only a gate that does skips a record's fallback line, and only when
 * the record decoded.
 */
export const CAN_EVALUATE_RULE_RECORDS = true

/** How long Tier R keeps a session's plan before reading it again. */
export const PLAN_CACHE_MS = 30_000

/** What a tool call's result says about how it went, for {@link Gate.recordOutcome}. */
export interface ToolOutcome {
  exitCode?: number | null
  isError?: boolean | null
  output?: string | null
}

/** The decide tier's budget for one call: `INTUTIC_DECIDE_BUDGET_MS`, or {@link DECIDE_BUDGET_MS}. */
function decideBudgetFromEnv(): number {
  const raw = (process.env.INTUTIC_DECIDE_BUDGET_MS ?? '').trim()
  const n = /^[0-9]+$/.test(raw) ? Number(raw) : NaN
  return Number.isSafeInteger(n) && n > 0 ? n : DECIDE_BUDGET_MS
}

/**
 * The engine, its URL, the canary cache and the per-call p95 `intutic doctor`
 * stored, read from `~/.intutic/decide/` and the environment for each call
 * that needs them. With the p95, a rule whose estimate does not fit the
 * budget is not asked: an enforcing one escalates. `cfg` is the resolved
 * configuration, for the decide log, or null when it does not resolve.
 */
function decideDeps(): DecideEvaluateDeps & { cfg: DecideEngineConfig | null } {
  const dir = joinPath(homedir(), '.intutic/decide')
  let engine: DecideEngine | DecideEngineError
  let url = ''
  let q95Ms: number | null = null
  let parallel = 1
  let file: unknown = null
  let resolved: DecideEngineConfig | null = null
  try {
    try {
      file = JSON.parse(readFileSync(joinPath(dir, 'engine.json'), 'utf-8'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new DecideEngineError('not_configured', `engine.json does not read: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    q95Ms = decideStoredQ95Ms(file)
    const cfg = resolveDecideEngineConfig(file, process.env)
    resolved = cfg
    url = cfg.url
    parallel = cfg.parallel
    engine = createDecideEngine(cfg)
  } catch (err) {
    engine = err instanceof DecideEngineError ? err : new DecideEngineError('not_configured', err instanceof Error ? err.message : String(err))
  }
  return {
    engine,
    engineUrl: url,
    canary: createDecideCanaryFileStore(joinPath(dir, 'canary.json'), fs),
    sha256Hex: (t) => createHash('sha256').update(t, 'utf-8').digest('hex'),
    q95Ms,
    parallel,
    cfg: resolved,
  }
}

/** Tools that cannot change anything. They still get the local snapshot check
 *  (Tier A1), but skip the remote gate call (Tier B). */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'list_files',
  'read',
  'cat',
  'view',
])

/** How a {@link Gate} evaluates calls. Every field is optional. */
export interface GateConfig {
  /**
   * Where relative manifest and allowlist paths resolve from.
   * @defaultValue `'.'`
   */
  repoRoot?: string
  /**
   * Compared with the workspace the policy snapshot was compiled for, and
   * scopes the SOP-rule fetch.
   * @defaultValue `''`
   */
  workspaceId?: string
  /**
   * The image allowlist, relative to `repoRoot` unless absolute.
   * @defaultValue `'.intutic/image-allowlist.json'`
   */
  allowlistPath?: string
  /**
   * `false` turns {@link Gate.guard} into a no-op.
   * @defaultValue `true`
   */
  enforce?: boolean
  /**
   * Call the control plane's hook gate (needs a client).
   * @defaultValue `true`
   */
  useHookGate?: boolean
  /**
   * Fetch and apply the workspace's SOP rules (needs a client).
   * @defaultValue `true`
   */
  useSopRules?: boolean
}

interface ResolvedConfig {
  repoRoot: string
  workspaceId: string
  allowlistPath: string
  enforce: boolean
  useHookGate: boolean
  useSopRules: boolean
}

function resolveConfig(cfg: GateConfig): ResolvedConfig {
  return {
    repoRoot: cfg.repoRoot ?? '.',
    workspaceId: cfg.workspaceId ?? '',
    allowlistPath: cfg.allowlistPath ?? '.intutic/image-allowlist.json',
    enforce: cfg.enforce ?? true,
    useHookGate: cfg.useHookGate ?? true,
    useSopRules: cfg.useSopRules ?? true,
  }
}

export type ToolInput = Record<string, unknown>

/** A chaos run's plan, read from the environment once per gate. */
interface ChaosState {
  plan: ChaosGatePlan | null
  events: string
  /** Why a plan that is set cannot be used. */
  error: string | null
}

/** What a chaos run's events say about one call besides its decision. */
interface ChaosNote {
  /** The first rule that fired on the call, deciding it or not. */
  ruleId: string | null
  /** A destructive-command rule fires on the call, whether or not it decided it. */
  destructive: boolean
  /** An enforce-mode rule fired: an approved bypass let a held call through. */
  policyHit: boolean
}

/**
 * The pre-execution gate. {@link Gate.guard} evaluates one tool call against
 * the local tiers (SSO group policy, policy snapshot, MCP servers, image
 * integrity) and, with a {@link GateClient}, the control-plane tiers (SOP
 * rules, hook gate), and throws {@link IntuticGateRefusal} to refuse it.
 * Without a client only the local tiers run.
 */
export class Gate {
  readonly cfg: ResolvedConfig
  readonly client: GateClient | null
  private _snapshot: snapshot.Snapshot | null = null
  private _snapshotReported = false
  private _policy: imagecheck.ImagePolicy | null = null
  /** `null` = not fetched yet. A failed fetch caches `[]` so one unreachable
   *  control plane does not add a timeout to every subsequent tool call. */
  private _sopRules: soprules.SopRule[] | null = null
  /** The SOP register said the workspace is OPAQUE (read with its rules). */
  private _registerOpaque = false
  private _chaos: ChaosState | null = null
  /** The outcome state of each session (testOutcome.ts), by session id, in memory. */
  private _outcomes = new Map<string, OutcomeState>()
  /** Each session's plan, as Tier R last read it. */
  private _plans = new Map<string, { atMs: number; plan: GateRulePlan }>()

  constructor(cfg: GateConfig = {}, client: GateClient | null = null) {
    this.cfg = resolveConfig(cfg)
    this.client = client
  }

  private allowlistAbs(): string {
    const p = this.cfg.allowlistPath
    return isAbsolutePath(p) ? p : joinPath(this.cfg.repoRoot, p)
  }

  // ------------------------------------------------------------ loading

  getSnapshot(): snapshot.Snapshot {
    if (this._snapshot === null) {
      this._snapshot = snapshot.loadSnapshot(this.cfg.workspaceId, undefined, {
        evaluatesDecide: CAN_EVALUATE_DECIDE,
        evaluatesRules: CAN_EVALUATE_RULE_RECORDS,
      })
    }
    return this._snapshot
  }

  /**
   * Load the image allowlist.
   *
   * A missing or malformed allowlist is NOT treated as "allow everything".
   * An empty policy with `require_digest` still refuses every unpinned
   * image, which is the safe direction; a policy we cannot read at all
   * throws, and the caller turns that into a block.
   */
  getPolicy(): imagecheck.ImagePolicy {
    if (this._policy === null) {
      const path = this.allowlistAbs()
      if (!existsSync(path)) {
        throw new IntuticGateRefusal(
          `[image-integrity] ${imagecheck.E_MANIFEST_UNPARSEABLE}: image allowlist not found at ` +
            `${path}; refusing to approve an image against a policy that does not exist`,
          imagecheck.E_MANIFEST_UNPARSEABLE,
        )
      }
      try {
        this._policy = JSON.parse(readFileSync(path, 'utf-8')) as imagecheck.ImagePolicy
      } catch (exc) {
        const name = exc instanceof Error ? exc.constructor.name : 'Error'
        throw new IntuticGateRefusal(
          `[image-integrity] ${imagecheck.E_MANIFEST_UNPARSEABLE}: image allowlist at ${path} is ` +
            `unreadable (${name})`,
          imagecheck.E_MANIFEST_UNPARSEABLE,
        )
      }
    }
    return this._policy
  }

  /**
   * Active SOP rules, fetched once per process.
   *
   * Deliberately not refreshed on a timer: a rule set that changes mid-run
   * makes a verdict depend on when the fetch landed. Construct a new `Gate`
   * (or clear the cache) to refresh.
   */
  async getSopRules(): Promise<soprules.SopRule[]> {
    if (this._sopRules === null) {
      let fetched: soprules.SopRule[] | null = null
      if (this.client !== null && this.client.localOnly) {
        // No key: the register cannot be read, and saying so is not news.
        this._sopRules = []
        return this._sopRules
      }
      if (this.client !== null) {
        const register = await soprules.fetchRegister(this.client.baseUrl, this.client.apiKey, this.cfg.workspaceId)
        if (register !== null) {
          fetched = register.rules
          this._registerOpaque = register.opaque
        }
      }
      if (fetched === null) {
        // Could not read the register. Say so once, then stay quiet — Tier
        // A2 still fails closed on the same condition.
        await this.emit(
          'tool_flagged',
          'sop_rules',
          'SOP rule register unreachable; SOP-rule tier inactive for this run ' +
            '(image-integrity check unaffected)',
        )
        fetched = []
      }
      this._sopRules = fetched
    }
    return this._sopRules
  }

  /**
   * What the agent is told of a refusal on workspace policy: the reason, or in
   * an OPAQUE workspace (the snapshot's `@intervention_mode` record) the
   * generic sentence, so it cannot learn the rule to route around it. The
   * code is unchanged, and the event is always emitted with the full reason.
   */
  private shown(reason: string): string {
    return this.opaque() ? OPAQUE_REFUSAL_MESSAGE : reason
  }

  /**
   * Whether the workspace is OPAQUE: the policy snapshot's record when there
   * is a snapshot, and the SOP register's `interventionMode` when there is
   * none. Without a snapshot the only tiers that refuse on workspace policy
   * are the register's (A3, which reads the mode with its rules) and the hook
   * gate, which applies the mode itself.
   */
  private opaque(): boolean {
    const snap = this.getSnapshot()
    return snap.opaque || (snap.state === 'absent' && this._registerOpaque)
  }

  // ------------------------------------------------------------ emitting

  private async emit(
    event: string,
    tool: string,
    reason = '',
    toolInput?: unknown,
    incidentId?: string,
    filePath?: string,
    gateDecisionId?: string,
  ): Promise<void> {
    if (this.client !== null) {
      await this.client.emit(event, tool, reason, toolInput, incidentId, filePath, gateDecisionId)
    }
  }

  /**
   * Report snapshot condition exactly once per process — otherwise these
   * states are computed and never read, and an operator cannot distinguish
   * "snapshot missing on 400 machines" from "snapshot healthy".
   */
  private async reportSnapshotHealthOnce(tool: string): Promise<void> {
    if (this._snapshotReported) return
    this._snapshotReported = true
    const snap = this.getSnapshot()
    if (snap.state !== 'ok') {
      await this.emit(`snapshot_${snap.state}`, tool, snap.healthMessage)
    }
    if (snap.formatVersion > SNAPSHOT_FORMAT) {
      await this.emit(
        'snapshot_format_newer',
        tool,
        `Policy snapshot format ${snap.formatVersion} is newer than this gate reads (${SNAPSHOT_FORMAT}) — records it does not know are skipped and their fallback lines enforced`,
      )
    }
  }

  /** A chaos run's plan, from `INTUTIC_CHAOS_PLAN` and `INTUTIC_CHAOS_EVENTS`, read once. */
  private chaos(): ChaosState {
    if (this._chaos === null) {
      const raw = process.env.INTUTIC_CHAOS_PLAN ?? ''
      const events = process.env.INTUTIC_CHAOS_EVENTS ?? ''
      const state: ChaosState = { plan: null, events, error: null }
      if (raw) {
        const decoded = chaosGateDecode(raw)
        if (decoded.error !== null) state.error = decoded.error
        else if (!events) state.error = 'INTUTIC_CHAOS_PLAN is set but INTUTIC_CHAOS_EVENTS is not, so nothing the run does could be reported'
        else state.plan = decoded.plan
      }
      this._chaos = state
    }
    return this._chaos
  }

  /** Reports one call to a chaos run's events file; returns the fault due on an allowed call. */
  private chaosReport(
    plan: ChaosGatePlan,
    events: string,
    toolName: string,
    decision: 'allow' | 'deny' | 'hold',
    note: ChaosNote,
    policyHit: boolean,
    key: string,
  ): ChaosGateFaultOutcome | null {
    return chaosGateCall(
      fs,
      plan,
      events,
      { tool: toolName, decision, ruleId: note.ruleId, destructive: note.destructive, policyHit: policyHit || note.policyHit, key },
      new Date().toISOString(),
    )
  }

  // --------------------------------------------------------------- guard

  /**
   * Throws {@link IntuticGateRefusal} if this call must not run. Resolves to allow.
   *
   * Under a chaos run's plan, the call is reported to the run's events file
   * whatever the tiers decide, and a call they allowed can still be refused
   * by the fault that is due (`CHAOS_FAULT`, or {@link IntuticGateHold} for
   * a held one). A plan that is set but unreadable refuses every call: an
   * experiment run without the faults it asked for reports a resilience it
   * never measured.
   */
  async guard(toolName: string, toolInput: ToolInput): Promise<void> {
    if (!this.cfg.enforce) return
    const chaos = this.chaos()
    if (chaos.error !== null) {
      const reason = `${chaos.error} — refusing the call rather than running the experiment without the faults it asked for`
      await this.emit('tool_blocked', toolName, reason)
      throw new IntuticGateRefusal(reason, 'CHAOS_FAULT')
    }
    if (chaos.plan === null) return this.decide(toolName, toolInput, null)

    const note: ChaosNote = { ruleId: null, destructive: false, policyHit: false }
    try {
      await this.decide(toolName, toolInput, note)
    } catch (err) {
      // A refusal a tier decided is a policy hit; a call too large to read, or
      // a failure that is not a refusal, is not.
      const refusal = err instanceof IntuticGateRefusal
      const held = err instanceof IntuticGateHold || err instanceof IntuticGateEscalation
      this.chaosReport(chaos.plan, chaos.events, toolName, held ? 'hold' : 'deny', note,
        refusal && err.code !== 'COMMAND_TOO_LARGE', '')
      throw err
    }
    const { toolNameNormalized, targetHash } = holdKey(toolName, toolInput)
    const key = createHash('sha256').update(`${toolNameNormalized}\0${targetHash}`).digest('hex')
    const fault = this.chaosReport(chaos.plan, chaos.events, toolName, 'allow', note, false, key)
    if (fault === null) return
    if (fault.kind === 'hold') throw new IntuticGateHold(fault.reason, undefined)
    throw new IntuticGateRefusal(fault.reason, 'CHAOS_FAULT')
  }

  /** The tiers: throws to refuse, resolves to allow. `note` collects a chaos run's record of the call. */
  private async decide(toolName: string, toolInput: ToolInput, note: ChaosNote | null): Promise<void> {
    const target = String(toolInput.path ?? toolInput.file_path ?? '')
    const command = String(toolInput.command ?? '')

    // ---- Size: refused before any tier reads the call ------------------
    //
    // Every built-in rule is linear, but a workspace's own WHERE patterns
    // need not be, and the bound is what keeps a crafted call from holding
    // the agent (or a harness hook) past its deadline. See limits.ts.
    const tooLarge = tooLargeReason(command, toolInput)
    if (tooLarge !== null) {
      await this.emit('tool_blocked', toolName, tooLarge)
      throw new IntuticGateRefusal(tooLarge, 'COMMAND_TOO_LARGE')
    }

    await this.reportSnapshotHealthOnce(toolName)

    // ---- Tier A0: SSO group policy, from the snapshot ------------------
    //
    // The workspace's group policy decided for the member the snapshot was
    // issued to — the same evaluator, and so the same answer, as the control
    // plane's hook gate. Not skippable by INTUTIC_GUARD_DISABLE: it is the
    // workspace's own policy, not the destructive family.
    const sso = this.getSnapshot().ssoGroups
    if (sso) {
      const d = evaluateSsoGroupClearance(sso.policy, toolName, sso.member ? sso.member.ssoGroups : null)
      if (d.clearance !== 'GRANTED') {
        if (note) note.ruleId = d.ruleId
        const reason = `${d.reason} [${d.ruleId}]`
        await this.emit('tool_blocked', toolName, reason, toolInput)
        throw new IntuticGateRefusal(this.shown(reason), 'SSO_GROUP')
      }
    }

    // ---- Tier A1: policy snapshot -------------------------------------
    const disabled = snapshot.guardDisabledFromEnv()
    if (disabled) {
      await this.emit(
        'guards_disabled',
        toolName,
        'INTUTIC_GUARD_DISABLE=1 — policy-snapshot rules skipped; built-in protections still active',
      )
    }

    // Hold rules an approved bypass let through on this call, so the register's
    // copy of the same rule in Tier A3 does not hold it a second time.
    const approved = new Set<string>()
    let d = snapshot.evaluate(toolName, target, command, this.getSnapshot(), disabled)
    if (note) {
      if (d.ruleId) note.ruleId = d.ruleId
      // Destructive whether or not a rule decided the call, the escape hatch
      // included: what a chaos run's no_destructive_attempt probe reads.
      const destructive = new snapshot.Snapshot()
      destructive.rules = this.getSnapshot().rules.filter((r) => r.id.startsWith('destructive.'))
      note.destructive = snapshot.evaluate(toolName, target, command, destructive, false).severity !== null
    }
    // As the rendered gates: every shadow or warn match is recorded, and an
    // approved hold lets evaluation continue, so a later block still refuses.
    for (;;) {
      for (const a of d.advisories ?? []) {
        await this.emit(a.severity === snapshot.SEV_WARN ? 'tool_flagged' : 'tool_would_block', toolName, a.reason, toolInput)
      }
      if (d.severity === snapshot.SEV_BLOCK) {
        await this.emit('tool_blocked', toolName, d.reason, toolInput)
        throw new IntuticGateRefusal(this.shown(d.reason), 'SNAPSHOT')
      }
      if (d.severity !== snapshot.SEV_HOLD) break
      await this.hold({ id: d.ruleId, reason: d.reason }, toolName, toolInput)
      approved.add(d.ruleId)
      if (note) note.policyHit = true
      d = snapshot.evaluate(toolName, target, command, this.getSnapshot(), disabled, d.next)
    }

    // ---- Tier R: the snapshot's rule records ---------------------------
    await this.guardRules(toolName, toolInput, note)

    // ---- Tier M: the MCP server registry and allowlist ----------------
    await this.guardMcp(toolName, toolInput, note)

    // ---- Tier A3: SOP rules authored in the product --------------------
    //
    // Runs before A2 on purpose. When both would fire, the block should be
    // attributed to the policy someone wrote in the register, not to the one
    // hardcoded here.
    if (this.cfg.useSopRules && !READ_ONLY_TOOLS.has(toolName)) {
      const rule = soprules.firstMatch(await this.getSopRules(), toolName, toolInput)
      if (rule !== null) {
        // The deciding rule's id, or the first that fired when none decides.
        if (note && (rule.action !== soprules.ACTION_WARN || !note.ruleId)) note.ruleId = `sop.${rule.id}`
        const reason = `[sop:${rule.id}] ${rule.reason}`
        if (rule.action === soprules.ACTION_BLOCK) {
          await this.emit('tool_blocked', toolName, reason, toolInput)
          throw new IntuticGateRefusal(this.shown(reason), 'SOP_RULE')
        }
        if (rule.action === soprules.ACTION_APPROVAL) {
          // Held for a person, under the id the snapshot gives the same rule
          // (`sop.<id>`), so one approval covers the call in either tier.
          const id = `sop.${rule.id}`
          if (!approved.has(id)) await this.hold({ id, reason: rule.reason }, toolName, toolInput)
          if (note) note.policyHit = true
        } else {
          await this.emit('tool_flagged', toolName, reason, toolInput)
        }
      }
    }

    // ---- Tier A2: image integrity -------------------------------------
    if (isDeploy(toolName, toolInput)) {
      const verdict = imagecheck.checkCommand(command, this.cfg.repoRoot, this.getPolicy())
      if (!verdict.ok) {
        const reason = `${imagecheck.verdictReason(verdict)} — policy ${this.cfg.allowlistPath}`
        await this.emit('tool_blocked', toolName, reason, toolInput)
        throw new IntuticGateRefusal(reason, verdict.code)
      }
    }

    // A write to infrastructure gets the same check one turn earlier, as a
    // flag rather than a block: the dashboard then shows the bad manifest
    // being authored before it is applied.
    if (target && touchesInfra(target) && 'content' in toolInput) {
      const v = imagecheck.checkWrittenManifest(target, String(toolInput.content), this.getPolicy())
      if (!v.ok) {
        await this.emit(
          'tool_flagged',
          toolName,
          `${imagecheck.verdictReason(v)} (authoring-time check; the apply will be refused)`,
          toolInput,
          undefined,
          target,
        )
      }
    }

    // ---- Tier D: decide rules -----------------------------------------
    //
    // Only here, after every deterministic tier allowed the call: a refusal
    // above never reaches the engine.
    await this.guardDecide(toolName, toolInput, note)

    // ---- Tier B: control plane gate -----------------------------------
    //
    // Skipped for read-only tools — a network round trip whose checks are
    // DLP regexes over the arguments and SOP rules, neither of which can say
    // anything useful about a directory listing.
    let decisionId: string | undefined
    if (this.cfg.useHookGate && this.client !== null && !READ_ONLY_TOOLS.has(toolName)) {
      const resp = await this.client.hookGate(toolName, toolInput)
      // Every answer is reported: the event drives the incident, rule
      // evidence and plan tracking. It carries the hook gate's decision id,
      // which the control plane exported to SIEM itself and filed its DLP
      // refusal's incident under, so neither happens twice.
      decisionId = resp.decisionId
      if (!resp.allowed) {
        await this.emit('tool_blocked', toolName, resp.reason, toolInput, undefined, undefined, resp.decisionId)
        // The hook gate names the MCP registry's own code when the registry
        // refused, and INSUFFICIENT_SCOPE when the key lacks its scope;
        // anything else it refuses is HOOK_GATE.
        const code =
          MCP_CODES.has(resp.code ?? '') || resp.code === 'INSUFFICIENT_SCOPE' ? (resp.code as GateRefusalCode) : 'HOOK_GATE'
        throw new IntuticGateRefusal(this.shown(resp.reason), code, resp.incidentId)
      }
    }

    if (!READ_ONLY_TOOLS.has(toolName)) {
      await this.emit('tool_allowed', toolName, '', toolInput, undefined, undefined, decisionId)
    }
  }

  /**
   * Records how a call that ran went, for Tier R. A test run
   * (`action:run_tests`) records its outcome (testOutcome.ts: the exit code,
   * else one read from `output`, the error flag and the runner summaries);
   * any other call marks earlier outcomes as no longer adjacent, and a call
   * that changed files (`isFileWriteCall`, scopeMatch.ts) makes an earlier pass stale.
   * Kept in memory per {@link GateClient.sessionId}; with no session id
   * nothing is kept, and a qualified rule stays unmet. {@link wrapTool} calls
   * this after every call it ran.
   */
  recordOutcome(toolName: string, toolInput: ToolInput, result: ToolOutcome = {}): void {
    const session = this.client?.sessionId ?? ''
    if (!session) return
    const state = this._outcomes.get(session) ?? emptyOutcomeState()
    if (classify(toolName, toolInput).includes('action:run_tests')) {
      const output = typeof result.output === 'string' ? result.output : undefined
      const exitCode = typeof result.exitCode === 'number' ? result.exitCode : extractExitCode(output)
      const decision = decideTestOutcome({ exitCode, isError: result.isError ?? null, output })
      this._outcomes.set(session, recordTestOutcome(state, 'action:run_tests', decision, Date.now()))
    } else {
      this._outcomes.set(session, noteCompletedCall(state, isFileWriteCall(toolName, toolInput)))
    }
  }

  /** The session's plan, read at most every {@link PLAN_CACHE_MS}. */
  private async sessionPlan(sessionId: string): Promise<GateRulePlan> {
    if (this.client === null || sessionId === '') return { status: 'none' }
    const cached = this._plans.get(sessionId)
    if (cached && Date.now() - cached.atMs < PLAN_CACHE_MS) return cached.plan
    const res = await this.client.sessionPlan(sessionId)
    const plan = gateRulePlanFromResponse(res.status, res.body)
    // An unreadable feed is not cached: the next call asks again.
    if (plan.status !== 'unavailable') this._plans.set(sessionId, { atMs: Date.now(), plan })
    return plan
  }

  /**
   * Tier R. Throws {@link IntuticGateRefusal} when an enforcing rule record
   * refuses the call (`PREREQUISITE_UNMET`, `OUT_OF_SCOPE`, `OFF_PLAN`,
   * `PLAN_NOT_APPROVED`), with the refusal's scope; each shadow record's
   * finding is reported as `tool_would_block` and the call goes on.
   */
  private async guardRules(toolName: string, toolInput: ToolInput, note: ChaosNote | null): Promise<void> {
    if (!CAN_EVALUATE_RULE_RECORDS) return
    const records = this.getSnapshot().ruleRecords
    if (records.length === 0) return
    const sessionId = this.client?.sessionId ?? ''
    const cwd = process.cwd()
    const plan: GateRulePlan = records.some((r) => r.kind === 'plan_approval') ? await this.sessionPlan(sessionId) : { status: 'none' }
    const ev = evaluateGateRuleRecords(records, {
      tool: toolName,
      input: toolInput,
      actions: classify(toolName, toolInput),
      cwd,
      root: workspaceRoot(cwd),
      sessionId,
      harness: this.client?.harness ?? 'sdk',
      outcomes: this._outcomes.get(sessionId) ?? null,
      observable: true,
      plan,
      nowMs: Date.now(),
    })
    for (const f of ev.shadow) await this.emit('tool_would_block', toolName, `${f.reason} [${f.ruleId}]`, toolInput)
    if (ev.refusal === null) return
    const f = ev.refusal
    if (note) note.ruleId = f.ruleId
    await this.emit('tool_blocked', toolName, `${f.reason} [${f.ruleId}]`, toolInput)
    const opaque = this.opaque()
    throw new IntuticGateRefusal(this.shown(`${f.reason} [${f.ruleId}]`), f.code, undefined, refusalDetailForMode(opaque ? 'OPAQUE' : 'TRANSPARENT', f.scope, []))
  }

  /**
   * Tier D. Throws when a decide rule on this tool refuses the call
   * ({@link IntuticGateRefusal}, `DECIDE_REFUSED` or `GOVERNANCE_UNAVAILABLE`)
   * or could not decide it ({@link IntuticGateEscalation}). Each shadow rule's
   * finding is recorded; the call goes on.
   */
  private async guardDecide(toolName: string, toolInput: ToolInput, note: ChaosNote | null): Promise<void> {
    if (!CAN_EVALUATE_DECIDE) return
    const rules = this.getSnapshot().decideRules.filter((r) => r.ir.on === 'tool_call' && (r.ir.tools ?? []).includes(toolName))
    if (rules.length === 0) return
    const budget = decideBudgetFromEnv()
    let decision: DecideDecision
    let timer: ReturnType<typeof setTimeout> | undefined
    const started = Date.now()
    try {
      const deps = decideDeps()
      const cwd = process.cwd()
      const ev = await Promise.race([
        evaluateDecideCall({ deterministic: 'allow', tool: toolName, toolInput, cwd, rules, deadlineMs: started + budget }, deps),
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), budget + 250) }),
      ])
      if (ev !== null) this.logDecide(ev, rules, { tool: toolName, toolInput, cwd, budgetMs: budget, startedMs: started, cfg: deps.cfg })
      if (ev === null) {
        decision = decideUnavailableDecision(rules, toolName, `the decide rules on ${toolName} were not evaluated within ${budget} ms`)
      } else {
        for (const f of decideShadowFindings(ev, rules)) await this.emit('tool_would_block', toolName, `${f.reason} [${f.ruleId}]`, toolInput)
        decision = decideDecision(ev, rules)
      }
    } catch (err) {
      decision = decideUnavailableDecision(rules, toolName, `the decide rules on ${toolName} could not be evaluated (${err instanceof Error ? err.message : String(err)})`)
    } finally {
      if (timer) clearTimeout(timer)
    }
    if (decision.outcome === 'allow') return
    if (note && decision.ruleId) note.ruleId = decision.ruleId
    const reason = decision.ruleId ? `${decision.reason} [${decision.ruleId}]` : decision.reason
    if (decision.outcome === 'escalate') {
      await this.emit('tool_flagged', toolName, `DECIDE_ESCALATED — asked a person: ${reason}`, toolInput)
      throw new IntuticGateEscalation(this.shown(reason), this.opaque() ? undefined : (decision.ruleId ?? undefined))
    }
    await this.emit('tool_blocked', toolName, reason, toolInput)
    throw new IntuticGateRefusal(this.shown(reason), decision.code ?? 'GOVERNANCE_UNAVAILABLE')
  }

  /**
   * Appends the call's decide record to `~/.intutic/logs/decide-<date>.jsonl`
   * and updates each rule's drift stats, as `intutic decide check` does for
   * the shell gates. Never throws: a log that cannot be written never
   * changes the decision.
   */
  private logDecide(
    ev: DecideEvaluation,
    rules: readonly DecideRuleEntry[],
    call: { tool: string; toolInput: ToolInput; cwd: string; budgetMs: number; startedMs: number; cfg: DecideEngineConfig | null },
  ): void {
    try {
      const sha256Hex = (t: string) => createHash('sha256').update(t, 'utf-8').digest('hex')
      const now = Date.now()
      writeDecideCallLog(
        ev,
        rules,
        {
          atMs: now,
          harness: this.client?.harness ?? 'sdk',
          workspaceId: this.cfg.workspaceId,
          sessionId: this.client?.sessionId ?? '',
          tool: call.tool,
          toolInput: call.toolInput,
          cwd: call.cwd,
          budgetMs: call.budgetMs,
          latencyMs: now - call.startedMs,
          engine: decideLogEngine(call.cfg, ev),
          redact: DECIDE_LOG_REDACTION_SOURCES,
          // The call's reversibility class; a gate has no revert rates.
          lane: laneOf(classify(call.tool, call.toolInput)),
          revertRate: null,
        },
        decideLogDeps(fs, homedir(), sha256Hex),
      )
    } catch {
      // A log that cannot be written never changes the decision.
    }
  }

  /**
   * Throws when the workspace's MCP server registry or allowlist refuses an
   * `mcp__<server>__<tool>` call: the registry first, as every gate orders
   * them. An allowlist in `shadow` records the refusal and lets the call on.
   * A snapshot that failed its integrity check admits no MCP server.
   */
  private async guardMcp(toolName: string, toolInput: ToolInput, note: ChaosNote | null): Promise<void> {
    if (!toolName.startsWith('mcp__')) return
    const rest = toolName.slice('mcp__'.length)
    const sep = rest.indexOf('__')
    if (sep <= 0) return
    const snap = this.getSnapshot()
    const server = rest.slice(0, sep)
    if (snap.state === 'invalid') {
      const refusal = mcpSnapshotUnverifiedRefusal(server)
      if (note) note.ruleId = refusal.ruleId
      const reason = `${refusal.reason} [${refusal.ruleId}]`
      await this.emit('tool_blocked', toolName, reason, toolInput)
      throw new IntuticGateRefusal(reason, refusal.code)
    }
    const registry = snap.mcpRegistry ? evaluateMcpRegistry(snap.mcpRegistry, server, rest.slice(sep + 2)) : null
    if (registry) {
      if (note) note.ruleId = registry.ruleId
      const reason = `${registry.reason} [${registry.ruleId}]`
      await this.emit('tool_blocked', toolName, reason, toolInput)
      throw new IntuticGateRefusal(this.shown(reason), registry.code)
    }
    const allowlist = snap.mcpAllowlist ? evaluateMcpAllowlist(snap.mcpAllowlist, server) : null
    if (allowlist) {
      if (note && (snap.mcpAllowlist!.severity !== 'shadow' || !note.ruleId)) note.ruleId = allowlist.ruleId
      const reason = `${allowlist.reason} [${allowlist.ruleId}]`
      if (snap.mcpAllowlist!.severity === 'shadow') {
        await this.emit('tool_would_block', toolName, reason, toolInput)
        return
      }
      await this.emit('tool_blocked', toolName, reason, toolInput)
      throw new IntuticGateRefusal(this.shown(reason), allowlist.code)
    }
  }

  /**
   * A hold rule matched: resolves when an approved bypass lets this exact
   * call through (the remaining tiers still apply), and otherwise throws
   * {@link IntuticGateHold} after recording the hold.
   */
  private async hold(rule: { id: string; reason: string }, toolName: string, toolInput: ToolInput): Promise<void> {
    const outcome = await requestHold(this.client, rule, toolName, toolInput)
    if (outcome.kind === 'bypassed') {
      // Let through, loudly: a bypass nobody can see used is no better than
      // no review at all.
      await this.emit(
        'hold_approved_bypass_used',
        toolName,
        `Approved bypass for ${rule.id} — approved by ${outcome.decidedBy || 'an approver'} on hold ${outcome.holdId}`,
        toolInput,
      )
      return
    }
    await this.emit('tool_held', toolName, `${rule.reason} [${rule.id}]`, toolInput)
    // An OPAQUE workspace's hold names the hold, not the rule.
    const opaque = this.opaque()
    throw new IntuticGateHold(
      holdMessage(opaque ? OPAQUE_REFUSAL_MESSAGE : rule.reason, opaque ? '' : rule.id, outcome),
      outcome.recorded ? outcome.holdId : undefined,
    )
  }
}

/** The refusal codes of the MCP registry and allowlist, which the hook gate may also return. */
const MCP_CODES: ReadonlySet<string> = new Set<GateRefusalCode>([
  'SERVER_BLOCKED',
  'SERVER_HELD',
  'SERVER_NOT_APPROVED',
  'TOOL_DISABLED',
  'SERVER_NOT_ALLOWED',
])

function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p)
}

function trimTrailingSlashes(s: string): string {
  let end = s.length
  while (end > 0 && s[end - 1] === '/') end--
  return s.slice(0, end)
}

function trimLeadingSlashes(s: string): string {
  let start = 0
  while (start < s.length && s[start] === '/') start++
  return s.slice(start)
}

function joinPath(a: string, b: string): string {
  return `${trimTrailingSlashes(a)}/${trimLeadingSlashes(b)}`
}

/** The workspace root Tier R makes paths relative to: the nearest directory at or above `cwd` holding `.git`, else `cwd`. */
function workspaceRoot(cwd: string): string {
  let dir = cwd
  for (;;) {
    if (existsSync(joinPath(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return cwd
    dir = parent
  }
}

// The process-wide active gate lives in registry.ts, which imports no Node.js
// built-ins (see that module's doc); re-exported so the API is unchanged.
export { install, active } from './registry.js'
