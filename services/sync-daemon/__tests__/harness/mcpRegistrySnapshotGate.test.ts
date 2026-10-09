/**
 * The MCP server registry in the policy snapshot, end to end through the
 * emitted gates.
 *
 * `GET /api/v1/policy/resolve` serves the workspace's registry decisions as
 * `mcpRegistry`; the daemon writes them as an `@mcp_registry` record inside
 * the digest, and the hook gates refuse an `mcp__<server>__<tool>` call the
 * registry refuses — the MCP servers no proxy fronts included — with the MCP
 * proxy's decision.
 *
 * The conformance half runs `mcp-registry-vectors.json` — the cases
 * `evaluateMcpRegistry` and the MCP proxy also run, and the allowlist cases
 * `evaluateMcpAllowlist` runs — through one node gate and one bash gate, each
 * case with a snapshot written by the real `writePolicySnapshot`. The tamper
 * half adds an approval, or an allowlisted server, to a written snapshot and
 * checks it clears nothing.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  decodeMcpRegistryRecord,
  encodeMcpAllowlistRecord,
  encodeMcpRegistryRecord,
  MCP_ALLOWLIST_RECORD_TAG,
  MCP_REGISTRY_RECORD_TAG,
  type McpAllowlistRecord,
  type McpRegistryRecord,
} from '@intutic/shared-types'
import { MCP_REGISTRY_PY_SOURCE } from '../../src/lib/mcpRegistryPy.js'
import { GATES, type GateEntry } from './gateRegistry.js'
import {
  fetchResolvedPolicy,
  refreshPolicySnapshot,
  writePolicySnapshot,
  SNAPSHOT_JSON,
  SNAPSHOT_RULES,
  type ResolvedPolicy,
} from '../../src/lib/policySnapshot.js'

interface Case { name: string; toolName: string; code: string | null; ruleId: string | null; reason: string | null }
interface Vectors {
  registries: Record<string, McpRegistryRecord>
  cases: Array<Case & { registry: string }>
  allowlists: Record<string, McpAllowlistRecord>
  allowlistCases: Array<Case & { allowlist: string }>
}
const VECTORS: Vectors = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../../packages/shared-types/fixtures/mcp-registry-vectors.json'), 'utf8'),
)

const DENY: McpRegistryRecord = {
  defaultPolicy: 'deny',
  approvedServers: ['github'],
  blockedServers: ['pastebin'],
  heldServers: [],
  disabledTools: {},
}

function policy(over: Partial<ResolvedPolicy> = {}): ResolvedPolicy {
  return {
    workspaceId: 'ws_test',
    sopRules: [],
    interventionMode: 'TRANSPARENT',
    mcpAllowedServers: [],
    sqlDropStrictBlock: false,
    ...over,
  }
}

const dataLines = (file: string) => readFileSync(file, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'))

afterEach(() => vi.restoreAllMocks())

describe('the bash gates\' registry decision', () => {
  it('is a byte-identical copy of intutic-clawde\'s mcp_registry.py', () => {
    const clawde = join(dirname(fileURLToPath(import.meta.url)), '../../../../packages/intutic-clawde/intutic_clawde/gate/mcp_registry.py')
    expect(MCP_REGISTRY_PY_SOURCE).toBe(readFileSync(clawde, 'utf8'))
  })
})

describe('fetchResolvedPolicy — the registry', () => {
  it('reads mcpRegistry, and an older control plane without it as none', async () => {
    const resolve = (body: Record<string, unknown>) =>
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ workspaceId: 'ws_1', sopRules: [], ...body }) })) as unknown as typeof fetch)
    resolve({ mcpRegistry: { ...DENY, blockedServers: ['pastebin', 7] } })
    const opts = { controlPlaneUrl: 'https://cp.example', apiKey: 'k', workspaceId: 'ws_1' }
    expect((await fetchResolvedPolicy(opts))?.mcpRegistry).toEqual(DENY)
    resolve({})
    expect((await fetchResolvedPolicy(opts))?.mcpRegistry).toBeNull()
  })
})

describe('writePolicySnapshot — the @mcp_registry record', () => {
  it('writes the record inside the digest, and the same registry in the JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'intutic-reg-snap-'))
    try {
      const { digest } = await writePolicySnapshot(policy({ mcpRegistry: DENY }), dir)
      const lines = dataLines(join(dir, SNAPSHOT_RULES))
      const record = lines.find((l) => l.startsWith(`${MCP_REGISTRY_RECORD_TAG}\t`))!
      expect(decodeMcpRegistryRecord(record)).toEqual(DENY)
      expect(createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 32)).toBe(digest)
      expect(JSON.parse(readFileSync(join(dir, SNAPSHOT_JSON), 'utf8')).mcpRegistry).toEqual(DENY)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('writes nothing for a registry that refuses nothing, or none at all', async () => {
    for (const mcpRegistry of [VECTORS.registries['unrestricted']!, null]) {
      const dir = mkdtempSync(join(tmpdir(), 'intutic-reg-none-'))
      try {
        await writePolicySnapshot(policy({ mcpRegistry }), dir)
        expect(readFileSync(join(dir, SNAPSHOT_RULES), 'utf8')).not.toContain(MCP_REGISTRY_RECORD_TAG)
        expect(JSON.parse(readFileSync(join(dir, SNAPSHOT_JSON), 'utf8'))).not.toHaveProperty('mcpRegistry')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  it('keeps the registry when a refused key makes the daemon rewrite the snapshot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'intutic-reg-refused-'))
    const opts = { controlPlaneUrl: 'https://cp.example', apiKey: 'k', workspaceId: 'ws_test', snapshotDir: dir }
    try {
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true, status: 200,
        json: async () => ({
          workspaceId: 'ws_test', interventionMode: 'TRANSPARENT', sopRules: [], mcpRegistry: DENY,
          ssoGroupPolicy: { highRiskTools: ['Bash'], requiredGroups: ['sre'] }, principal: { memberId: 'mem_1', ssoGroups: ['sre'] },
        }),
      })) as unknown as typeof fetch)
      await refreshPolicySnapshot(opts)
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch)
      expect(await refreshPolicySnapshot(opts)).toBeNull()
      const record = dataLines(join(dir, SNAPSHOT_RULES)).find((l) => l.startsWith(`${MCP_REGISTRY_RECORD_TAG}\t`))
      expect(record && decodeMcpRegistryRecord(record)).toEqual(DENY)
      expect(dataLines(join(dir, SNAPSHOT_RULES)).some((l) => l.startsWith('sso_group.high_risk.Bash\t'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ─── Through the emitted gates ──────────────────────────────────────────────

/** One node gate and one bash gate — the two evaluators of the shared gate body. */
const CHOSEN = ['claudeCode', 'openhands'] as const
const gates = CHOSEN.map((n) => GATES.find((g) => g.name === n)).filter((g): g is GateEntry => g !== undefined)

