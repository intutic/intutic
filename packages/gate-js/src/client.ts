/**
 * HTTP client for the Intutic control plane's gate endpoints.
 *
 * Port of `packages/intutic-clawde/intutic_clawde/gate/client.py`.
 *
 * Endpoints used:
 *
 *   POST /api/v1/hook-gate       synchronous allow/deny  -> {allowed, reason, incidentId?, code?, degraded?, decisionId?}
 *   POST /api/v1/hook-events     batched telemetry       -> creates governance_incidents rows
 *   POST /api/v1/decisions       record a hold           -> joins the review queue (hold.ts)
 *   GET  /api/v1/decisions/approved-bypasses             -> approvals that let a held call through
 *
 * Two behaviours that must not be "improved":
 *
 *   * The hook gate fails CLOSED, on both sides. The server refuses a call
 *     whose checks could not run (403 `GOVERNANCE_UNAVAILABLE`; a shadow-mode
 *     workspace gets a degraded allow instead) and a body it cannot read
 *     (400 `INVALID_REQUEST`). This client treats `GOVERNANCE_UNAVAILABLE`
 *     exactly as it treats a control plane it cannot reach, a non-2xx answer,
 *     or an answer with no boolean `allowed`: there is no verdict to defer to,
 *     and `failClosed` (default true) decides, reporting `allowed=false`. Set
 *     `failClosed=false` to treat the tier as advisory during an outage. A 400
 *     is refused whatever `failClosed` says: it is this client's request that
 *     is wrong, not the control plane that is down, and allowing would hide it.
 *   * `emit` NEVER throws. Telemetry that can break a run is worse than no
 *     telemetry.
 *
 * A client with no API key is LOCAL-ONLY ({@link GateClient.localOnly}): it
 * cannot authenticate, so it makes no request at all. Its hook gate answers
 * allow with code `LOCAL_ONLY` and says why, its events and holds are not
 * sent, and the `Gate` skips the SOP register. The local tiers (policy
 * snapshot, SSO groups from the snapshot, MCP registry, image integrity) are
 * unaffected. A client WITH a key that the control plane refuses (401) is not
 * local-only: that is an authentication fault, and fails closed as above.
 */

import { randomBytes } from 'node:crypto'
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
  'tool_held',
  'hold_approved_bypass_used',
])

export interface GateResponse {
  allowed: boolean
  reason: string
  incidentId?: string | undefined
  /**
   * The code the hook gate names, when it names one: the MCP registry's on its
   * refusals, `GOVERNANCE_UNAVAILABLE` when its checks could not run, and
   * `INVALID_REQUEST` when it could not read the request.
   */
  code?: string | undefined
  /** False when the hook gate gave no verdict and `failClosed` decided it. */
  reached: boolean
  /**
   * The hook gate's id for this decision, when this answer is its own verdict:
   * every verdict it gives names one, and a `GOVERNANCE_UNAVAILABLE` refusal
   * keeps it only while `failClosed` refuses too. The gate reports the call
   * with it (`gateDecisionId`), so the control plane exports the decision to
   * SIEM once and files its incident once.
   */
  decisionId?: string | undefined
}

/** The hook gate's code for a call whose checks could not run. */
const GOVERNANCE_UNAVAILABLE = 'GOVERNANCE_UNAVAILABLE'

/** The code on a local-only client's hook-gate answer: no key, so no call was made. */
const LOCAL_ONLY = 'LOCAL_ONLY'

/** Thrown before any request a local-only client would otherwise send. */
class LocalOnlyError extends Error {
  constructor(path: string) {
    super(`no API key: ${path} not called (local-only client)`)
    this.name = 'LocalOnlyError'
  }
}

/** A non-2xx answer, with its status and whatever JSON body it carried. */
class HttpStatusError extends Error {
  constructor(
    path: string,
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(`HTTP ${status} from ${path}`)
    this.name = 'HttpStatusError'
  }
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

  /**
   * True when there is no API key. Such a client cannot authenticate, so it
   * sends nothing: the control-plane tiers (SOP register, hook gate) are
   * skipped, events and holds are not reported, and the local tiers decide.
   */
  get localOnly(): boolean {
    return this.apiKey === ''
  }

