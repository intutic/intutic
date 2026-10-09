/**
 * interceptor.ts — tools/call decision engine.
 *
 * Given a tool name and arguments, evaluates:
 * 0. The MCP server registry, server/tool allowlists and SSO group clearance
 * 1. DLP scan (credential / destructive pattern detection)
 * 2. SOP policy rules (fetched from control plane via PolicyClient)
 * 3–5. Prompt injection, anomaly detectors, WASM rules
 * 6. MCP call budgets — last, so only a call that would otherwise run is counted
 *
 * Returns an allow / block / redact decision.
 *
 * @module
 */

import * as node_crypto from 'node:crypto'
import { createStderrLogger as createLogger } from './stderrLog.js'
import { evaluateMcpRegistry, evaluateSsoGroupClearance, holdApprovalHint } from '@intutic/shared-types'
import { scanToolInput, formatDlpBlockReason, setDynamicPatterns, setWorkspacePii } from './dlp.js'
import type { DlpFinding } from './dlp.js'
import { scanText, injectionSeverity, setDynamicInjectionPatterns } from './injection.js'
import { evaluateSequenceDetectors, resolveEffectiveDisposition, REASK_MAX_ATTEMPTS } from './anomaly/index.js'
import type { AnomalyMode, Disposition } from './anomaly/index.js'
import { SessionState } from './session.js'
import type { WasmRunner } from './wasm/runner.js'
import type { PolicyClient, SopRule } from './policy.js'
import { detectionFinding, type GovernanceEmitter } from './emitter.js'
import type { ApprovalHolds } from './approvalHold.js'
import { budgetEventDetail, exceededReason, unavailableReason, warningReason, type McpBudgetEnforcer } from './budget.js'
import type { McpRefusalCode } from './refusals.js'

const log = createLogger('mcp-proxy-interceptor')

/**
 * A refusal: what the agent reads (`reason`), and what a client reads — the
 * stable `code`, the `ruleId` that decided, and any `detail` the code carries
 * (refusals.ts). All three reach the JSON-RPC frame's `error.data`.
 */
export interface Block {
  action: 'block'
  reason: string
  code: Exclude<McpRefusalCode, 'HELD'>
  ruleId: string
  detail?: Record<string, unknown>
}

export type Decision =
  | { action: 'allow' }
  | Block
  | { action: 'redact'; reason: string; redactedInput: unknown }
  /**
   * Refused for now, pending a person's approval (`require_approval`). Not a
   * block: the agent is told the hold id and to retry once it is approved,
   * which passes only while the workspace's review-hold bypass is on — see
   * approvalHold.ts. `holdId` is empty when the hold could not be recorded.
   */
  | { action: 'hold'; reason: string; holdId: string; ruleId: string }

/** The decision for a refusal. */
function block(code: Block['code'], ruleId: string, reason: string, detail?: Record<string, unknown>): Block {
  return detail ? { action: 'block', reason, code, ruleId, detail } : { action: 'block', reason, code, ruleId }
}

/** Every governance check that cannot complete refuses with this, when the proxy fails closed. */
const FAIL_CLOSED_REASON =
  'Governance check failed — Intutic control plane unreachable. ' +
  'Tool call blocked by workspace policy (fail-closed mode). ' +
  'Contact your administrator or update mcpProxyFailBehavior to open.'

