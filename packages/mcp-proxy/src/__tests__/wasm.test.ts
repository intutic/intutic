/**
 * wasm.test.ts — Unit tests for Phase 3's directory loader (wasm/loader.ts)
 * and context builder (wasm/context.ts). Real-module compile/evaluate
 * coverage (the worker, import validation, timeout/disable ladder, verdict
 * mapping) lives in `integration/wasm-rules.test.ts`, which needs `asc`.
 *
 * @module
 */

import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  resolveWasmDir,
  parsePriority,
  scanSignatures,
  WasmLoader,
  MAX_RULE_FILE_BYTES,
  DEFAULT_PRIORITY,
  type CompileBridge,
  type CompileOutcome,
} from '../wasm/loader.js'
import { buildWasmContext } from '../wasm/context.js'

describe('resolveWasmDir', () => {
  const ORIGINAL_ENV = process.env['INTUTIC_WASM_DIR']
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env['INTUTIC_WASM_DIR']
    else process.env['INTUTIC_WASM_DIR'] = ORIGINAL_ENV
  })

  it('defaults to ~/.intutic/wasm', () => {
    delete process.env['INTUTIC_WASM_DIR']
    expect(resolveWasmDir()).toBe(path.join(os.homedir(), '.intutic', 'wasm'))
  })

  it('a config override wins over the home default', () => {
    delete process.env['INTUTIC_WASM_DIR']
    expect(resolveWasmDir('/custom/dir')).toBe('/custom/dir')
  })

  it('the env var wins over the config override', () => {
    process.env['INTUTIC_WASM_DIR'] = '/env/dir'
    expect(resolveWasmDir('/custom/dir')).toBe('/env/dir')
  })

  it('expands a ~/ prefix against the home directory', () => {
    delete process.env['INTUTIC_WASM_DIR']
    expect(resolveWasmDir('~/my-rules')).toBe(path.join(os.homedir(), 'my-rules'))
  })
})

describe('parsePriority', () => {
  it('parses an NN_ prefix', () => {
    expect(parsePriority('10_block-prod-db.wasm')).toEqual({ priority: 10, name: 'block-prod-db' })
    expect(parsePriority('05_a.wasm')).toEqual({ priority: 5, name: 'a' })
  })

  it('defaults to priority 100 without a prefix', () => {
    expect(parsePriority('my-rule.wasm')).toEqual({ priority: DEFAULT_PRIORITY, name: 'my-rule' })
  })

  it('defaults to priority 100 when the prefix is not numeric', () => {
    expect(parsePriority('block_prod.wasm')).toEqual({ priority: DEFAULT_PRIORITY, name: 'block_prod' })
  })

  it('defaults to priority 100 on a leading underscore (empty prefix)', () => {
    expect(parsePriority('_hidden.wasm')).toEqual({ priority: DEFAULT_PRIORITY, name: '_hidden' })
  })
})

describe('scanSignatures', () => {
  let dir: string

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true })
  })

  it('treats a missing directory as empty', async () => {
    const sigs = await scanSignatures('/nonexistent/intutic-wasm-test-dir')
    expect(sigs.size).toBe(0)
  })

  it('ignores non-.wasm files and only signs .wasm ones', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wasm-scan-'))
    await fs.writeFile(path.join(dir, 'notes.txt'), 'not a rule')
    await fs.writeFile(path.join(dir, '10_rule.wasm'), Buffer.from('\0asm'))
    const sigs = await scanSignatures(dir)
    expect(sigs.size).toBe(1)
    expect([...sigs.keys()][0]).toContain('10_rule.wasm')
  })
})

// ── WasmLoader.rescan — fail-open-per-file, using a stub CompileBridge ────

class StubBridge implements CompileBridge {
  compiled: string[] = []
  removed: string[] = []
  /** ruleId -> forced outcome; default is a success. */
  outcomes = new Map<string, CompileOutcome>()

  async compile(ruleId: string, _bytes: Uint8Array): Promise<CompileOutcome> {
    this.compiled.push(ruleId)
    return this.outcomes.get(ruleId) ?? { ok: true, readsReferencedFiles: false }
  }

  remove(ruleId: string): void {
    this.removed.push(ruleId)
  }
}

