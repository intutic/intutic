/**
 * interceptor.ts — tools/call decision engine.
 *
 * Given a tool name and arguments, evaluates:
 * 1. DLP scan (credential / destructive pattern detection)
 * 2. SOP policy rules (fetched from control plane via PolicyClient)
 *
 * Returns an allow / block / redact decision.
 *
 * @module
 */

import * as node_crypto from 'node:crypto'
import { createStderrLogger as createLogger } from './stderrLog.js'
import { scanToolInput, formatDlpBlockReason, setDynamicPatterns } from './dlp.js'
import type { DlpFinding } from './dlp.js'
import { scanText, injectionSeverity } from './injection.js'
import { evaluateSequenceDetectors, resolveEffectiveDisposition, REASK_MAX_ATTEMPTS } from './anomaly/index.js'
import type { AnomalyMode, Disposition } from './anomaly/index.js'
import { SessionState } from './session.js'
import type { WasmRunner } from './wasm/runner.js'
import type { PolicyClient } from './policy.js'
import type { GovernanceEmitter } from './emitter.js'

const log = createLogger('mcp-proxy-interceptor')

export type Decision =
  | { action: 'allow' }
  | { action: 'block'; reason: string }
  | { action: 'redact'; reason: string; redactedInput: unknown }

export class ToolCallInterceptor {
  constructor(
    private readonly policy: PolicyClient,
    private readonly emitter: GovernanceEmitter,
    private readonly failOpen: boolean = true,
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
  ) {}

  /**
   * Applies the shared reask ladder (Phase 2 anomaly detectors AND Phase 3
   * WASM rules both use this): a session-lifetime attempt counter keyed by
   * `key`, `REASK_MAX_ATTEMPTS` (3) tries before hardening into an
   * unconditional block. Always emits `tool_blocked` — a reask blocks the
   * CURRENT attempt, so existing consumers keyed on `tool_blocked` must see
   * it, exactly like every other new block reason in this package.
   */
  private applyReaskLadder(key: string, baseReason: string, toolName: string, toolInput: unknown): Decision {
    const attempts = this.session.incrReaskAttempt(key)
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
        // 'require_approval' treated as block in headless proxy (no interactive UI)
        if (rule.action === 'require_approval') {
          const reason = `Tool requires human approval per SOP rule ${rule.id}: ${rule.reason}`
          log.warn({ action: 'policy_approval_required', toolName, ruleId: rule.id }, reason)
          this.emitter.emit('tool_blocked', toolName, toolInput, reason)
          return { action: 'block', reason }
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
        this.emitter.emit('injection_detected', toolName, toolInput, reason, severity)
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
    if (anomalyMode !== 'off') {
      try {
        const prospective = this.session.prospectiveSequence(toolName)
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
          this.emitter.emit('anomaly_detected', toolName, toolInput, finding.reason, severity)

          if (effective === 'kill') {
            this.emitter.emit('tool_blocked', toolName, toolInput, finding.reason)
            return { action: 'block', reason: finding.reason }
          }

          if (effective === 'reask') {
            // Keyed per-detector-id, independent of every other detector's
            // (and every WASM rule's — see applyReaskLadder) own counter.
            return this.applyReaskLadder(finding.detectorId, finding.reason, toolName, toolInput)
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
          toolSequence: this.session.prospectiveSequence(toolName),
          callsLast60s: this.session.callsInLastMs(),
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
          return this.applyReaskLadder(`wasm:${verdict.ruleId}`, verdict.reason, toolName, toolInput)
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

    // 6. Allow — emit telemetry event
    this.emitter.emit('tool_allowed', toolName, toolInput)
    return { action: 'allow' }
  }
}