export class ToolCallInterceptor {
  constructor(
    private readonly policy: PolicyClient,
    private readonly emitter: GovernanceEmitter,
    /**
     * The local fail setting (`INTUTIC_MCP_FAIL_OPEN`, config.ts). The
     * workspace's `mcpProxyFailBehavior`, once a policy has delivered it,
     * takes precedence — see {@link failOpen}.
     */
    private readonly localFailOpen: boolean = true,
    /**
     * The real MCP server this proxy process fronts, from `--server-name`
     * (config.ts, threaded since Phase D's `wrapWithProxy` but unconsumed
     * until now). `'unknown'` when unset, matching config.ts's own default —
     * see the server-scoping check below for why an allowlist naming
     * anything else then refuses every call from this process.
     */
    private readonly serverName: string = 'unknown',
    /**
     * Env-derived default prompt-injection disposition (`config.ts`'s
     * `mcpInjectionAction`), used whenever `policy.getInjectionAction()`
     * reports no control-plane override. Defaults to `'warn'` here too, so
     * every existing construction site/test that doesn't pass this
     * parameter keeps the same steer-not-kill posture the Rust detector this
     * was ported from uses by default.
     */
    private readonly injectionActionDefault: 'warn' | 'block' = 'warn',
    /**
     * Shared per-process session state (Phase 2) — the SAME instance
     * `McpGovernanceProxy` (proxy.ts) owns and hands to `handleHarnessLine`
     * for post-decision recording, so the sequence this method reads for
     * detection and the sequence `handleHarnessLine` appends to after an
     * `allow` are never two different objects that could drift. Defaults to
     * a fresh instance so every existing construction site/test that
     * predates Phase 2 keeps working unchanged.
     */
    private readonly session: SessionState = new SessionState(),
    /**
     * Env-derived default anomaly mode (`config.ts`'s `mcpAnomalyMode`),
     * used whenever `policy.getAnomalyMode()` reports no control-plane
     * override. Defaults to `'enforce'` — see `config.ts`'s doc comment on
     * why "enforce" here does not mean "block on suspicion": every
     * detector's own Rust-declared disposition ceiling still applies via
     * `resolveEffectiveDisposition`.
     */
    private readonly anomalyModeDefault: AnomalyMode = 'enforce',
    /**
     * Env-derived default per-detector override map (`config.ts`'s
     * `mcpAnomalyOverrides`). Merged with `policy.getAnomalyOverrides()` per
     * key, control-plane value winning — the same "policy overrides the
     * env-derived default, per field" shape `injectionActionDefault` uses,
     * just applied per-map-entry instead of to one scalar.
     */
    private readonly anomalyOverridesDefault: Readonly<Record<string, Disposition | 'off'>> = {},
    /**
     * Phase 3's WASM custom-rule runner, or `undefined` to skip WASM
     * evaluation entirely (every construction site/test that predates Phase
     * 3, and any deployment with no `~/.intutic/wasm/` rules). Owned by
     * `McpGovernanceProxy` (proxy.ts), same sharing pattern as `session`.
     */
    private readonly wasmRunner: WasmRunner | undefined = undefined,
    /**
     * This proxy's workspace id, from `config.ts` — needed for Phase 3's
     * `RequestContext.workspace_id` field. Stored separately from `policy`
     * (which has no getter for it) and from `serverName` (a different
     * identity: the MCP SERVER this process fronts, not the WORKSPACE it
     * belongs to).
     */
    private readonly workspaceId: string = 'unknown',
    /**
     * Turns a `require_approval` rule into a hold through the control
     * plane's decisions API. `undefined` (construction sites that predate
     * holds) leaves such a call held with nothing recorded, which is still a
     * refusal — never an allow.
     */
    private readonly holds: ApprovalHolds | undefined = undefined,
    /**
     * Counts each call against the workspace's MCP call budgets (budget.ts).
     * `undefined` (construction sites that predate budgets) skips them; the
     * proxy always passes one, with no store when it has no Valkey, so a
     * covered call then resolves through the fail setting.
     */
    private readonly budgets: McpBudgetEnforcer | undefined = undefined,
  ) {}

  /** Set once this process has said that budgets went unchecked under fail-open, so the log says it once. */
  private budgetsUncheckedWarned = false

  /**
   * Whether a governance check that cannot complete lets the call through:
   * the workspace's `mcpProxyFailBehavior` when the control plane has sent
   * it, the local `INTUTIC_MCP_FAIL_OPEN` until then (and for a workspace
   * that never chose).
   */
  get failOpen(): boolean {
    return this.policy.getFailOpen() ?? this.localFailOpen
  }

  /**
   * Applies the shared reask ladder (Phase 2 anomaly detectors AND Phase 3
   * WASM rules both use this): a session-lifetime attempt counter keyed by
   * `key`, `REASK_MAX_ATTEMPTS` (3) tries before hardening into an
   * unconditional block. Always emits `tool_blocked` — a reask blocks the
   * CURRENT attempt, so existing consumers keyed on `tool_blocked` must see
   * it, exactly like every other new block reason in this package.
   */
  private async applyReaskLadder(key: string, baseReason: string, toolName: string, toolInput: unknown): Promise<Block> {
    // Shared across the session's sibling proxy processes when a session
    // store is configured (Wave 5.3); the per-process counter otherwise.
    const attempts = await this.session.incrReaskAttemptShared(key)
    if (attempts > REASK_MAX_ATTEMPTS) {
      const hardenedReason =
        `${baseReason} — hardened to an unconditional block after ${REASK_MAX_ATTEMPTS} reask ` +
        `attempts with no correction.`
      log.warn({ action: 'reask_hardened', toolName, key, attempts }, 'Reask attempts exhausted — hardening to a hard block')
      this.emitter.emit('tool_blocked', toolName, toolInput, hardenedReason)
      return block('REASK_EXHAUSTED', key, hardenedReason)
    }
    const reaskReason =
      `${baseReason} (attempt ${attempts}/${REASK_MAX_ATTEMPTS} — will become an unconditional ` +
      `block if this keeps tripping)`
    this.emitter.emit('tool_blocked', toolName, toolInput, reaskReason)
    return block('REASK', key, reaskReason)
  }

