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

export type EventKind = 'tool_allowed' | 'tool_blocked' | 'tool_redacted'

export interface GovernanceEvent {
  incidentId: string
  kind: EventKind
  toolName: string
  toolInput: unknown
  workspaceId: string
  harnessType: string
  reason?: string
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

  emit(kind: EventKind, toolName: string, toolInput: unknown, reason?: string): void {
    const event: GovernanceEvent = {
      incidentId: node_crypto.randomUUID(),
      kind,
      toolName,
      toolInput,
      workspaceId: this.workspaceId,
      harnessType: 'mcp-governance-proxy',
      reason,
      timestamp: new Date().toISOString(),
    }

    if (this.mcpProxyMode === 'daemon') {
      const eventPayload = {
        event: kind === 'tool_blocked' ? 'tool_blocked' : 'tool_allowed',
        toolName,
        workspaceId: this.workspaceId,
        harnessType: 'mcp-governance-proxy',
        timestamp: event.timestamp,
        reason,
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
          event: event.kind === 'tool_blocked' ? 'tool_blocked' : 'tool_allowed',
          toolName: event.toolName,
          toolInput: event.toolInput,
          workspaceId: event.workspaceId,
          harnessType: event.harnessType,
          incidentId: event.incidentId,
          reason: event.reason,
          timestamp: event.timestamp,
        },
      ],
    })

    const url = `${this.controlPlaneUrl}/api/v1/telemetry/enqueue`
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
        res.on('end', resolve)
      }
    )
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('HTTP POST timed out')) })
    req.write(body)
    req.end()
  })
}
