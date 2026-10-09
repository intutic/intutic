import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  decodeMcpAllowlistRecord,
  decodeMcpRegistryRecord,
  encodeMcpAllowlistRecord,
  encodeMcpRegistryRecord,
  evaluateMcpAllowlist,
  evaluateMcpRegistry,
  isUnrestrictedMcpRegistry,
  MCP_ALLOWLIST_JS_SOURCE,
  MCP_ALLOWLIST_RECORD_TAG,
  MCP_REGISTRY_JS_SOURCE,
  MCP_REGISTRY_RECORD_TAG,
  parseMcpRegistryRecord,
  type McpAllowlistRecord,
  type McpRegistryRecord,
} from '../mcpRegistryRecord.js'

interface Vectors {
  registries: Record<string, McpRegistryRecord>
  cases: Array<{ name: string; registry: string; toolName: string; code: string | null; ruleId: string | null; reason: string | null }>
  allowlists: Record<string, McpAllowlistRecord>
  allowlistCases: Array<{ name: string; allowlist: string; toolName: string; code: string | null; ruleId: string | null; reason: string | null }>
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
const emittedAllowlist = new Function(`${MCP_ALLOWLIST_JS_SOURCE}\nreturn evaluateMcpAllowlist`)() as typeof evaluateMcpAllowlist

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

describe('MCP allowlist vectors', () => {
  it('cover a refusal and an allow', () => {
    expect(new Set(VECTORS.allowlistCases.map((c) => c.code))).toEqual(new Set([null, 'SERVER_NOT_ALLOWED']))
  })

  for (const c of VECTORS.allowlistCases) {
    it(c.name, () => {
      const [server] = split(c.toolName)
      for (const evaluate of [evaluateMcpAllowlist, emittedAllowlist]) {
        const d = evaluate(VECTORS.allowlists[c.allowlist]!, server)
        expect(d?.code ?? null).toBe(c.code)
        expect(d?.ruleId ?? null).toBe(c.ruleId)
        expect(d?.reason ?? null).toBe(c.reason)
      }
    })
  }
})

describe('the @mcp_allowlist record', () => {
  it('round-trips as one three-column line', () => {
    const allowlist: McpAllowlistRecord = { severity: 'shadow', servers: ['github', 'pg-prod'] }
    const line = encodeMcpAllowlistRecord(allowlist)
    expect(line).toBe(`${MCP_ALLOWLIST_RECORD_TAG}\tshadow\tgithub,pg-prod`)
    expect(decodeMcpAllowlistRecord(line)).toEqual(allowlist)
  })

  it('reads a severity it does not know as block, and another line as none', () => {
    expect(decodeMcpAllowlistRecord(`${MCP_ALLOWLIST_RECORD_TAG}\tSHADOW\tgithub`)).toEqual({ severity: 'block', servers: ['github'] })
    expect(decodeMcpAllowlistRecord(`${MCP_ALLOWLIST_RECORD_TAG}\tblock\t`)).toEqual({ severity: 'block', servers: [] })
    expect(decodeMcpAllowlistRecord(`${MCP_ALLOWLIST_RECORD_TAG}\tblock`)).toBeNull()
    expect(decodeMcpAllowlistRecord(`${MCP_ALLOWLIST_RECORD_TAG}\tblock\tgithub\textra`)).toBeNull()
    expect(decodeMcpAllowlistRecord(encodeMcpRegistryRecord(VECTORS.registries['deny']!))).toBeNull()
  })
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
