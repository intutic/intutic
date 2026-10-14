/**
 * The guardrail layer vectors through the gate-js decision path.
 *
 * Each vector is a set of hook-rule guardrails, the rules `GET /api/v1/sop/rules`
 * serves for them, one tool call and the decision every layer must reach. Here
 * the served envelope comes back from a stubbed `fetch`, so the rules go
 * through the real register fetch and parser into the real SOP-rule tier of
 * `Gate.guard`: `block` is a refusal naming the rule, `warn` lets the call on
 * with a `tool_flagged` event naming it, `allow` does neither. A refusal wins
 * over a shadow match wherever it sits in the list.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { GateClient, type GateResponse } from '../client.js'
import { IntuticGateRefusal } from '../errors.js'
import { Gate } from '../gate.js'
import * as snapshotMod from '../snapshot.js'

interface LayerVector {
  name: string
  served: { hookRules: Array<Record<string, unknown>> }
  toolCall: { tool: string; toolInput: Record<string, unknown> }
  expected: { decision: 'block' | 'warn' | 'allow'; ruleId: string | null }
}

const VECTORS_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../../shared-types/fixtures/guardrail-layer-vectors.json')
// A missing or unreadable fixture throws here and fails the file: never a skip.
const vectors: LayerVector[] = (JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as { vectors: LayerVector[] }).vectors

// The image-integrity tier runs on every deploy-shaped call (the terraform
// and kubectl vectors). An allowlist and image-free manifests keep it out of
// the decision, so the vectors measure the SOP-rule tier alone.
const root = mkdtempSync(join(tmpdir(), 'intutic-gate-layer-'))
mkdirSync(join(root, '.intutic'))
writeFileSync(join(root, '.intutic', 'image-allowlist.json'), JSON.stringify({ require_digest: true, registries_allowed: [], images: {} }))
const CONFIG_MAP = 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: layer\ndata:\n  k: v\n'
for (const f of ['deploy.yaml', 'a.yaml']) writeFileSync(join(root, f), CONFIG_MAP)
afterAll(() => rmSync(root, { recursive: true, force: true }))

class RecordingClient extends GateClient {
  events: Array<{ event: string; toolName: string; reason: string }> = []
  constructor() {
    super({ baseUrl: 'http://127.0.0.1:9', apiKey: 'k', workspaceId: 'ws_layer', sessionId: 'sess_layer' })
  }
  override async emit(event: string, toolName: string, reason = ''): Promise<boolean> {
    this.events.push({ event, toolName, reason })
    return true
  }
  override async hookGate(): Promise<GateResponse> {
    return { allowed: true, reason: '', reached: true }
  }
}

/** One call through a gate whose register serves `hookRules`, with an empty, healthy snapshot. */
async function guard(v: LayerVector): Promise<{ refusal: IntuticGateRefusal | null; events: RecordingClient['events']; urls: string[] }> {
  const urls: string[] = []
  vi.stubGlobal('fetch', async (url: string) => {
    urls.push(String(url))
    return new Response(JSON.stringify({ rules: v.served.hookRules }), { status: 200 })
  })
  const client = new RecordingClient()
  const gate = new Gate({ repoRoot: root, workspaceId: 'ws_layer', useHookGate: false }, client)
  const empty = new snapshotMod.Snapshot()
  empty.state = 'ok'
  empty.workspaceId = 'ws_layer'
  ;(gate as unknown as { _snapshot: snapshotMod.Snapshot })._snapshot = empty
  try {
    await gate.guard(v.toolCall.tool, v.toolCall.toolInput)
    return { refusal: null, events: client.events, urls }
  } catch (err) {
    if (err instanceof IntuticGateRefusal) return { refusal: err, events: client.events, urls }
    throw err
  }
}

describe('guardrail layer vectors through Gate.guard', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reads the vector file, with every decision represented', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(24)
    const decisions = new Set(vectors.map((v) => v.expected.decision))
    for (const d of ['block', 'warn', 'allow']) expect(decisions, d).toContain(d)
  })

  for (const v of vectors) {
    it(v.name, async () => {
      const { refusal, events, urls } = await guard(v)
      expect(urls.some((u) => u.includes('/api/v1/sop/rules')), 'the rules came from the register').toBe(true)
      const flagged = events.filter((e) => e.event === 'tool_flagged')
      const { decision, ruleId } = v.expected
      if (decision === 'block') {
        expect(refusal, 'refused').not.toBeNull()
        expect(refusal!.code).toBe('SOP_RULE')
        expect(refusal!.reason).toContain(`[sop:${ruleId}]`)
        expect(flagged).toEqual([])
      } else if (decision === 'warn') {
        expect(refusal?.reason ?? null, 'not refused').toBeNull()
        expect(flagged.map((e) => e.reason).join('\n')).toContain(`[sop:${ruleId}]`)
      } else {
        expect(refusal?.reason ?? null, 'not refused').toBeNull()
        expect(flagged.filter((e) => e.reason.includes('[sop:'))).toEqual([])
      }
      // No other rule than the deciding one is named by a refusal or a flag.
      for (const r of v.served.hookRules) {
        if (r.id === ruleId) continue
        expect(refusal?.reason ?? '').not.toContain(`[sop:${String(r.id)}]`)
        expect(flagged.map((e) => e.reason).join('\n')).not.toContain(`[sop:${String(r.id)}]`)
      }
    })
  }
})
