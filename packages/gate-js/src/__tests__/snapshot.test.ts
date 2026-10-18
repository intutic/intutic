import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { evaluate, loadSnapshot, SEV_BLOCK, SEV_SHADOW, SEV_WARN } from '../snapshot.js'
import { CAN_EVALUATE_DECIDE, Gate } from '../gate.js'
import { IntuticGateRefusal } from '../errors.js'
import { expectLinearTime } from './linearTime.js'

// Port of packages/intutic-clawde/tests/test_gate_snapshot.py.

const WS = 'ws_demo'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'intutic-gate-snapshot-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function digest(bodyLines: string[]): string {
  return createHash('sha256').update(bodyLines.join('\n')).digest('hex').slice(0, 32)
}

function rulesFile(
  rules: string[],
  opts: { workspace?: string; digest?: string; generated?: string } = {},
): string {
  const workspace = opts.workspace ?? WS
  const body = [...rules]
  const header = [`#workspace ${workspace}`, `#digest ${opts.digest ?? digest(body)}`]
  if (opts.generated) header.push(`#generated ${opts.generated}`)
  const p = join(dir, 'policy-snapshot.rules')
  writeFileSync(p, [...header, ...body].join('\n') + '\n', 'utf-8')
  return p
}

function line(id: string, severity: string, flags: string, subject: string, reason: string, regex: string): string {
  return [id, severity, flags, subject, reason, regex].join('\t')
}

describe('parsing', () => {
  it('is absent when missing', () => {
    const s = loadSnapshot(WS, join(dir, 'nope.rules'))
    expect(s.state).toBe('absent')
    expect(s.rules).toEqual([])
    expect(s.healthMessage).toContain('built-in protections only')
  })

  it('parses a rule', () => {
    const p = rulesFile([line('d.rm', 'block', '-', 'command', 'Destructive filesystem command', 'rm\\s+-rf')])
    const s = loadSnapshot(WS, p)
    expect(s.state).toBe('ok')
    expect(s.rules).toHaveLength(1)
    expect(s.rules[0]!.id).toBe('d.rm')
    expect(s.rules[0]!.subject).toBe('command')
  })

  it('is empty state when no rules', () => {
    const p = rulesFile([])
    expect(loadSnapshot(WS, p).state).toBe('empty')
  })

  it('skips a short line', () => {
    const p = rulesFile(['only\ttwo'])
    expect(loadSnapshot(WS, p).state).toBe('empty')
  })

  it('drops an uncompilable regex, not fatal', () => {
    const p = rulesFile([
      line('bad', 'block', '-', 'command', 'broken', '([unclosed'),
      line('good', 'block', '-', 'command', 'fine', 'rm -rf'),
    ])
    const s = loadSnapshot(WS, p)
    expect(s.state).toBe('ok')
    expect(s.rules).toHaveLength(1)
    expect(s.droppedRules).toBe(1)
  })

  it('honours the ignore-case flag', () => {
    const p = rulesFile([line('c', 'block', 'i', 'command', 'r', 'KUBECTL')])
    const s = loadSnapshot(WS, p)
    expect(evaluate('shell', '', 'kubectl apply', s).severity).toBe(SEV_BLOCK)
  })
})