const home = mkdtempSync(join(tmpdir(), 'intutic-reg-gates-'))
const roots = new Map<string, string>()
/** One snapshot per registry in the vectors, and one per allowlist. */
const registrySnapshots = new Map<string, string>()
const allowlistSnapshots = new Map<string, string>()
let tampered = ''
let tamperedAllowlist = ''

beforeAll(async () => {
  for (const name of Object.keys(VECTORS.registries)) {
    const dir = join(home, `registry-${name}`)
    await writePolicySnapshot(policy({ mcpRegistry: VECTORS.registries[name]! }), dir)
    registrySnapshots.set(name, join(dir, SNAPSHOT_RULES))
  }
  for (const [name, allowlist] of Object.entries(VECTORS.allowlists)) {
    const dir = join(home, `allowlist-${name}`)
    await writePolicySnapshot(policy({ mcpAllowedServers: allowlist.servers }), dir)
    const file = join(dir, SNAPSHOT_RULES)
    if (allowlist.servers.length === 0) {
      // The writer writes no record for an empty list (no record is
      // "unrestricted"), so the record that admits no server is added by
      // hand, with the digest recomputed so the snapshot stays valid.
      const lines = [encodeMcpAllowlistRecord(allowlist), ...dataLines(file)]
      const digest = createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 32)
      const header = readFileSync(file, 'utf8').split('\n').filter((l) => l.startsWith('#')).map((l) => (l.startsWith('#digest ') ? `#digest ${digest}` : l))
      chmodSync(file, 0o644)
      writeFileSync(file, [...header, ...lines].join('\n') + '\n')
    }
    allowlistSnapshots.set(name, file)
  }

  // A deny registry approving github — then an approval for "newcomer" and
  // the removal of pastebin's block written into the file by hand.
  const dir = join(home, 'tampered')
  await writePolicySnapshot(policy({
    mcpRegistry: DENY,
    sopRules: [{ id: 's_write', toolPattern: 'Write', action: 'block', reason: 'no writes' }],
  }), dir)
  tampered = join(dir, SNAPSHOT_RULES)
  const text = readFileSync(tampered, 'utf8')
  const recordLine = text.split('\n').find((l) => l.startsWith(`${MCP_REGISTRY_RECORD_TAG}\t`))!
  const edited = encodeMcpRegistryRecord({ ...DENY, approvedServers: ['github', 'newcomer'] })
  chmodSync(tampered, 0o644)
  writeFileSync(tampered, text.replace(recordLine, edited))

  // An allowlist of github — then "newcomer" added to it by hand.
  const allowDir = join(home, 'tampered-allowlist')
  await writePolicySnapshot(policy({
    mcpAllowedServers: ['github'],
    sopRules: [{ id: 's_write', toolPattern: 'Write', action: 'block', reason: 'no writes' }],
  }), allowDir)
  tamperedAllowlist = join(allowDir, SNAPSHOT_RULES)
  const allowText = readFileSync(tamperedAllowlist, 'utf8')
  const allowLine = allowText.split('\n').find((l) => l.startsWith(`${MCP_ALLOWLIST_RECORD_TAG}\t`))!
  chmodSync(tamperedAllowlist, 0o644)
  writeFileSync(tamperedAllowlist, allowText.replace(allowLine, encodeMcpAllowlistRecord({ severity: 'block', servers: ['github', 'newcomer'] })))

  for (const g of gates) {
    const root = join(home, g.name)
    mkdirSync(root, { recursive: true })
    process.env.HOME = root
    process.env.USERPROFILE = root
    try {
      const mod = await import(g.module)
      await g.invoke(mod, root)
    } catch (err) {
      roots.set(`${g.name}:error`, String(err))
    }
    roots.set(g.name, root)
  }
}, 120_000)