describe('WasmLoader.rescan', () => {
  let dir: string

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true })
  })

  it('loads every .wasm file and reports rules in priority order', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wasm-loader-'))
    await fs.writeFile(path.join(dir, '20_second.wasm'), Buffer.from('fake'))
    await fs.writeFile(path.join(dir, '10_first.wasm'), Buffer.from('fake'))
    const loader = new WasmLoader(dir)
    const bridge = new StubBridge()
    await loader.rescan(bridge)
    expect(loader.getRules().map((r) => r.name)).toEqual(['first', 'second'])
  })

  it('skips a file over the size cap, fail-open (does not touch bridge.compile)', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wasm-loader-cap-'))
    const big = path.join(dir, 'huge.wasm')
    await fs.writeFile(big, Buffer.alloc(1)) // create it small first
    // Simulate an oversized file by writing exactly the cap+1 without
    // actually allocating a 10MB buffer content twice; a sparse write is
    // fine since only the size, not content, matters to the cap check.
    await fs.truncate(big, MAX_RULE_FILE_BYTES + 1)
    const loader = new WasmLoader(dir)
    const bridge = new StubBridge()
    await loader.rescan(bridge)
    expect(bridge.compiled).toEqual([])
    expect(loader.getRules()).toEqual([])
  })

  it('retains the previous good rule when a recompile fails (fail-open-per-file)', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wasm-loader-failopen-'))
    const file = path.join(dir, 'flaky.wasm')
    await fs.writeFile(file, Buffer.from('v1'))
    const loader = new WasmLoader(dir)
    const bridge = new StubBridge()
    await loader.rescan(bridge)
    expect(loader.getRules()).toHaveLength(1)
    const ruleId = loader.getRules()[0]!.ruleId

    // Force the next compile of this ruleId to fail, then change the file
    // so a rescan actually attempts a recompile.
    bridge.outcomes.set(ruleId, { ok: false, error: 'corrupt' })
    await fs.writeFile(file, Buffer.from('v2-corrupt'))
    await loader.rescan(bridge)

    expect(loader.getRules()).toHaveLength(1) // still there
    expect(loader.getRules()[0]!.ruleId).toBe(ruleId)
  })

  it('removes a rule whose file disappeared, telling the bridge', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wasm-loader-removed-'))
    const file = path.join(dir, 'gone.wasm')
    await fs.writeFile(file, Buffer.from('v1'))
    const loader = new WasmLoader(dir)
    const bridge = new StubBridge()
    await loader.rescan(bridge)
    const ruleId = loader.getRules()[0]!.ruleId

    await fs.unlink(file)
    await loader.rescan(bridge)

    expect(loader.getRules()).toEqual([])
    expect(bridge.removed).toContain(ruleId)
  })

  it('does not recompile when nothing changed', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wasm-loader-nochange-'))
    await fs.writeFile(path.join(dir, 'stable.wasm'), Buffer.from('v1'))
    const loader = new WasmLoader(dir)
    const bridge = new StubBridge()
    await loader.rescan(bridge)
    await loader.rescan(bridge)
    expect(bridge.compiled).toHaveLength(1)
  })
})

// ── buildWasmContext ──────────────────────────────────────────────────────

describe('buildWasmContext', () => {
  const baseInput = {
    sessionId: 'ses_1',
    workspaceId: 'ws_1',
    tools: [{ name: 'fetch', description: 'Fetches a URL' }],
    toolCallId: 'call_1',
    toolName: 'Bash',
    toolArguments: { command: 'ls' },
    toolSequence: ['Read', 'Bash', 'Bash'],
    callsLast60s: 2,
    dlpFindingDescriptions: [],
    injectionFindings: [],
    injectionSources: [],
    corroboratingDetectors: 0,
    toolContractChanged: undefined,
  }

  it('includes the fields this proxy honestly has', () => {
    const ctx = buildWasmContext(baseInput)
    expect(ctx['session_id']).toBe('ses_1')
    expect(ctx['workspace_id']).toBe('ws_1')
    expect(ctx['tools']).toEqual([{ name: 'fetch', description: 'Fetches a URL' }])
    expect(ctx['tool_calls']).toEqual([{ id: 'call_1', name: 'Bash', arguments: { command: 'ls' } }])
    expect(ctx['tool_sequence']).toEqual(['Read', 'Bash', 'Bash'])
    expect(ctx['calls_last_60s']).toBe(2)
  })

  it('omits harness/model/budget/graph/SOP-declaration fields entirely — not even as null', () => {
    const ctx = buildWasmContext(baseInput)
    for (const key of [
      'harness',
      'model',
      'allowed_harnesses',
      'graph_spend_usd',
      'graph_budget_usd',
      'budget_remaining_usd',
      'node_id',
      'agent_role',
      'graph_id',
      'denied_tools',
      'plan_steps',
      'scope_paths',
      'review_before',
    ]) {
      expect(Object.prototype.hasOwnProperty.call(ctx, key), `${key} must be absent, not present as any value`).toBe(false)
    }
  })

  it('folds tool_sequence into tool_call_counts as (tool, count) pairs', () => {
    const ctx = buildWasmContext(baseInput)
    expect(ctx['tool_call_counts']).toEqual(
      expect.arrayContaining([
        ['Read', 1],
        ['Bash', 2],
      ]),
    )
  })

  it('maps DLP finding descriptions to pattern_name, honestly omitting fields it cannot derive', () => {
    const ctx = buildWasmContext({ ...baseInput, dlpFindingDescriptions: ['AWS Access Key ID'] })
    expect(ctx['dlp_findings']).toEqual([{ pattern_name: 'AWS Access Key ID' }])
  })

  it('includes tool_contract_changed only when known', () => {
    const unknown = buildWasmContext(baseInput)
    expect(Object.prototype.hasOwnProperty.call(unknown, 'tool_contract_changed')).toBe(false)

    const known = buildWasmContext({ ...baseInput, toolContractChanged: true })
    expect(known['tool_contract_changed']).toBe(true)
  })
})
