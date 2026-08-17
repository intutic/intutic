import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { writePolicySnapshot } from '@intutic/sync-daemon'
import {
  parsePolicySnapshot,
  readPolicySnapshot,
  resolveSnapshotRulesPath,
  SNAPSHOT_RULES_FILE,
  SNAPSHOT_STALE_AFTER_DAYS,
} from './policySnapshot.js'

/** Digest over the rule body, exactly as the writer computes it. */
function digestOf(bodyLines: string[]): string {
  return createHash('sha256').update(bodyLines.join('\n')).digest('hex').slice(0, 32)
}

/** A `.rules` record in `RULES_COLUMNS` order. */
function rule(id: string, source: string, severity = 'block', subject = 'tool'): string {
  return [id, severity, '-', subject, `Blocked by ${id}`, source].join('\t')
}

function snapshotText(
  rules: string[],
  opts: { workspace?: string; generated?: string; digest?: string } = {},
): string {
  const digest = opts.digest ?? digestOf(rules)
  return (
    '# Intutic policy snapshot (projection of policy-snapshot.json) — DO NOT EDIT.\n' +
    '# Columns: id\tseverity\tflags\tsubject\treason\tsource\n' +
    `#digest ${digest}\n` +
    `#workspace ${opts.workspace ?? 'wk_alpha'}\n` +
    `#generated ${opts.generated ?? new Date().toISOString()}\n` +
    rules.join('\n') +
    '\n'
  )
}

const tempDirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'intutic-snapshot-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  delete process.env.INTUTIC_SNAPSHOT_RULES
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('parsePolicySnapshot', () => {
  it('reports ok with the rule count a gate would load', () => {
    const snap = parsePolicySnapshot(
      snapshotText([rule('sop.1', ' (Bash) '), rule('destructive.rm', 'rm -rf /', 'warn', 'command')]),
      { expectedWorkspaceId: 'wk_alpha' },
    )
    expect(snap.state).toBe('ok')
    expect(snap.ruleCount).toBe(2)
    expect(snap.droppedRules).toBe(0)
    expect(snap.workspaceId).toBe('wk_alpha')
  })

  it('reports invalid when the body no longer matches the digest', () => {
    const rules = [rule('sop.1', ' (Bash) ')]
    // The header keeps the digest of the original body — an edited rule is
    // exactly the tamper the digest exists to catch.
    const text = snapshotText([rule('sop.1', ' (Read) ')], { digest: digestOf(rules) })
    const snap = parsePolicySnapshot(text, { expectedWorkspaceId: 'wk_alpha' })
    expect(snap.state).toBe('invalid')
    // The gates drop the whole dynamic tier, so doctor must not report rules
    // that nothing will enforce.
    expect(snap.ruleCount).toBe(0)
  })

  it('reports invalid when the snapshot belongs to another workspace', () => {
    const snap = parsePolicySnapshot(snapshotText([rule('sop.1', ' (Bash) ')], { workspace: 'wk_beta' }), {
      expectedWorkspaceId: 'wk_alpha',
    })
    expect(snap.state).toBe('invalid')
    expect(snap.ruleCount).toBe(0)
  })

  it('does not claim a workspace mismatch when the machine has no workspace id', () => {
    const snap = parsePolicySnapshot(snapshotText([rule('sop.1', ' (Bash) ')], { workspace: 'wk_beta' }))
    expect(snap.state).toBe('ok')
    expect(snap.ruleCount).toBe(1)
  })

  it('reports empty when the compile produced no rules', () => {
    const snap = parsePolicySnapshot(snapshotText([]), { expectedWorkspaceId: 'wk_alpha' })
    expect(snap.state).toBe('empty')
    expect(snap.ruleCount).toBe(0)
  })

  it('reports stale past the window, still counting the rules it enforces', () => {
    const old = new Date(Date.now() - (SNAPSHOT_STALE_AFTER_DAYS + 1) * 86_400_000 - 60_000)
    const snap = parsePolicySnapshot(
      snapshotText([rule('sop.1', ' (Bash) ')], { generated: old.toISOString() }),
      { expectedWorkspaceId: 'wk_alpha' },
    )
    expect(snap.state).toBe('stale')
    expect(snap.ageDays).toBe(SNAPSHOT_STALE_AFTER_DAYS + 1)
    // Staleness governs alerting, not enforcement.
    expect(snap.ruleCount).toBe(1)
  })

  it('is still ok exactly at the window boundary', () => {
    const at = new Date(Date.now() - SNAPSHOT_STALE_AFTER_DAYS * 86_400_000 - 60_000)
    const snap = parsePolicySnapshot(snapshotText([rule('sop.1', ' (Bash) ')], { generated: at.toISOString() }))
    expect(snap.state).toBe('ok')
    expect(snap.ageDays).toBe(SNAPSHOT_STALE_AFTER_DAYS)
  })

  it('counts a rule whose regex will not compile as dropped, not as loaded', () => {
    const rules = [rule('sop.1', ' (Bash) '), rule('sop.broken', '(unclosed')]
    const snap = parsePolicySnapshot(snapshotText(rules), { expectedWorkspaceId: 'wk_alpha' })
    expect(snap.state).toBe('ok')
    expect(snap.ruleCount).toBe(1)
    expect(snap.droppedRules).toBe(1)
  })

  it('skips short records and records with no pattern, as the gates do', () => {
    const rules = ['sop.short\tblock\t-\ttool', ['sop.nopattern', 'block', '-', 'tool', 'why', ''].join('\t')]
    const snap = parsePolicySnapshot(snapshotText(rules))
    expect(snap.ruleCount).toBe(0)
    expect(snap.droppedRules).toBe(0)
    expect(snap.state).toBe('empty')
  })

  it('leaves the digest unverified when the file declares none', () => {
    const text = snapshotText([rule('sop.1', ' (Bash) ')], { digest: 'none' })
    const snap = parsePolicySnapshot(text)
    expect(snap.digest).toBe('none')
    expect(snap.state).toBe('ok')
  })

  it('surfaces a future-dated snapshot as a negative age rather than hiding it', () => {
    const ahead = new Date(Date.now() + 3 * 86_400_000)
    const snap = parsePolicySnapshot(snapshotText([rule('sop.1', ' (Bash) ')], { generated: ahead.toISOString() }))
    expect(snap.ageDays).toBeLessThan(0)
  })
})

