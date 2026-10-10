/**
 * integration/cloud-rules.test.ts — the workspace's control-plane rules,
 * fetched, verified against their descriptors' SHA-256, compiled and evaluated
 * through the real `worker_threads` worker, beside the local rules directory.
 *
 * The semantics are the Rust proxy's (`packages/proxy/src/wasm/registry.rs`,
 * and its `tests/wasm_rule_integrity_test.rs`): a version that cannot load is
 * reported once and the previous version keeps enforcing; a control plane that
 * cannot be reached leaves the loaded set alone; a tie in priority runs the
 * control-plane rule first; a shadowed rule never decides.
 *
 * Native rules are hand-assembled (each returns a fixed verdict code), so the
 * suite needs no compiler; Rego rules are the Rust proxy's OPA fixtures.
 *
 * @module
 */

import { describe, it, expect, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WasmRuleDescriptor } from '@intutic/shared-types'
import { WasmRunner } from '../../wasm/runner.js'
import type { WasmContextInput } from '../../wasm/context.js'
import {
  CLOUD_RETRY_MS,
  CloudRuleSet,
  fetchRuleBinaryFrom,
  refusalDetail,
  type CloudRuleRefusalReport,
} from '../../wasm/cloudRules.js'

const regoFixture = (name: string): Buffer =>
  readFileSync(fileURLToPath(new URL(`../../../../proxy/tests/fixtures/rego/${name}`, import.meta.url)))

/**
 * A native rule that returns `code` for every call: `allocate` answers a
 * fixed offset, `evaluate` the code. `tag` lands in a custom section, so two
 * rules with one code are two binaries with two hashes.
 */
function nativeRule(code: 0 | 1 | 3, tag: string): Buffer {
  const name = Buffer.from(tag)
  return Buffer.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    // types: (i32) -> i32, (i32, i32) -> i32
    0x01, 0x0c, 0x02, 0x60, 0x01, 0x7f, 0x01, 0x7f, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
    // functions: allocate: type 0, evaluate: type 1
    0x03, 0x03, 0x02, 0x00, 0x01,
    // one memory of one page
    0x05, 0x03, 0x01, 0x00, 0x01,
    // exports: memory, allocate, evaluate
    0x07, 0x20, 0x03,
    0x06, ...Buffer.from('memory'), 0x02, 0x00,
    0x08, ...Buffer.from('allocate'), 0x00, 0x00,
    0x08, ...Buffer.from('evaluate'), 0x00, 0x01,
    // code: allocate -> 1024, evaluate -> code
    0x0a, 0x0c, 0x02,
    0x05, 0x00, 0x41, 0x80, 0x08, 0x0b,
    0x04, 0x00, 0x41, code, 0x0b,
    // custom section "tag"
    0x00, 4 + name.length, 0x03, ...Buffer.from('tag'), ...name,
  ])
}

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

function descriptor(ruleId: string, bytes: Uint8Array, priority = 100, mode: 'ENFORCE' | 'SHADOW' = 'ENFORCE'): WasmRuleDescriptor {
  return { ruleId, name: ruleId.replace(/^wasm_/, ''), sha256: sha(bytes), priority, mode }
}

const call = (command: string): WasmContextInput => ({
  sessionId: 'ses_cloud',
  workspaceId: 'ws_cloud',
  tools: [],
  toolCallId: 'call_cloud',
  toolName: 'Bash',
  toolArguments: { command },
  toolSequence: ['Bash'],
  callsLast60s: 1,
  dlpFindingDescriptions: [],
  injectionFindings: [],
  injectionSources: [],
  corroboratingDetectors: 0,
  toolContractChanged: undefined,
  serverName: 'shell',
})

/** The control plane's rule store, as the fetch sees it: binaries by hash, or unreachable. */
class Store {
  binaries = new Map<string, Uint8Array>()
  reachable = true
  fetches: string[] = []

  put(bytes: Uint8Array, as = sha(bytes)): void {
    this.binaries.set(as, bytes)
  }

  fetch = async (hash: string): Promise<Uint8Array | null> => {
    this.fetches.push(hash)
    if (!this.reachable) throw new Error('connect ECONNREFUSED')
    return this.binaries.get(hash) ?? null
  }
}

