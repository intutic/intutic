/**
 * A gate with no API key is local-only: the local tiers decide, the
 * control-plane tiers are skipped, and nothing is sent. A key the control
 * plane refuses still fails closed. The vectors are shared with
 * intutic-clawde's tests/test_gate_local_only.py.
 */
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { CLOUD_RELEASED as CANONICAL_CLOUD_RELEASED } from '@intutic/shared-types'
import { GateClient } from '../client.js'
import { IntuticGateRefusal } from '../errors.js'
import { Gate } from '../gate.js'
import { CLOUD_RELEASED } from '../release.js'
import { rulesText } from './fixtures/rulesFile.js'

interface Answer {
  status: number
  body: unknown
}
interface HookGateVector {
  name: string
  apiKey: string
  failClosed: boolean
  response: Answer
  expect: { allowed: boolean; reached: boolean; code?: string; requests?: number; reasonContains?: string }
}
interface ConstructionVector {
  name: string
  apiKey: string
  cloudReleased: boolean
  expect: { throws: boolean; localOnly?: boolean; messageContains?: string }
}
interface GuardVector {
  name: string
  apiKey: string
  response: Answer
  snapshotRules: string[]
  call: { tool: string; input: Record<string, unknown> }
  expect: { refused: string | null; requests?: number }
}

const VECTORS = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../../shared-types/fixtures/gate-client-credentials-vectors.json'),
    'utf8',
  ),
) as { hookGate: HookGateVector[]; guard: GuardVector[]; construction: ConstructionVector[] }

let server: Server
let baseUrl: string
let answer: Answer
let requests = 0
const dir = mkdtempSync(join(tmpdir(), 'intutic-gate-local-only-'))

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = createServer((req, res) => {
      requests++
      req.resume()
      req.on('end', () => {
        res.writeHead(answer.status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(answer.body))
      })
    })
    server.listen(0, () => resolve())
  })
  const address = server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

afterAll(() => {
  server.close()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  requests = 0
})

describe('GateClient.localOnly', () => {
  it('is true exactly when there is no API key', () => {
    expect(new GateClient().localOnly).toBe(true)
    expect(new GateClient({ apiKey: '' }).localOnly).toBe(true)
    expect(new GateClient({ baseUrl, apiKey: 'k' }).localOnly).toBe(false)
  })

  it('sends no events', async () => {
    answer = { status: 200, body: { ok: true } }
    await expect(new GateClient({ baseUrl }).emit('tool_allowed', 'shell')).resolves.toBe(false)
    expect(requests).toBe(0)
  })
})

describe('GateClient.hookGate with and without a key, as the shared vectors say', () => {
  it.each(VECTORS.hookGate.map((v) => [v.name, v] as const))('%s', async (_name, v) => {
    answer = v.response
    const client = new GateClient({ baseUrl, apiKey: v.apiKey, workspaceId: 'ws_1', failClosed: v.failClosed })
    const resp = await client.hookGate('shell', { command: 'make test' })
    expect({ allowed: resp.allowed, reached: resp.reached }).toEqual({ allowed: v.expect.allowed, reached: v.expect.reached })
    expect(resp.code).toBe(v.expect.code)
    if (v.expect.reasonContains) expect(resp.reason).toContain(v.expect.reasonContains)
    if (v.expect.requests !== undefined) expect(requests).toBe(v.expect.requests)
  })
})

describe('Gate.guard with and without a key, as the shared vectors say', () => {
  it.each(VECTORS.guard.map((v, i) => [v.name, v, i] as const))('%s', async (_name, v, i) => {
    answer = v.response
    const snapshotPath = join(dir, `snap-${i}.rules`)
    writeFileSync(snapshotPath, rulesText(v.snapshotRules))
    const previous = process.env.INTUTIC_SNAPSHOT_RULES
    process.env.INTUTIC_SNAPSHOT_RULES = snapshotPath
    try {
      const client = new GateClient({ baseUrl, apiKey: v.apiKey, workspaceId: 'ws_1', sessionId: 's_1' })
      const gate = new Gate({ workspaceId: 'ws_1', repoRoot: dir }, client)
      let refused: string | null = null
      try {
        await gate.guard(v.call.tool, v.call.input)
      } catch (err) {
        if (!(err instanceof IntuticGateRefusal)) throw err
        refused = err.code
      }
      expect(refused).toBe(v.expect.refused)
      if (v.expect.requests !== undefined) expect(requests).toBe(v.expect.requests)
    } finally {
      if (previous === undefined) delete process.env.INTUTIC_SNAPSHOT_RULES
      else process.env.INTUTIC_SNAPSHOT_RULES = previous
    }
  })
})

/** Runs `fn` with INTUTIC_CONTROL_PLANE_URL unset (and HOME at `home`, when given), then restores both. */
function withoutControlPlane<T>(fn: () => T, home?: string): T {
  const saved = { url: process.env.INTUTIC_CONTROL_PLANE_URL, home: process.env.HOME }
  delete process.env.INTUTIC_CONTROL_PLANE_URL
  if (home) process.env.HOME = home
  try {
    return fn()
  } finally {
    if (saved.url !== undefined) process.env.INTUTIC_CONTROL_PLANE_URL = saved.url
    if (saved.home === undefined) delete process.env.HOME
    else process.env.HOME = saved.home
  }
}

describe('GateClient with no control-plane address, as the shared vectors say', () => {
  it('keeps its release flag in step with @intutic/shared-types', () => {
    expect(CLOUD_RELEASED).toBe(CANONICAL_CLOUD_RELEASED)
  })

  it.each(VECTORS.construction.filter((v) => v.cloudReleased === CLOUD_RELEASED).map((v) => [v.name, v] as const))('%s', (_name, v) => {
    withoutControlPlane(() => {
      const make = () => new GateClient({ apiKey: v.apiKey, workspaceId: 'ws_1', sessionId: 's_1' })
      if (v.expect.throws) {
        expect(make).toThrow(v.expect.messageContains)
      } else {
        expect(make().localOnly).toBe(v.expect.localOnly)
      }
    })
  })

  it('fromEnv takes the control plane intutic login saved', () => {
    const home = mkdtempSync(join(tmpdir(), 'intutic-gate-home-'))
    try {
      mkdirSync(join(home, '.intutic'))
      writeFileSync(
        join(home, '.intutic', 'credentials.json'),
        JSON.stringify({ apiKey: 'k', workspaceId: 'ws_1', controlPlaneUrl: 'https://cp.saved.example' }),
      )
      const client = withoutControlPlane(() => GateClient.fromEnv({ sessionId: 's_1' }), home)
      expect(client.baseUrl).toBe('https://cp.saved.example')
      expect(client.localOnly).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
