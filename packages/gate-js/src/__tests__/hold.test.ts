import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { GateClient } from '../client.js'
import { GATE_REFUSAL_CODES, IntuticGateHold, IntuticGateRefusal } from '../errors.js'
import { Gate } from '../gate.js'
import { canonicalJson, holdKey } from '../hold.js'
import * as snapshotMod from '../snapshot.js'
import type { SopRule } from '../soprules.js'

// Holds in the SDK gate: a hold rule records a hold through the decisions API
// and refuses with IntuticGateHold, unless an approved bypass covers this
// exact call. Port of packages/intutic-clawde/tests/test_gate_hold.py.

const FIXTURES = join(__dirname, '../../../shared-types/fixtures')
const VECTORS = JSON.parse(readFileSync(join(FIXTURES, 'hold-key-vectors.json'), 'utf-8')).vectors as Array<{
  name: string
  toolInput: unknown
  canonical: string
  targetHash: string
}>
const CODES = JSON.parse(readFileSync(join(FIXTURES, 'refusal-codes.json'), 'utf-8')).gate.refusals as Array<{
  code: string
}>

describe('the hold key', () => {
  it.each(VECTORS.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    expect(canonicalJson(v.toolInput)).toBe(v.canonical)
    expect(holdKey(' Deploy ', v.toolInput)).toEqual({ toolNameNormalized: 'deploy', targetHash: v.targetHash })
  })
})

describe('gate refusal codes', () => {
  it('are the shared list', () => {
    expect([...GATE_REFUSAL_CODES]).toEqual(CODES.map((c) => c.code))
  })

  it('are each documented in the gate SDK reference', () => {
    const doc = readFileSync(join(__dirname, '../../../../apps/docs/reference/gate-sdk.md'), 'utf-8')
    const documented = [...doc.matchAll(/^\| `([A-Z_]+)` \|/gm)].map((m) => m[1])
    expect(documented).toEqual(CODES.map((c) => c.code))
  })
})

const RULE_ID = 'sop.local.review_before.deploy'
const DEPLOY = { target: 'prod', image: 'api@sha256:abc' }

interface Seen {
  method: string
  path: string
  body: any
}

