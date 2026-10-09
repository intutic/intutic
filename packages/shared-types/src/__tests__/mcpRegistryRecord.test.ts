import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  decodeMcpRegistryRecord,
  encodeMcpRegistryRecord,
  evaluateMcpRegistry,
  isUnrestrictedMcpRegistry,
  MCP_REGISTRY_JS_SOURCE,
  MCP_REGISTRY_RECORD_TAG,
  parseMcpRegistryRecord,
  type McpRegistryRecord,
} from '../mcpRegistryRecord.js'

interface Vectors {
  registries: Record<string, McpRegistryRecord>
  cases: Array<{ name: string; registry: string; toolName: string; code: string | null; ruleId: string | null; reason: string | null }>
}

const VECTORS: Vectors = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/mcp-registry-vectors.json'), 'utf8'),
)

/** The harness name split the way every gate splits it: the server is the part before the first `__`. */
function split(toolName: string): [string, string] {
  const rest = toolName.slice('mcp__'.length)
  const sep = rest.indexOf('__')
  return [rest.slice(0, sep), rest.slice(sep + 2)]
}

// The emitted source, run the way the JavaScript hook gates run it.
const emitted = new Function(`${MCP_REGISTRY_JS_SOURCE}\nreturn evaluateMcpRegistry`)() as typeof evaluateMcpRegistry

describe('MCP registry vectors', () => {
  it('cover every refusal code and an allow', () => {
    expect(new Set(VECTORS.cases.map((c) => c.code))).toEqual(
      new Set([null, 'SERVER_BLOCKED', 'SERVER_HELD', 'SERVER_NOT_APPROVED', 'TOOL_DISABLED']),
    )
  })

  for (const c of VECTORS.cases) {
    it(c.name, () => {
      const [server, tool] = split(c.toolName)
      for (const evaluate of [evaluateMcpRegistry, emitted]) {
        const d = evaluate(VECTORS.registries[c.registry]!, server, tool)
        expect(d?.code ?? null).toBe(c.code)
        expect(d?.ruleId ?? null).toBe(c.ruleId)
        expect(d?.reason ?? null).toBe(c.reason)
      }
    })
  }
})

describe('the @mcp_registry record', () => {
  const registry = VECTORS.registries['deny']!

  it('round-trips as one two-column line', () => {
    const line = encodeMcpRegistryRecord(registry)
    expect(line.split('\t')).toHaveLength(2)
    expect(line.startsWith(`${MCP_REGISTRY_RECORD_TAG}\t`)).toBe(true)
    expect(decodeMcpRegistryRecord(line)).toEqual(registry)
  })

  it('reads another line or a damaged record as none', () => {
    expect(decodeMcpRegistryRecord('@sso_groups\te30=')).toBeNull()
    expect(decodeMcpRegistryRecord(`${MCP_REGISTRY_RECORD_TAG}\tnot-base64!`)).toBeNull()
    expect(decodeMcpRegistryRecord(`${encodeMcpRegistryRecord(registry)}\textra`)).toBeNull()
  })

  it('parses what the control plane sends, reading anything but deny as allow', () => {
    expect(parseMcpRegistryRecord(null)).toBeNull()
    expect(parseMcpRegistryRecord({ defaultPolicy: 'DENY', blockedServers: ['a', 7], disabledTools: { s: [], t: ['x'] } })).toEqual({
      defaultPolicy: 'allow',
      approvedServers: [],
      blockedServers: ['a'],
      heldServers: [],
      disabledTools: { t: ['x'] },
    })
  })

  it('names a registry that refuses nothing', () => {
    expect(isUnrestrictedMcpRegistry(VECTORS.registries['unrestricted']!)).toBe(true)
    expect(isUnrestrictedMcpRegistry({ ...VECTORS.registries['unrestricted']!, approvedServers: ['a'] })).toBe(true)
    expect(isUnrestrictedMcpRegistry(VECTORS.registries['denyNothingApproved']!)).toBe(false)
    expect(isUnrestrictedMcpRegistry({ ...VECTORS.registries['unrestricted']!, disabledTools: { a: ['b'] } })).toBe(false)
  })
})
