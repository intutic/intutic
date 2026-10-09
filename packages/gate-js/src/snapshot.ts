/**
 * Policy-snapshot reader — a port of the shipped gate contract.
 *
 * Primary porting source: `packages/intutic-clawde/intutic_clawde/gate/snapshot.py`.
 * Source of truth for the wire format and evaluation order (both the Python
 * port and this one target the same artifact):
 *   services/sync-daemon/src/harness/gateBody.ts
 *     - RULES_COLUMNS / toRulesLine()   the `.rules` line layout
 *     - JS_SNAPSHOT_LOADER              parsing + integrity
 *     - intuticGate()                   evaluation order
 *
 * The sync-daemon compiles a workspace's SOPs into
 * `~/.intutic/hooks/policy-snapshot.rules` and every harness gate reads it.
 * This is the JS/TS SDK's reader, for frameworks that have no dedicated
 * adapter of their own — it consumes the same documented artifact rather than
 * inventing a channel.
 *
 * Deliberate fidelity points, each of which the upstream comments call out as
 * a past defect:
 *
 *   * Subjects are tested SEPARATELY, never concatenated. Joining them lets a
 *     pattern match across the seam between two innocuous values.
 *   * The block reason is the rule's own text plus `[id]`. `hookEvents.resolveSeverity`
 *     greps that text for "governance-protected" to file the incident CRITICAL;
 *     a generic message silently downgrades it to MEDIUM.
 *   * INTUTIC_GUARD_DISABLE=1 drops ONLY the `destructive.*` family, never the
 *     compiled floor and never a workspace's own rules.
 *   * A snapshot rule whose regex will not compile is dropped, not fatal.
 *   * Snapshot health is reported as an event — "snapshot missing on 400
 *     machines" must not look identical to "snapshot present and healthy".
 *
 * ## Padding and case
 *
 * Normalisation pads the subject with a space at each end and collapses
 * whitespace, and does not lowercase, as the shipped gates do
 * (`NORMALISE_CONTRACT` in `protectedPaths.ts`). Padding is what lets a
 * floor/destructive pattern use a plain leading space or non-word character as
 * a stand-in for `^` (POSIX ERE has no `\b` and no reliable `^`/`$` inside the
 * emitted shell gates), so without it a command that BEGINS with the dangerous
 * verb (`"rm -rf /"`, `"DROP TABLE users"`) never matches. Case sensitivity is
 * each rule's own `ignoreCase` flag: `bypass.env_kill_switch` and the
 * recursive chmod/chown rules key on an uppercase letter without one. The
 * Python SDK's reader once lowercased and did not pad, and missed both; it now
 * follows the same contract, and `destructive-sql-vectors.json` in
 * shared-types runs both readers over the same commands.
 *
 * The regex-dialect divergence the Python module documents (`.rules` patterns
 * are authored as JavaScript regexes; compiling them with a different engine
 * can disagree on lookbehind syntax and some Unicode escapes) does not apply
 * here — this reader compiles them as native JS `RegExp`, the dialect they
 * were authored in.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { decodeSsoGroupRecord, SSO_GROUP_RECORD_TAG, type SsoGroupRecord } from './ssoGroups.js'

export const SNAPSHOT_STALE_AFTER_DAYS = 7

/** Severity tiers, in the order the shipped gate handles them. */
export const SEV_SHADOW = 'shadow' as const
export const SEV_WARN = 'warn' as const
export const SEV_BLOCK = 'block' as const

export type Severity = typeof SEV_SHADOW | typeof SEV_WARN | typeof SEV_BLOCK
export type RuleSubject = 'tool' | 'command' | 'target' | 'any'
export type SnapshotState = 'ok' | 'absent' | 'invalid' | 'empty' | 'stale'

export interface Rule {
  id: string
  severity: string
  subject: RuleSubject
  reason: string
  pattern: RegExp
}

export class Snapshot {
  rules: Rule[] = []
  digest = 'none'
  state: SnapshotState = 'absent'
  workspaceId = ''
  generatedAt = ''
  ageDays = 0
  /** Regexes that would not compile. */
  droppedRules = 0
  /**
   * The workspace's SSO-group policy and the member this snapshot was issued
   * to, or null when the workspace has no group policy. On a snapshot that
   * fails its integrity check the member is null — groups unknown — so an
   * edited group list in the file clears nothing.
   */
  ssoGroups: SsoGroupRecord | null = null

  get healthMessage(): string {
    switch (this.state) {
      case 'absent':
        return 'No policy snapshot — built-in protections only'
      case 'invalid':
        return 'Policy snapshot failed its digest or workspace check — dynamic rules dropped except SSO-group refusals'
      case 'empty':
        return 'Policy snapshot contains no rules — the compile produced nothing'
      case 'stale':
        return `Policy snapshot is ${this.ageDays} days old and still enforced`
      default:
        return ''
    }
  }
}

export interface Decision {
  /** `null` means allow. */
  severity: Severity | null
  reason: string
  ruleId: string
}

function allow(): Decision {
  return { severity: null, reason: '', ruleId: '' }
}

export function snapshotPath(): string {
  return (
    process.env.INTUTIC_SNAPSHOT_RULES ||
    join(homedir(), '.intutic', 'hooks', 'policy-snapshot.rules')
  )
}

