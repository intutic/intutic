/**
 * HTTP client for the Intutic control plane's gate endpoints.
 *
 * Port of `packages/intutic-clawde/intutic_clawde/gate/client.py`.
 *
 * Endpoints used:
 *
 *   POST /api/v1/hook-gate       synchronous allow/deny  -> {allowed, reason, incidentId?}
 *   POST /api/v1/hook-events     batched telemetry       -> creates governance_incidents rows
 *
 * Two behaviours that must not be "improved":
 *
 *   * The hook-gate SERVER fails OPEN on its own error paths — it returns
 *     `{allowed:true}` on malformed input, schema mismatch, or DB error,
 *     because blocking a developer over a bad payload teaches people to
 *     disable the hook. This CLIENT, by contrast, defaults to FAIL-CLOSED
 *     (`failClosed=true`) for blocking decisions: a transport error or
 *     non-2xx response means we have no verdict at all to defer to, so
 *     `hookGate` reports `allowed=false`. Set `failClosed=false` to treat the
 *     tier as advisory, mirroring the server's own posture.
 *   * `emit` NEVER throws. Telemetry that can break a run is worse than no
 *     telemetry.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_TIMEOUT_MS = 2_000
const EVENT_TIMEOUT_MS = 2_000
const REASON_MAX = 512 // control plane truncates at 512; do it here so logs match

// Mirrors HookEventSchema in services/control-plane/src/routes/hookEvents.ts.
const VALID_EVENTS = new Set([
  'tool_blocked',
  'tool_allowed',
  'tool_flagged',
  'tool_would_block',
  'config_tamper',
  'network_bypass',
  'guards_disabled',
  'snapshot_absent',
  'snapshot_stale',
  'snapshot_invalid',
  'snapshot_empty',
])

export interface GateResponse {
  allowed: boolean
  reason: string
  incidentId?: string | undefined
  /** False when the call failed and `failClosed` decided the verdict. */
  reached: boolean
}

export interface GateClientOptions {
  baseUrl?: string
  apiKey?: string
  workspaceId?: string
  sessionId?: string
  /**
   * Attributes incidents to the right adapter. Sent as `harnessType` on every
   * gate call and event.
   */
  harness?: string
  failClosed?: boolean
  timeoutMs?: number
}

/**
 * Control-plane client for the pre-execution gate.
 *
 * `harness` defaults to `"generic"` and is sent as `harnessType` on every
 * gate call and event, so incidents attribute to the right adapter. Override
 * it when wrapping a specific framework (`mastra`, `vercel-ai`,
 * `langchainjs`, `dsh`, ...).
 */
export class GateClient {
  readonly baseUrl: string
  readonly apiKey: string
  readonly workspaceId: string
  readonly sessionId: string
  readonly harness: string
  readonly failClosed: boolean
  readonly timeoutMs: number