afterAll(() => {
  spawnSync('chflags', ['-R', 'nouchg', home])
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    // A leftover temp dir is not worth failing a run over.
  }
})

interface RunResult { status: number; stderr: string }

/** Async spawn, never spawnSync: see the note in generatedGateBehaviour.test.ts. */
function runGate(g: GateEntry, tool: string, snapshot: string): Promise<RunResult> {
  const root = roots.get(g.name)!
  return new Promise((resolve, reject) => {
    const child = spawn(g.runner, [join(root, g.artifact)], {
      env: { ...process.env, HOME: root, USERPROFILE: root, INTUTIC_SNAPSHOT_RULES: snapshot },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d: string) => { stderr += d })
    child.stdout.resume()
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ status: code === null ? -1 : code, stderr })
    })
    child.stdin.end(JSON.stringify({ tool_name: tool, tool_input: {}, session_id: 'sess_reg' }))
  })
}

async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!)
  }))
}

describe('the shared MCP registry vectors through the emitted gates', () => {
  it('has a node gate and a bash gate to run', () => {
    expect(gates.map((g) => g.runner).sort()).toEqual(['bash', 'node'])
  })

  for (const g of gates) {
    it(`${g.name} (${g.runner}): reaches every vector's decision, with the proxy's reason and rule`, async () => {
      expect(roots.get(`${g.name}:error`), `the ${g.name} writer failed`).toBeUndefined()
      await mapLimit(VECTORS.cases, 4, async (c) => {
        const r = await runGate(g, c.toolName, registrySnapshots.get(c.registry)!)
        const label = `${g.name}: ${c.name}`
        if (c.code === null) {
          expect(r.status, `${label}: expected an allow.\nstderr: ${r.stderr.slice(0, 400)}`).toBe(0)
        } else {
          expect(r.status, `${label}: expected a refusal.\nstderr: ${r.stderr.slice(0, 400)}`).toBe(2)
          expect(r.stderr, `${label}: the refusal did not carry the proxy's reason and rule`).toContain(`${c.reason} [${c.ruleId}]`)
        }
      })
    }, 180_000)

    it(`${g.name} (${g.runner}): reaches every allowlist vector's decision, with its reason and rule`, async () => {
      expect(roots.get(`${g.name}:error`), `the ${g.name} writer failed`).toBeUndefined()
      await mapLimit(VECTORS.allowlistCases, 4, async (c) => {
        const r = await runGate(g, c.toolName, allowlistSnapshots.get(c.allowlist)!)
        const label = `${g.name}: ${c.name}`
        if (c.code === null) {
          expect(r.status, `${label}: expected an allow.\nstderr: ${r.stderr.slice(0, 400)}`).toBe(0)
        } else {
          expect(r.status, `${label}: expected a refusal.\nstderr: ${r.stderr.slice(0, 400)}`).toBe(2)
          expect(r.stderr, `${label}: the refusal did not carry the reason and rule`).toContain(`${c.reason} [${c.ruleId}]`)
        }
      })
    }, 180_000)

    it(`${g.name} (${g.runner}): leaves a tool that is not an MCP tool alone under deny`, async () => {
      expect((await runGate(g, 'Read', registrySnapshots.get('denyNothingApproved')!)).status).toBe(0)
    }, 30_000)
  }
})

