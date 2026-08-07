/**
 * Reader for `~/.intutic/hooks/policy-snapshot.rules`.
 *
 * The sync daemon compiles a workspace's policy into that file and every gate
 * reads it — the five bash gates and the eight JS ones inline the same parse
 * (`services/sync-daemon/src/harness/gateBody.ts`, `intuticLoadSnapshot`), and
 * the LangGraph gate ports it to Python. This is the reader `intutic doctor`
 * needs, and it exists because the answer it produces is not "is there a file":
 * a snapshot whose digest or workspace id does not check out has **every**
 * dynamic rule dropped by every gate, which looks from the outside exactly like
 * a healthy quiet workspace.
 *
 * The states, and what each one costs:
 *
 *   ok       — rules are loaded and enforced
 *   stale    — older than the staleness window, still fully enforced. Alerting
 *              only: if rules expired into permissiveness, "kill the daemon and
 *              wait" would be a supported way to disarm governance.
 *   empty    — parsed, but no rules. The writer always ships the destructive
 *              tier, so zero rules means the compile produced nothing.
 *   invalid  — digest or workspace mismatch. The gates drop the dynamic tier.
 *   absent   — no file. The compiled floor still applies; nothing else does.
 *
 * Kept deliberately faithful rather than improved: a reader that disagrees with
 * the gates would have `doctor` report a state no gate is in.
 *
 * @module
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

/**
 * Staleness window, in days.
 *
 * Mirrors `SNAPSHOT_STALE_AFTER_DAYS` in
 * `services/sync-daemon/src/harness/gateBody.ts`. Not imported from there:
 * `gateBody` is neither in `@intutic/sync-daemon`'s index nor in its `exports`
 * map, so the CLI cannot reach it. `snapshotStaleAfterDaysMatchesGate` in the
 * test beside this file re-reads the daemon's source and fails if the two ever
 * disagree.
 */
export const SNAPSHOT_STALE_AFTER_DAYS = 7

/** Filename the writer produces and every gate opens. */
export const SNAPSHOT_RULES_FILE = 'policy-snapshot.rules'

export type SnapshotState = 'absent' | 'ok' | 'stale' | 'empty' | 'invalid'

export interface PolicySnapshotHealth {
  state: SnapshotState
  /** The `#digest` header, or `'none'` when the file carries no digest. */
  digest: string
  /** The `#workspace` header, or `''`. */
  workspaceId: string
  /** The `#generated` header, or `''`. */
  generatedAt: string
  /** Whole days since `generatedAt`; 0 when it is absent or unparseable. */
  ageDays: number
  /** Rules a gate would load — after `invalid` empties the tier. */
  ruleCount: number
  /** Rules dropped because their regex would not compile. */
  droppedRules: number
  /** Where the snapshot was looked for. */
  path: string
}

/**
 * The path the gates read.
 *
 * `homedir()`, not `getIntuticDir()`: the daemon writes to
 * `homedir()/.intutic/hooks` on every platform and the emitted gates hardcode
 * the same, so resolving through the Windows `%APPDATA%` branch would have
 * doctor inspect a directory nothing writes to and report every snapshot absent.
 */
export function resolveSnapshotRulesPath(): string {
  const override = process.env.INTUTIC_SNAPSHOT_RULES
  if (override && override.length > 0) return override
  return join(homedir(), '.intutic', 'hooks', SNAPSHOT_RULES_FILE)
}

/**
 * Classify snapshot text exactly as `intuticLoadSnapshot` does.
 *
 * `expectedWorkspaceId` is compared only when both sides have one — an
 * unauthenticated machine cannot tell whose snapshot this is, and guessing
 * would report a healthy snapshot as invalid.
 */
export function parsePolicySnapshot(
  text: string,
  opts: { expectedWorkspaceId?: string; now?: Date; path?: string } = {},
): PolicySnapshotHealth {
  const out: PolicySnapshotHealth = {
    state: 'ok',
    digest: 'none',
    workspaceId: '',
    generatedAt: '',
    ageDays: 0,
    ruleCount: 0,
    droppedRules: 0,
    path: opts.path ?? resolveSnapshotRulesPath(),
  }

  const lines = text.split('\n')
  for (const line of lines) {
    if (line.startsWith('#digest ')) {
      out.digest = line.slice(8).trim()
      continue
    }
    if (line.startsWith('#workspace ')) {
      out.workspaceId = line.slice(11).trim()
      continue
    }
    if (line.startsWith('#generated ')) {
      out.generatedAt = line.slice(11).trim()
      continue
    }
    if (!line || line.startsWith('#')) continue

    // Column order is `RULES_COLUMNS`: id, severity, flags, subject, reason,
    // source. A short record or a record with no pattern is skipped silently by
    // the gates, so it is skipped here — counting it would report rules that
    // enforce nothing.
    const f = line.split('\t')
    if (f.length < 6 || !f[5]) continue
    try {
      new RegExp(f[5], f[2] === 'i' ? 'i' : '')
    } catch {
      // A rule that will not compile is dropped, not fatal — the compiled floor
      // is unaffected. Counted, because a silently shrinking rule set is the
      // thing worth telling the user about.
      out.droppedRules += 1
      continue
    }
    out.ruleCount += 1
  }

  // Integrity, cheapest failure first. A digest nobody recomputes is a comment;
  // a workspace id nobody compares means workspace A's rules get enforced on B's
  // machine, with B's audit events attributing A's policy to B.
  const body = lines.filter((l) => l && l.charAt(0) !== '#').join('\n')
  const actual = createHash('sha256').update(body).digest('hex').slice(0, 32)
  if (out.digest !== 'none' && actual !== out.digest) out.state = 'invalid'

  if (
    out.state === 'ok' &&
    out.workspaceId &&
    opts.expectedWorkspaceId &&
    out.workspaceId !== opts.expectedWorkspaceId
  ) {
    out.state = 'invalid'
  }

  if (out.state === 'ok' && out.ruleCount === 0) out.state = 'empty'

  // The dynamic tier is additive, so dropping it returns to yesterday's
  // behaviour rather than opening a hole. Reported as zero rules because zero is
  // what the gates will have.
  if (out.state === 'invalid') out.ruleCount = 0

  if (out.state === 'ok' && out.generatedAt) {
    const t = Date.parse(out.generatedAt)
    if (!Number.isNaN(t)) {
      // Not clamped at zero: a negative age means the snapshot is dated in the
      // future, which is a clock-skew fault worth seeing rather than rounding
      // away.
      out.ageDays = Math.floor(((opts.now?.getTime() ?? Date.now()) - t) / 86_400_000)
      if (out.ageDays > SNAPSHOT_STALE_AFTER_DAYS) out.state = 'stale'
    }
  }

  return out
}

/**
 * Read and classify the snapshot on this machine.
 *
 * Any read failure is `absent`, matching the gates: they cannot distinguish a
 * missing file from an unreadable one either, and both leave them enforcing the
 * compiled floor alone.
 */
export function readPolicySnapshot(
  opts: { expectedWorkspaceId?: string; now?: Date } = {},
): PolicySnapshotHealth {
  const path = resolveSnapshotRulesPath()
  let text: string
  try {
    text = readFileSync(path, 'utf-8')
  } catch {
    return {
      state: 'absent',
      digest: 'none',
      workspaceId: '',
      generatedAt: '',
      ageDays: 0,
      ruleCount: 0,
      droppedRules: 0,
      path,
    }
  }
  return parsePolicySnapshot(text, { ...opts, path })
}
