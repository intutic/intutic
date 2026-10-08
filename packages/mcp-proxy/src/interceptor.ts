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
import { evaluateSsoGroupClearance } from '@intutic/shared-types'
import { scanToolInput, formatDlpBlockReason, setDynamicPatterns } from './dlp.js'
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

const log = createLogger('mcp-proxy-interceptor')

export type Decision =
  | { action: 'allow' }
  | { action: 'block'; reason: string }
  | { action: 'redact'; reason: string; redactedInput: unknown }
  /**
   * Refused for now, pending a person's approval (`require_approval`). Not a
   * block: the agent is told the hold id and to retry once it is approved,
   * which passes only while the workspace's review-hold bypass is on — see
   * approvalHold.ts.
   */
  | { action: 'hold'; reason: string; holdId: string }

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
  private async applyReaskLadder(key: string, baseReason: string, toolName: string, toolInput: unknown): Promise<Decision> {
    // Shared across the session's sibling proxy processes when a session
    // store is configured (Wave 5.3); the per-process counter otherwise.
    const attempts = await this.session.incrReaskAttemptShared(key)
    if (attempts > REASK_MAX_ATTEMPTS) {
      const hardenedReason =
        `${baseReason} — hardened to an unconditional block after ${REASK_MAX_ATTEMPTS} reask ` +
        `attempts with no correction.`
      log.warn({ action: 'reask_hardened', toolName, key, attempts }, 'Reask attempts exhausted — hardening to a hard block')
      this.emitter.emit('tool_blocked', toolName, toolInput, hardenedReason)
      return { action: 'block', reason: hardenedReason }
    }
    const reaskReason =
      `${baseReason} (attempt ${attempts}/${REASK_MAX_ATTEMPTS} — will become an unconditional ` +
      `block if this keeps tripping)`
    this.emitter.emit('tool_blocked', toolName, toolInput, reaskReason)
    return { action: 'block', reason: reaskReason }
  }

  /**
   * A `require_approval` rule matched. Returns the hold decision, or `null`
   * when an approved bypass for this exact call lets it continue. Every hold
   * reason names the hold id and the command that approves it, the same
   * wording the hook gates print, so a person reading the agent's transcript
   * knows what to run.
   */
  private async hold(rule: SopRule, toolName: string, toolInput: unknown): Promise<Decision | null> {
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
        `An approver can run: intutic decision approve ${outcome.holdId} (or reject it). ` +
        `Retry this exact call after it is approved.`
      : `HELD for approval: ${rule.reason} [${rule.id}], but the hold could not be recorded ` +
        `(Intutic control plane unreachable), so there is nothing to approve yet. Retry once the ` +
        `control plane is reachable to request approval.`
    log.warn({ action: 'tool_held', toolName, ruleId: rule.id, holdId: outcome.holdId, recorded: outcome.recorded }, reason)
    this.emitter.emit('tool_held', toolName, toolInput, `${rule.reason} [${rule.id}]`)
    return { action: 'hold', reason, holdId: outcome.holdId }
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
      return { action: 'block', reason }
    }

    let reason: string | null = null
    if (registry.blockedServers.includes(this.serverName)) {
      reason =
        `MCP server "${this.serverName}" is blocked in this workspace's MCP server registry. ` +
        `An owner or admin can change that on the MCP Servers page.`
    } else if (registry.heldServers.includes(this.serverName)) {
      reason =
        `MCP server "${this.serverName}" changed its tools in a way scored high risk, and this workspace ` +
        `holds such a server until it is approved again. It is waiting in the approval queue on the MCP ` +
        `Servers page for an owner or admin.`
    } else if (registry.defaultPolicy === 'deny' && !registry.approvedServers.includes(this.serverName)) {
      reason =
        `MCP server "${this.serverName}" is not approved in this workspace's MCP server registry, ` +
        `and the workspace refuses unapproved servers (mcpDefaultPolicy: deny). It is waiting in ` +
        `the approval queue on the MCP Servers page for an owner or admin.`
    } else if ((registry.disabledTools[this.serverName] ?? []).includes(toolName)) {
      reason =
        `Tool "${toolName}" is disabled on MCP server "${this.serverName}" in this workspace's ` +
        `MCP server registry. An owner or admin can re-enable it on the MCP Servers page.`
    }
    if (!reason) return null
    log.warn({ action: 'registry_block', serverName: this.serverName, toolName }, reason)
    this.emitter.emit('tool_blocked', toolName, toolInput, reason)
    return { action: 'block', reason }
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
    return { action: 'block', reason }
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
      return { action: 'block', reason }
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
      return { action: 'block', reason }
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
        return { action: 'block', reason }
      }
    } catch (err) {
      log.error({ action: 'dlp_error', err: (err as Error).message }, 'DLP scan error — skipping')
      if (!this.failOpen) {
        return {
          action: 'block',
          reason:
            'Governance check failed — Intutic control plane unreachable. ' +
            'Tool call blocked by workspace policy (fail-closed mode). ' +
            'Contact your administrator or update mcpProxyFailBehavior to open.',
        }
      }
    }

    // 2. SOP policy rule match
    try {
      const toolInputJson = JSON.stringify(toolInput ?? {})
      const rule = this.policy.matchRule(toolName, toolInputJson)
      if (rule) {
        if (rule.action === 'block') {
          log.warn({ action: 'policy_block', toolName, ruleId: rule.id, reason: rule.reason }, 'Policy block')
          this.emitter.emit('tool_blocked', toolName, toolInput, rule.reason)
          return { action: 'block', reason: rule.reason }
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
      if (!this.failOpen) {
        return {
          action: 'block',
          reason:
            'Governance check failed — Intutic control plane unreachable. ' +
            'Tool call blocked by workspace policy (fail-closed mode). ' +
            'Contact your administrator or update mcpProxyFailBehavior to open.',
        }
      }
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
          return { action: 'block', reason }
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
            return { action: 'block', reason: finding.reason }
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

    // 5. WASM custom rules (Phase 3) — operator-authored, compiled
    // AssemblyScript rules dropped into `~/.intutic/wasm/`. Position: after
    // every built-in check, immediately before allow — this is deliberately
    // the LAST gate, so a WASM rule's `RequestContext` carries
    // `injection_findings`/`corroborating_detectors`/etc. already populated
    // by the steps above it (see `wasm/context.ts`'s module doc).
    if (this.wasmRunner) {
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
        })

        if (verdict.code === 'block') {
          log.warn({ action: 'wasm_block', toolName, ruleId: verdict.ruleId }, 'Tool call blocked by WASM governance rule')
          this.emitter.emit('tool_blocked', toolName, toolInput, verdict.reason)
          return { action: 'block', reason: verdict.reason }
        }
        if (verdict.code === 'reask') {
          // Keyed per-rule-id, independent of every anomaly detector's own
          // counter — see applyReaskLadder's doc comment.
          return await this.applyReaskLadder(`wasm:${verdict.ruleId}`, verdict.reason, toolName, toolInput)
        }
        // 'allow': fall through.
      } catch (err) {
        // Fail-open, matching every other governance-check catch in this
        // method — a WASM runner failure (not to be confused with a single
        // rule's own timeout/trap, which `WasmRunner.evaluate` already
        // absorbs internally) must not take the whole proxy down.
        log.error({ action: 'wasm_evaluate_error', err: (err as Error).message }, 'WASM rule evaluation error — skipping')
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
      this.emitter.emit('tool_blocked', toolName, toolInput, reason, undefined, budgetEventDetail(verdict.standing))
      return { action: 'block', reason }
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
    return { action: 'block', reason }
  }
}
