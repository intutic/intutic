/**
 * The gate-js half of the MCP registry conformance suite.
 *
 * `packages/shared-types/fixtures/mcp-registry-vectors.json` is run by
 * `evaluateMcpRegistry`, the MCP proxy, the control plane's hook gate, the
 * emitted hook gates and intutic-clawde. This runs it through `Gate.guard`
 * reading a real policy snapshot file, which is how the registry reaches this
 * package in production, and through the hook script `intuticSandboxBootstrap`
 * writes into a sandbox. Both also run the vectors' unverified cases: a
 * snapshot tampered with in any of the named ways admits no MCP server.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { GateClient, type GateResponse } from '../client.js'
import { IntuticGateRefusal } from '../errors.js'
import { Gate } from '../gate.js'
import { _internal } from '../harness.js'
import {
  decodeMcpRegistryRecord,
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
  unverifiedSnapshots: Record<string, { registry: string; allowlist: string; interventionMode: string }>
  unverifiedCases: Array<Case & { snapshot: string; tamper: string }>
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

/**
 * The vectors' snapshot for an unverified case, written with its digest and
 * then tampered with as the case names (the digest left as written, except
 * where the tamper removes it).
 */
function unverifiedSnapshot(c: Vectors['unverifiedCases'][number]): string {
  const base = VECTORS.unverifiedSnapshots[c.snapshot]!
  const severity = base.interventionMode === 'SILENT_LOG' ? 'shadow' : 'block'
  const lines = [
    encodeMcpRegistryRecord(VECTORS.registries[base.registry]!),
    encodeMcpAllowlistRecord({ severity, servers: VECTORS.allowlists[base.allowlist]!.servers }),
    WRITE_RULE,
  ]
  const text = readFileSync(snapshotFile(lines), 'utf8').split('\n')
  const at = (prefix: string) => text.findIndex((l) => l.startsWith(prefix))
  const reg = at('@mcp_registry\t')
  const allow = at('@mcp_allowlist\t')
  switch (c.tamper) {
    case 'registryDenyToAllow': text[reg] = encodeMcpRegistryRecord({ ...decodeMcpRegistryRecord(text[reg]!)!, defaultPolicy: 'allow' }); break
    case 'registryUnblock': text[reg] = encodeMcpRegistryRecord({ ...decodeMcpRegistryRecord(text[reg]!)!, blockedServers: [] }); break
    case 'registryLineDeleted': text.splice(reg, 1); break
    case 'allowlistLineDeleted': text.splice(allow, 1); break
    case 'allowlistWidened': text[allow] += ',newcomer'; break
    case 'allowlistShadowed': text[allow] = text[allow]!.replace('\tblock\t', '\tshadow\t'); break
    case 'digestLineDeleted':
      text[allow] += ',newcomer'
      text.splice(at('#digest '), 1)
      break
    default: throw new Error(`unknown tamper ${c.tamper}`)
  }
  const path = join(dir, `snap-${n++}.rules`)
  writeFileSync(path, text.join('\n'))
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

describe('the shared unverified-snapshot vectors through Gate.guard', () => {
  for (const c of VECTORS.unverifiedCases) {
    it(c.name, async () => {
      const snap = unverifiedSnapshot(c)
      expectCase(await guard(snap, c.toolName), c)
      // The SOP rule beside the records is gone: the gate read the snapshot as unverified.
      expect(await guard(snap, 'Write')).toBeNull()
    })
  }

  it('reports the refusal as tool_blocked with its rule id', async () => {
    const client = new RecordingClient()
    const snap = unverifiedSnapshot(VECTORS.unverifiedCases.find((c) => c.tamper === 'allowlistWidened')!)
    expect((await guard(snap, 'mcp__github__create_issue', client))?.code).toBe('POLICY_SNAPSHOT_UNVERIFIED')
    expect(client.events.find((e) => e.event === 'tool_blocked')?.reason).toMatch(/\[policy_snapshot\]$/)
  })
})

describe('the sandbox hook script intuticSandboxBootstrap writes', () => {
  const script = join(dir, 'sandbox-check.js')
  const rules = join(dir, 'policy-snapshot.rules')
  writeFileSync(script, _internal.renderSandboxGateScript('policy-snapshot.rules', 'ws_test'))

  /** Runs the script on one call against `snapshot`, copied to where it reads its rules. */
  function run(snapshot: string, tool: string): Promise<{ status: number | null; stderr: string }> {
    writeFileSync(rules, readFileSync(snapshot))
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script], { stdio: ['pipe', 'ignore', 'pipe'] })
      let stderr = ''
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (d: string) => { stderr += d })
      child.on('error', reject)
      child.on('close', (status) => resolve({ status, stderr }))
      child.stdin.end(JSON.stringify({ tool_name: tool, tool_input: {} }))
    })
  }

  function expectScript(r: { status: number | null; stderr: string }, c: Case): void {
    if (c.code === null) {
      expect(r.status, `${c.name}: expected an allow.\nstderr: ${r.stderr}`).toBe(0)
    } else {
      expect(r.status, `${c.name}: expected a refusal.\nstderr: ${r.stderr}`).toBe(2)
      expect(r.stderr).toContain(`${c.code}: ${c.reason} [${c.ruleId}]`)
    }
  }

  it('reaches every registry vector\'s decision', async () => {
    for (const c of VECTORS.cases) {
      expectScript(await run(snapshotFile([encodeMcpRegistryRecord(VECTORS.registries[c.registry]!), WRITE_RULE]), c.toolName), c)
    }
  }, 60_000)

  it('reaches every allowlist vector\'s decision, and reports a shadow refusal without refusing', async () => {
    for (const c of VECTORS.allowlistCases) {
      expectScript(await run(snapshotFile([encodeMcpAllowlistRecord(VECTORS.allowlists[c.allowlist]!), WRITE_RULE]), c.toolName), c)
    }
    const shadow = await run(snapshotFile([encodeMcpAllowlistRecord({ severity: 'shadow', servers: ['github'] }), WRITE_RULE]), 'mcp__pastebin__paste')
    expect(shadow.status).toBe(0)
    expect(shadow.stderr).toContain('FLAGGED (shadow)')
  }, 60_000)

  it('refuses every MCP call on a tampered snapshot, observe-only too', async () => {
    for (const c of VECTORS.unverifiedCases) {
      const snap = unverifiedSnapshot(c)
      expectScript(await run(snap, c.toolName), c)
      expect((await run(snap, 'Write')).status, `${c.name}: the SOP rule survived`).toBe(0)
    }
  }, 60_000)

  it('applies the rules of a verified snapshot, and treats one issued to another workspace as unverified', async () => {
    const snap = snapshotFile([encodeMcpAllowlistRecord({ severity: 'block', servers: ['github'] }), WRITE_RULE])
    expect((await run(snap, 'Write')).status).toBe(2)
    const other = join(dir, `snap-${n++}.rules`)
    writeFileSync(other, readFileSync(snap, 'utf8').replace('#workspace ws_test', '#workspace ws_other'))
    expect((await run(other, 'Write')).status).toBe(0)
    expect((await run(other, 'mcp__github__create_issue')).stderr).toContain('POLICY_SNAPSHOT_UNVERIFIED')
  }, 60_000)

  it('treats an empty rules file as no snapshot', async () => {
    const empty = join(dir, `snap-${n++}.rules`)
    writeFileSync(empty, '')
    expect((await run(empty, 'mcp__anything__run')).status).toBe(0)
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
