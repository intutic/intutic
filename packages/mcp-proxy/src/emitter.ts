/**
 * emitter.ts — Dual-path governance event emitter.
 *
 * Path A: HTTP POST to /api/v1/hook-events (same endpoint as claudeCodeHooks.ts)
 * Path B: Append JSONL line to ~/.intutic/events/hook-events.jsonl
 *
 * Mirrors the dual-path pattern from claudeCodeHooks.ts.
 *
 * @module
 */

import * as node_fs from 'node:fs/promises'
import * as node_path from 'node:path'
import * as node_crypto from 'node:crypto'
import { createStderrLogger as createLogger } from './stderrLog.js'
import { callDaemonSocket } from './daemonClient.js'
import { httpRequest } from './httpJson.js'
import type { CallerIdentity } from './identity.js'
import type { AnomalyFinding } from './anomaly/index.js'
import type { BudgetEventDetail } from './budget.js'

const log = createLogger('mcp-proxy-emitter')

export type EventKind =
  | 'tool_allowed'
  | 'tool_blocked'
  | 'tool_redacted'
  /**
   * A `warn` SOP rule matched and the call was allowed: the same
   * event the harness gates log for a warn-severity rule, carrying the rule
   * id as `[<id>]` in `reason`, so a SHADOW guardrail seen through this
   * proxy counts toward its evidence like one seen through a gate.
   */
  | 'tool_flagged'
  /**
   * Server-level TOFU pin mismatch (tofu.ts) — a server's `tools/list`
   * response no longer matches the fingerprint pinned on first contact. Sent
   * with `toolName` carrying the SERVER name (there is no single tool
   * involved), the same "reuse toolName as the identifier of whatever this
   * event is about" shape `tool_blocked`/`tool_allowed` already use.
   */
  | 'mcp_server_definition_changed'
  /**
   * A prompt-injection pattern fired (injection.ts), on any of the three
   * scanned surfaces (`tool_result`/`tool_description`/`tool_input`). Always
   * emitted regardless of `mcpInjectionAction` — warn mode reports and
   * allows, block mode reports and additionally emits `tool_blocked` (see
   * interceptor.ts / proxy.ts) so existing consumers keyed on `tool_blocked`
   * are not blind to this new block reason.
   */
  | 'injection_detected'
  /**
   * A Phase-2 anomaly detector (anomaly/detectors.ts) fired against the
   * session's tool-call sequence. Emitted on Steer (allow) and on Reask/Kill
   * (block) alike — a Reask/Kill firing ALSO emits `tool_blocked`, the same
   * "existing consumers key on it" rule `injection_detected` follows.
   */
  | 'anomaly_detected'
  /**
   * A `require_approval` rule held the call for a person's decision
   * (approvalHold.ts). `reason` carries the rule id as `[<id>]`, as the hook
   * gates' hold events do.
   */
  | 'tool_held'
  /** An approved, unexpired, exact-match bypass let a held call through. */
  | 'hold_approved_bypass_used'
  /**
   * An MCP call budget (budget.ts) reached its warning threshold. Once per
   * budget per period, across every proxy sharing the Valkey; carries
   * `budget` and a finding. The call itself was allowed.
   */
  | 'mcp_budget_threshold'
  /**
   * An MCP call budget is used up. Once per budget per period, on the first
   * refusal; every refusal also sends its own `tool_blocked`.
   */
  | 'mcp_budget_exceeded'

/**
 * What a detection-style event found, so the control plane can file it as a
 * detector finding (adjudicable on the Findings page, routed as
 * `anomaly.finding`). Carried by `injection_detected`, `anomaly_detected` and
 * `tool_redacted` — the events that report something seen rather than a
 * verdict on the call, which `tool_allowed`/`tool_blocked` carry.
 */
export interface DetectionFinding {
  /** This proxy's detector id, e.g. `consecutive_repeat` or `injection:tool_result`. */
  detectorId: string
  /** A taxonomy label (`anomaly-taxonomy`), lower-cased like the detectors' own. */
  kind: string
  /** What the finding did to the call or result. */
  disposition: 'steer' | 'reask' | 'kill'
  severity: 'low' | 'medium' | 'high'
  /** 0.0–1.0. A pattern match is certain about the pattern: 1. */
  confidence: number
}

/** An anomaly detector's finding as a {@link DetectionFinding}, with what it actually did. */
export function detectionFinding(
  finding: AnomalyFinding,
  disposition: DetectionFinding['disposition'],
  severity: DetectionFinding['severity'],
): DetectionFinding {
  return { detectorId: finding.detectorId, kind: finding.kind, disposition, severity, confidence: finding.confidence }
}