  private async post(path: string, body: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
    return this.request('POST', path, body, timeoutMs)
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    if (this.localOnly) throw new LocalOnlyError(path)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(this.baseUrl + path, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          Authorization: `Bearer ${this.apiKey}`,
          'X-Workspace-Id': this.workspaceId,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      })
      const text = await res.text()
      if (!res.ok) {
        let body: unknown = null
        try {
          body = text ? JSON.parse(text) : null
        } catch {
          // Not JSON: the status alone is the answer.
        }
        throw new HttpStatusError(path, res.status, body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {})
      }
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
   * When there is no verdict (the control plane cannot be reached, answers
   * non-2xx or without a boolean `allowed`, or answers
   * `GOVERNANCE_UNAVAILABLE` because its own checks could not run), the
   * verdict is decided by `failClosed`: true (the default) reports BLOCK,
   * because a client with no verdict has nothing to defer to; false reports
   * allow. A 400 `INVALID_REQUEST` is a BLOCK whatever `failClosed` says. A
   * shadow-mode workspace's `{allowed: true, degraded: true}` is an allow.
   *
   * A {@link localOnly} client makes no call and answers allow with code
   * `LOCAL_ONLY`, whatever `failClosed` says: with no key there is no
   * control-plane tier to fail, only local ones, which have already run.
   */
  async hookGate(toolName: string, toolInput: unknown): Promise<GateResponse> {
    if (this.localOnly) {
      return {
        allowed: true,
        reason:
          'hook-gate skipped — no API key, so this client is local-only: the control-plane ' +
          'tiers (SOP register, hook gate) did not run; the policy snapshot, SSO-group and ' +
          'image tiers did',
        code: LOCAL_ONLY,
        reached: false,
      }
    }
    let d: Record<string, unknown>
    try {
      d = await this.post(
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
    } catch (exc) {
      if (exc instanceof HttpStatusError && exc.status === 400) {
        const why = typeof exc.body.reason === 'string' ? exc.body.reason : exc.message
        return {
          allowed: false,
          reason: `hook-gate rejected the request (INVALID_REQUEST): ${why}`,
          code: 'INVALID_REQUEST',
          reached: true,
        }
      }
      if (exc instanceof HttpStatusError && exc.body.code === GOVERNANCE_UNAVAILABLE) {
        return this.noVerdict(`governance check unavailable (${GOVERNANCE_UNAVAILABLE})`, GOVERNANCE_UNAVAILABLE, exc.body.decisionId)
      }
      const name = exc instanceof Error ? exc.constructor.name : 'Error'
      return this.noVerdict(`unreachable (${name})`)
    }
    if (d.allowed === false && d.code === GOVERNANCE_UNAVAILABLE) {
      return this.noVerdict(`governance check unavailable (${GOVERNANCE_UNAVAILABLE})`, GOVERNANCE_UNAVAILABLE, d.decisionId)
    }
    if (typeof d.allowed !== 'boolean') return this.noVerdict('answered without a verdict')
    return {
      allowed: d.allowed,
      reason: String(d.reason ?? ''),
      incidentId: typeof d.incidentId === 'string' ? d.incidentId : undefined,
      code: typeof d.code === 'string' ? d.code : undefined,
      reached: true,
      decisionId: typeof d.decisionId === 'string' ? d.decisionId : undefined,
    }
  }

  /**
   * The answer when the hook gate gave no verdict: `failClosed` decides. A
   * `GOVERNANCE_UNAVAILABLE` refusal's `decisionId` is kept when failing
   * closed, which refuses as the hook gate did, and dropped when failing open:
   * the call then runs, and its report must not stand for the refusal.
   */
  private noVerdict(what: string, code?: string, decisionId?: unknown): GateResponse {
    return this.failClosed
      ? {
          allowed: false, reason: `hook-gate ${what} — failing closed (failClosed=true)`, code, reached: false,
          decisionId: typeof decisionId === 'string' ? decisionId : undefined,
        }
      : { allowed: true, reason: `hook-gate ${what} — failing open (failClosed=false)`, code, reached: false }
  }

  /**
   * Fire-and-forget telemetry. Never throws.
   *
   * A `tool_blocked` event creates a `governance_incidents` row whose
   * description embeds the reason verbatim. `gateDecisionId` is the hook
   * gate's `decisionId` for the call this event reports: the control plane
   * then files the decision's incident once and does not export it to SIEM a
   * second time.
   */
  async emit(
    event: string,
    toolName: string,
    reason = '',
    toolInput?: unknown,
    incidentId?: string,
    filePath?: string,
    gateDecisionId?: string,
  ): Promise<boolean> {
    if (!VALID_EVENTS.has(event)) return false
    const ev: Record<string, unknown> = {
      event,
      toolName,
      reason: (reason || '').slice(0, REASON_MAX),
      workspaceId: this.workspaceId,
      sessionId: this.sessionId,
      harnessType: this.harness,
      // No daemon reports an SDK gate, so the control plane expects one from
      // its own events: one that keeps reporting and stops is a silent gate.
      gateSource: 'sdk',
      timestamp: new Date().toISOString(),
      // The event's id, made once: if this post is ever repeated, the control
      // plane processes the event once.
      eventId: randomBytes(16).toString('hex'),
    }
    if (toolInput !== undefined) ev.toolInput = toolInput
    if (incidentId) ev.incidentId = incidentId
    if (gateDecisionId) ev.gateDecisionId = gateDecisionId
    if (filePath) ev.filePath = filePath.slice(0, 512)
    try {
      await this.post('/api/v1/hook-events', { events: [ev] }, EVENT_TIMEOUT_MS)
      return true
    } catch {
      return false
    }
  }

  /**
   * Records one hold in the review queue (`POST /api/v1/decisions`), the way
   * the hook gates' records reach it. Never throws; `false` when the control
   * plane did not accept it, so the refusal can say there is nothing to
   * approve yet.
   */
  async recordHold(hold: Record<string, unknown>): Promise<boolean> {
    try {
      const d = await this.post('/api/v1/decisions', { holds: [hold] }, this.timeoutMs)
      return d.accepted === 1
    } catch {
      return false
    }
  }

  /**
   * The workspace's approved bypasses (`GET /api/v1/decisions/approved-bypasses`),
   * or `null` when they cannot be read. Never throws: a hold that cannot be
   * checked for an approval stays held.
   */
  async approvedBypasses(): Promise<unknown[] | null> {
    try {
      const d = await this.request('GET', '/api/v1/decisions/approved-bypasses', undefined, this.timeoutMs)
      return Array.isArray(d.bypasses) ? d.bypasses : null
    } catch {
      return null
    }
  }

  /**
   * Build a client from the environment, falling back to CLI credentials.
   *
   * Reading `~/.intutic/credentials.json` means the gate works with whatever
   * workspace `intutic login` already bound, instead of duplicating the key.
   * With no key in either place the client is {@link localOnly}.
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
