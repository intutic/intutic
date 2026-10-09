/**
 * The gate-js half of the MCP registry conformance suite.
 *
 * `packages/shared-types/fixtures/mcp-registry-vectors.json` is run by
 * `evaluateMcpRegistry`, the MCP proxy, the control plane's hook gate, the
 * emitted hook gates and intutic-clawde. This runs it through `Gate.guard`
 * reading a real policy snapshot file, which is how the registry reaches this
 * package in production, and checks the tamper rule the hook gates apply: a
 * snapshot that fails its digest keeps the registry's and the allowlist's
 * refusals and drops what they admit.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { GateClient, type GateResponse } from '../client.js'
import { IntuticGateRefusal } from '../errors.js'
import { Gate } from '../gate.js'
import {
  encodeMcpAllowlistRecord,
  encodeMcpRegistryRecord,
  type McpAllowlistRecord,
  type McpRegistryRecord,
} from '../mcpRegistryRecord.js'

interface Case { name: string; toolName: string; code: string | null; ruleId: string | null; reason: string | null }
interface Vectors {
  registries: Record<string, McpRegistryRecord>
  cases: Array<Case & { registry: string }>
  allowlists: Record<string, McpAllowlistRecord>
  allowlistCases: Array<Case & { allowlist: string }>
}

const HERE = dirname(fileURLToPath(import.meta.url))
const VECTORS: Vectors = JSON.parse(readFileSync(join(HERE, '../../../shared-types/fixtures/mcp-registry-vectors.json'), 'utf8'))

const dir = mkdtempSync(join(tmpdir(), 'intutic-gate-mcp-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** A block SOP rule on `Write`, so a test can see whether the snapshot was read as valid. */
const WRITE_RULE = ['sop.s_write', 'block', '', 'tool', 'no writes', ' (Write) '].join('\t')

let n = 0
/** A snapshot file whose digest covers `body`, unless `digestOf` says otherwise. */
function snapshotFile(body: string[], digestOf: string[] = body): string {
  const digest = createHash('sha256').update(digestOf.join('\n')).digest('hex').slice(0, 32)
  const path = join(dir, `snap-${n++}.rules`)
  writeFileSync(path, `#digest ${digest}\n#workspace ws_test\n#generated ${new Date().toISOString()}\n${body.join('\n')}\n`)
  return path
}

class RecordingClient extends GateClient {
  events: Array<{ event: string; toolName: string; reason: string }> = []
  constructor(private readonly verdict: GateResponse = { allowed: true, reason: '', reached: true }) {
    super({ baseUrl: 'http://127.0.0.1:9', workspaceId: 'ws_test', sessionId: 'sess_mcp' })
  }
  override async emit(event: string, toolName: string, reason = ''): Promise<boolean> {
    this.events.push({ event, toolName, reason })
    return true
  }
  override async hookGate(): Promise<GateResponse> {
    return this.verdict
  }
}

async function guard(snapshot: string, tool: string, client: GateClient | null = null): Promise<IntuticGateRefusal | null> {
  const previous = process.env.INTUTIC_SNAPSHOT_RULES
  process.env.INTUTIC_SNAPSHOT_RULES = snapshot
  try {
    await new Gate({ workspaceId: 'ws_test', useSopRules: false, useHookGate: client !== null }, client).guard(tool, {})
    return null
  } catch (err) {
    if (err instanceof IntuticGateRefusal) return err
    throw err
  } finally {
    if (previous === undefined) delete process.env.INTUTIC_SNAPSHOT_RULES
    else process.env.INTUTIC_SNAPSHOT_RULES = previous
  }
}

function expectCase(refusal: IntuticGateRefusal | null, c: Case): void {
  if (c.code === null) {
    expect(refusal, `${c.name}: expected an allow, got ${refusal?.message}`).toBeNull()
  } else {
    expect(refusal?.code).toBe(c.code)
    expect(refusal?.reason).toBe(`${c.reason} [${c.ruleId}]`)
  }
}

it('carries a byte-identical copy of the shared registry module', () => {
  const shared = readFileSync(join(HERE, '../../../shared-types/src/mcpRegistryRecord.ts'), 'utf-8')
  expect(readFileSync(join(HERE, '../mcpRegistryRecord.ts'), 'utf-8')).toBe(shared)
})

describe('the shared registry vectors through Gate.guard', () => {
  for (const c of VECTORS.cases) {
    it(c.name, async () => {
      const snap = snapshotFile([encodeMcpRegistryRecord(VECTORS.registries[c.registry]!), WRITE_RULE])
      expectCase(await guard(snap, c.toolName), c)
    })
  }

  it('leaves a tool that is not an MCP tool alone under deny', async () => {
    const snap = snapshotFile([encodeMcpRegistryRecord(VECTORS.registries['denyNothingApproved']!), WRITE_RULE])
    expect(await guard(snap, 'Read')).toBeNull()
  })
})

