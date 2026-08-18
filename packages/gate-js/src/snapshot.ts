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
 * ## Two deliberate divergences from the Python SDK reader
 *
 * Both were found empirically, by running `src/__tests__/fidelity.test.ts`
 * against a hand-port of `intutic_clawde/gate/snapshot.py`'s `_normalise()`
 * and watching real patterns from `protectedPaths.ts` fail to fire. Neither
 * is a stylistic choice; both are confirmed gaps in `intutic_clawde`'s
 * reader relative to the shipped contract it claims to port, carried here
 * only as a documented finding, not as behaviour to reproduce.
 *
 * 1. **No padding.** `_normalise()` lowercases and collapses whitespace but
 *    does not pad the result with a leading/trailing space. The actual
 *    shipped gate (`intuticNormalise` in gateBody.ts, emitted from
 *    `NORMALISE_CONTRACT.jsSource`) pads. Padding is what lets a
 *    floor/destructive pattern use a plain leading space as a stand-in for
 *    `^` (`' rm( +-[a-zA-Z-]+)+ +/( |\\*)'` requires a literal space before
 *    `rm`) — POSIX ERE has no `\b` and no reliable `^`/`$` inside the emitted
 *    shell gates, so the whole pattern table is authored against the padded
 *    contract. It is also why `policySnapshot.ts`'s `toGuardPattern` strips
 *    the `^`/`$` off an SOP `toolPattern` and re-wraps it as `' (name) '`
 *    before shipping it as a `subject: 'tool'` snapshot rule — that
 *    transformation only makes sense against a padded reader. Without
 *    padding, a command that BEGINS with the dangerous verb (`"rm -rf /"`,
 *    no leading space) never matches `' rm...'` at all, and the block
 *    silently never fires.
 * 2. **Forced lowercasing.** `_normalise()` lowercases unconditionally; the
 *    real `NORMALISE_CONTRACT.jsSource` does not — case sensitivity is
 *    governed entirely by each rule's own `ignoreCase`/`i`-flag column.
 *    `bypass.env_kill_switch` (` [A-Z][A-Z0-9_]*_HOOKS?=`) and
 *    `destructive.chmod_recursive_root`/`chown_recursive_root`
 *    (`[a-zA-Z]*R[a-zA-Z]*`, a literal uppercase `R` for the recursive flag)
 *    both key on case WITHOUT setting that flag; forcing the subject to
 *    lowercase first makes them never fire, on real production patterns.
 *
 * This reader pads and preserves case, matching the real shipped contract;
 * see the fidelity suite for the evidence.
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

  get healthMessage(): string {
    switch (this.state) {
      case 'absent':
        return 'No policy snapshot — built-in protections only'
      case 'invalid':
        return 'Policy snapshot failed its digest or workspace check — dynamic rules dropped'
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
