/**
 * A review hold is the one place raw tool *arguments* leave the machine.
 *
 * `Write` carries file contents. `Bash` carries whole command lines. Both
 * routinely contain credentials the developer never meant to publish, and the
 * proxy's DLP scanner cannot help — it sits on the HTTP path, and this runs
 * inside the harness before any request exists.
 *
 * So the snapshot is scrubbed in the hook, before it touches disk. Scrubbing on
 * the way out instead would leave the plaintext sitting in `.intutic/events/`,
 * and a file that exists is a file that ends up in a bug report.
 *
 * Every credential below is ASSEMBLED AT RUNTIME. A contiguous credential-shaped
 * literal in source is itself the thing being defended against: secret scanners
 * flag the fixture, and the fixture is what teaches the next reader the shape.
 */
import { describe, it, expect } from 'vitest'
import {
  redactSecrets,
  buildContextSnapshot,
  emitRedactor,
  MAX_STRING,
  MAX_SNAPSHOT_BYTES,
} from '../../src/harness/holdRedaction.js'

/** Builds a credential-shaped string without ever writing one down. */
const shape = (prefix: string, body: string, n: number): string =>
  prefix + body.repeat(Math.ceil(n / body.length)).slice(0, n)

const AWS = shape('AK' + 'IA', 'QRSTUVWX34567890', 16)
const ANTHROPIC = shape('sk-' + 'ant-', 'aBcDeFgHiJkLmNoPqRsT', 40)
const OPENAI = shape('sk-', 'aBcDeFgHiJkLmNoPqRsTuVwXyZ012345', 40)
const GITHUB = shape('gh' + 'p_', 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789', 36)
const SLACK = shape('xo' + 'xb-', '1234567890-abcdefghij', 24)
const GOOGLE = shape('AI' + 'za', 'SyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456', 35)
const JWT = [shape('ey' + 'J', 'hbGciOiJIUzI1NiJ9', 17), shape('ey', 'JzdWIiOiIxMjM0NTY3ODkwIn0', 24), shape('', 'dBjftJeZ4CVPmB92K27uhbUJU1p1r', 28)].join('.')

describe('credential shapes are scrubbed', () => {
  it.each([
    ['AWS access key', AWS],
    ['Anthropic key', ANTHROPIC],
    ['OpenAI key', OPENAI],
    ['GitHub token', GITHUB],
    ['Slack token', SLACK],
    ['Google API key', GOOGLE],
    ['JWT', JWT],
  ])('scrubs a %s embedded in a command', (label, secret) => {
    const out = redactSecrets({ command: `curl -H "x-key: ${secret}" https://example.test` })
    const text = JSON.stringify(out)
    expect(text, `${label} survived redaction and would have been uploaded`).not.toContain(secret)
    expect(text).toContain('[redacted]')
  })

  it('scrubs a private key block whole, not just its header', () => {
    const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'.repeat(4)
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`
    const out = JSON.stringify(redactSecrets({ file_text: pem }))
    expect(out).not.toContain(body)
  })

  it('scrubs basic-auth credentials in a URL', () => {
    const out = JSON.stringify(redactSecrets({ command: 'git clone https://user:hunter2swordfish@git.test/r.git' }))
    expect(out).not.toContain('hunter2swordfish')
  })

  it('redacts by key name even when the value looks innocent', () => {
    // The value is 'abc' — no pattern matches it. The key is what condemns it.
    for (const key of ['password', 'api_key', 'apiKey', 'X-Api-Key', 'authorization', 'privateKey', 'cookie']) {
      const out = redactSecrets({ [key]: 'abc' }) as Record<string, unknown>
      expect(out[key], `${key} was passed through verbatim`).toBe('[redacted]')
    }
  })

  it('scrubs an assignment form under an innocent key', () => {
    const out = JSON.stringify(redactSecrets({ command: 'deploy --db-password=correcthorsebatterystaple' }))
    expect(out).not.toContain('correcthorsebatterystaple')
  })

  it('leaves ordinary arguments alone', () => {
    // Over-redaction is its own failure: a snapshot of [redacted] cannot serve
    // as a rule's block mock, which is the whole reason it is captured.
    const input = { command: 'pnpm test --filter @intutic/db', file_path: 'src/index.ts' }
    expect(redactSecrets(input)).toEqual(input)
  })
})

describe('the snapshot stays bounded', () => {
  it('keeps both ends of a long string, not just the head', () => {
    const long = 'A'.repeat(MAX_STRING * 2) + 'THE-TARGET'
    const out = redactSecrets(long) as string
    expect(out.length).toBeLessThan(long.length)
    expect(out, 'the tail identifies what the hold was about').toContain('THE-TARGET')
    expect(out).toContain('elided')
  })

  it('caps arrays and says how many it dropped', () => {
    const out = redactSecrets(Array.from({ length: 200 }, (_, i) => i)) as unknown[]
    expect(out.length).toBeLessThanOrEqual(51)
    expect(String(out[out.length - 1])).toMatch(/more elided/)
  })

  it('stops at the depth limit instead of recursing forever', () => {
    let deep: Record<string, unknown> = { end: 'leaf' }
    for (let i = 0; i < 40; i++) deep = { nest: deep }
    expect(() => redactSecrets(deep)).not.toThrow()
    expect(JSON.stringify(redactSecrets(deep))).toContain('depth limit')
  })

  it('drops the arguments rather than emitting unparseable JSON', () => {
    // Many fields, not one long one: a single string is capped at MAX_STRING
    // long before the snapshot ceiling, so the ceiling is only reachable by
    // breadth. That is also the realistic shape — a tool input with a hundred
    // keys, not one enormous value.
    const wide: Record<string, string> = {}
    for (let i = 0; i < 60; i++) wide[`field_${i}`] = 'x'.repeat(MAX_STRING)
    const snapshot = buildContextSnapshot({
      tool: 'Write',
      toolInput: wide,
      cwd: '/repo',
      reason: 'action:deploy',
    })
    const text = JSON.stringify(snapshot)
    expect(() => JSON.parse(text)).not.toThrow()
    expect(text.length).toBeLessThan(MAX_SNAPSHOT_BYTES)
    expect(String(snapshot['toolInput'])).toMatch(/elided/)
    expect(snapshot['reason'], 'why it was held must survive the cap').toBe('action:deploy')
  })

  it('survives a cyclic object rather than hanging the hook', () => {
    // A hook that throws is a hook that does not block. Depth is what saves us
    // here — there is no seen-set — so this asserts the cap is load-bearing.
    const cyclic: Record<string, unknown> = { name: 'root' }
    cyclic['self'] = cyclic
    expect(() => JSON.stringify(redactSecrets(cyclic))).not.toThrow()
  })
})

describe('the emitted form is what runs', () => {
  const emitted = emitRedactor()

  it('binds both functions to fixed names', () => {
    expect(emitted).toContain('const __intuticRedact =')
    expect(emitted).toContain('const __intuticSnapshot =')
  })

  it('references no binding it does not also declare', () => {
    // The hook has no module resolution. A closure capture here emits a body
    // referencing something that does not exist, and the hold write throws
    // inside a catch — silently producing no snapshot at all.
    // Every module-level name the two functions can reach, not just the caps.
    // The caps-only version of this assertion passed while the emitted source
    // called a `redactSecrets` that was never declared.
    for (const name of [
      'MAX_STRING',
      'MAX_DEPTH',
      'MAX_ARRAY',
      'MAX_SNAPSHOT_BYTES',
      'redactSecrets',
      'buildContextSnapshot',
    ]) {
      if (!new RegExp(`\\b${name}\\b`).test(emitted)) continue
      expect(emitted, `${name} is referenced but not declared in the emitted source`).toContain(
        `const ${name} =`,
      )
    }
    expect(emitted, 'an import survived into the emitted hook').not.toMatch(/\brequire\(|\bimport\s/)
  })

  it('actually evaluates and redacts once emitted', () => {
    // The real check: run the emitted text the way the hook will.
    const run = new Function(`${emitted}
      return __intuticSnapshot({
        tool: 'Bash',
        toolInput: { command: ${JSON.stringify(`aws configure set key ${AWS}`)} },
        cwd: '/repo',
        reason: 'action:deploy',
      });`) as () => Record<string, unknown>
    const snapshot = run()
    const text = JSON.stringify(snapshot)
    expect(text).not.toContain(AWS)
    expect(text).toContain('[redacted]')
    expect(snapshot['tool']).toBe('Bash')
  })
})