describe('resolveSnapshotRulesPath', () => {
  it('defaults to the directory the daemon writes and the gates read', () => {
    expect(resolveSnapshotRulesPath().endsWith(join('.intutic', 'hooks', SNAPSHOT_RULES_FILE))).toBe(true)
  })

  it('honours INTUTIC_SNAPSHOT_RULES, which every gate consults first', () => {
    process.env.INTUTIC_SNAPSHOT_RULES = '/somewhere/else.rules'
    expect(resolveSnapshotRulesPath()).toBe('/somewhere/else.rules')
  })
})

describe('readPolicySnapshot', () => {
  it('reports absent when there is no file', () => {
    process.env.INTUTIC_SNAPSHOT_RULES = join(tempDir(), 'nothing-here.rules')
    const snap = readPolicySnapshot()
    expect(snap.state).toBe('absent')
    expect(snap.ruleCount).toBe(0)
  })

  it('reads and classifies a file at the override path', () => {
    const path = join(tempDir(), 'policy-snapshot.rules')
    writeFileSync(path, snapshotText([rule('sop.1', ' (Bash) ')]), 'utf-8')
    process.env.INTUTIC_SNAPSHOT_RULES = path
    const snap = readPolicySnapshot({ expectedWorkspaceId: 'wk_alpha' })
    expect(snap.state).toBe('ok')
    expect(snap.ruleCount).toBe(1)
    expect(snap.path).toBe(path)
  })
})

describe('agreement with the sync daemon', () => {
  it('reads a snapshot the daemon actually wrote', async () => {
    const dir = tempDir()
    const written = await writePolicySnapshot(
      {
        workspaceId: 'wk_alpha',
        interventionMode: 'TRANSPARENT',
        sopRules: [
          { id: 'r1', toolPattern: 'Bash', action: 'block', reason: 'No shell in this workspace' },
        ],
        mcpAllowedServers: [],
      },
      dir,
    )

    process.env.INTUTIC_SNAPSHOT_RULES = join(dir, SNAPSHOT_RULES_FILE)
    const snap = readPolicySnapshot({ expectedWorkspaceId: 'wk_alpha' })

    // The whole point of the digest check: this fails if the reader disagrees
    // with the writer about which bytes are covered.
    expect(snap.state).toBe('ok')
    expect(snap.digest).toBe(written.digest)
    expect(snap.ruleCount).toBe(written.ruleCount)
    expect(snap.workspaceId).toBe('wk_alpha')
  })

  it('keeps SNAPSHOT_STALE_AFTER_DAYS equal to the gate the daemon emits', () => {
    // The constant cannot be imported: gateBody is neither in the daemon's index
    // nor in its exports map. Read the declaration instead, so a change there
    // fails here rather than silently making doctor disagree with the gates.
    const gateBody = join(
      dirname(fileURLToPath(import.meta.url)),
      '..', '..', '..', '..',
      'services', 'sync-daemon', 'src', 'harness', 'gateBody.ts',
    )
    const source = readFileSync(gateBody, 'utf-8')
    const match = source.match(/export const SNAPSHOT_STALE_AFTER_DAYS = (\d+)/)
    expect(match).not.toBeNull()
    expect(Number(match![1])).toBe(SNAPSHOT_STALE_AFTER_DAYS)
  })
})
