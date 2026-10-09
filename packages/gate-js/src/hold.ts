/**
 * Approval holds — a hold rule refuses the call for now and asks a person.
 *
 * Port of `packages/intutic-clawde/intutic_clawde/gate/hold.py`, and the same
 * mechanism as the MCP proxy's `approvalHold.ts`, through the same
 * control-plane decisions API the harness hook gates use:
 *
 * 1. A call that matches a hold rule (`hold` severity in the policy snapshot,
 *    or a `REQUIRE_APPROVAL:` rule in the SOP register) is looked up in the
 *    workspace's approved bypasses (`GET /api/v1/decisions/approved-bypasses`).
 *    An exact, unexpired match — same rule, same tool, same arguments — lets
 *    the call through.
 * 2. Otherwise the call is refused with an {@link IntuticGateHold} and a hold
 *    is recorded (`POST /api/v1/decisions`): it joins the review queue, the
 *    workspace is notified (`decision.pending`, Slack included), and the
 *    refusal carries the hold id.
 * 3. An owner, admin or engineering manager approves it
 *    (`intutic decision approve <holdId>` or the Slack card). The identical
 *    retry passes only while the workspace's review-hold bypass
 *    (`reviewHoldBypassEnabled`) is on, for `reviewHoldBypassTtlMinutes`;
 *    with it off, approving records the decision and the retry is held again.
 *
 * "Identical" is the bypass key: the rule id, the tool name trimmed and
 * lower-cased, and a SHA-256 of the arguments serialised with sorted keys, so
 * the same arguments in a different key order still match and any other
 * value does not. `packages/shared-types/fixtures/hold-key-vectors.json` holds
 * this, the Python gate and the MCP proxy to the same hash.
 *
 * A hold needs the control plane both ways, so without one (no client, or an
 * unreachable control plane) the call stays held, whatever `failClosed` says,
 * exactly as a hook gate's hold refuses when it cannot record: a rule that
 * says a person must approve is not satisfied by nobody being reachable.
 */

import { createHash, randomBytes } from 'node:crypto'
import type { GateClient } from './client.js'

/** The hold-record version the control plane accepts. */
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

/** The bypass key's call half: the tool and a hash of its arguments. */
export function holdKey(toolName: string, toolInput: unknown): { toolNameNormalized: string; targetHash: string } {
  return {
    toolNameNormalized: toolName.trim().toLowerCase(),
    targetHash: createHash('sha256').update(canonicalJson(toolInput ?? {})).digest('hex'),
  }
}

function newHoldId(): string {
  return `hold_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`
}

/**
 * What the agent is told, held or not recorded — the one place this package
 * words a hold. Says who can approve, and that a retry passes only with the
 * bypass setting on, because "retry after approval" alone is false under the
 * default settings.
 */
export function holdMessage(ruleReason: string, ruleId: string, outcome: { holdId: string; recorded: boolean }): string {
  if (!outcome.recorded) {
    return (
      `HELD for approval: ${ruleReason} [${ruleId}], but the hold could not be recorded ` +
      `(Intutic control plane unreachable), so there is nothing to approve yet. Do not retry ` +
      `until the control plane is reachable; the retry then asks for approval.`
    )
  }
  return (
    `HELD for approval: ${ruleReason} [${ruleId}]. Hold id: ${outcome.holdId}. ` +
    `An owner, admin or engineering manager can approve it with: intutic decision approve ` +
    `${outcome.holdId} (or reject it), or from the Slack card. Retry this exact call after ` +
    `approval only if the workspace's review-hold bypass (reviewHoldBypassEnabled) is on; ` +
    `otherwise approving records the decision and the call stays held.`
  )
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

/**
 * Lets the call through on an approved bypass, or records a hold and returns
 * its id. Never throws: every failure leaves the call held.
 */
export async function requestHold(
  client: GateClient | null,
  rule: { id: string; reason: string },
  toolName: string,
  toolInput: unknown,
): Promise<HoldOutcome> {
  const holdId = newHoldId()
  if (client === null) return { kind: 'held', holdId, recorded: false }
  const { toolNameNormalized, targetHash } = holdKey(toolName, toolInput)

  const bypass = await findBypass(client, rule.id, toolNameNormalized, targetHash)
  if (bypass) return bypass

  const recorded = await client.recordHold({
    v: HOLD_RECORD_VERSION,
    holdId,
    reason: rule.id,
    tool: toolName,
    sessionId: client.sessionId,
    at: new Date().toISOString(),
    toolNameNormalized,
    targetHash,
    context: { source: 'gate_sdk', harness: client.harness, tool: toolName, rule: rule.reason },
  })
  return { kind: 'held', holdId, recorded }
}

async function findBypass(
  client: GateClient,
  ruleId: string,
  toolNameNormalized: string,
  targetHash: string,
): Promise<HoldOutcome | null> {
  const list = (await client.approvedBypasses()) as BypassEntry[] | null
  if (!list) return null
  const now = Date.now()
  for (const raw of list) {
    // The route answers for the key's own workspace; the comparison is a
    // second check, made whenever this client was told its workspace.
    if (client.workspaceId && raw.workspaceId !== client.workspaceId) continue
    if (raw.sopRuleId !== ruleId) continue
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
