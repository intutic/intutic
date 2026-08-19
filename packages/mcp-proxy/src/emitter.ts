/**
 * emitter.ts — Dual-path governance event emitter.
 *
 * Path A: HTTP POST to /api/v1/hook-events (same endpoint as claudeCodeHooks.ts)
 * Path B: Append JSONL line to ~/.intutic/events/hook-events.jsonl
 *
 * Mirrors the dual-path pattern from claudeCodeHooks.ts / syncLoop.ts.
 *
 * @module
 */

import * as node_fs from 'node:fs/promises'
import * as node_https from 'node:https'
import * as node_http from 'node:http'
import * as node_path from 'node:path'
import * as node_crypto from 'node:crypto'
import { createStderrLogger as createLogger } from './stderrLog.js'
import { callDaemonSocket } from './daemonClient.js'

const log = createLogger('mcp-proxy-emitter')

export type EventKind =
  | 'tool_allowed'
  | 'tool_blocked'
  | 'tool_redacted'
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

export interface GovernanceEvent {
  incidentId: string
  kind: EventKind
  toolName: string
  toolInput: unknown
  workspaceId: string
  harnessType: string
  reason?: string
  /**
   * Set only by `injection_detected`/`anomaly_detected` today — the
   * escalation-rule mirror `injection.ts`'s `injectionSeverity` (Phase 1) and
   * the per-detector disposition mapping (Phase 2) compute. Absent on every
   * other event kind, matching how `reason` is already optional here.
   */
  severity?: string
  timestamp: string
}

export class GovernanceEmitter {
  constructor(
    private readonly controlPlaneUrl: string,
    private readonly apiKey: string,
    private readonly eventsFilePath: string,
    private readonly workspaceId: string,
    private readonly mcpProxyMode: string = 'per-session'
  ) {}

  emit(kind: EventKind, toolName: string, toolInput: unknown, reason?: string, severity?: string): void {
    const event: GovernanceEvent = {
      incidentId: node_crypto.randomUUID(),
      kind,
      toolName,
      toolInput,
      workspaceId: this.workspaceId,
      harnessType: 'mcp-governance-proxy',
      reason,
      severity,
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
        timestamp: event.timestamp,
        reason,
        severity,
        toolInput,
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
          reason: event.reason,
          severity: event.severity,
          timestamp: event.timestamp,
        },
      ],
    })

    // POST /api/v1/hook-events — the batch governance-event ingest whose
    // BatchHookEventsSchema this payload already matches exactly. Path A used
    // to post to /api/v1/telemetry/enqueue, an endpoint that never existed in
    // the control plane; because httpPost resolved on any response, every
    // tool_allowed/tool_blocked event 404'd silently and the 'Path A failed'
    // warning never fired.
    const url = `${this.controlPlaneUrl}/api/v1/hook-events`
    await httpPost(url, this.apiKey, payload)
  }

  private async appendToFile(event: GovernanceEvent): Promise<void> {
    const dir = node_path.dirname(this.eventsFilePath)
    await node_fs.mkdir(dir, { recursive: true })
    const line = JSON.stringify(event) + '\n'
    await node_fs.appendFile(this.eventsFilePath, line, 'utf-8')
  }
}

function httpPost(url: string, apiKey: string, body: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const lib = parsed.protocol === 'https:' ? node_https : node_http
    const req = lib.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Bearer ${apiKey}`,
        },
        timeout: 4000,
      },
      (res) => {
        // Drain response body to free socket
        res.resume()
        res.on('end', () => {
          // Reject on error statuses so a wrong or removed endpoint surfaces as
          // a caller-visible failure instead of silently succeeding.
          const status = res.statusCode ?? 0
          if (status >= 400) {
            reject(new Error(`HTTP POST ${url} returned ${status}`))
            return
          }
          resolve()
        })
      }
    )
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('HTTP POST timed out')) })
    req.write(body)
    req.end()
  })
}
