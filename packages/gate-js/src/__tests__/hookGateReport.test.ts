/**
 * What `Gate.guard` reports when the hook gate refuses a call.
 *
 * The hook gate files an incident itself only for its DLP check, and says so
 * by naming the incident in its refusal. Every other refusal it gives is
 * filed only through the `tool_blocked` event the gate sends, so that event
 * must still be sent; the DLP refusal's must not, or it is filed twice. The
 * Python gate decides the same way (tests/test_gate_hook_gate_report.py), and
 * the last case here pins the two sources to the same condition.
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

class RecordingClient extends GateClient {
  events: Array<{ event: string; toolName: string; reason: string }> = []
  constructor(private readonly verdict: GateResponse) {
    super({ baseUrl: 'http://127.0.0.1:9', workspaceId: 'ws_test', sessionId: 'sess_hookgate' })
  }
  override async emit(event: string, toolName: string, reason = ''): Promise<boolean> {
    this.events.push({ event, toolName, reason })
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

describe('a hook-gate refusal', () => {
  it('that names an incident is not reported again: the hook gate filed it', async () => {
    const { client, refusal } = await refuse({ allowed: false, reason: 'DLP: AWS key detected', incidentId: 'gi_1', reached: true })
    expect(refusal?.code).toBe('HOOK_GATE')
    expect(refusal?.incidentId).toBe('gi_1')
    expect(client.events.filter((e) => e.event === 'tool_blocked')).toEqual([])
  })

  it('that names none is reported as tool_blocked: only that event files it', async () => {
    const { client, refusal } = await refuse({ allowed: false, reason: 'no shell on prod [sop.r1]', reached: true })
    expect(refusal?.code).toBe('HOOK_GATE')
    expect(client.events.filter((e) => e.event === 'tool_blocked')).toEqual([
      { event: 'tool_blocked', toolName: 'Bash', reason: 'no shell on prod [sop.r1]' },
    ])
  })

  it('made because the hook gate gave no verdict is reported', async () => {
    const { client } = await refuse({ allowed: false, reason: 'hook-gate unreachable — failing closed (failClosed=true)', reached: false })
    expect(client.events.some((e) => e.event === 'tool_blocked')).toBe(true)
  })

  it('is decided the same way by the Python gate', () => {
    const ts = readFileSync(join(HERE, '../gate.ts'), 'utf-8')
    const py = readFileSync(join(HERE, '../../../intutic-clawde/intutic_clawde/gate/gate.py'), 'utf-8')
    expect(ts).toContain("if (!resp.incidentId) await this.emit('tool_blocked', toolName, resp.reason, toolInput)")
    expect(py).toMatch(/if not resp\.incident_id:\n\s+self\._emit\("tool_blocked", tool_name, resp\.reason, tool_input\)/)
  })
})
