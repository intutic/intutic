/**
 * The guardrail layer vectors through the MCP proxy.
 *
 * Each vector is a set of hook-rule guardrails, the rules `GET /api/v1/sop/rules`
 * serves for them, one tool call and the decision every layer must reach. A
 * real `PolicyClient` loads the served envelope over HTTP, and the call goes
 * through `matchRule` and the interceptor's decision: `block` is refused with
 * `SOP_RULE` and the rule id, `warn` is allowed with a `tool_flagged` event
 * naming the rule, `allow` is allowed with neither. A refusal wins over a
 * shadow match wherever it sits in the list.
 */
import { readFileSync } from 'node:fs'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as node_os from 'node:os'
import * as node_path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GovernanceEmitter, type EventKind } from '../emitter.js'
import { ToolCallInterceptor } from '../interceptor.js'
import { PolicyClient } from '../policy.js'

interface LayerVector {
  name: string
  served: { hookRules: Array<{ id: string } & Record<string, unknown>> }
  toolCall: { tool: string; toolInput: Record<string, unknown> }
  expected: { decision: 'block' | 'warn' | 'allow'; ruleId: string | null }
}

const VECTORS_PATH = node_path.join(node_path.dirname(fileURLToPath(import.meta.url)), '../../../shared-types/fixtures/guardrail-layer-vectors.json')
// A missing or unreadable fixture throws here and fails the file: never a skip.
const vectors: LayerVector[] = (JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as { vectors: LayerVector[] }).vectors

class RecordingEmitter extends GovernanceEmitter {
  readonly emitted: Array<{ kind: string; reason?: string }> = []
  constructor() {
    super('http://localhost:0', '', node_path.join(node_os.homedir(), '.intutic-test', 'events.jsonl'), 'ws_layer')
  }
  override emit(kind: EventKind, _toolName: string, _toolInput: unknown, reason?: string): void {
    this.emitted.push({ kind, reason })
  }
}

describe('guardrail layer vectors through the MCP proxy', () => {
  let server: http.Server
  let baseUrl: string
  let body: unknown = { rules: [] }
  const paths: string[] = []

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      paths.push(req.url ?? '')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()))
  })

  /** A real PolicyClient that has loaded `hookRules` from the served envelope. */
  async function loaded(v: LayerVector): Promise<PolicyClient> {
    body = { rules: v.served.hookRules }
    paths.length = 0
    const policy = new PolicyClient(baseUrl, 'vk_test', 'ws_layer')
    await policy.refresh()
    expect(paths.some((p) => p.startsWith('/api/v1/sop/rules')), 'the rules came from the register').toBe(true)
    expect(policy.getRules().map((r) => r.id)).toEqual(v.served.hookRules.map((r) => r.id))
    return policy
  }

  it('reads the vector file, with every decision represented', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(24)
    const decisions = new Set(vectors.map((v) => v.expected.decision))
    for (const d of ['block', 'warn', 'allow']) expect(decisions, d).toContain(d)
  })

  for (const v of vectors) {
    it(`matchRule: ${v.name}`, async () => {
      const policy = await loaded(v)
      const rule = policy.matchRule(v.toolCall.tool, JSON.stringify(v.toolCall.toolInput ?? {}))
      if (v.expected.decision === 'allow') {
        expect(rule).toBeNull()
      } else {
        expect(rule?.id).toBe(v.expected.ruleId)
        expect(rule?.action).toBe(v.expected.decision)
      }
    })

    it(`interceptor: ${v.name}`, async () => {
      const policy = await loaded(v)
      const emitter = new RecordingEmitter()
      const decision = await new ToolCallInterceptor(policy, emitter, true).decide(v.toolCall.tool, v.toolCall.toolInput)
      const flagged = emitter.emitted.filter((e) => e.kind === 'tool_flagged').map((e) => e.reason ?? '')
      const { decision: expected, ruleId } = v.expected
      if (expected === 'block') {
        expect(decision).toMatchObject({ action: 'block', code: 'SOP_RULE', ruleId })
        expect(flagged).toEqual([])
      } else {
        expect(decision.action, JSON.stringify(decision)).toBe('allow')
        if (expected === 'warn') {
          expect(flagged).toHaveLength(1)
          expect(flagged[0]).toContain(`[${ruleId}]`)
        } else {
          expect(flagged).toEqual([])
        }
      }
    })
  }
})