  /**
   * A `require_approval` rule matched. Returns the hold decision, or `null`
   * when an approved bypass for this exact call lets it continue. Every hold
   * reason names the hold id, who may approve it and when a retry passes, in
   * the words the hook gates print (`holdApprovalHint`), so a person reading
   * the agent's transcript knows what to do.
   */
  private async hold(rule: Pick<SopRule, 'id' | 'reason'>, toolName: string, toolInput: unknown): Promise<Decision | null> {
    const outcome = this.holds
      ? await this.holds.request(rule, toolName, toolInput)
      : { kind: 'held' as const, holdId: '', recorded: false }

    if (outcome.kind === 'bypassed') {
      const reason = `Approved bypass for ${rule.id} — approved by ${outcome.decidedBy || 'an approver'} on hold ${outcome.holdId}`
      log.warn({ action: 'hold_approved_bypass_used', toolName, ruleId: rule.id, holdId: outcome.holdId }, reason)
      this.emitter.emit('hold_approved_bypass_used', toolName, toolInput, reason)
      return null
    }

    const reason = outcome.recorded
      ? `HELD for approval: ${rule.reason} [${rule.id}]. Hold id: ${outcome.holdId}. ` +
        holdApprovalHint(outcome.holdId)
      : `HELD for approval: ${rule.reason} [${rule.id}], but the hold could not be recorded ` +
        `(Intutic control plane unreachable), so there is nothing to approve yet. Retry once the ` +
        `control plane is reachable to request approval.`
    log.warn({ action: 'tool_held', toolName, ruleId: rule.id, holdId: outcome.holdId, recorded: outcome.recorded }, reason)
    this.emitter.emit('tool_held', toolName, toolInput, `${rule.reason} [${rule.id}]`)
    return { action: 'hold', reason, holdId: outcome.recorded ? outcome.holdId : '', ruleId: rule.id }
  }

  /**
   * Refuses the call when the registry says this server — or this tool on it —
   * may not be used. Returns `null` to let the call continue.
   *
   * A blocked server is refused under either default; under `deny`, so is any
   * server not approved (a candidate, or one the registry has never seen);
   * a disabled tool is refused within any server. All three are definite
   * operator decisions and do not depend on `failOpen`.
   *
   * What does depend on it is a registry this process has never loaded — the
   * control plane unreachable since start, or only the MCP daemon's snapshot
   * seed so far. The last-known registry is kept for as long as the process
   * runs, so this is only ever the never-loaded case. Fail-open lets the call continue
   * unchecked against the registry, exactly as a workspace with no registry;
   * fail-closed refuses it, because a `deny` workspace cannot be told apart
   * from an `allow` one without the registry.
   */
  private async checkRegistry(toolName: string, toolInput: unknown): Promise<Decision | null> {
    await this.policy.ready()
    const registry = this.policy.getRegistry()
    if (!registry) {
      if (this.failOpen) return null
      const reason =
        `MCP server registry for this workspace has not loaded (Intutic control plane unreachable ` +
        `since this proxy started), so whether "${this.serverName}" is approved is unknown. ` +
        `Tool call blocked (fail-closed mode: mcpProxyFailBehavior or INTUTIC_MCP_FAIL_OPEN=false).`
      log.warn({ action: 'registry_unknown_block', serverName: this.serverName, toolName }, reason)
      this.emitter.emit('tool_blocked', toolName, toolInput, reason)
      return block('REGISTRY_UNAVAILABLE', 'mcpProxyFailBehavior', reason)
    }

    // The decision every gate makes (`@intutic/shared-types` mcpRegistryRecord.ts):
    // the harness hook gates apply the same function, from the policy
    // snapshot, to the servers no proxy fronts.
    const decision = evaluateMcpRegistry(registry, this.serverName, toolName)
    const refusal: Block | null = decision ? block(decision.code, decision.ruleId, decision.reason) : null
    if (!refusal) return null
    log.warn({ action: 'registry_block', serverName: this.serverName, toolName }, refusal.reason)
    this.emitter.emit('tool_blocked', toolName, toolInput, refusal.reason)
    return refusal
  }

