/**
 * approvalHold.test.ts — `require_approval` as a real hold, end to end against
 * a stand-in control plane that implements the two decisions endpoints the
 * hook gates use: `POST /api/v1/decisions` records a hold, and
 * `GET /api/v1/decisions/approved-bypasses` lists the approvals that let an
 * identical retry through.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as node_fs from 'node:fs'
import * as node_os from 'node:os'
import * as node_path from 'node:path'
import { ApprovalHolds, canonicalJson, holdKey } from '../approvalHold.js'
import { ToolCallInterceptor } from '../interceptor.js'
import { PolicyClient, UNRESTRICTED_REGISTRY, type McpRegistryPolicy, type SopRule } from '../policy.js'
import { GovernanceEmitter } from '../emitter.js'
import { handleHarnessLine, type PendingRequest } from '../proxy.js'
import { holdApprovalHint } from '@intutic/shared-types'

const RULE: SopRule = { id: 'sop_deploy', toolPattern: '^deploy$', action: 'require_approval', reason: 'Deploys need a second pair of eyes' }

class Policy extends PolicyClient {
  constructor() {
    super('http://localhost:0', '', 'ws_hold', 60_000)
  }
  override getRules(): readonly SopRule[] { return [RULE] }
  override matchRule(toolName: string): SopRule | null { return /^deploy$/.test(toolName) ? RULE : null }
  override getRegistry(): McpRegistryPolicy { return UNRESTRICTED_REGISTRY }
  override async ready(): Promise<void> {}
  override start(): void {}
  override async refresh(): Promise<void> {}
}

class Emitter extends GovernanceEmitter {
  readonly emitted: Array<{ kind: string; reason?: string }> = []
  constructor() {
    super('http://localhost:0', '', node_path.join(node_os.tmpdir(), 'intutic-hold-test.jsonl'), 'ws_hold')
  }
  override emit(kind: Parameters<GovernanceEmitter['emit']>[0], _t: string, _i: unknown, reason?: string): void {
    this.emitted.push({ kind, reason })
  }
}

describe('approval holds', () => {
  let server: http.Server
  let baseUrl: string
  let holds: Array<Record<string, unknown>> = []
  let bypasses: Array<Record<string, unknown>> = []
  let decisionsStatus = 200

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json')
        if (req.method === 'GET' && req.url === '/api/v1/decisions/approved-bypasses') {
          res.end(JSON.stringify({ ok: true, bypasses }))
          return
        }
        if (req.method === 'POST' && req.url === '/api/v1/decisions') {
          res.statusCode = decisionsStatus
          if (decisionsStatus < 400) {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { holds: Array<Record<string, unknown>> }
            holds.push(...body.holds)
          }
          res.end(JSON.stringify({ accepted: 1, dropped: 0, entryIds: ['dm_1'] }))
          return
        }
        res.statusCode = 404
        res.end('{}')
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()))
  })

  beforeEach(() => {
    holds = []
    bypasses = []
    decisionsStatus = 200
  })

  function interceptorWith(emitter: Emitter, url = baseUrl): ToolCallInterceptor {
    return new ToolCallInterceptor(
      new Policy(), emitter, true, 'deployer', 'warn', undefined, 'off', {}, undefined, 'ws_hold',
      new ApprovalHolds(url, 'vk_test', 'ws_hold', 'deployer'),
    )
  }

  /** What the control plane writes when an approver approves a hold, given workspace bypasses are on. */
  function approve(hold: Record<string, unknown>, expiresInMs = 10 * 60_000): void {
    bypasses.push({
      workspaceId: 'ws_hold',
      sopRuleId: hold['reason'],
      toolNameNormalized: hold['toolNameNormalized'],
      targetHash: hold['targetHash'],
      holdId: hold['holdId'],
      decidedBy: 'mem_approver',
      decidedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    })
  }

  it('holds the call, records it through the decisions API, and tells the agent the hold id', async () => {
    const emitter = new Emitter()
    const decision = await interceptorWith(emitter).decide('deploy', { env: 'prod', ref: 'v1.2.3' })

    expect(decision.action).toBe('hold')
    const { holdId, reason } = decision as { holdId: string; reason: string }
    expect(holdId).toMatch(/^hold_[0-9a-z]+_[0-9a-f]{8}$/)
    expect(reason).toContain(`Hold id: ${holdId}`)
    expect(reason).toContain(`intutic decision approve ${holdId}`)
    // Who can approve, and that the retry passes only under the bypass, which
    // is off by default: a Developer cannot approve their own hold, and a
    // promise that the retry passes would be false on a default workspace.
    expect(reason).toContain('An Owner, Admin or EM can approve it')
    expect(reason).toContain('only if the workspace has turned on the review-hold bypass')
    expect(reason).toBe(`HELD for approval: Deploys need a second pair of eyes [sop_deploy]. Hold id: ${holdId}. ${holdApprovalHint(holdId)}`)

    expect(holds).toHaveLength(1)
    expect(holds[0]).toMatchObject({
      v: 1,
      holdId,
      reason: 'sop_deploy',
      tool: 'mcp__deployer__deploy',
      toolNameNormalized: 'mcp__deployer__deploy',
      targetHash: holdKey('deployer', 'deploy', { env: 'prod', ref: 'v1.2.3' }).targetHash,
      context: { source: 'mcp_proxy', server: 'deployer', tool: 'deploy' },
    })
    expect(emitter.emitted.map((e) => e.kind)).toEqual(['tool_held'])
    expect(emitter.emitted[0]!.reason).toBe('Deploys need a second pair of eyes [sop_deploy]')
  })

  it('lets the identical retry through once approved, and says so', async () => {
    const emitter = new Emitter()
    const interceptor = interceptorWith(emitter)
    await interceptor.decide('deploy', { env: 'prod', ref: 'v1.2.3' })
    approve(holds[0]!)

    // Same arguments, different key order: still the same call.
    const retry = await interceptor.decide('deploy', { ref: 'v1.2.3', env: 'prod' })
    expect(retry.action).toBe('allow')
    expect(holds).toHaveLength(1) // no second hold
    const used = emitter.emitted.find((e) => e.kind === 'hold_approved_bypass_used')
    expect(used?.reason).toContain('approved by mem_approver')
    expect(used?.reason).toContain(String(holds[0]!['holdId']))
  })

  it('an approval covers only that call: different arguments are held again', async () => {
    const interceptor = interceptorWith(new Emitter())
    await interceptor.decide('deploy', { env: 'prod', ref: 'v1.2.3' })
    approve(holds[0]!)
    const other = await interceptor.decide('deploy', { env: 'prod', ref: 'v9.9.9' })
    expect(other.action).toBe('hold')
    expect(holds).toHaveLength(2)
  })

  it('an expired approval does not let the retry through', async () => {
    const interceptor = interceptorWith(new Emitter())
    await interceptor.decide('deploy', { env: 'prod' })
    approve(holds[0]!, -1000)
    expect((await interceptor.decide('deploy', { env: 'prod' })).action).toBe('hold')
  })

  it('an approval for another server with the same tool name does not match', async () => {
    const interceptor = interceptorWith(new Emitter())
    await interceptor.decide('deploy', { env: 'prod' })
    approve({ ...holds[0]!, toolNameNormalized: 'mcp__other__deploy' })
    expect((await interceptor.decide('deploy', { env: 'prod' })).action).toBe('hold')
  })

  it('stays held, and says nothing was recorded, when the control plane is unreachable', async () => {
    const decision = await interceptorWith(new Emitter(), 'http://127.0.0.1:1').decide('deploy', { env: 'prod' })
    expect(decision.action).toBe('hold')
    expect((decision as { reason: string }).reason).toContain('could not be recorded')
  })

  it('stays held when the control plane refuses the hold record', async () => {
    decisionsStatus = 500
    const decision = await interceptorWith(new Emitter()).decide('deploy', { env: 'prod' })
    expect(decision.action).toBe('hold')
    expect((decision as { reason: string }).reason).toContain('could not be recorded')
  })

  it('canonicalJson sorts keys at every level and ignores undefined members', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[2,{"y":2,"z":1}]},"b":1}')
  })

  // The SDK gates (`@intutic/gate`, `intutic_clawde.gate`) key their bypasses
  // the same way and run the same vectors; this side is the reference.
  it('hashes every shared hold-key vector to its expected target hash', () => {
    const { vectors } = JSON.parse(
      node_fs.readFileSync(node_path.join(__dirname, '../../../shared-types/fixtures/hold-key-vectors.json'), 'utf-8'),
    ) as { vectors: Array<{ toolInput: unknown; canonical: string; targetHash: string }> }
    expect(vectors.length).toBeGreaterThan(5)
    for (const v of vectors) {
      expect(canonicalJson(v.toolInput)).toBe(v.canonical)
      expect(holdKey('deployer', 'deploy', v.toolInput).targetHash).toBe(v.targetHash)
    }
  })

  it('the proxy answers a held call with a held error frame carrying the hold id', async () => {
    const writes: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk))
      return true
    })
    const forwarded: string[] = []
    try {
      handleHarnessLine(
        JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'deploy', arguments: { env: 'prod' } } }),
        new Map<string | number, PendingRequest>(),
        interceptorWith(new Emitter()),
        (l) => forwarded.push(l),
      )
      for (let i = 0; i < 100 && writes.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
    } finally {
      spy.mockRestore()
    }
    expect(forwarded).toEqual([])
    const frame = JSON.parse(writes[0]!) as { id: number; error: { message: string; data: { status: string; holdId: string } } }
    expect(frame.id).toBe(7)
    expect(frame.error.message).toMatch(/^\[Intutic Governance\] Tool call HELD for approval/)
    expect(frame.error.data).toEqual({ code: 'HELD', ruleId: 'sop_deploy', status: 'pending_approval', holdId: holds[0]!['holdId'] })
  })
})