describe('integrity', () => {
  it('a bad digest invalidates and drops rules', () => {
    const p = rulesFile([line('d', 'block', '-', 'command', 'r', 'rm')], { digest: '0'.repeat(32) })
    const s = loadSnapshot(WS, p)
    expect(s.state).toBe('invalid')
    expect(s.rules).toEqual([])
  })

  it('a missing digest invalidates, as it does in every gate', () => {
    const p = rulesFile([line('d', 'block', '-', 'command', 'r', 'rm')])
    writeFileSync(p, readFileSync(p, 'utf-8').replace(/^#digest .*\n/m, ''), 'utf-8')
    const s = loadSnapshot(WS, p)
    expect(s.state).toBe('invalid')
    expect(s.rules).toEqual([])
  })

  it('a workspace mismatch invalidates', () => {
    const p = rulesFile([line('d', 'block', '-', 'command', 'r', 'rm')], { workspace: 'ws_someone_else' })
    const s = loadSnapshot(WS, p)
    expect(s.state).toBe('invalid')
    expect(s.rules).toEqual([])
  })

  it('a matching workspace is ok', () => {
    const p = rulesFile([line('d', 'block', '-', 'command', 'r', 'rm')])
    expect(loadSnapshot(WS, p).state).toBe('ok')
  })

  it('a stale snapshot still enforces', () => {
    const p = rulesFile([line('d', 'block', '-', 'command', 'r', 'rm')], {
      generated: '2020-01-01T00:00:00+00:00',
    })
    const s = loadSnapshot(WS, p)
    expect(s.state).toBe('stale')
    expect(s.rules).toHaveLength(1)
    expect(evaluate('shell', '', 'rm x', s).severity).toBe(SEV_BLOCK)
  })
})

describe('evaluation', () => {
  function snap() {
    return loadSnapshot(
      WS,
      rulesFile([
        line('destructive.rm', 'block', '-', 'command', 'Destructive command', 'rm\\s+-rf\\s+/'),
        line('proto.paths', 'block', '-', 'target', 'governance-protected path', '\\.intutic/'),
        line('advise.curl', 'warn', '-', 'command', 'Network egress', 'curl '),
        line('shadow.helm', 'shadow', '-', 'command', 'Helm use', 'helm '),
        // Real snapshot rules never carry a bare `^name$` for a tool-subject
        // pattern: `toGuardPattern` in services/sync-daemon/src/lib/policySnapshot.ts
        // strips a SOP toolPattern's `^`/`$` and re-wraps it as `' (name) '`
        // specifically because the reader tests against a padded string —
        // see snapshot.ts's module doc comment for why. This fixture mirrors
        // the real wire shape, as the Python reader's test now does too.
        line('tool.fetch', 'block', '-', 'tool', 'Tool not permitted', ' (webfetch) '),
      ]),
    )
  }

  it('allows benign commands', () => {
    expect(evaluate('shell', '', 'ls -la', snap()).severity).toBeNull()
  })

  it('blocks on the command subject', () => {
    const d = evaluate('shell', '', 'rm -rf /', snap())
    expect(d.severity).toBe(SEV_BLOCK)
    expect(d.ruleId).toBe('destructive.rm')
  })

  it('carries the rule id in the reason', () => {
    const d = evaluate('write_file', '.intutic/image-allowlist.json', '', snap())
    expect(d.severity).toBe(SEV_BLOCK)
    expect(d.reason).toContain('governance-protected')
    expect(d.reason).toContain('[proto.paths]')
  })

  it('does not let a target rule match a command', () => {
    expect(evaluate('shell', '', 'echo .intutic/ stuff', snap()).severity).not.toBe(SEV_BLOCK)
  })

  it('matches the tool subject', () => {
    expect(evaluate('webfetch', '', '', snap()).severity).toBe(SEV_BLOCK)
  })

  it('a shadow or warn match does not hide a later block, as in the rendered gates', () => {
    const s = loadSnapshot(
      WS,
      rulesFile([
        line('shadow.push', 'shadow', '-', 'command', 'Push observed', 'git push'),
        line('advise.push', 'warn', '-', 'command', 'Push flagged', 'git push'),
        line('sop.no_force', 'block', '-', 'command', 'No force push', 'push --force'),
      ]),
    )
    const d = evaluate('shell', '', 'git push --force origin main', s)
    expect(d.severity).toBe(SEV_BLOCK)
    expect(d.ruleId).toBe('sop.no_force')
    expect(d.advisories?.map((a) => a.ruleId)).toEqual(['shadow.push', 'advise.push'])
    // With no block, the first advisory match is still the decision.
    const plain = evaluate('shell', '', 'git push origin feature', s)
    expect(plain.severity).toBe(SEV_SHADOW)
    expect(plain.advisories?.map((a) => a.ruleId)).toEqual(['shadow.push', 'advise.push'])
  })

  it('resumes after the deciding rule, so a block behind an approved hold still decides', () => {
    const s = loadSnapshot(
      WS,
      rulesFile([
        line('sop.deploy_hold', 'hold', '-', 'command', 'Deploys are reviewed', 'deploy'),
        line('sop.no_prod', 'block', '-', 'command', 'Not to prod', 'deploy prod'),
      ]),
    )
    const held = evaluate('shell', '', 'make deploy prod', s)
    expect(held.severity).toBe('hold')
    const after = evaluate('shell', '', 'make deploy prod', s, false, held.next)
    expect(after.severity).toBe(SEV_BLOCK)
    expect(after.ruleId).toBe('sop.no_prod')
  })

  it('warn allows but reports the verb', () => {
    const d = evaluate('shell', '', 'curl https://example.com', snap())
    expect(d.severity).toBe(SEV_WARN)
    expect(d.reason).toContain('verb=curl')
  })

  it('counts shadow apart from warn', () => {
    expect(evaluate('shell', '', 'helm upgrade x', snap()).severity).toBe(SEV_SHADOW)
  })

  it('guard-disable drops only the destructive family', () => {
    const s = snap()
    expect(evaluate('shell', '', 'rm -rf /', s, true).severity).toBeNull()
    expect(evaluate('write_file', '.intutic/x', '', s, true).severity).toBe(SEV_BLOCK)
  })
})

// Port of TestPhraseRules: a `phrase` rule's source is phrases joined by |,
// matched as words by the phrase matcher, never as a regex — the gap regex it
// replaced backtracked for seconds on a few hundred kilobytes of crafted text.
describe('phrase rules', () => {
  const load = () =>
    loadSnapshot(
      WS,
      rulesFile([
        line('destructive.sql_drop', 'warn', 'i', 'phrase', 'Destructive SQL statement', 'drop table|drop database|drop schema|truncate table'),
      ]),
    )

  it.each([
    "psql -c 'DROP/**/TABLE users'",
    "psql -c 'DROP -- why\nTABLE users'",
    "psql -c 'DROP \\\nTABLE users'",
    "printf 'DROP\\nTABLE users' | psql",
  ])('matches %j whatever separates the words', (command) => {
    const d = evaluate('shell', '', command, load())
    expect(d.severity).toBe(SEV_WARN)
    expect(d.ruleId).toBe('destructive.sql_drop')
  })

  it.each(['git stash drop && cat table.md', 'truncate --size 0 table.log', './drop_table.sh'])(
    'needs the whole words: %j',
    (command) => {
      expect(evaluate('shell', '', command, load()).severity).toBeNull()
    },
  )

  it.each([
    ['drop -- ', 25000],
    ['drop /* ', 25000],
    ['\\ ', 100000],
  ] as const)('stays linear on %j repeated up to %i times', (unit, times) => {
    const s = load()
    const commands = { 1: unit.repeat(times / 4), 4: unit.repeat(times) }
    expectLinearTime(JSON.stringify(unit), (scale) => evaluate('shell', '', commands[scale], s))
  })
})

describe('decide records (snapshot format 2)', () => {
  // The shared vectors' LLD example: an enforce record on Bash, and the
  // fallback line it names.
  const VECTORS = JSON.parse(readFileSync(join(__dirname, '../../../shared-types/fixtures/decide-vectors.json'), 'utf-8')).record as {
    valid: Array<{ name: string; line: string }>
    damaged: Array<{ name: string; line: string }>
  }
  const record = VECTORS.valid[0]!.line
  const damaged = VECTORS.damaged.find((c) => c.name === 'a word of the rule changed under the same hash')!.line
  const FB = 'decide-fallback:prod-data-export@6bcd6b021e7d'
  const fallback = line(FB, 'block', '-', 'tool', 'Decide rule prod-data-export (Production data handling): upgrade to Intutic 3.0 to evaluate this rule', ' (Bash) ')
  const other = line('d.rm', 'block', '-', 'command', 'Destructive', 'rm -rf')

  it('carries a record that decodes, and keeps its fallback line for a caller that does not evaluate decide rules', () => {
    const s = loadSnapshot(WS, rulesFile(['@format\t2', record, fallback, other]))
    expect(s.state).toBe('ok')
    expect(s.formatVersion).toBe(2)
    expect(s.decideRules.map((r) => r.ref)).toEqual(['local:data.md#prod-data-export'])
    expect(s.rules.map((r) => r.id)).toEqual([FB, 'd.rm'])
    expect(evaluate('Bash', '', 'ls -la', s)).toMatchObject({ severity: SEV_BLOCK, ruleId: FB })
  })

  it('skips the fallback line a decoded record names only for a caller that evaluates decide rules', () => {
    const s = loadSnapshot(WS, rulesFile(['@format\t2', record, fallback, other]), { evaluatesDecide: true })
    expect(s.rules.map((r) => r.id)).toEqual(['d.rm'])
    expect(evaluate('Bash', '', 'ls -la', s).severity).toBeNull()
  })

  it('a Gate evaluates decide rules: it skips the fallback line, and with no engine configured refuses GOVERNANCE_UNAVAILABLE', async () => {
    expect(CAN_EVALUATE_DECIDE).toBe(true)
    const saved = { rules: process.env.INTUTIC_SNAPSHOT_RULES, home: process.env.HOME, model: process.env.INTUTIC_DECIDE_MODEL }
    process.env.INTUTIC_SNAPSHOT_RULES = rulesFile(['@format\t2', record, fallback, other])
    // No engine.json under this HOME and no model: the engine is not configured.
    process.env.HOME = dir
    delete process.env.INTUTIC_DECIDE_MODEL
    try {
      const gate = new Gate({ repoRoot: dir, workspaceId: WS, useHookGate: false, useSopRules: false }, null)
      const err = await gate.guard('Bash', { command: 'ls -la' }).then(() => null, (e: unknown) => e)
      expect(err).toBeInstanceOf(IntuticGateRefusal)
      expect((err as IntuticGateRefusal).code).toBe('GOVERNANCE_UNAVAILABLE')
      expect((err as IntuticGateRefusal).reason).not.toContain(`[${FB}]`)
      expect(gate.getSnapshot().decideRules).toHaveLength(1)
      expect(gate.getSnapshot().rules.map((r) => r.id)).toEqual(['d.rm'])
    } finally {
      for (const [k, v] of [['INTUTIC_SNAPSHOT_RULES', saved.rules], ['HOME', saved.home], ['INTUTIC_DECIDE_MODEL', saved.model]] as const) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  it('keeps the fallback line in force when the record does not decode', () => {
    const s = loadSnapshot(WS, rulesFile(['@format\t2', damaged, fallback, other]), { evaluatesDecide: true })
    expect(s.decideRules).toEqual([])
    expect(evaluate('Bash', '', 'ls -la', s)).toMatchObject({ severity: SEV_BLOCK, ruleId: FB })
  })

  it('enforces a fallback line no record names', () => {
    const orphan = line('decide-fallback:unreadable.1@6bcd6b021e7d', 'block', '-', 'tool', 'Decide rule x does not read', ' [^ ]+ ')
    const s = loadSnapshot(WS, rulesFile([record, fallback, orphan]), { evaluatesDecide: true })
    expect(s.rules.map((r) => r.id)).toEqual(['decide-fallback:unreadable.1@6bcd6b021e7d'])
    expect(s.formatVersion).toBe(1)
  })

  it('drops the records with the rest of the dynamic tier on a snapshot that fails its check', () => {
    const s = loadSnapshot(WS, rulesFile(['@format\t2', record, fallback], { digest: 'f'.repeat(32) }))
    expect(s.state).toBe('invalid')
    expect(s.decideRules).toEqual([])
    expect(s.rules).toEqual([])
  })

  it('reads a newer format and still enforces what it reads', () => {
    const s = loadSnapshot(WS, rulesFile(['@format\t3', '@novel\trecord', fallback]))
    expect(s.formatVersion).toBe(3)
    expect(evaluate('Bash', '', 'ls', s)).toMatchObject({ severity: SEV_BLOCK, ruleId: FB })
  })
})