describe('the shared allowlist vectors through Gate.guard', () => {
  for (const c of VECTORS.allowlistCases) {
    it(c.name, async () => {
      const snap = snapshotFile([encodeMcpAllowlistRecord(VECTORS.allowlists[c.allowlist]!), WRITE_RULE])
      expectCase(await guard(snap, c.toolName), c)
    })
  }

  it('records a shadow refusal and lets the call through', async () => {
    const client = new RecordingClient()
    const snap = snapshotFile([encodeMcpAllowlistRecord({ severity: 'shadow', servers: ['github'] }), WRITE_RULE])
    expect(await guard(snap, 'mcp__pastebin__paste', client)).toBeNull()
    expect(client.events).toContainEqual({
      event: 'tool_would_block',
      toolName: 'mcp__pastebin__paste',
      reason: 'MCP server "pastebin" is not on the MCP server allowlist for this workspace [mcp_allowlist]',
    })
  })

  it('applies the registry ahead of the allowlist', async () => {
    const snap = snapshotFile([
      encodeMcpRegistryRecord(VECTORS.registries['allowWithDecisions']!),
      encodeMcpAllowlistRecord({ severity: 'block', servers: ['github'] }),
      WRITE_RULE,
    ])
    expect((await guard(snap, 'mcp__pastebin__paste'))?.code).toBe('SERVER_BLOCKED')
    expect((await guard(snap, 'mcp__newcomer__query'))?.code).toBe('SERVER_NOT_ALLOWED')
  })
})

describe('a snapshot edited by hand', () => {
  const deny = VECTORS.registries['deny']!

  it('keeps the registry\'s refusals and ignores an approval added to it', async () => {
    const original = [encodeMcpRegistryRecord(deny), WRITE_RULE]
    const snap = snapshotFile(
      [encodeMcpRegistryRecord({ ...deny, approvedServers: [...deny.approvedServers, 'newcomer'] }), WRITE_RULE],
      original,
    )
    expect((await guard(snap, 'mcp__newcomer__query'))?.code).toBe('SERVER_NOT_APPROVED')
    // An approval the control plane made does not survive either.
    expect((await guard(snap, 'mcp__github__create_issue'))?.code).toBe('SERVER_NOT_APPROVED')
    expect((await guard(snap, 'mcp__pastebin__paste'))?.code).toBe('SERVER_BLOCKED')
    // The SOP rule beside it is gone: the gate read the snapshot as invalid.
    expect(await guard(snap, 'Write')).toBeNull()
  })

  it('keeps the allowlist and admits no server when one is added to it', async () => {
    const original = [encodeMcpAllowlistRecord({ severity: 'block', servers: ['github'] }), WRITE_RULE]
    const snap = snapshotFile([encodeMcpAllowlistRecord({ severity: 'block', servers: ['github', 'newcomer'] }), WRITE_RULE], original)
    expect((await guard(snap, 'mcp__newcomer__query'))?.code).toBe('SERVER_NOT_ALLOWED')
    expect((await guard(snap, 'mcp__github__create_issue'))?.code).toBe('SERVER_NOT_ALLOWED')
    expect(await guard(snap, 'Write')).toBeNull()
  })

  it('refuses when block is edited to shadow', async () => {
    const original = [encodeMcpAllowlistRecord({ severity: 'block', servers: ['github'] }), WRITE_RULE]
    const snap = snapshotFile([encodeMcpAllowlistRecord({ severity: 'shadow', servers: ['github'] }), WRITE_RULE], original)
    expect((await guard(snap, 'mcp__pastebin__paste'))?.code).toBe('SERVER_NOT_ALLOWED')
  })
})

describe('reporting', () => {
  it('reports an unapproved server as a tool_blocked event the control plane queues for approval', async () => {
    const client = new RecordingClient()
    const snap = snapshotFile([encodeMcpRegistryRecord(VECTORS.registries['denyNothingApproved']!), WRITE_RULE])
    expect((await guard(snap, 'mcp__ide__getDiagnostics', client))?.code).toBe('SERVER_NOT_APPROVED')
    const blocked = client.events.find((e) => e.event === 'tool_blocked')
    expect(blocked?.toolName).toBe('mcp__ide__getDiagnostics')
    // hookEvents.ts queues the server from the bracketed rule id.
    expect(blocked?.reason).toMatch(/\[mcpDefaultPolicy\]$/)
  })

  it('takes the registry code the hook gate names, and HOOK_GATE otherwise', async () => {
    const snap = snapshotFile([WRITE_RULE])
    const named = new RecordingClient({ allowed: false, reason: 'blocked [mcp_registry.pastebin]', code: 'SERVER_BLOCKED', reached: true })
    expect((await guard(snap, 'mcp__pastebin__paste', named))?.code).toBe('SERVER_BLOCKED')
    const unnamed = new RecordingClient({ allowed: false, reason: 'DLP: AWS key', reached: true })
    expect((await guard(snap, 'Bash', unnamed))?.code).toBe('HOOK_GATE')
    const other = new RecordingClient({ allowed: false, reason: 'x', code: 'SOMETHING_ELSE', reached: true })
    expect((await guard(snap, 'Bash', other))?.code).toBe('HOOK_GATE')
  })
})