/**
 * Collapse and pad whitespace, as the shipped gates do — case is
 * DELIBERATELY left untouched; a rule that wants case-insensitivity sets its
 * own `ignoreCase` flag. See the module doc comment for both ways the Python
 * SDK's reader diverges from this.
 */
function normalise(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value)
  return ' ' + s.replace(/\s+/g, ' ').trim() + ' '
}

export function loadSnapshot(workspaceId = '', path?: string): Snapshot {
  const p = path ?? snapshotPath()
  const snap = new Snapshot()

  let text: string
  try {
    text = readFileSync(p, 'utf-8')
  } catch {
    return snap // state stays 'absent'
  }

  snap.state = 'ok'
  for (const line of text.split('\n')) {
    if (line.startsWith('#digest ')) {
      snap.digest = line.slice(8).trim()
      continue
    }
    if (line.startsWith('#workspace ')) {
      snap.workspaceId = line.slice(11).trim()
      continue
    }
    if (line.startsWith('#generated ')) {
      snap.generatedAt = line.slice(11).trim()
      continue
    }
    if (!line || line.startsWith('#')) continue
    if (line.startsWith(`${SSO_GROUP_RECORD_TAG}\t`)) {
      snap.ssoGroups = decodeSsoGroupRecord(line)
      continue
    }

    const f = line.split('\t')
    // Column order: id, severity, flags, subject, reason, source(regex), [argPatternB64].
    if (f.length < 6 || !f[5]) continue
    try {
      snap.rules.push({
        id: f[0]!,
        severity: f[1]!,
        subject: (f[3] as RuleSubject) || 'any',
        reason: f[4]!,
        pattern: new RegExp(f[5]!, f[2] === 'i' ? 'i' : ''),
      })
    } catch {
      snap.droppedRules += 1
    }
  }

  // Integrity. A digest nobody recomputes is a comment; a workspace id nobody
  // compares means workspace A's rules get enforced on B's machine and B's
  // events attribute A's policy to B.
  const body = text
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .join('\n')
  const actual = createHash('sha256').update(body, 'utf-8').digest('hex').slice(0, 32)
  if (snap.digest !== 'none' && actual !== snap.digest) {
    snap.state = 'invalid'
  }

  if (snap.state === 'ok' && snap.workspaceId && workspaceId && snap.workspaceId !== workspaceId) {
    snap.state = 'invalid'
  }

  // Distinct from absent: the writer always ships the destructive tier, so no
  // rules means the compile produced nothing.
  if (snap.state === 'ok' && snap.rules.length === 0) {
    snap.state = 'empty'
  }

  if (snap.state === 'invalid') {
    snap.rules = [] // additive tier — dropping it returns to yesterday's behaviour
    // Except the group policy, which only ever refuses: it still applies, to a
    // member whose groups this gate can no longer vouch for.
    if (snap.ssoGroups) snap.ssoGroups = { ...snap.ssoGroups, member: null }
  }

  if (snap.state === 'ok' && snap.generatedAt) {
    const t = Date.parse(snap.generatedAt)
    if (!Number.isNaN(t)) {
      snap.ageDays = Math.max(0, Math.floor((Date.now() - t) / 86_400_000))
      if (snap.ageDays > SNAPSHOT_STALE_AFTER_DAYS) {
        snap.state = 'stale' // staleness governs alerting, not enforcement
      }
    }
  }

  return snap
}

/** Evaluate one tool call against the snapshot. First match wins. */
export function evaluate(
  toolName: string,
  target: string,
  command: string,
  snap: Snapshot,
  guardDisabled = false,
): Decision {
  let rules = snap.rules
  if (guardDisabled) {
    // Only the destructive family is skippable. The alternative a blocked
    // developer reaches for is chflags nouchg on the hook itself, which is
    // strictly worse; every use is recorded by the caller.
    rules = rules.filter((r) => !r.id.startsWith('destructive.'))
  }

  const nTool = normalise(toolName)
  const nCommand = normalise(command)
  const nTarget = normalise(target)

  for (const rule of rules) {
    const subjects =
      rule.subject === 'tool'
        ? [nTool]
        : rule.subject === 'command'
          ? [nCommand]
          : rule.subject === 'target'
            ? [nTarget]
            : [nCommand, nTarget]

    for (const subject of subjects) {
      if (!rule.pattern.test(subject)) continue
      if (rule.severity === SEV_SHADOW) {
        return { severity: SEV_SHADOW, reason: `${rule.reason} [${rule.id}]`, ruleId: rule.id }
      }
      if (rule.severity === SEV_WARN) {
        const verb = nCommand.trim().split(' ')[0] ?? ''
        return {
          severity: SEV_WARN,
          reason: `${rule.reason} [${rule.id}] verb=${verb}`,
          ruleId: rule.id,
        }
      }
      // The rule's own reason, not a generic one — resolveSeverity reads it.
      return { severity: SEV_BLOCK, reason: `${rule.reason} [${rule.id}]`, ruleId: rule.id }
    }
  }

  return allow()
}

export function guardDisabledFromEnv(): boolean {
  return process.env.INTUTIC_GUARD_DISABLE === '1'
}
