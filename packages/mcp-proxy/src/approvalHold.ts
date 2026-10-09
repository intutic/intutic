/**
 * approvalHold.ts — `require_approval` rules as real holds, not blocks.
 *
 * Mirrors the harness hook gates' hold tier through the same control-plane
 * decisions API:
 *
 * 1. A call that matches a `require_approval` rule is looked up in the
 *    workspace's approved bypasses (`GET /api/v1/decisions/approved-bypasses`).
 *    An exact, unexpired match — same rule, same server and tool, same
 *    arguments — lets the call through.
 * 2. Otherwise the call is refused and a hold is recorded
 *    (`POST /api/v1/decisions`), which puts it in the review queue, notifies
 *    the workspace (`decision.pending`, Slack included), and gives the agent a
 *    hold id to quote.
 * 3. An Owner, Admin or EM approves it (`intutic decision approve <holdId>`, the review
 *    API, or the Slack card — all one code path in the control plane). The
 *    approval lets the identical retry pass only while the workspace's
 *    review-hold bypass (`reviewHoldBypassEnabled`) is on: approving then
 *    writes the bypass step 1 finds, valid for `reviewHoldBypassTtlMinutes`.
 *    Otherwise the approval records the decision only, exactly as it does for
 *    a hook-gate hold.
 *
 * "Identical" is the bypass key: the rule id, `mcp__<server>__<tool>`
 * lower-cased, and a SHA-256 of the arguments serialised with sorted keys, so
 * the same arguments in a different key order still match and any other
 * argument value does not.
 *
 * A hold needs the control plane both ways — to find an approval and to
 * record a request for one — so an unreachable control plane means the call
 * stays held, whatever the fail-open setting: a rule that says a person must
 * approve is not satisfied by nobody being reachable to ask.
 *
 * @module
 */

import * as node_crypto from 'node:crypto'
import { createStderrLogger as createLogger } from './stderrLog.js'
import { getJson, postJson } from './httpJson.js'
import type { SopRule } from './policy.js'
import type { CallerIdentity } from './identity.js'

const log = createLogger('mcp-proxy-hold')

/** The hold-record version the control plane accepts (`POST /api/v1/decisions`). */
const HOLD_RECORD_VERSION = 1

export type HoldOutcome =
  | { kind: 'bypassed'; holdId: string; decidedBy: string }
  | { kind: 'held'; holdId: string; recorded: boolean }

/** JSON with object keys sorted at every level, so key order never changes a hash. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

export function holdKey(serverName: string, toolName: string, toolInput: unknown): { toolNameNormalized: string; targetHash: string } {
  return {
    toolNameNormalized: `mcp__${serverName}__${toolName}`.trim().toLowerCase(),
    targetHash: node_crypto.createHash('sha256').update(canonicalJson(toolInput ?? {})).digest('hex'),
  }
}

function newHoldId(): string {
  return `hold_${Date.now().toString(36)}_${node_crypto.randomBytes(4).toString('hex')}`
}

interface BypassEntry {
  workspaceId?: unknown
  sopRuleId?: unknown
  toolNameNormalized?: unknown
  targetHash?: unknown
  holdId?: unknown
  decidedBy?: unknown
  expiresAt?: unknown
}

export class ApprovalHolds {
  constructor(
    private readonly controlPlaneUrl: string,
    private readonly apiKey: string,
    private readonly workspaceId: string,
    private readonly serverName: string,
    /** Rides on the hold record so the reviewer sees who asked (identity.ts). */
    private readonly identity: CallerIdentity | undefined = undefined,
  ) {}

  /** Lets the call through on an approved bypass, or records a hold and returns its id. Never throws. */
  async request(rule: Pick<SopRule, 'id' | 'reason'>, toolName: string, toolInput: unknown): Promise<HoldOutcome> {
    const { toolNameNormalized, targetHash } = holdKey(this.serverName, toolName, toolInput)

    const bypass = await this.findBypass(rule.id, toolNameNormalized, targetHash)
    if (bypass) return bypass

    const holdId = newHoldId()
    try {
      await postJson(`${this.controlPlaneUrl}/api/v1/decisions`, this.apiKey, {
        holds: [
          {
            v: HOLD_RECORD_VERSION,
            holdId,
            reason: rule.id,
            tool: toolNameNormalized,
            sessionId: '',
            at: new Date().toISOString(),
            toolNameNormalized,
            targetHash,
            context: {
              source: 'mcp_proxy',
              server: this.serverName,
              tool: toolName,
              rule: rule.reason,
              ...(this.identity ? { principal: this.identity } : {}),
            },
          },
        ],
      })
      return { kind: 'held', holdId, recorded: true }
    } catch (err) {
      log.warn({ action: 'hold_record_failed', ruleId: rule.id, err: (err as Error).message }, 'Could not record the hold')
      return { kind: 'held', holdId, recorded: false }
    }
  }

  private async findBypass(
    ruleId: string,
    toolNameNormalized: string,
    targetHash: string,
  ): Promise<HoldOutcome | null> {
    let body: unknown
    try {
      body = await getJson(`${this.controlPlaneUrl}/api/v1/decisions/approved-bypasses`, this.apiKey)
    } catch (err) {
      log.warn({ action: 'bypass_lookup_failed', err: (err as Error).message }, 'Could not look up approved bypasses — the call stays held')
      return null
    }
    const list = (body as { bypasses?: unknown } | null)?.bypasses
    if (!Array.isArray(list)) return null
    const now = Date.now()
    for (const raw of list as BypassEntry[]) {
      if (raw.workspaceId !== this.workspaceId || raw.sopRuleId !== ruleId) continue
      if (raw.toolNameNormalized !== toolNameNormalized || raw.targetHash !== targetHash) continue
      const expires = typeof raw.expiresAt === 'string' ? Date.parse(raw.expiresAt) : NaN
      if (Number.isNaN(expires) || now >= expires) continue
      return {
        kind: 'bypassed',
        holdId: typeof raw.holdId === 'string' ? raw.holdId : '',
        decidedBy: typeof raw.decidedBy === 'string' ? raw.decidedBy : '',
      }
    }
    return null
  }
}