describe('Gate.guard: hold rules', () => {
  let server: Server
  let baseUrl: string
  let seen: Seen[] = []
  let bypasses: unknown[] = []
  let decisionsStatus = 200

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = createServer((req, res) => {
        let raw = ''
        req.on('data', (c) => (raw += c))
        req.on('end', () => {
          const path = req.url ?? ''
          seen.push({ method: req.method ?? '', path, body: raw ? JSON.parse(raw) : undefined })
          let status = 200
          let body: unknown = {}
          if (path === '/api/v1/decisions/approved-bypasses') body = { ok: true, bypasses }
          else if (path === '/api/v1/decisions') {
            status = decisionsStatus
            body = { accepted: 1, dropped: 0, entryIds: ['dm_1'] }
          }
          res.writeHead(status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(body))
        })
      })
      server.listen(0, () => resolve())
    })
    const address = server.address()
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  })

  afterAll(() => {
    server.close()
  })

  beforeEach(() => {
    seen = []
    bypasses = []
    decisionsStatus = 200
  })

  const client = (url = baseUrl) =>
    new GateClient({ baseUrl: url, apiKey: 'k', workspaceId: 'ws_1', sessionId: 's_1', timeoutMs: 500 })

  /** A gate whose snapshot holds `deploy`, with the given SOP-register rules. */
  function holdingGate(c: GateClient | null, sopRules: SopRule[] = []): Gate {
    const g = new Gate({ workspaceId: 'ws_1', useHookGate: false }, c)
    const snap = new snapshotMod.Snapshot()
    snap.state = 'ok'
    snap.workspaceId = 'ws_1'
    snap.rules = [
      { id: RULE_ID, severity: 'hold', subject: 'tool', reason: 'Held for human review: deploy', pattern: / (deploy) /i },
    ]
    ;(g as unknown as { _snapshot: snapshotMod.Snapshot })._snapshot = snap
    ;(g as unknown as { _sopRules: SopRule[] })._sopRules = sopRules
    return g
  }

  const bypassFor = (input: unknown, extra: Record<string, unknown> = {}) => ({
    workspaceId: 'ws_1',
    sopRuleId: RULE_ID,
    ...holdKey('deploy', input),
    holdId: 'hold_prev',
    decidedBy: 'mem_admin',
    decidedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...extra,
  })

  const events = () => seen.filter((s) => s.path === '/api/v1/hook-events').map((s) => s.body.events[0].event)
  const holds = () => seen.filter((s) => s.method === 'POST' && s.path === '/api/v1/decisions').map((s) => s.body.holds[0])

  it('records a hold and refuses with its id and accurate approval instructions', async () => {
    const err = await holdingGate(client()).guard('deploy', DEPLOY).catch((e) => e)

    expect(err).toBeInstanceOf(IntuticGateHold)
    // Callers that stop on every refusal stop on a hold too.
    expect(err).toBeInstanceOf(IntuticGateRefusal)
    expect(err.code).toBe('HELD')
    expect(err.holdId).toMatch(/^hold_[0-9a-z]+_[0-9a-f]{8}$/)
    expect(err.message).toMatch(/^\[Intutic Governance\] HELD: HELD for approval: Held for human review: deploy \[sop\.local\.review_before\.deploy\]/)
    expect(err.message).toContain(`intutic decision approve ${err.holdId}`)
    expect(err.message).toContain('owner, admin or engineering manager')
    expect(err.message).toContain('reviewHoldBypassEnabled')

    expect(holds()).toEqual([
      {
        v: 1,
        holdId: err.holdId,
        reason: RULE_ID,
        tool: 'deploy',
        sessionId: 's_1',
        at: expect.any(String),
        ...holdKey('deploy', DEPLOY),
        context: { source: 'gate_sdk', harness: 'generic', tool: 'deploy', rule: 'Held for human review: deploy' },
      },
    ])
    expect(events()).toEqual(['tool_held'])
  })

  it('lets the identical call through on an approved bypass, loudly, and records no hold', async () => {
    // Same arguments, other key order: still the identical call.
    bypasses = [bypassFor({ image: 'api@sha256:abc', target: 'prod' })]

    await expect(holdingGate(client()).guard('deploy', DEPLOY)).resolves.toBeUndefined()

    expect(holds()).toEqual([])
    expect(events()).toEqual(['hold_approved_bypass_used', 'tool_allowed'])
  })

  it.each([
    ['other arguments', bypassFor({ target: 'staging', image: 'api@sha256:abc' })],
    ['another rule', bypassFor(DEPLOY, { sopRuleId: 'sop.other' })],
    ['another workspace', bypassFor(DEPLOY, { workspaceId: 'ws_2' })],
    ['an expired approval', bypassFor(DEPLOY, { expiresAt: new Date(Date.now() - 1000).toISOString() })],
  ])('holds again when the only approval is for %s', async (_what, bypass) => {
    bypasses = [bypass]
    await expect(holdingGate(client()).guard('deploy', DEPLOY)).rejects.toBeInstanceOf(IntuticGateHold)
    expect(holds()).toHaveLength(1)
  })

  it('stays held, with nothing to approve, when the control plane cannot record it', async () => {
    decisionsStatus = 503
    const err = await holdingGate(client()).guard('deploy', DEPLOY).catch((e) => e)
    expect(err).toBeInstanceOf(IntuticGateHold)
    expect(err.holdId).toBeUndefined()
    expect(err.message).toContain('could not be recorded')
    expect(err.message).not.toContain('intutic decision approve')
  })

  it('stays held whatever failClosed says when the control plane is unreachable', async () => {
    const unreachable = new GateClient({ baseUrl: 'http://127.0.0.1:1', workspaceId: 'ws_1', failClosed: false, timeoutMs: 200 })
    const err = await holdingGate(unreachable).guard('deploy', DEPLOY).catch((e) => e)
    expect(err).toBeInstanceOf(IntuticGateHold)
    expect(err.holdId).toBeUndefined()
  })

  it('stays held without a client', async () => {
    const err = await holdingGate(null).guard('deploy', DEPLOY).catch((e) => e)
    expect(err).toBeInstanceOf(IntuticGateHold)
    expect(err.holdId).toBeUndefined()
  })

  it('holds a REQUIRE_APPROVAL rule from the SOP register under its snapshot id', async () => {
    const g = holdingGate(client(), [
      { id: 'deploys', toolPattern: '^ship$', action: 'require_approval', reason: 'Ships need review', argPattern: null },
    ])
    const err = await g.guard('ship', DEPLOY).catch((e) => e)
    expect(err).toBeInstanceOf(IntuticGateHold)
    expect(holds().map((h) => h.reason)).toEqual(['sop.deploys'])
  })

  it('lets one approval cover a rule that is in both the snapshot and the register', async () => {
    const g = holdingGate(client(), [
      { id: 'local.review_before.deploy', toolPattern: '^deploy$', action: 'require_approval', reason: 'r', argPattern: null },
    ])
    bypasses = [bypassFor(DEPLOY)]
    await expect(g.guard('deploy', DEPLOY)).resolves.toBeUndefined()
    expect(holds()).toEqual([])
  })
})
