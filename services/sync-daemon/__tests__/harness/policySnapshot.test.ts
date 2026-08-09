/**
 * The policy snapshot is the only thing in this design that can turn an allow
 * into a block without a release, so it is the only thing that can turn a
 * workspace off by accident.
 *
 * Two live landmines make that concrete rather than theoretical:
 *
 *  1. `evaluate.ts` emits `{toolPattern: '.*', action: 'warn'}` for **every**
 *     HIGH- or CRITICAL-risk SOP in a workspace. Anything that ships resolved
 *     rules to a blocking path and does not filter on the action will put a
 *     catch-all on every developer's machine.
 *  2. A `BLOCK:` SOP's `toolPattern` is author-written text. It reaches thirteen
 *     gates, five of which evaluate it with `grep -E` and eight with JavaScript
 *     `RegExp`.
 *
 * So the assertions here are mostly about what does *not* get written.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  writePolicySnapshot,
  buildSnapshotRules,
  validateRule,
  SNAPSHOT_JSON,
  SNAPSHOT_RULES,
  DESTRUCTIVE_TIER_SEVERITY,
  type ResolvedPolicy,
} from '../../src/lib/policySnapshot.js'

function policy(over: Partial<ResolvedPolicy> = {}): ResolvedPolicy {
  return {
    workspaceId: 'ws_test',
    interventionMode: 'ENFORCE',
    sopRules: [],
    ...over,
  }
}

describe('validateRule', () => {
  it('accepts an ordinary tool pattern', () => {
    expect(validateRule('Bash', 'sop_1')).toBeNull()
    expect(validateRule('Write|Edit', 'sop_2')).toBeNull()
  })

  it('rejects a pattern that matches every known tool', () => {
    // Written as "matches all the canaries" rather than as a denylist of the
    // three spellings we happened to think of, so `.+`, `[A-Za-z]*` and
    // anything else someone reaches for is caught by the same rule.
    for (const catchAll of ['.*', '.+', '^.*$', '[A-Za-z]*', '.?.*']) {
      expect(validateRule(catchAll, 'sop_x'), `${catchAll} was accepted`).toMatch(/catch-all/)
    }
  })

  it('rejects an empty or anchor-only pattern', () => {
    expect(validateRule('', 'sop_x')).toMatch(/empty/)
    expect(validateRule('   ', 'sop_x')).toMatch(/empty/)
    expect(validateRule('^$', 'sop_x')).toMatch(/only anchors/)
  })

  it('rejects a pattern the two engines would read differently', () => {
    // `\s` is a JavaScript construct POSIX ERE does not define. A rule using it
    // would enforce in the eight JS gates and match nothing in the five bash
    // ones — enforcement that looks present and is half absent.
    expect(validateRule('Bash\\s+run', 'sop_x')).toMatch(/not portable/)
    expect(validateRule('[[:alpha:]]+', 'sop_x')).toMatch(/not portable/)
  })
})

describe('buildSnapshotRules', () => {
  it('drops every non-block rule', () => {
    const rules = buildSnapshotRules(
      policy({
        sopRules: [
          { id: 's1', toolPattern: 'Bash', action: 'block', reason: 'no shell' },
          { id: 's2', toolPattern: 'Write', action: 'warn', reason: 'careful' },
          { id: 's3', toolPattern: 'Edit', action: 'require_approval', reason: 'ask' },
        ],
      }),
    )
    const sopIds = rules.filter((r) => r.id.startsWith('sop.')).map((r) => r.id)
    expect(sopIds).toEqual(['sop.s1'])
  })

  it('drops the HIGH/CRITICAL catch-all the control plane emits', () => {
    // The landmine, verbatim: evaluate.ts returns this for every HIGH or
    // CRITICAL SOP in the workspace. Two independent things stop it — the
    // action filter and validateRule — because one of them being right is not
    // the same as it being guarded.
    const rules = buildSnapshotRules(
      policy({
        sopRules: [{ id: 'risky', toolPattern: '.*', action: 'warn', reason: 'High-risk SOP active' }],
      }),
    )
    expect(rules.filter((r) => r.id.startsWith('sop.'))).toEqual([])

    const asBlock = buildSnapshotRules(
      policy({
        sopRules: [{ id: 'risky', toolPattern: '.*', action: 'block', reason: 'High-risk SOP active' }],
      }),
    )
    expect(
      asBlock.filter((r) => r.id.startsWith('sop.')),
      'a catch-all survived even with the action filter bypassed',
    ).toEqual([])
  })

  it('matches a whole tool token, not a substring', () => {
    const [rule] = buildSnapshotRules(
      policy({ sopRules: [{ id: 's1', toolPattern: 'Bash', action: 'block', reason: 'x' }] }),
    )
    const re = new RegExp(rule!.source)
    expect(re.test(' Bash '), 'did not match the tool it names').toBe(true)
    expect(re.test(' BashHistory '), 'matched an unrelated tool by prefix').toBe(false)
    expect(rule!.subject, 'a tool rule matched against command text would never fire').toBe('tool')
  })

  it('carries a WHERE clause through to the gate rule', () => {
    // The defect this whole change repairs: resolve served argPattern, this
    // type dropped it, and every gate enforced the rule as an unconditional
    // tool-name block — over-blocking `make test` while never testing the
    // condition the rule was written for.
    const [rule] = buildSnapshotRules(
      policy({
        sopRules: [{
          id: 's1', toolPattern: '^shell$', action: 'block',
          argPattern: 'kubectl\\s+apply(?!.*@sha256:)', reason: 'pin your images',
        }],
      }),
    )
    expect(rule!.argPattern).toBe('kubectl\\s+apply(?!.*@sha256:)')
    // The tool half still gets the portable-ERE treatment; the arg half must
    // NOT — it is a JS regex matched against serialized input, and lookahead
    // is most of why it exists.
    expect(rule!.source).toBe(' (shell) ')
  })

  it('strips an un-compilable argPattern and keeps the rule name-only', () => {
    // The clause NARROWS a block. Losing the clause widens enforcement (safe,
    // and visible as over-blocking); losing the rule would open a hole.
    const [rule] = buildSnapshotRules(
      policy({
        sopRules: [{
          id: 's1', toolPattern: 'Bash', action: 'block',
          argPattern: '*invalid(', reason: 'x',
        }],
      }),
    )
    expect(rule!.id).toBe('sop.s1')
    expect(rule!.argPattern).toBeUndefined()
  })

  it('ships the destructive tier at the declared severity', () => {
    const rules = buildSnapshotRules(policy())
    const rm = rules.find((r) => r.id === 'destructive.rm_rf_root')
    expect(rm, 'the destructive tier is not in the snapshot at all').toBeDefined()
    expect(rm!.severity).toBe(DESTRUCTIVE_TIER_SEVERITY)
  })

  it('marks rules shadow, not warn, in SHADOW mode', () => {
    const rules = buildSnapshotRules(
      policy({
        interventionMode: 'SHADOW',
        sopRules: [{ id: 's1', toolPattern: 'Bash', action: 'block', reason: 'x' }],
      }),
    )
    // `shadow`, not `warn`. Both allow, but only one means "this would have
    // blocked" — and a shadow rollout is decided on that count. Collapsing them
    // made it unmeasurable.
    expect(rules.every((r) => r.severity === 'shadow')).toBe(true)
    expect(rules.some((r) => r.severity === 'warn'), 'a shadow snapshot still emits warn rules').toBe(false)
  })
})

describe('writePolicySnapshot', () => {
  it('writes both artifacts, read-only, with a shared digest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'intutic-snap-'))
    try {
      const { digest, ruleCount } = await writePolicySnapshot(
        policy({
          sopRules: [
            { id: 's1', toolPattern: 'Bash', action: 'block', reason: 'no shell' },
            {
              id: 's2', toolPattern: '^shell$', action: 'block',
              argPattern: 'kubectl\\s+apply(?!.*@sha256:)', reason: 'pin your images',
            },
          ],
        }),
        dir,
      )
      const jsonPath = join(dir, SNAPSHOT_JSON)
      const rulesPath = join(dir, SNAPSHOT_RULES)

      const doc = JSON.parse(readFileSync(jsonPath, 'utf8'))
      expect(doc.digest).toBe(digest)
      expect(doc.rules.length).toBe(ruleCount)
      expect(doc.workspaceId).toBe('ws_test')

      const rulesText = readFileSync(rulesPath, 'utf8')
      expect(rulesText).toContain(`#digest ${digest}`)

      // The projection must be derivable from the JSON — otherwise the bash
      // gates and the JS gates are reading two different policies that merely
      // claim the same digest.
      const lines = rulesText.split('\n').filter((l) => l && !l.startsWith('#'))
      expect(lines.length).toBe(doc.rules.length)
      expect(createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 32)).toBe(digest)

      // Every line has a declared column count. A reason containing a tab
      // would shift `source` into the reason column and the rule would
      // silently stop matching anything. Six columns without an argPattern —
      // byte-identical to the v3 layout, which is the forward-compat
      // contract — and seven with one.
      for (const line of lines) {
        const cols = line.split('\t').length
        expect([6, 7], `wrong column count (${cols}): ${line}`).toContain(cols)
      }

      // The WHERE rule's clause rides the seventh column, base64 — the one
      // encoding that cannot collide with the tab separator, since an
      // argPattern is an arbitrary regex the portable-ERE rules never vetted.
      const whereLine = lines.find((l) => l.startsWith('sop.s2\t'))!
      const cols = whereLine.split('\t')
      expect(cols.length).toBe(7)
      expect(Buffer.from(cols[6]!, 'base64').toString('utf8')).toBe('kubectl\\s+apply(?!.*@sha256:)')
      // And the name-only rule stays six columns — no trailing empty field.
      expect(lines.find((l) => l.startsWith('sop.s1\t'))!.split('\t').length).toBe(6)

      // 0444. The daemon replaces this by rename and never needs write access to
      // the file itself.
      expect(statSync(jsonPath).mode & 0o777).toBe(0o444)
      expect(statSync(rulesPath).mode & 0o777).toBe(0o444)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('replaces an existing read-only snapshot rather than failing on it', async () => {
    // 0444 plus a plain overwrite is EACCES. The writer renames onto the target
    // instead, which is also what stops a gate from ever reading a half-written
    // file.
    const dir = mkdtempSync(join(tmpdir(), 'intutic-snap2-'))
    try {
      await writePolicySnapshot(policy(), dir)
      const second = await writePolicySnapshot(
        policy({ sopRules: [{ id: 's9', toolPattern: 'Edit', action: 'block', reason: 'x' }] }),
        dir,
      )
      const doc = JSON.parse(readFileSync(join(dir, SNAPSHOT_JSON), 'utf8'))
      expect(doc.digest).toBe(second.digest)
      expect(doc.rules.some((r: { id: string }) => r.id === 'sop.s9')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
