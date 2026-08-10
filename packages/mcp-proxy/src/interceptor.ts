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

import { createStderrLogger as createLogger } from './stderrLog.js'
import { scanToolInput, formatDlpBlockReason, setDynamicPatterns } from './dlp.js'
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
    private readonly failOpen: boolean = true
  ) {}

  /**
   * Evaluate a tools/call request and return a governance decision.
   *
   * @param toolName - The MCP tool name (e.g. "mcp__filesystem__read_file" or "Bash")
   * @param toolInput - The tool_input / arguments object
   * @returns Decision: allow, block, or redact
   */
  async decide(toolName: string, toolInput: unknown): Promise<Decision> {
    log.debug({ action: 'interceptor_decide', toolName }, 'Evaluating tool call')

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
          // Fall through to allow — warnings are logged only
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

    // 3. Allow — emit telemetry event
    this.emitter.emit('tool_allowed', toolName, toolInput)
    return { action: 'allow' }
  }
}