describe('an approval written into the snapshot', () => {
  for (const g of gates) {
    it(`${g.name} (${g.runner}): fails the digest, clears nothing, and keeps the registry's refusals`, async () => {
      const added = await runGate(g, 'mcp__newcomer__query', tampered)
      expect(added.status, `the edit approved a server.\nstderr: ${added.stderr.slice(0, 400)}`).toBe(2)
      expect(added.stderr).toContain('[mcpDefaultPolicy]')
      // An approval the control plane made does not survive an invalid file
      // either: unknown is never approved.
      expect((await runGate(g, 'mcp__github__create_issue', tampered)).status).toBe(2)
      expect((await runGate(g, 'mcp__pastebin__paste', tampered)).stderr).toContain('[mcp_registry.pastebin]')
      // The SOP rule beside it is gone, which is how we know the gate read the
      // snapshot as invalid rather than missing the edit.
      expect((await runGate(g, 'Write', tampered)).status).toBe(0)
    }, 60_000)
  }
})

describe('a server added to the allowlist in the snapshot', () => {
  for (const g of gates) {
    it(`${g.name} (${g.runner}): fails the digest, admits nothing, and keeps the allowlist`, async () => {
      const added = await runGate(g, 'mcp__newcomer__query', tamperedAllowlist)
      expect(added.status, `the edit widened the allowlist.\nstderr: ${added.stderr.slice(0, 400)}`).toBe(2)
      expect(added.stderr).toContain('[mcp_allowlist]')
      expect((await runGate(g, 'mcp__github__create_issue', tamperedAllowlist)).status).toBe(2)
      expect((await runGate(g, 'Write', tamperedAllowlist)).status).toBe(0)
    }, 60_000)
  }
})
