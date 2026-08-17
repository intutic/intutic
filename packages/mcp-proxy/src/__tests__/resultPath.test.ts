/**
 * The response direction, which the byte-for-byte pipe never inspected.
 *
 * Request-side scanning existed since the interceptor did; the real server's
 * stdout streamed into the agent's context untouched, and the `redact`
 * decision + `tool_redacted` event were declared types with no producer.
 * These tests pin the producer: results are redacted (not blocked — the call
 * already ran), tools/list is curated by the additive allowlist and operator
 * description overrides, and the empty allowlist means unrestricted — never
 * "permit nothing", the inversion the starter rules keep warning about.
 */
import { describe, it, expect } from 'vitest'
import { processServerLine, type PendingRequest } from '../proxy.js'
import { redactText, setDynamicPatterns, scanToolInput } from '../dlp.js'

/** Runtime-assembled per the repo convention: no contiguous credential-shaped literals. */
const fangedKey = () => `${'AKIA'}${'B2C3D4E5F6G7H2J3'}`

describe('redactText', () => {
  it('redacts a credential value out of result text', () => {
    const { redacted, findings } = redactText(`token is ${fangedKey()} ok`)
    expect(redacted).not.toContain(fangedKey())
    expect(redacted).toContain('[REDACTED_SECRET]')
    expect(findings.map((f) => f.description)).toContain('AWS Access Key ID')
  })

  it('redacts an SSN — the PII class this scanner never had', () => {
    const ssn = ['123', '45', '6789'].join('-')
    const { redacted } = redactText(`ssn: ${ssn}`)
    expect(redacted).not.toContain(ssn)
  })

  it('does NOT redact command patterns out of results', () => {
    // A schema dump legitimately mentions DROP TABLE; rewriting it would
    // change what the result means. Command patterns are input-gate-only.
    const { redacted, findings } = redactText('migration: DROP TABLE users;')
    expect(redacted).toBe('migration: DROP TABLE users;')
    expect(findings).toEqual([])
  })
})

describe('setDynamicPatterns', () => {
  it('workspace patterns reach both directions of the scanner', () => {
    setDynamicPatterns(['INTERNAL-[0-9]{6}'])
    try {
      expect(scanToolInput({ note: 'ref INTERNAL-123456' }).hasFinding).toBe(true)
      expect(redactText('ref INTERNAL-123456').redacted).toContain('[REDACTED_SECRET]')
    } finally {
      setDynamicPatterns([])
    }
  })

  it('drops invalid regexes by count instead of taking the scanner down', () => {
    expect(setDynamicPatterns(['[unclosed', 'ok-[0-9]+'])).toBe(1)
    setDynamicPatterns([])
  })
})

describe('processServerLine', () => {
  const pendingWith = (id: string | number, req: PendingRequest) =>
    new Map<string | number, PendingRequest>([[id, req]])

  it('redacts a secret inside a tool result before the agent sees it', () => {
    const key = fangedKey()
    const line = JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      result: { content: [{ type: 'text', text: `config: ${key}` }] },
    })
    const out = processServerLine(line, pendingWith(7, { method: 'tools/call', toolName: 'read_file' }), [], {})
    expect(out.line).not.toContain(key)
    expect(out.line).toContain('[REDACTED_SECRET]')
    expect(out.redactedTool).toBe('read_file')
    // Still a parseable response the harness can consume.
    expect(() => JSON.parse(out.line)).not.toThrow()
  })

  it('forwards a clean result byte-identical', () => {
    const line = JSON.stringify({ jsonrpc: '2.0', id: 8, result: { content: [] } })
    const out = processServerLine(line, pendingWith(8, { method: 'tools/call', toolName: 'x' }), [], {})
    expect(out.line).toBe(line)
    expect(out.redactedTool).toBeUndefined()
  })

  it('scans resources/read the same way', () => {
    const key = fangedKey()
    const line = JSON.stringify({ jsonrpc: '2.0', id: 9, result: { contents: [{ text: key }] } })
    const out = processServerLine(line, pendingWith(9, { method: 'resources/read' }), [], {})
    expect(out.line).not.toContain(key)
  })

  it('filters tools/list to the allowlist and overrides descriptions', () => {
    const line = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: {
        tools: [
          { name: 'read_file', description: 'upstream text' },
          { name: 'delete_everything', description: 'nope' },
        ],
      },
    })
    const out = processServerLine(
      line,
      pendingWith(1, { method: 'tools/list' }),
      ['read_file'],
      { read_file: 'curated text' },
    )
    const parsed = JSON.parse(out.line)
    expect(parsed.result.tools).toHaveLength(1)
    expect(parsed.result.tools[0].description).toBe('curated text')
    expect(out.curated).toEqual({ hidden: 1, overridden: 1 })
  })

  it('an EMPTY allowlist leaves the listing alone — unrestricted, not "hide everything"', () => {
    const line = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      result: { tools: [{ name: 'a' }, { name: 'b' }] },
    })
    const out = processServerLine(line, pendingWith(2, { method: 'tools/list' }), [], {})
    expect(out.line).toBe(line)
    expect(out.curated).toBeUndefined()
  })

  it('exposes toolsListTools on every tools/list response, curated or not — TOFU pinning needs it', () => {
    const uncuratedLine = JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      result: { tools: [{ name: 'a', description: 'A' }] },
    })
    const uncurated = processServerLine(uncuratedLine, pendingWith(3, { method: 'tools/list' }), [], {})
    expect(uncurated.toolsListTools).toEqual([{ name: 'a', description: 'A' }])
    expect(uncurated.toolsListMsgId).toBe(3)

    const curatedLine = JSON.stringify({
      jsonrpc: '2.0',
      id: 4,
      result: { tools: [{ name: 'a', description: 'A' }, { name: 'b', description: 'B' }] },
    })
    const curated = processServerLine(curatedLine, pendingWith(4, { method: 'tools/list' }), ['a'], {})
    expect(curated.toolsListTools).toEqual([{ name: 'a', description: 'A' }])
    expect(curated.toolsListMsgId).toBe(4)
  })

  it('passes notifications and unknown ids through untouched', () => {
    const notification = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress' })
    expect(processServerLine(notification, new Map(), [], {}).line).toBe(notification)
    const unknown = JSON.stringify({ jsonrpc: '2.0', id: 99, result: { x: fangedKey() } })
    // No pending entry: this response answers a request the proxy never saw
    // (pre-start traffic); forwarding beats guessing at its method.
    expect(processServerLine(unknown, new Map(), [], {}).line).toBe(unknown)
  })
})