export interface GovernanceEvent {
  incidentId: string
  /**
   * This event's id, made once in {@link GovernanceEmitter.emit} and carried
   * on every path it is delivered by — the daemon socket, the direct post and
   * the event file — so the control plane processes it once however many of
   * them, and their retries, arrive.
   */
  eventId: string
  kind: EventKind
  toolName: string
  toolInput: unknown
  workspaceId: string
  harnessType: string
  reason?: string
  /** The finding's severity, for readers of the local event file. */
  severity?: string
  /** Set on detection events; see {@link DetectionFinding}. */
  finding?: DetectionFinding
  /**
   * Who made the call, as this proxy observed it (identity.ts). The control
   * plane adds the member the API key resolves to when it ingests the event.
   * Absent only for an emitter constructed without one.
   */
  principal?: CallerIdentity
  /**
   * Set on the budget events, and on the `tool_blocked` of a call a used-up
   * budget refused: which budget, its limit, the calls made, when it resets.
   */
  budget?: BudgetEventDetail
  timestamp: string
}

export class GovernanceEmitter {
  constructor(
    private readonly controlPlaneUrl: string,
    private readonly apiKey: string,
    private readonly eventsFilePath: string,
    private readonly workspaceId: string,
    private readonly mcpProxyMode: string = 'per-session',
    private readonly identity: CallerIdentity | undefined = undefined,
  ) {}

  emit(
    kind: EventKind,
    toolName: string,
    toolInput: unknown,
    reason?: string,
    finding?: DetectionFinding,
    budget?: BudgetEventDetail,
  ): void {
    const event: GovernanceEvent = {
      incidentId: node_crypto.randomUUID(),
      eventId: node_crypto.randomUUID(),
      kind,
      toolName,
      toolInput,
      workspaceId: this.workspaceId,
      harnessType: 'mcp-governance-proxy',
      reason,
      severity: finding?.severity,
      finding,
      principal: this.identity,
      budget,
      timestamp: new Date().toISOString(),
    }

    if (this.mcpProxyMode === 'daemon') {
      const eventPayload = {
        // `tool_redacted` was declared in EventKind and collapsed to
        // `tool_allowed` here since the type existed — a redaction the audit
        // trail recorded as a plain allow. The kind passes through as itself.
        event: kind,
        toolName,
        workspaceId: this.workspaceId,
        harnessType: 'mcp-governance-proxy',
        incidentId: event.incidentId,
        eventId: event.eventId,
        timestamp: event.timestamp,
        reason,
        severity: event.severity,
        finding,
        toolInput,
        principal: event.principal,
        budget,
      }
      callDaemonSocket('telemetry.enqueue', eventPayload).then(() => {
        log.debug({ action: 'telemetry_enqueued' }, 'Telemetry successfully enqueued to daemon')
      }).catch((err) => {
        log.warn({ action: 'telemetry_daemon_failed', err: err.message }, 'Failed to enqueue telemetry to daemon socket — falling back to dual-path')
        this.runDualPath(event)
      })
      return
    }

    this.runDualPath(event)
  }

  private runDualPath(event: GovernanceEvent): void {
    // Path A: HTTP POST (best effort)
    this.postToControlPlane(event).catch((err) => {
      log.warn({ action: 'emit_path_a_failed', err: (err as Error).message }, 'Path A emission failed')
    })

    // Path B: JSONL file append (best effort)
    this.appendToFile(event).catch((err) => {
      log.warn({ action: 'emit_path_b_failed', err: (err as Error).message }, 'Path B emission failed')
    })
  }

  private async postToControlPlane(event: GovernanceEvent): Promise<void> {
    const payload = JSON.stringify({
      events: [
        {
          // Same collapse as the daemon path had: the kind IS the event.
          event: event.kind,
          toolName: event.toolName,
          toolInput: event.toolInput,
          workspaceId: event.workspaceId,
          harnessType: event.harnessType,
          incidentId: event.incidentId,
          eventId: event.eventId,
          reason: event.reason,
          severity: event.severity,
          finding: event.finding,
          principal: event.principal,
          budget: event.budget,
          timestamp: event.timestamp,
        },
      ],
    })

    // POST /api/v1/hook-events — the batch governance-event ingest whose
    // BatchHookEventsSchema this payload already matches exactly. Path A used
    // to post to /api/v1/telemetry/enqueue, an endpoint that never existed in
    // the control plane; because the old helper resolved on any response,
    // every tool_allowed/tool_blocked event 404'd silently and the 'Path A
    // failed' warning never fired. httpRequest rejects on an error status.
    const url = `${this.controlPlaneUrl}/api/v1/hook-events`
    await httpRequest('POST', url, this.apiKey, payload, 4000)
  }

  private async appendToFile(event: GovernanceEvent): Promise<void> {
    const dir = node_path.dirname(this.eventsFilePath)
    await node_fs.mkdir(dir, { recursive: true })
    const line = JSON.stringify(event) + '\n'
    await node_fs.appendFile(this.eventsFilePath, line, 'utf-8')
  }
}