  /**
   * Brings the workspace's control-plane rules up to date with the policy, and
   * refuses the call when they have never loaded and the proxy fails closed.
   *
   * Never loaded means no policy from the control plane yet, or one whose rule
   * binaries could not be fetched: whether one of those rules refuses this
   * call is unknown. Fail-open judges the call by the rules that are loaded —
   * this machine's — as a workspace with no uploaded rules would be;
   * fail-closed refuses it, as it does an unknown registry. Once loaded, the
   * set is kept for as long as the process runs, through any later outage.
   */
  private async checkCloudRulesLoaded(runner: WasmRunner, toolName: string, toolInput: unknown): Promise<Decision | null> {
    await runner.syncCloudRules(this.policy.getWasmRules())
    if (runner.cloudRulesLoaded() || this.failOpen) return null
    const reason =
      `This workspace's custom rules have not loaded (Intutic control plane unreachable since this ` +
      `proxy started), so whether one of them refuses this call is unknown. Tool call blocked ` +
      `(fail-closed mode: mcpProxyFailBehavior or INTUTIC_MCP_FAIL_OPEN=false).`
    log.warn({ action: 'wasm_cloud_unknown_block', toolName }, reason)
    this.emitter.emit('tool_blocked', toolName, toolInput, reason)
    return block('GOVERNANCE_UNAVAILABLE', 'mcpProxyFailBehavior', reason)
  }

  /**
   * The workspace's SSO group policy, applied to the member this proxy's API
   * key resolves to, by `evaluateSsoGroupClearance` — the function the
   * server-side hook gate (`resolveSsoGroupPrivilege`) and the policy snapshot
   * use, so all of them answer alike. A tool matches by its bare MCP name or
   * as `mcp__<server>__<tool>`, the name the harness hooks see for the same
   * call. A tool on the `requireOboFor` list is refused: a proxy has no
   * on-behalf-of token to present.
   *
   * With a policy but no resolved member the groups are unknown, and a
   * high-risk tool is refused rather than allowed — unknown is never granted.
   * Without a policy there is nothing to apply.
   */
  private checkSsoGroupClearance(toolName: string, toolInput: unknown): Decision | null {
    const policy = this.policy.getSsoGroupPolicy()
    if (!policy) return null
    const principal = this.policy.getPrincipal()
    const decision = evaluateSsoGroupClearance(
      policy,
      [toolName, `mcp__${this.serverName}__${toolName}`],
      principal ? principal.ssoGroups : null,
    )
    if (decision.clearance === 'GRANTED') return null
    // The bracketed rule id is how hook-events and the SIEM export name the
    // rule that decided — the same id every other gate gives this decision.
    const reason = `${decision.reason} [${decision.ruleId}]`
    log.warn({ action: 'sso_group_block', toolName, memberId: principal?.memberId ?? null, ruleId: decision.ruleId }, reason)
    this.emitter.emit('tool_blocked', toolName, toolInput, reason)
    return block('SSO_GROUP', decision.ruleId ?? 'sso_group', reason)
  }

