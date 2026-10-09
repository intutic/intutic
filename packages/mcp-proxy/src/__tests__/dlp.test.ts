/**
 * dlp.test.ts — Unit tests for the DLP argument scanner.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { scanToolInput, formatDlpBlockReason } from '../dlp.js'

describe('scanToolInput', () => {
  it('returns no findings for benign content', () => {
    const result = scanToolInput({ path: '/tmp/file.txt', content: 'hello world' })
    expect(result.hasFinding).toBe(false)
    expect(result.findings).toHaveLength(0)
  })

  it('detects OpenAI API keys', () => {
    const result = scanToolInput({ env: 'OPENAI_KEY=sk-abc123def456ghi789jkl012mno345pqr' })
    expect(result.hasFinding).toBe(true)
    expect(result.findings.some((f) => f.description.includes('OpenAI'))).toBe(true)
  })

  it('detects Anthropic API keys', () => {
    const result = scanToolInput({ key: 'sk-ant-' + 'api03-verylongantkeyhere12345678901234' })
    expect(result.hasFinding).toBe(true)
    expect(result.findings.some((f) => f.description.includes('Anthropic'))).toBe(true)
  })

  it('detects GitHub personal access tokens', () => {
    const result = scanToolInput({ token: 'ghp_' + 'abcdefghijklmnopqrstuvwxyz123456789012' })
    expect(result.hasFinding).toBe(true)
    expect(result.findings.some((f) => f.description.includes('GitHub'))).toBe(true)
  })

  it('detects AWS Access Key IDs', () => {
    // Fixture is runtime-assembled: the repo convention forbids contiguous
    // credential-shaped literals in source, in every package.
    const result = scanToolInput({ key: 'AKIA' + 'IOSFODNN7EXAMPLE' })
    expect(result.hasFinding).toBe(true)
    expect(result.findings.some((f) => f.description.includes('AWS'))).toBe(true)
  })

  // Slack token fixtures are assembled at runtime and never written as a
  // contiguous literal — GitHub push protection blocks format-valid `xoxb-`
  // strings on push. The scanned value is identical, so the tests still bite.
  //
  // These assert on the finding's *description* rather than on `f.pattern`
  // (which is `regex.source`) on purpose: the token shape is the contract,
  // the regex text is an implementation detail.
  const slackBody = ['2345678901', '2345678901234', 'AbCdEfGhIjKlMnOpQrStUvWxYz'].join('-')

  it('detects Slack bot tokens', () => {
    const result = scanToolInput({ env: 'SLACK_BOT_TOKEN=' + 'xoxb' + '-' + slackBody })
    expect(result.hasFinding).toBe(true)
    expect(result.findings.some((f) => f.description === 'Slack bot token')).toBe(true)
  })

  it('detects Slack user tokens', () => {
    const result = scanToolInput({ env: 'SLACK_USER_TOKEN=' + 'xoxp' + '-' + slackBody })
    expect(result.hasFinding).toBe(true)
    expect(result.findings.some((f) => f.description === 'Slack user token')).toBe(true)
  })

  it('spans the internal hyphen separators of a Slack token body', () => {
    // Pins `-` as a member of the token-body character class. A real Slack
    // token is hyphen-delimited, so if the hyphen ever stopped being matched
    // the scanner would only ever see the first ~10-char segment and would
    // silently stop detecting Slack tokens entirely.
    const body = 'a-'.repeat(25) // exactly 50 chars, 25 of them hyphens
    expect(body).toHaveLength(50)
    const result = scanToolInput({ token: 'xoxb' + '-' + body })
    expect(result.findings.some((f) => f.description === 'Slack bot token')).toBe(true)
  })

  it('does not flag a Slack-prefixed body shorter than the 50-char minimum', () => {
    const body = 'a-'.repeat(24) + 'a' // 49 chars
    expect(body).toHaveLength(49)
    const result = scanToolInput({ token: 'xoxb' + '-' + body })
    expect(result.findings.some((f) => f.description.includes('Slack'))).toBe(false)
  })

  it('detects PEM private keys', () => {
    const result = scanToolInput({ cert: '-----BEGIN ' + 'RSA PRIVATE KEY-----\nMIIEowIBAAK...' })
    expect(result.hasFinding).toBe(true)
    expect(result.findings.some((f) => f.description.includes('private key'))).toBe(true)
  })

  it('detects destructive rm -rf / commands', () => {
    const result = scanToolInput({ command: 'rm -rf /var/data' })
    expect(result.hasFinding).toBe(true)
    expect(result.findings.some((f) => f.description.includes('Destructive'))).toBe(true)
  })

  it('detects SQL DROP TABLE', () => {
    const result = scanToolInput({ query: 'DROP TABLE users; SELECT 1' })
    expect(result.hasFinding).toBe(true)
    expect(result.findings.some((f) => f.description.includes('DROP TABLE'))).toBe(true)
  })

  // `DROP\s+TABLE` against the JSON-encoded arguments let every one of these
  // through: a newline or tab is a two-character escape in the JSON, and a
  // comment between the words is not whitespace at all.
  describe('destructive SQL, whatever separates the keywords', () => {
    const blocked = (input: unknown) =>
      scanToolInput(input).findings.some((f) => f.description === 'SQL DROP TABLE statement')

    it.each([
      ['a newline', 'DROP\nTABLE users'],
      ['a tab', 'DROP\tTABLE users'],
      ['a block comment', 'DROP/**/TABLE users'],
      ['a commented block comment', 'DROP /* why */ TABLE users'],
      ['a line comment', 'DROP -- why\nTABLE users'],
      ['mixed case', 'dRoP tAbLe users'],
      ['an escape that printf expands', String.raw`printf 'DROP\nTABLE users' | psql`],
    ])('blocks DROP TABLE split by %s', (_, query) => {
      expect(blocked({ query })).toBe(true)
    })

    it('blocks an escaped newline in the JSON request body', () => {
      expect(blocked(JSON.parse(String.raw`{"query": "DROP\nTABLE users"}`))).toBe(true)
    })

    it('blocks a statement in a nested argument or an object key', () => {
      expect(blocked({ batch: [{ sql: 'select 1' }, { sql: 'DROP\nTABLE users' }] })).toBe(true)
      expect(blocked({ 'DROP TABLE users': true })).toBe(true)
    })

    it('blocks DROP DATABASE and TRUNCATE TABLE the same way', () => {
      const descriptions = (q: string) => scanToolInput({ q }).findings.map((f) => f.description)
      expect(descriptions('DROP/**/DATABASE prod')).toContain('SQL DROP DATABASE statement')
      expect(descriptions('truncate\ttable events')).toContain('SQL TRUNCATE TABLE statement')
    })

    it('blocks a quoted mention: the rule reads text, not SQL', () => {
      // Documented intent: a quoted string is also how a shell command carries
      // the real statement (`psql -c 'DROP TABLE x'`), so this rule does not
      // skip literals. The proxy's sql_guard, which reads the SQL a client will
      // run, is the one that tells them apart.
      expect(blocked({ query: "SELECT 'drop table' AS note" })).toBe(true)
    })

    it('does not join a keyword to anything but the next keyword', () => {
      expect(blocked({ command: 'git stash drop && cat table.md' })).toBe(false)
      expect(blocked({ command: 'psql --command "SELECT 1" --table' })).toBe(false)
    })

    // The scan used a regex with the gap between the keywords, which a
    // backtracking engine took seconds on; the phrase matcher stays linear.
    it.each(
      (JSON.parse(readFileSync(join(__dirname, '../../../proxy/src/plugins/anomaly/action_vectors.json'), 'utf-8')) as {
        adversarial: Array<[string, number]>
      }).adversarial,
    )('scans %j repeated %i times in under 200 ms', (unit, times) => {
      const command = unit.repeat(times)
      const t0 = performance.now()
      scanToolInput({ command })
      expect(performance.now() - t0).toBeLessThan(200)
    })
  })

  it('detects SQL DROP DATABASE', () => {
    const result = scanToolInput({ sql: 'DROP DATABASE production' })
    expect(result.hasFinding).toBe(true)
  })

  it('handles null/undefined input gracefully', () => {
    expect(() => scanToolInput(null)).not.toThrow()
    expect(() => scanToolInput(undefined)).not.toThrow()
    const result = scanToolInput(undefined)
    expect(result.hasFinding).toBe(false)
  })

  it('handles deeply nested objects', () => {
    const result = scanToolInput({ outer: { inner: { key: 'sk-abc123def456ghi789jkl012mno345pqr' } } })
    expect(result.hasFinding).toBe(true)
  })

  it('returns multiple findings when multiple patterns match', () => {
    const result = scanToolInput({
      openai: 'sk-abc123def456ghi789jkl012mno345pqr',
      aws: 'AKIA' + 'IOSFODNN7EXAMPLE',
    })
    expect(result.findings.length).toBeGreaterThanOrEqual(2)
  })
})

describe('formatDlpBlockReason', () => {
  it('formats a single finding into readable text', () => {
    const findings = [{ pattern: 'sk-.*', description: 'OpenAI API key pattern' }]
    const reason = formatDlpBlockReason(findings)
    expect(reason).toContain('DLP scanner')
    expect(reason).toContain('OpenAI API key pattern')
    expect(reason).toContain('•')
  })

  it('formats multiple findings', () => {
    const findings = [
      { pattern: 'sk-.*', description: 'OpenAI API key' },
      { pattern: 'AKIA.*', description: 'AWS Access Key' },
    ]
    const reason = formatDlpBlockReason(findings)
    expect(reason).toContain('OpenAI API key')
    expect(reason).toContain('AWS Access Key')
  })
})
