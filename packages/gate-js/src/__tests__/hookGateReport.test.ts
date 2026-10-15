/**
 * What `Gate.guard` reports after the hook gate answered.
 *
 * Every answer is reported — `tool_blocked` for a refusal, `tool_allowed` for
 * an allow — because that event drives the incident, rule evidence, the
 * shadow denominator, plan deviations and observed tools. It carries the
 * answer's `decisionId` as `gateDecisionId`: the hook gate exported the
 * decision to SIEM itself, and filed its DLP refusal's incident under a key
 * derived from that id, so the control plane neither exports nor files the
 * decision twice. The Python gate decides the same way
 * (tests/test_gate_hook_gate_report.py), and the last case here pins the two
 * sources to the same condition.
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

const HERE = dirname(fileURLToPath(import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'intutic-gate-hookgate-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const RULE = ['sop.s_write', 'block', '', 'tool', 'no writes to the ledger', ' (Write) '].join('\t')

function snapshotFile(): string {
  const digest = createHash('sha256').update(RULE).digest('hex').slice(0, 32)
  const path = join(dir, 'snap.rules')
  writeFileSync(path, `#digest ${digest}\n#workspace ws_test\n#generated ${new Date().toISOString()}\n${RULE}\n`)
  return path
}

interface Reported { event: string; toolName: string; reason: string; gateDecisionId?: string }

class RecordingClient extends GateClient {
  events: Reported[] = []
  constructor(private readonly verdict: GateResponse) {
    super({ baseUrl: 'http://127.0.0.1:9', workspaceId: 'ws_test', sessionId: 'sess_hookgate' })
  }
  override async emit(
    event: string, toolName: string, reason = '', _toolInput?: unknown, _incidentId?: string, _filePath?: string,
    gateDecisionId?: string,
  ): Promise<boolean> {
    this.events.push({ event, toolName, reason, ...(gateDecisionId ? { gateDecisionId } : {}) })
    return true
  }
  override async hookGate(): Promise<GateResponse> {
    return this.verdict
  }
}

async function refuse(verdict: GateResponse): Promise<{ client: RecordingClient; refusal: IntuticGateRefusal | null }> {
  const previous = process.env.INTUTIC_SNAPSHOT_RULES
  process.env.INTUTIC_SNAPSHOT_RULES = snapshotFile()
  const client = new RecordingClient(verdict)
  const gate = new Gate({ workspaceId: 'ws_test', useSopRules: false, useHookGate: true }, client)
  try {
    await gate.guard('Bash', { command: 'echo hi' })
    return { client, refusal: null }
  } catch (err) {
    if (err instanceof IntuticGateRefusal) return { client, refusal: err }
    throw err
  } finally {
    if (previous === undefined) delete process.env.INTUTIC_SNAPSHOT_RULES
    else process.env.INTUTIC_SNAPSHOT_RULES = previous
  }
}

const reports = (client: RecordingClient) => client.events.filter((e) => e.event === 'tool_blocked' || e.event === 'tool_allowed')

describe('a hook-gate answer', () => {
  it('a DLP refusal that names an incident is reported with its decision id: the control plane files it once', async () => {
    const { client, refusal } = await refuse({
      allowed: false, reason: 'DLP: AWS key detected', incidentId: 'gi_1', decisionId: 'hgd_1', reached: true,
    })
    expect(refusal?.code).toBe('HOOK_GATE')
    expect(refusal?.incidentId).toBe('gi_1')
    expect(reports(client)).toEqual([
      { event: 'tool_blocked', toolName: 'Bash', reason: 'DLP: AWS key detected', gateDecisionId: 'hgd_1' },
    ])
  })

  it('a rule refusal is reported with its decision id', async () => {
    const { client, refusal } = await refuse({ allowed: false, reason: 'no shell on prod [sop.r1]', decisionId: 'hgd_2', reached: true })
    expect(refusal?.code).toBe('HOOK_GATE')
    expect(reports(client)).toEqual([
      { event: 'tool_blocked', toolName: 'Bash', reason: 'no shell on prod [sop.r1]', gateDecisionId: 'hgd_2' },
    ])
  })

  it('a key without the hook gate\'s scope is refused as INSUFFICIENT_SCOPE, not HOOK_GATE', async () => {
    const reason = 'hook-gate refused the API key (INSUFFICIENT_SCOPE): it needs the gateway:use scope'
    const { client, refusal } = await refuse({ allowed: false, reason, code: 'INSUFFICIENT_SCOPE', reached: true })
    expect(refusal?.code).toBe('INSUFFICIENT_SCOPE')
    expect(refusal?.reason).toContain('gateway:use')
    expect(reports(client)).toEqual([{ event: 'tool_blocked', toolName: 'Bash', reason }])
  })

  it('an allow is reported with its decision id', async () => {
    const { client, refusal } = await refuse({ allowed: true, reason: '', decisionId: 'hgd_3', reached: true })
    expect(refusal).toBeNull()
    expect(reports(client)).toEqual([{ event: 'tool_allowed', toolName: 'Bash', reason: '', gateDecisionId: 'hgd_3' }])
  })

  it('an answer without a decision id (an older control plane, no verdict) is reported without one', async () => {
    const { client } = await refuse({ allowed: false, reason: 'hook-gate unreachable — failing closed (failClosed=true)', reached: false })
    expect(reports(client)).toEqual([
      { event: 'tool_blocked', toolName: 'Bash', reason: 'hook-gate unreachable — failing closed (failClosed=true)' },
    ])
  })

  it('is decided the same way by the Python gate', () => {
    const ts = readFileSync(join(HERE, '../gate.ts'), 'utf-8')
    const py = readFileSync(join(HERE, '../../../intutic-clawde/intutic_clawde/gate/gate.py'), 'utf-8')
    expect(ts).toContain("await this.emit('tool_blocked', toolName, resp.reason, toolInput, undefined, undefined, resp.decisionId)")
    expect(py).toContain('self._emit("tool_blocked", tool_name, resp.reason, tool_input, gate_decision_id=resp.decision_id)')
    expect(ts).toContain("await this.emit('tool_allowed', toolName, '', toolInput, undefined, undefined, decisionId)")
    expect(py).toContain('self._emit("tool_allowed", tool_name, "", tool_input, gate_decision_id=decision_id)')
  })
})