  /**
   * Evaluate a tools/call request and return a governance decision.
   *
   * @param toolName - The MCP tool name (e.g. "mcp__filesystem__read_file" or "Bash")
   * @param toolInput - The tool_input / arguments object
   * @returns Decision: allow, block, or redact
   */
  async decide(toolName: string, toolInput: unknown): Promise<Decision> {
    log.debug({ action: 'interceptor_decide', toolName }, 'Evaluating tool call')

    // Captured across pipeline steps for Phase 3's WASM context (built only
    // if this call reaches step 5) — each stays honestly empty/undefined
    // when its step never ran or found nothing, never fabricated.
    let dlpFindingsForContext: DlpFinding[] = []
    let injectionFindingsForContext: string[] = []
    let injectionSourcesForContext: string[] = []
    let corroboratingDetectorsForContext = 0

    // -2. The MCP server registry: operator decisions on this server, and the
    // workspace's default for servers nobody has decided on yet.
    const registryDecision = await this.checkRegistry(toolName, toolInput)
    if (registryDecision) return registryDecision

    // -1. Additive SERVER scoping. When the workspace declares a server
    // allowlist (mcpAllowedServers), ONLY calls proxied to those servers may
    // proceed — checked ahead of the per-tool allowlist below since a
    // disallowed server should never even reach tool-name evaluation. Same
    // empty-means-unrestricted convention as every allowlist in this file,
    // and — deliberately, like the tool-scoping check right below it — NOT
    // gated on `failOpen`: an explicit, non-empty allowlist that excludes
    // this server is a definite policy decision the proxy already has the
    // data to make, not a "control plane unreachable" failure mode. A
    // control-plane outage naturally fails open here too, for the same
    // reason it does for tool scoping: an unreachable policy fetch leaves
    // `allowedServers` empty, which reads as unrestricted rather than as a
    // block.
    const allowedServers = this.policy.getAllowedServers()
    if (allowedServers.length > 0 && !allowedServers.includes(this.serverName)) {
      const reason =
        `MCP server "${this.serverName}" is not in this workspace's MCP server allowlist ` +
        `(${allowedServers.length} server(s) permitted). An operator can widen the ` +
        `allowlist in workspace settings (mcpAllowedServers).`
      log.warn({ action: 'server_allowlist_block', serverName: this.serverName, toolName }, reason)
      this.emitter.emit('tool_blocked', toolName, toolInput, reason)
      return block('SERVER_NOT_ALLOWED', 'mcpAllowedServers', reason)
    }

    // 0. Additive tool scoping. When the workspace declares an allowlist,
    // ONLY those tools may be called — the inverse of every other rule here,
    // which names what is forbidden. An EMPTY allowlist means unrestricted,
    // never "permit nothing": read the other way it would block every
    // workspace that never declared one, which is the exact inversion the
    // starter rules' harness-allowlist near-miss exists to catch.
    const allowedTools = this.policy.getAllowedTools()
    if (allowedTools.length > 0 && !allowedTools.includes(toolName)) {
      const reason =
        `Tool "${toolName}" is not in this workspace's MCP tool allowlist ` +
        `(${allowedTools.length} tool(s) permitted). An operator can widen the ` +
        `allowlist in workspace settings (mcpAllowedTools).`
      log.warn({ action: 'allowlist_block', toolName }, reason)
      this.emitter.emit('tool_blocked', toolName, toolInput, reason)
      return block('TOOL_NOT_ALLOWED', 'mcpAllowedTools', reason)
    }

    // 0.5. SSO group clearance, after the scoping checks and before DLP.
    const clearance = this.checkSsoGroupClearance(toolName, toolInput)
    if (clearance) return clearance

    // 1. DLP scan — with the workspace's own patterns loaded first, so a
    // control-plane-defined pattern reaches the same scanner as the floor.
    try {
      setDynamicPatterns(this.policy.getDlpPatterns())
    } catch {
      // Pattern delivery must never take the scanner down; the floor stands.
    }
    // The workspace's PII detector actions, the baseline this machine's
    // INTUTIC_MCP_DLP_DETECTORS may only tighten. When the control plane
    // could not read them, which detectors the workspace requires is
    // unknown: fail-closed refuses the call, as the LLM proxy refuses the
    // request; fail-open scans with the local config alone.
    const piiDetectors = this.policy.getPiiDetectors()
    if (piiDetectors.kind === 'unreadable' && !this.failOpen) {
      const reason =
        `This workspace's PII detector actions could not be read (${piiDetectors.reason}), so which ` +
        `detectors apply is unknown. Tool call blocked (fail-closed mode: mcpProxyFailBehavior or ` +
        `INTUTIC_MCP_FAIL_OPEN=false).`
      log.warn({ action: 'pii_detectors_unreadable_block', toolName }, reason)
      this.emitter.emit('tool_blocked', toolName, toolInput, reason)
      return block('GOVERNANCE_UNAVAILABLE', 'piiDetectors', reason)
    }
    setWorkspacePii(piiDetectors)
    try {
      const dlp = scanToolInput(toolInput)
      // Captured regardless of outcome — by pipeline position, a non-empty
      // result here always blocks below, so `dlpFindingsForContext` is
      // honestly almost always `[]` by the time Phase 3 reads it (a
      // property of the pipeline order, not a bug in this capture).
      dlpFindingsForContext = dlp.findings
      if (dlp.hasFinding) {
        const reason = formatDlpBlockReason(dlp.findings)
        log.warn({ action: 'dlp_block', toolName, findings: dlp.findings }, 'DLP block')
        this.emitter.emit('tool_blocked', toolName, toolInput, reason)
        return block('DLP', `dlp.${dlp.findings[0]?.pattern ?? 'input'}`, reason)
      }
    } catch (err) {
      log.error({ action: 'dlp_error', err: (err as Error).message }, 'DLP scan error — skipping')
      if (!this.failOpen) return block('GOVERNANCE_UNAVAILABLE', 'mcpProxyFailBehavior', FAIL_CLOSED_REASON)
    }

    // 2. SOP policy rule match
    try {
      const toolInputJson = JSON.stringify(toolInput ?? {})
      const rule = this.policy.matchRule(toolName, toolInputJson)
      if (rule) {
        if (rule.action === 'block') {
          log.warn({ action: 'policy_block', toolName, ruleId: rule.id, reason: rule.reason }, 'Policy block')
          this.emitter.emit('tool_blocked', toolName, toolInput, rule.reason)
          return block('SOP_RULE', rule.id, rule.reason)
        }
        if (rule.action === 'warn') {
          log.warn({ action: 'policy_warn', toolName, ruleId: rule.id, reason: rule.reason }, 'Policy warning (allowing)')
          // Fall through to allow. Reported as `tool_flagged` with the rule id
          // in the reason — the same shape the harness gates use — so a
          // SHADOW guardrail's evidence (LLD #71) counts this proxy's traffic.
          this.emitter.emit('tool_flagged', toolName, toolInput, `${rule.reason} [${rule.id}]`)
        }
        if (rule.action === 'require_approval') {
          const held = await this.hold(rule, toolName, toolInput)
          if (held) return held
          // An approved bypass: the remaining checks still apply.
        }
      }
    } catch (err) {
      log.error({ action: 'policy_error', err: (err as Error).message }, 'Policy evaluation error')
      if (!this.failOpen) return block('GOVERNANCE_UNAVAILABLE', 'mcpProxyFailBehavior', FAIL_CLOSED_REASON)
    }

    // 3. Prompt-injection scan (request direction) — the `toolInput` a
    // MISBEHAVING or COMPROMISED calling agent sends, e.g. an agent that
    // itself already ingested injected content from an earlier step and is
    // now echoing instructions into its own tool call. Pipeline position
    // mirrors the Rust proxy's own ordering: after DLP/SOP, before anomaly
    // detection and WASM rules (neither exists yet in this package — Phase
    // 2/3 land after this).
    try {
      const toolInputText = JSON.stringify(toolInput ?? {})
      setDynamicInjectionPatterns(this.policy.getInjectionPatterns())
      const findings = scanText(toolInputText)
      if (findings.length > 0) {
        injectionFindingsForContext = findings
        injectionSourcesForContext = ['tool_input']
        const severity = injectionSeverity(findings, 'tool_input')
        const reason = `Prompt-injection pattern(s) detected in tool input: ${findings.join(', ')}`
        log.warn(
          { action: 'injection_detected', toolName, patterns: findings, source: 'tool_input', severity },
          'Prompt-injection pattern matched in tool call input',
        )
        const injectionAction = this.policy.getInjectionAction() ?? this.injectionActionDefault
        this.emitter.emit('injection_detected', toolName, toolInput, reason, {
          detectorId: 'injection:tool_input',
          kind: 'prompt_injection',
          disposition: injectionAction === 'block' ? 'kill' : 'steer',
          severity,
          confidence: 1,
        })
        if (injectionAction === 'block') {
          this.emitter.emit('tool_blocked', toolName, toolInput, reason)
          return block('INJECTION', 'injection.tool_input', reason)
        }
        // 'warn' (default): report only, fall through to allow.
      }
    } catch (err) {
      // Never let a scanner failure take the proxy down — same posture as
      // the DLP/SOP try/catches above, and unconditionally non-fatal (unlike
      // those) because injection scanning's own default disposition is
      // report-only, so a scanner error degrading to "scan skipped" is no
      // more permissive than the feature's own warn default.
      log.error({ action: 'injection_scan_error', err: (err as Error).message }, 'Injection scan error — skipping')
    }

    // 4. Anomaly detection (Phase 2) — the 7 detectors ported from
    // `packages/proxy/src/plugins/anomaly/detectors.rs`; see
    // `anomaly/detectors.ts`. Five (consecutive_repeat, ping_pong_cycle,
    // landmark_cycle, tool_diversity_collapse, code_as_action) are
    // sequence/current-call detectors evaluated here, on every request; the
    // other two (tool_poisoning, dlp_escalation) read data this pipeline
    // stage does not have (a cached tools/list, response-direction DLP
    // findings) and run from `proxy.ts`'s response-direction handling
    // instead. Position: after injection, before WASM (Phase 3, not yet
    // built) and allow.
    const anomalyMode: AnomalyMode = this.policy.getAnomalyMode() ?? this.anomalyModeDefault
    // The session window — the shared one across this session's sibling
    // proxy processes when a store is configured (Wave 5.3, TD-437), the
    // per-process one otherwise. One round trip at most per tools/call, and
    // none when nothing below would read it.
    const window = anomalyMode !== 'off' || this.wasmRunner ? await this.session.loadWindow(toolName) : undefined
    if (anomalyMode !== 'off' && window) {
      try {
        const prospective = window.prospective
        const findings = evaluateSequenceDetectors(prospective, toolName, toolInput)
        corroboratingDetectorsForContext = findings.length
        const overrides = { ...this.anomalyOverridesDefault, ...this.policy.getAnomalyOverrides() }
        for (const finding of findings) {
          const effective: Disposition | 'off' = resolveEffectiveDisposition(finding, anomalyMode, overrides)
          if (effective === 'off') continue // demoted below reporting entirely — skip silently

          const severity = effective === 'kill' ? 'high' : effective === 'reask' ? 'medium' : 'low'
          log.warn(
            {
              action: 'anomaly_detected',
              toolName,
              detectorId: finding.detectorId,
              kind: finding.kind,
              disposition: effective,
              confidence: finding.confidence,
            },
            'Anomaly detector fired',
          )
          this.emitter.emit('anomaly_detected', toolName, toolInput, finding.reason, detectionFinding(finding, effective, severity))

          if (effective === 'kill') {
            this.emitter.emit('tool_blocked', toolName, toolInput, finding.reason)
            return block('ANOMALY', finding.detectorId, finding.reason)
          }

          if (effective === 'reask') {
            // Keyed per-detector-id, independent of every other detector's
            // (and every WASM rule's — see applyReaskLadder) own counter.
            return await this.applyReaskLadder(finding.detectorId, finding.reason, toolName, toolInput)
          }

          // 'steer': report only. Findings are sorted most-severe-first
          // (evaluateSequenceDetectors), so once we reach a 'steer' finding
          // every remaining one is 'steer' too — keep logging/emitting them,
          // then fall through to allow.
        }
      } catch (err) {
        // Same non-fatal posture as the injection scanner above: an anomaly
        // detector is a pure function of in-memory state, but a defensive
        // catch here means a bug in one detector degrades to "this call's
        // anomaly check was skipped," never "the proxy crashed."
        log.error({ action: 'anomaly_detection_error', err: (err as Error).message }, 'Anomaly detection error — skipping')
      }
    }

    // 5. WASM custom rules (Phase 3) — operator-authored rules, native or
    // Rego: the workspace's, uploaded to the control plane, and this
    // machine's, dropped into `~/.intutic/wasm/`. Position: after every
    // built-in check, immediately before allow — this is deliberately the
    // LAST gate, so a WASM rule's `RequestContext` carries
    // `injection_findings`/`corroborating_detectors`/etc. already populated
    // by the steps above it (see `wasm/context.ts`'s module doc).
    if (this.wasmRunner) {
      const unloaded = await this.checkCloudRulesLoaded(this.wasmRunner, toolName, toolInput)
      if (unloaded) return unloaded
      try {
        const verdict = await this.wasmRunner.evaluate({
          sessionId: this.session.sessionId,
          workspaceId: this.workspaceId,
          tools: this.session.getToolsList(),
          toolCallId: node_crypto.randomUUID(),
          toolName,
          toolArguments: toolInput,
          toolSequence: window?.prospective ?? this.session.prospectiveSequence(toolName),
          callsLast60s: window?.callsLast60s ?? this.session.callsInLastMs(),
          dlpFindingDescriptions: dlpFindingsForContext.map((f) => f.description),
          injectionFindings: injectionFindingsForContext,
          injectionSources: injectionSourcesForContext,
          corroboratingDetectors: corroboratingDetectorsForContext,
          toolContractChanged: this.session.getToolContractChanged(),
          serverName: this.serverName,
        })

        if (verdict.code === 'unavailable') {
          // A rule reached no verdict: refused whatever `failOpen` says (see
          // `WasmRunner.evaluate`). Reported like any refusal, except a
          // quarantined rule's: the call that quarantined it was reported
          // already, and one event per refused call after it would file an
          // incident per retry.
          log.warn({ action: 'wasm_unavailable_block', toolName, ruleId: verdict.ruleId, stop: verdict.stop }, verdict.reason)
          if (verdict.stop !== 'quarantined') this.emitter.emit('tool_blocked', toolName, toolInput, verdict.reason)
          return block('GOVERNANCE_UNAVAILABLE', `wasm:${verdict.ruleId}`, verdict.reason)
        }
        if (verdict.code === 'block') {
          log.warn({ action: 'wasm_block', toolName, ruleId: verdict.ruleId }, 'Tool call blocked by WASM governance rule')
          this.emitter.emit('tool_blocked', toolName, toolInput, verdict.reason)
          return block('WASM_RULE', `wasm:${verdict.ruleId}`, verdict.reason)
        }
        if (verdict.code === 'reask') {
          // Keyed per-rule-id, independent of every anomaly detector's own
          // counter — see applyReaskLadder's doc comment.
          return await this.applyReaskLadder(`wasm:${verdict.ruleId}`, verdict.reason, toolName, toolInput)
        }
        if (verdict.code === 'hold') {
          // A Rego rule's hold takes the `require_approval` path: the same
          // approved-bypass lookup and hold record, keyed on the rule id.
          const held = await this.hold({ id: verdict.ruleId, reason: verdict.reason }, toolName, toolInput)
          if (held) return held
          // An approved bypass: the remaining checks still apply.
        }
        // 'allow': fall through.
      } catch (err) {
        // The runner itself failed (not one rule's timeout or trap, which
        // `WasmRunner.evaluate` turns into a verdict): no rule judged the
        // call, so it is refused like a rule that reached no verdict, whatever
        // the fail setting.
        log.error({ action: 'wasm_evaluate_error', err: (err as Error).message }, 'WASM rule evaluation error')
        return block(
          'GOVERNANCE_UNAVAILABLE',
          'wasm',
          `Custom rules could not be evaluated: ${(err as Error).message}. Tool call blocked: a rule ` +
            `that cannot decide never allows.`,
        )
      }
    }

    // 6. MCP call budgets — after every other check, so a call another check
    // refuses never spends allowance.
    const budgetDecision = await this.checkBudgets(toolName, toolInput)
    if (budgetDecision) return budgetDecision

    // 7. Allow — emit telemetry event
    this.emitter.emit('tool_allowed', toolName, toolInput)
    return { action: 'allow' }
  }

