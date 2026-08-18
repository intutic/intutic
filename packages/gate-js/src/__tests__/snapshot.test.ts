import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { evaluate, loadSnapshot, SEV_BLOCK, SEV_SHADOW, SEV_WARN } from '../snapshot.js'

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
        // the real wire shape rather than the anchor-only form the ported
        // Python test used (which only worked there because the Python
        // reader does not pad).
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
