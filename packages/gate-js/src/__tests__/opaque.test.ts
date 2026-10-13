/**
 * The OPAQUE intervention mode in `@intutic/gate`.
 *
 * A snapshot carrying the `@intervention_mode` record makes every refusal on
 * workspace policy tell the agent `OPAQUE_REFUSAL_MESSAGE`, with the same
 * code, while the emitted event keeps the rule. Without the record the
 * refusal names the rule, as it always has.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { GateClient, type GateResponse } from '../client.js'
import { IntuticGateHold, IntuticGateRefusal } from '../errors.js'
import { Gate } from '../gate.js'
import { sandboxGateScript } from './fixtures/sandboxGateScript.js'
import { encodeMcpRegistryRecord } from '../mcpRegistryRecord.js'
import { encodeInterventionModeRecord, OPAQUE_REFUSAL_MESSAGE } from '../opaqueRefusal.js'
import { parseRegister, type SopRule } from '../soprules.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'intutic-gate-opaque-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const WRITE_RULE = ['sop.s_write', 'block', '', 'tool', 'no writes to the ledger', ' (Write) '].join('\t')
const HOLD_RULE = ['sop.s_deploy', 'hold', '', 'tool', 'deploys need a reviewer', ' (Deploy) '].join('\t')
const REGISTRY = encodeMcpRegistryRecord({
  defaultPolicy: 'allow', approvedServers: [], blockedServers: ['pastebin'], heldServers: [], disabledTools: {},
})

let n = 0
function snapshotFile(body: string[], digestOf: string[] = body): string {
  const digest = createHash('sha256').update(digestOf.join('\n')).digest('hex').slice(0, 32)
  const path = join(dir, `snap-${n++}.rules`)
  writeFileSync(path, `#digest ${digest}\n#workspace ws_test\n#generated ${new Date().toISOString()}\n${body.join('\n')}\n`)
  return path
}
const opaque = (...lines: string[]) => snapshotFile([encodeInterventionModeRecord(), ...lines])
const transparent = (...lines: string[]) => snapshotFile(lines)

class RecordingClient extends GateClient {
  events: Array<{ event: string; toolName: string; reason: string }> = []
  constructor(private readonly verdict: GateResponse = { allowed: true, reason: '', reached: true }) {
    super({ baseUrl: 'http://127.0.0.1:9', apiKey: 'k', workspaceId: 'ws_test', sessionId: 'sess_opaque' })
  }
  override async emit(event: string, toolName: string, reason = ''): Promise<boolean> {
    this.events.push({ event, toolName, reason })
    return true
  }
  override async hookGate(): Promise<GateResponse> {
    return this.verdict
  }
}

async function guard(
  snapshot: string,
  tool: string,
  opts: { client?: GateClient | null; sopRules?: SopRule[] } = {},
): Promise<IntuticGateRefusal | null> {
  const previous = process.env.INTUTIC_SNAPSHOT_RULES
  process.env.INTUTIC_SNAPSHOT_RULES = snapshot
  const client = opts.client ?? null
  const gate = new Gate({ workspaceId: 'ws_test', useSopRules: !!opts.sopRules, useHookGate: client !== null }, client)
  if (opts.sopRules) gate.getSopRules = async () => opts.sopRules!
  try {
    await gate.guard(tool, {})
    return null
  } catch (err) {
    if (err instanceof IntuticGateRefusal) return err
    throw err
  } finally {
    if (previous === undefined) delete process.env.INTUTIC_SNAPSHOT_RULES
    else process.env.INTUTIC_SNAPSHOT_RULES = previous
  }
}

it('carries a byte-identical copy of the shared module', () => {
  const shared = readFileSync(join(HERE, '../../../shared-types/src/opaqueRefusal.ts'), 'utf-8')
  expect(readFileSync(join(HERE, '../opaqueRefusal.ts'), 'utf-8')).toBe(shared)
})

describe('Gate.guard in an OPAQUE workspace', () => {
  it('refuses a snapshot rule with the generic sentence and the same code; the event names the rule', async () => {
    const client = new RecordingClient()
    const r = await guard(opaque(WRITE_RULE), 'Write', { client })
    expect(r?.code).toBe('SNAPSHOT')
    expect(r?.reason).toBe(OPAQUE_REFUSAL_MESSAGE)
    expect(r?.message).toBe(`[Intutic Governance] BLOCKED: ${OPAQUE_REFUSAL_MESSAGE}`)
    expect(client.events).toContainEqual({ event: 'tool_blocked', toolName: 'Write', reason: 'no writes to the ledger [sop.s_write]' })
  })

  it('names the rule in a TRANSPARENT workspace', async () => {
    const r = await guard(transparent(WRITE_RULE), 'Write')
    expect(r?.code).toBe('SNAPSHOT')
    expect(r?.reason).toBe('no writes to the ledger [sop.s_write]')
  })

  it('hides the MCP registry rule, keeping its code', async () => {
    const client = new RecordingClient()
    const r = await guard(opaque(REGISTRY, WRITE_RULE), 'mcp__pastebin__paste', { client })
    expect(r?.code).toBe('SERVER_BLOCKED')
    expect(r?.reason).toBe(OPAQUE_REFUSAL_MESSAGE)
    expect(client.events.find((e) => e.event === 'tool_blocked')?.reason).toMatch(/\[mcp_registry\.pastebin\]$/)
    expect((await guard(transparent(REGISTRY, WRITE_RULE), 'mcp__pastebin__paste'))?.reason).toMatch(/\[mcp_registry\.pastebin\]$/)
  })

  it('hides an SOP register rule (Tier A3)', async () => {
    const rule: SopRule = { id: 'r1', toolPattern: '^Bash$', action: 'block', reason: 'no shell on prod', argPattern: null }
    const client = new RecordingClient()
    const r = await guard(opaque(WRITE_RULE), 'Bash', { client, sopRules: [rule] })
    expect(r?.code).toBe('SOP_RULE')
    expect(r?.reason).toBe(OPAQUE_REFUSAL_MESSAGE)
    expect(client.events.find((e) => e.event === 'tool_blocked')?.reason).toBe('[sop:r1] no shell on prod')
    expect((await guard(transparent(WRITE_RULE), 'Bash', { sopRules: [rule] }))?.reason).toBe('[sop:r1] no shell on prod')
  })

  it('hides the hook gate\'s reason too, keeping its code', async () => {
    const client = new RecordingClient({ allowed: false, reason: 'blocked [mcp_registry.pastebin]', code: 'SERVER_BLOCKED', reached: true })
    const r = await guard(opaque(WRITE_RULE), 'mcp__pastebin__paste', { client })
    expect(r?.code).toBe('SERVER_BLOCKED')
    expect(r?.reason).toBe(OPAQUE_REFUSAL_MESSAGE)
  })

  it('words a hold without the rule, keeping the hold', async () => {
    const r = await guard(opaque(HOLD_RULE), 'Deploy')
    expect(r).toBeInstanceOf(IntuticGateHold)
    expect(r?.code).toBe('HELD')
    expect(r?.message).toContain(OPAQUE_REFUSAL_MESSAGE)
    expect(r?.message).not.toContain('sop.s_deploy')
    expect(r?.message).not.toContain('deploys need a reviewer')
    expect((await guard(transparent(HOLD_RULE), 'Deploy'))?.message).toContain('deploys need a reviewer [sop.s_deploy]')
  })

  it('leaves a refusal that says nothing about the policy as it was', async () => {
    // A tampered snapshot: the digest covers other lines. The record still
    // reads, but this refusal names no rule of the workspace's.
    const snap = snapshotFile([encodeInterventionModeRecord(), REGISTRY], ['something else'])
    const r = await guard(snap, 'mcp__github__create_issue')
    expect(r?.code).toBe('POLICY_SNAPSHOT_UNVERIFIED')
    expect(r?.reason).not.toBe(OPAQUE_REFUSAL_MESSAGE)
  })
})

describe('the sandbox hook script in an OPAQUE workspace', () => {
  const script = join(dir, 'sandbox-check.js')
  const rules = join(dir, 'policy-snapshot.rules')
  beforeAll(async () => writeFileSync(script, await sandboxGateScript('ws_test')))

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

  it('refuses with the generic sentence and the code, and names the rule otherwise', async () => {
    const o = await run(opaque(REGISTRY, WRITE_RULE), 'mcp__pastebin__paste')
    expect(o.status).toBe(2)
    expect(o.stderr).toContain(`BLOCKED: SERVER_BLOCKED: ${OPAQUE_REFUSAL_MESSAGE}`)
    expect(o.stderr).not.toContain('mcp_registry.pastebin')
    const w = await run(opaque(WRITE_RULE), 'Write')
    expect(w.status).toBe(2)
    expect(w.stderr).toContain(OPAQUE_REFUSAL_MESSAGE)
    expect(w.stderr).not.toContain('sop.s_write')
    const t = await run(transparent(WRITE_RULE), 'Write')
    expect(t.stderr).toContain('no writes to the ledger [sop.s_write]')
  }, 30_000)
})

describe('Gate.guard with no policy snapshot', () => {
  afterEach(() => vi.unstubAllGlobals())

  /** A gate whose SOP register answers `body` over HTTP, as `/api/v1/sop/rules` does. */
  async function guardRegister(body: unknown, tool: string): Promise<{ refusal: IntuticGateRefusal | null; events: RecordingClient['events'] }> {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(body), { status: 200 }))
    const previous = process.env.INTUTIC_SNAPSHOT_RULES
    process.env.INTUTIC_SNAPSHOT_RULES = join(dir, 'no-such-snapshot.rules')
    const client = new RecordingClient()
    try {
      await new Gate({ workspaceId: 'ws_test', useHookGate: false }, client).guard(tool, {})
      return { refusal: null, events: client.events }
    } catch (err) {
      if (err instanceof IntuticGateRefusal) return { refusal: err, events: client.events }
      throw err
    } finally {
      if (previous === undefined) delete process.env.INTUTIC_SNAPSHOT_RULES
      else process.env.INTUTIC_SNAPSHOT_RULES = previous
    }
  }

  const RULES = [{ id: 'r1', toolPattern: '^Bash$', action: 'block', reason: 'no shell on prod' }]

  it('reads the mode from the SOP register: an OPAQUE register rule is refused without naming it', async () => {
    const { refusal, events } = await guardRegister({ rules: RULES, interventionMode: 'OPAQUE' }, 'Bash')
    expect(refusal?.code).toBe('SOP_RULE')
    expect(refusal?.reason).toBe(OPAQUE_REFUSAL_MESSAGE)
    expect(events.find((e) => e.event === 'tool_blocked')?.reason).toBe('[sop:r1] no shell on prod')
  })

  it('names the rule when the register is TRANSPARENT, or predates the field', async () => {
    for (const body of [{ rules: RULES, interventionMode: 'TRANSPARENT' }, { rules: RULES }]) {
      expect((await guardRegister(body, 'Bash')).refusal?.reason).toBe('[sop:r1] no shell on prod')
    }
  })

  it('parses the mode beside the rules', () => {
    expect(parseRegister({ rules: RULES, interventionMode: 'opaque' }).opaque).toBe(true)
    expect(parseRegister({ rules: RULES, interventionMode: 'SILENT_LOG' }).opaque).toBe(false)
    expect(parseRegister(RULES).opaque).toBe(false)
    expect(parseRegister({ rules: RULES }).rules).toHaveLength(1)
  })
})