  constructor(opts: GateClientOptions = {}) {
    this.baseUrl = (opts.baseUrl || process.env.INTUTIC_CONTROL_PLANE_URL || 'https://api.intutic.ai').replace(
      /\/$/,
      '',
    )
    this.apiKey = opts.apiKey ?? ''
    this.workspaceId = opts.workspaceId ?? ''
    this.sessionId = opts.sessionId ?? ''
    this.harness = opts.harness ?? 'generic'
    this.failClosed = opts.failClosed ?? true
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  private async post(path: string, body: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(this.baseUrl + path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          'X-Workspace-Id': this.workspaceId,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${path}`)
      const text = await res.text()
      return text ? (JSON.parse(text) as Record<string, unknown>) : {}
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Synchronous allow/deny for one tool call.
   *
   * The endpoint matches ~19 DLP regexes against the serialised toolInput,
   * plus SOP rules. It is defence in depth on top of the local tiers, not a
   * replacement for them.
   *
   * When the call itself fails (transport error, non-2xx), the verdict is
   * decided by `failClosed`: true (the default) reports BLOCK, because a
   * client with no verdict has nothing to defer to; false reports allow,
   * mirroring the server's own fail-open error paths.
   */
  async hookGate(toolName: string, toolInput: unknown): Promise<GateResponse> {
    try {
      const d = await this.post(
        '/api/v1/hook-gate',
        {
          toolName,
          toolInput,
          workspaceId: this.workspaceId,
          sessionId: this.sessionId,
          harnessType: this.harness,
        },
        this.timeoutMs,
      )
      return {
        allowed: Boolean(d.allowed ?? true),
        reason: String(d.reason ?? ''),
        incidentId: typeof d.incidentId === 'string' ? d.incidentId : undefined,
        reached: true,
      }
    } catch (exc) {
      const name = exc instanceof Error ? exc.constructor.name : 'Error'
      if (this.failClosed) {
        return {
          allowed: false,
          reason: `hook-gate unreachable (${name}) — failing closed (failClosed=true)`,
          reached: false,
        }
      }
      return {
        allowed: true,
        reason: `hook-gate unreachable (${name}) — failing open (failClosed=false)`,
        reached: false,
      }
    }
  }

  /**
   * Fire-and-forget telemetry. Never throws.
   *
   * A `tool_blocked` event creates a `governance_incidents` row whose
   * description embeds the reason verbatim.
   */
  async emit(
    event: string,
    toolName: string,
    reason = '',
    toolInput?: unknown,
    incidentId?: string,
    filePath?: string,
  ): Promise<boolean> {
    if (!VALID_EVENTS.has(event)) return false
    const ev: Record<string, unknown> = {
      event,
      toolName,
      reason: (reason || '').slice(0, REASON_MAX),
      workspaceId: this.workspaceId,
      sessionId: this.sessionId,
      harnessType: this.harness,
      timestamp: new Date().toISOString(),
    }
    if (toolInput !== undefined) ev.toolInput = toolInput
    if (incidentId) ev.incidentId = incidentId
    if (filePath) ev.filePath = filePath.slice(0, 512)
    try {
      await this.post('/api/v1/hook-events', { events: [ev] }, EVENT_TIMEOUT_MS)
      return true
    } catch {
      return false
    }
  }

  /**
   * Build a client from the environment, falling back to CLI credentials.
   *
   * Reading `~/.intutic/credentials.json` means the gate works with whatever
   * workspace `intutic login` already bound, instead of duplicating the key.
   */
  static fromEnv(opts: { sessionId?: string; harness?: string; failClosed?: boolean } = {}): GateClient {
    const base = process.env.INTUTIC_CONTROL_PLANE_URL || 'https://api.intutic.ai'
    let key = process.env.INTUTIC_API_KEY || ''
    let ws = process.env.INTUTIC_WORKSPACE_ID || ''

    if (!key || !ws) {
      try {
        const credPath = join(homedir(), '.intutic', 'credentials.json')
        const c = JSON.parse(readFileSync(credPath, 'utf-8')) as Record<string, unknown>
        key = key || String(c.apiKey ?? '')
        ws = ws || String(c.workspaceId ?? '')
      } catch {
        // No credentials file — fall through with whatever env supplied.
      }
    }

    const sess = opts.sessionId || process.env.INTUTIC_SESSION_ID || ''
    if (!sess) {
      // The proxy defaults an unset x-session-id to the literal "unknown",
      // which collapses every run onto one dashboard row. Refuse instead.
      throw new Error(
        'No session id. Set INTUTIC_SESSION_ID or pass sessionId — an unset x-session-id ' +
          "becomes the literal 'unknown' in the proxy and merges every run into a single " +
          'dashboard session.',
      )
    }

    return new GateClient({
      baseUrl: base,
      apiKey: key,
      workspaceId: ws,
      sessionId: sess,
      harness: opts.harness ?? 'generic',
      failClosed: opts.failClosed ?? true,
    })
  }
}