let runner: WasmRunner | undefined
const dirs: string[] = []

afterEach(async () => {
  await runner?.shutdown()
  runner = undefined
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function setUp(local: Record<string, Buffer> = {}): { store: Store; reports: CloudRuleRefusalReport[]; cloud: CloudRuleSet; runner: WasmRunner } {
  const dir = mkdtempSync(join(tmpdir(), 'intutic-mcp-cloud-'))
  dirs.push(dir)
  for (const [name, bytes] of Object.entries(local)) writeFileSync(join(dir, name), bytes)
  const store = new Store()
  const reports: CloudRuleRefusalReport[] = []
  const cloud = new CloudRuleSet(store.fetch, (r) => reports.push(r))
  runner = new WasmRunner(dir, cloud)
  return { store, reports, cloud, runner }
}

/** Lets the retry interval pass for `cloud` without waiting it out. */
function expireRetry(cloud: CloudRuleSet): void {
  ;(cloud as unknown as { attemptedAt: number }).attemptedAt = Date.now() - CLOUD_RETRY_MS
}

describe("the workspace's control-plane rules in the MCP proxy", () => {
  it('fetches each binary by hash, verifies it, and enforces it under the control-plane rule id', async () => {
    const { store, reports, runner } = setUp()
    const block = nativeRule(1, 'block')
    store.put(block)

    await runner.syncCloudRules([descriptor('wasm_block', block)])

    expect(runner.cloudRulesLoaded()).toBe(true)
    expect(runner.getLoadedRuleIds()).toEqual(['wasm_block'])
    expect(await runner.evaluate(call('ls'))).toMatchObject({ code: 'block', ruleId: 'wasm_block' })
    expect(reports).toEqual([])
  })

  it('runs a Rego rule from the control plane', async () => {
    const { store, runner } = setUp()
    const rego = regoFixture('examples/block_destructive_shell.wasm')
    store.put(rego)

    await runner.syncCloudRules([descriptor('wasm_shell', rego)])

    expect(await runner.evaluate(call('rm -rf /'))).toMatchObject({ code: 'block', ruleId: 'wasm_shell' })
    expect(await runner.evaluate(call('ls'))).toEqual({ code: 'allow' })
  })

  it('fetches a binary once: a list that changes only names, priorities or modes fetches nothing', async () => {
    const { store, runner } = setUp()
    const block = nativeRule(1, 'block')
    store.put(block)
    await runner.syncCloudRules([descriptor('wasm_block', block, 10)])
    await runner.syncCloudRules([{ ...descriptor('wasm_block', block, 20), name: 'renamed' }])

    expect(store.fetches).toEqual([sha(block)])
    expect(await runner.evaluate(call('ls'))).toMatchObject({ code: 'block', ruleId: 'wasm_block' })
  })

  it('keeps the previous version and reports once when a new version does not hash to its descriptor', async () => {
    const { store, reports, cloud, runner } = setUp()
    const v1 = nativeRule(1, 'v1')
    const v2 = nativeRule(0, 'v2')
    const swapped = nativeRule(0, 'swapped')
    store.put(v1)
    await runner.syncCloudRules([descriptor('wasm_rule', v1)])

    // The store answers v2's hash with other bytes: the swap the hash exists to catch.
    store.put(swapped, sha(v2))
    await runner.syncCloudRules([descriptor('wasm_rule', v2)])

    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({
      descriptor: { ruleId: 'wasm_rule', sha256: sha(v2) },
      refusal: { kind: 'hash_mismatch', actual: sha(swapped) },
      hasPrevious: true,
    })
    expect(reports[0]!.description).toBe(
      `WASM rule 'rule' (wasm_rule) was refused: its binary hashes to ${sha(swapped)} but its descriptor ` +
        `names ${sha(v2)}. The previously loaded version stays in force.`,
    )
    // v1 still enforces.
    expect(await runner.evaluate(call('ls'))).toMatchObject({ code: 'block', ruleId: 'wasm_rule' })

    // Retried after the interval, refused again, reported no more.
    expireRetry(cloud)
    await runner.syncCloudRules([descriptor('wasm_rule', v2)])
    await runner.syncCloudRules([descriptor('wasm_rule', v2)])
    expect(store.fetches.filter((h) => h === sha(v2)).length).toBeGreaterThanOrEqual(2)
    expect(reports).toHaveLength(1)
    expect(await runner.evaluate(call('ls'))).toMatchObject({ code: 'block', ruleId: 'wasm_rule' })
  })

  it('loads a missing binary once it is published, and reports the rule it could not load meanwhile', async () => {
    const { store, reports, cloud, runner } = setUp()
    const block = nativeRule(1, 'late')
    await runner.syncCloudRules([descriptor('wasm_late', block)])

    expect(runner.cloudRulesLoaded()).toBe(true)
    expect(runner.getLoadedRuleIds()).toEqual([])
    expect(reports.map((r) => [r.refusal.kind, r.hasPrevious])).toEqual([['missing', false]])
    expect(reports[0]!.description).toContain('No version of this rule has loaded on this proxy')

    store.put(block)
    expireRetry(cloud)
    await runner.syncCloudRules([descriptor('wasm_late', block)])
    // The retry runs in the background: the loaded set was already the workspace's.
    await (cloud as unknown as { syncing: Promise<void> | null }).syncing
    expect(await runner.evaluate(call('ls'))).toMatchObject({ code: 'block', ruleId: 'wasm_late' })
  })

  it('refuses a binary the worker cannot load, and keeps the version that loaded', async () => {
    const { store, reports, runner } = setUp()
    const v1 = nativeRule(1, 'v1')
    const broken = Buffer.from('not a module')
    store.put(v1)
    store.put(broken)
    await runner.syncCloudRules([descriptor('wasm_rule', v1)])
    await runner.syncCloudRules([descriptor('wasm_rule', broken)])

    expect(reports.map((r) => r.refusal.kind)).toEqual(['compile_error'])
    expect(refusalDetail(reports[0]!)).toMatchObject({ ruleId: 'wasm_rule', refusal: 'compile_error', previousInForce: true })
    expect(await runner.evaluate(call('ls'))).toMatchObject({ code: 'block', ruleId: 'wasm_rule' })
  })

  it('has no rules loaded while the control plane cannot be reached, and keeps a loaded set through an outage', async () => {
    const { store, reports, cloud, runner } = setUp()
    const block = nativeRule(1, 'block')
    store.put(block)
    store.reachable = false

    await runner.syncCloudRules([descriptor('wasm_block', block)])
    expect(runner.cloudRulesLoaded()).toBe(false)
    expect(reports).toEqual([])

    // Within the retry interval a call does not wait on another fetch.
    await runner.syncCloudRules([descriptor('wasm_block', block)])
    expect(store.fetches).toHaveLength(1)

    store.reachable = true
    expireRetry(cloud)
    await runner.syncCloudRules([descriptor('wasm_block', block)])
    expect(runner.cloudRulesLoaded()).toBe(true)

    // A new list that cannot be fetched leaves the loaded one enforcing.
    const other = nativeRule(0, 'other')
    store.put(other)
    store.reachable = false
    await runner.syncCloudRules([descriptor('wasm_block', block), descriptor('wasm_other', other)])
    expect(runner.getLoadedRuleIds()).toEqual(['wasm_block'])
    expect(await runner.evaluate(call('ls'))).toMatchObject({ code: 'block', ruleId: 'wasm_block' })
  })

  it('stops enforcing a rule the list no longer names', async () => {
    const { store, runner } = setUp()
    const block = nativeRule(1, 'block')
    store.put(block)
    await runner.syncCloudRules([descriptor('wasm_block', block)])
    await runner.syncCloudRules([])

    expect(runner.getLoadedRuleIds()).toEqual([])
    expect(await runner.evaluate(call('ls'))).toEqual({ code: 'allow' })
  })

  it('runs local and control-plane rules as one list by priority, the control-plane rule first on a tie', async () => {
    const { store, runner } = setUp({
      '10_shell.wasm': regoFixture('examples/block_destructive_shell.wasm'),
      '50_reask.wasm': nativeRule(3, 'local-reask'),
    })
    const early = nativeRule(0, 'early')
    const tie = nativeRule(3, 'tie')
    const late = nativeRule(1, 'late')
    for (const b of [early, tie, late]) store.put(b)
    await runner.rescan()
    await runner.syncCloudRules([descriptor('wasm_late', late, 200), descriptor('wasm_tie', tie, 50), descriptor('wasm_early', early, 5)])

    expect(runner.getLoadedRuleIds()).toEqual(['wasm_early', 'local:10_shell.wasm', 'wasm_tie', 'local:50_reask.wasm', 'wasm_late'])
    // The local Rego rule blocks first; otherwise the later cloud block outranks
    // the reasks before it, and the first reask is the control-plane one.
    expect(await runner.evaluate(call('rm -rf /'))).toMatchObject({ code: 'block', ruleId: 'local:10_shell.wasm' })
    expect(await runner.evaluate(call('ls'))).toMatchObject({ code: 'block', ruleId: 'wasm_late' })
    await runner.syncCloudRules([descriptor('wasm_tie', tie, 50)])
    expect(await runner.evaluate(call('ls'))).toMatchObject({ code: 'reask', ruleId: 'wasm_tie' })
  })

  it('never lets a shadowed rule decide, not even when it reaches no verdict', async () => {
    const { store, runner } = setUp()
    const block = nativeRule(1, 'block')
    const conformance = regoFixture('conformance.wasm')
    store.put(block)
    store.put(conformance)
    await runner.syncCloudRules([
      descriptor('wasm_block', block, 10, 'SHADOW'),
      descriptor('wasm_conformance', conformance, 20, 'SHADOW'),
    ])

    expect(runner.getLoadedRuleIds()).toEqual(['wasm_block', 'wasm_conformance'])
    const shadow: Array<{ ruleId: string; wouldAct: boolean }> = []
    expect(await runner.evaluate(call('ls'), shadow)).toEqual({ code: 'allow' })
    // Both are promotion evidence: a block, and a rule that reached no verdict.
    expect(shadow).toEqual([
      { ruleId: 'wasm_block', wouldAct: true },
      { ruleId: 'wasm_conformance', wouldAct: true },
    ])

    // A bypass is reported too: it is the denominator.
    const allowRule = nativeRule(0, 'allow')
    store.put(allowRule)
    await runner.syncCloudRules([descriptor('wasm_allow', allowRule, 10, 'SHADOW')])
    const bypass: Array<{ ruleId: string; wouldAct: boolean }> = []
    await runner.evaluate(call('ls'), bypass)
    expect(bypass).toEqual([{ ruleId: 'wasm_allow', wouldAct: false }])

    // Promoted to enforce, the same binary blocks without another fetch.
    await runner.syncCloudRules([descriptor('wasm_block', block, 10)])
    expect(await runner.evaluate(call('ls'))).toMatchObject({ code: 'block', ruleId: 'wasm_block' })
  })
})

describe('fetchRuleBinaryFrom', () => {
  it('reads a binary by hash, a 404 as missing, and any other failure as unreachable', async () => {
    const bytes = nativeRule(1, 'http')
    const seen: Array<{ url: string; auth: string | undefined }> = []
    const server = http.createServer((req, res) => {
      seen.push({ url: req.url ?? '', auth: req.headers.authorization })
      if (req.url === `/api/v1/wasm-rules/binaries/${sha(bytes)}`) {
        res.writeHead(200, { 'Content-Type': 'application/wasm' })
        res.end(bytes)
      } else if (req.url?.endsWith('/broken')) {
        res.writeHead(500)
        res.end('{"error":"Internal server error"}')
      } else {
        res.writeHead(404)
        res.end('{"error":"Rule binary not found"}')
      }
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    try {
      const fetchBinary = fetchRuleBinaryFrom(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'vk_test')
      expect(Buffer.from((await fetchBinary(sha(bytes)))!)).toEqual(bytes)
      expect(await fetchBinary('b'.repeat(64))).toBeNull()
      await expect(fetchBinary('broken')).rejects.toThrow('500')
      expect(seen[0]).toEqual({ url: `/api/v1/wasm-rules/binaries/${sha(bytes)}`, auth: 'Bearer vk_test' })
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})