  /**
   * Counts the call against every budget that covers it, or refuses it when
   * one is used up. The threshold and exceeded events go out once per budget
   * per period (the store claims them), each as a `budget_breach` finding; a
   * refusal also sends `tool_blocked`, as every refusal does, carrying the
   * budget — the control plane files one incident per budget per period from
   * those and counts the rest on it.
   *
   * When the count cannot be checked, the fail setting decides, as for every
   * other governance check that cannot complete.
   */
  private async checkBudgets(toolName: string, toolInput: unknown): Promise<Decision | null> {
    if (!this.budgets) return null
    const policy = this.policy.getMcpBudgets()
    const verdict = await this.budgets.check(policy, toolName, this.policy.getPrincipal()?.memberId ?? null)

    if (verdict.kind === 'unlimited') return null
    if (verdict.kind === 'allowed') {
      for (const standing of verdict.warnings) {
        const reason = warningReason(standing, policy.warnAtPct)
        log.warn({ action: 'mcp_budget_threshold', toolName, budgetId: standing.budget.id, used: standing.used }, reason)
        this.emitter.emit(
          'mcp_budget_threshold',
          toolName,
          undefined,
          reason,
          { detectorId: 'budget', kind: 'budget_breach', disposition: 'steer', severity: 'low', confidence: 1 },
          budgetEventDetail(standing),
        )
      }
      return null
    }
    if (verdict.kind === 'exceeded') {
      const reason = exceededReason(verdict.standing)
      log.warn({ action: 'mcp_budget_exceeded', toolName, budgetId: verdict.standing.budget.id, notify: verdict.notify }, reason)
      if (verdict.notify) {
        this.emitter.emit(
          'mcp_budget_exceeded',
          toolName,
          undefined,
          reason,
          { detectorId: 'budget', kind: 'budget_breach', disposition: 'kill', severity: 'medium', confidence: 1 },
          budgetEventDetail(verdict.standing),
        )
      }
      const detail = budgetEventDetail(verdict.standing)
      this.emitter.emit('tool_blocked', toolName, toolInput, reason, undefined, detail)
      return block('BUDGET_EXCEEDED', detail.budgetId, reason, { ...detail })
    }

    // Unavailable: no Valkey configured, or it did not answer.
    if (this.failOpen) {
      if (!this.budgetsUncheckedWarned) {
        this.budgetsUncheckedWarned = true
        log.warn(
          { action: 'mcp_budget_unchecked', budgets: verdict.budgets.map((b) => b.id) },
          'MCP call budgets cover calls through this proxy but could not be checked (no Valkey, or unreachable); ' +
            'allowing them uncounted (fail-open)',
        )
      }
      return null
    }
    const reason = unavailableReason(verdict.budgets)
    log.warn({ action: 'mcp_budget_unchecked_block', toolName }, reason)
    this.emitter.emit('tool_blocked', toolName, toolInput, reason)
    return block('BUDGET_UNAVAILABLE', 'mcpProxyFailBehavior', reason, { budgetIds: verdict.budgets.map((b) => b.id) })
  }
}
