/**
 * SSO-group policy in the policy snapshot, end to end through the emitted
 * gates.
 *
 * The daemon decides the workspace's `sso_group_policy` for the member its key
 * resolves to (`principal` on `GET /api/v1/policy/resolve`), with the
 * evaluator the control plane's hook gate runs, and compiles the refusals into
 * `sso_group.*` block rules. The policy and the member's groups ride beside
 * them as an `@sso_groups` record inside the digest.
 *
 * The conformance half runs `sso-group-clearance-vectors.json` — the cases the
 * control plane, the MCP proxy, @intutic/gate and intutic-clawde also run —
 * through one node gate and one bash gate, each case with a snapshot written
 * by the real `writePolicySnapshot`. The tamper half edits the member's groups
 * in a written snapshot and checks the edit buys nothing.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { decodeSsoGroupRecord, encodeSsoGroupRecord, parseSsoGroupPolicy, SSO_GROUP_RECORD_TAG } from '@intutic/shared-types'
import { GATES, type GateEntry, rerunOnDeadline } from './gateRegistry.js'
import {
  buildSnapshotRules,
  fetchResolvedPolicy,
  refreshPolicySnapshot,
  writePolicySnapshot,
  SNAPSHOT_JSON,
  SNAPSHOT_RULES,
  type ResolvedPolicy,
} from '../../src/lib/policySnapshot.js'

interface Vectors {
  policies: Record<string, unknown>
  cases: Array<{ name: string; policy: string; memberGroups: string[] | null; toolName: string; clearance: string; ruleId: string | null }>
}
const VECTORS: Vectors = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../../packages/shared-types/fixtures/sso-group-clearance-vectors.json'), 'utf8'),
)

const STANDARD = { highRiskTools: ['Bash', 'database_write'], requiredGroups: ['sre-oncall'], requireOboFor: ['deploy_prod'] }

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

const member = (ssoGroups: string[]) => ({ memberId: 'mem_1', ssoGroups })

afterEach(() => vi.restoreAllMocks())

describe('fetchResolvedPolicy — the SSO group policy and the principal', () => {
  it('reads ssoGroupPolicy with the server parser and the principal the control plane resolved', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        workspaceId: 'ws_1', sopRules: [], interventionMode: 'TRANSPARENT',
        ssoGroupPolicy: { highRiskTools: ['Bash', 7], requiredGroups: ['sre'] },
        principal: { memberId: 'mem_1', email: 'dev@example.com', role: 'DEVELOPER', ssoGroups: ['sre', null] },
      }),
    })) as unknown as typeof fetch)
    const p = await fetchResolvedPolicy({ controlPlaneUrl: 'https://cp.example', apiKey: 'k', workspaceId: 'ws_1' })
    expect(p?.ssoGroupPolicy).toEqual({ highRiskTools: ['Bash'], requiredGroups: ['sre'], requireOboFor: [] })
    expect(p?.principal).toEqual({ memberId: 'mem_1', ssoGroups: ['sre'] })
  })

  it('reads an older control plane, with neither field, as no policy and no member', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ workspaceId: 'ws_1', sopRules: [], interventionMode: 'TRANSPARENT' }),
    })) as unknown as typeof fetch)
    const p = await fetchResolvedPolicy({ controlPlaneUrl: 'https://cp.example', apiKey: 'k', workspaceId: 'ws_1' })
    expect(p?.ssoGroupPolicy).toBeNull()
    expect(p?.principal).toBeNull()
  })
})

describe('buildSnapshotRules — SSO group refusals', () => {
  it('compiles one block rule per tool the member may not call, first, and nothing for a cleared tool', () => {
    const rules = buildSnapshotRules(policy({
      ssoGroupPolicy: STANDARD,
      principal: member(['eng']),
      sopRules: [{ id: 's1', toolPattern: 'Edit', action: 'require_approval', reason: 'ask' }],
    }))
    expect(rules.slice(0, 3).map((r) => [r.id, r.severity, r.subject, r.source])).toEqual([
      ['sso_group.require_obo.deploy_prod', 'block', 'tool', ' (deploy_prod|mcp__.+__deploy_prod) '],
      ['sso_group.high_risk.Bash', 'block', 'tool', ' (Bash|mcp__.+__Bash) '],
      ['sso_group.high_risk.database_write', 'block', 'tool', ' (database_write|mcp__.+__database_write) '],
    ])
    expect(rules[3]!.id).toBe('sop.s1')
    expect(rules[1]!.reason).toBe('SSO group policy: Bash requires one of the SSO groups sre-oncall, and this member holds none of them')

    const cleared = buildSnapshotRules(policy({ ssoGroupPolicy: STANDARD, principal: member(['sre-oncall']) }))
    expect(cleared.filter((r) => r.id.startsWith('sso_group.')).map((r) => r.id)).toEqual(['sso_group.require_obo.deploy_prod'])
  })

  it('refuses every high-risk tool when the control plane named no member', () => {
    const rules = buildSnapshotRules(policy({ ssoGroupPolicy: STANDARD, principal: null }))
    expect(rules.filter((r) => r.id.startsWith('sso_group.high_risk.')).map((r) => r.reason)).toEqual([
      "SSO group policy: Bash requires one of the SSO groups sre-oncall, and this gate does not know the member's groups",
      "SSO group policy: database_write requires one of the SSO groups sre-oncall, and this gate does not know the member's groups",
    ])
  })

  it('stays a block under SILENT_LOG, as on the hook gate and the MCP proxy', () => {
    const rules = buildSnapshotRules(policy({ interventionMode: 'SILENT_LOG', ssoGroupPolicy: STANDARD, principal: member([]) }))
    expect(rules.filter((r) => r.id.startsWith('sso_group.')).every((r) => r.severity === 'block')).toBe(true)
  })

  it('escapes a tool name to a literal and leaves a workspace without a policy untouched', () => {
    const [dot] = buildSnapshotRules(policy({ ssoGroupPolicy: { highRiskTools: ['db.query'], requiredGroups: [], requireOboFor: [] }, principal: member([]) }))
    expect(dot!.source).toBe(' (db\\.query|mcp__.+__db\\.query) ')
    expect(new RegExp(dot!.source).test(' dbXquery ')).toBe(false)
    expect(new RegExp(dot!.source).test(' mcp__pg__dbXquery ')).toBe(false)
    expect(buildSnapshotRules(policy({ ssoGroupPolicy: null, principal: member([]) }))).toEqual(buildSnapshotRules(policy()))
  })
})

describe("buildSnapshotRules — an MCP tool's two names", () => {
  it('matches a harness-form entry on its own server only, and an MCP tool by its own name on any server', () => {
    const rules = buildSnapshotRules(policy({
      ssoGroupPolicy: { highRiskTools: ['run_query', 'mcp__github__delete_repo'], requiredGroups: ['dba'], requireOboFor: [] },
      principal: member([]),
    })).filter((r) => r.id.startsWith('sso_group.'))
    // The harness-form entry first: the evaluator prefers an exact entry.
    expect(rules.map((r) => [r.id, r.source])).toEqual([
      ['sso_group.high_risk.mcp__github__delete_repo', ' (mcp__github__delete_repo) '],
      ['sso_group.high_risk.run_query', ' (run_query|mcp__.+__run_query) '],
    ])
  })

  it('compiles no second rule for an entry another entry already refuses', () => {
    const rules = buildSnapshotRules(policy({
      ssoGroupPolicy: { highRiskTools: ['mcp__pg__drop'], requiredGroups: [], requireOboFor: ['drop'] },
      principal: member([]),
    })).filter((r) => r.id.startsWith('sso_group.'))
    expect(rules.map((r) => r.id)).toEqual(['sso_group.require_obo.drop'])
  })
})

describe('writePolicySnapshot — the @sso_groups record', () => {
  it('writes the record as the first data line, inside the digest, and the same record in the JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'intutic-sso-snap-'))
    try {
      const { digest } = await writePolicySnapshot(policy({ ssoGroupPolicy: STANDARD, principal: member(['eng']) }), dir)
      const lines = readFileSync(join(dir, SNAPSHOT_RULES), 'utf8').split('\n').filter((l) => l && !l.startsWith('#'))
      expect(lines[0]!.startsWith(`${SSO_GROUP_RECORD_TAG}\t`)).toBe(true)
      expect(createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 32)).toBe(digest)
      const record = decodeSsoGroupRecord(lines[0]!)
      expect(record).toMatchObject({ policy: STANDARD, member: { memberId: 'mem_1', ssoGroups: ['eng'] } })
      const doc = JSON.parse(readFileSync(join(dir, SNAPSHOT_JSON), 'utf8'))
      expect(doc.ssoGroups).toEqual(record)
      expect(doc.ssoGroups.issuedAt).toBe(doc.generatedAt)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('writes no record for a workspace without a policy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'intutic-sso-snap-none-'))
    try {
      await writePolicySnapshot(policy({ principal: member(['eng']) }), dir)
      expect(readFileSync(join(dir, SNAPSHOT_RULES), 'utf8')).not.toContain(SSO_GROUP_RECORD_TAG)
      expect(JSON.parse(readFileSync(join(dir, SNAPSHOT_JSON), 'utf8'))).not.toHaveProperty('ssoGroups')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('refreshPolicySnapshot — a refused key', () => {
  const resolveWith = (status: number, body: unknown = {}) =>
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: status === 200, status, json: async () => body })) as unknown as typeof fetch)
  const opts = (snapshotDir: string) => ({ controlPlaneUrl: 'https://cp.example', apiKey: 'k', workspaceId: 'ws_test', snapshotDir })
  const ids = (dir: string) => readFileSync(join(dir, SNAPSHOT_RULES), 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split('\t')[0])

  it("forgets the member's groups on a 401 or 403 and keeps every other rule", async () => {
    for (const status of [401, 403]) {
      const dir = mkdtempSync(join(tmpdir(), 'intutic-sso-refused-'))
      try {
        resolveWith(200, {
          workspaceId: 'ws_test', interventionMode: 'TRANSPARENT', sqlDropStrictBlock: true,
          sopRules: [{ id: 's1', toolPattern: 'Write', action: 'block', reason: 'no writes' }],
          ssoGroupPolicy: STANDARD, principal: { memberId: 'mem_1', ssoGroups: ['sre-oncall'] },
        })
        await refreshPolicySnapshot(opts(dir))
        const before = ids(dir)
        expect(before).not.toContain('sso_group.high_risk.Bash')

        resolveWith(status)
        expect(await refreshPolicySnapshot(opts(dir))).toBeNull()
        const after = ids(dir)
        expect(after).toContain('sso_group.high_risk.Bash')
        expect(after).toContain('sop.s1')
        // The rest of the snapshot is rebuilt as it was, the sql_drop promotion included.
        expect(after.filter((id) => !id!.startsWith('sso_group.') && id !== SSO_GROUP_RECORD_TAG))
          .toEqual(before.filter((id) => !id!.startsWith('sso_group.') && id !== SSO_GROUP_RECORD_TAG))
        const doc = JSON.parse(readFileSync(join(dir, SNAPSHOT_JSON), 'utf8'))
        expect(doc.ssoGroups.member).toBeNull()
        expect(doc.rules.find((r: { id: string }) => r.id === 'destructive.sql_drop').severity).toBe('block')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  it('leaves the snapshot alone on any other failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'intutic-sso-down-'))
    try {
      resolveWith(200, { workspaceId: 'ws_test', interventionMode: 'TRANSPARENT', sopRules: [], ssoGroupPolicy: STANDARD, principal: { memberId: 'mem_1', ssoGroups: ['sre-oncall'] } })
      await refreshPolicySnapshot(opts(dir))
      const before = readFileSync(join(dir, SNAPSHOT_RULES), 'utf8')
      resolveWith(503)
      expect(await refreshPolicySnapshot(opts(dir))).toBeNull()
      expect(readFileSync(join(dir, SNAPSHOT_RULES), 'utf8')).toBe(before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ─── Through the emitted gates ──────────────────────────────────────────────

/** One node gate and one bash gate — the two evaluators of the shared gate body. */
const CHOSEN = ['claudeCode', 'openhands'] as const
const gates = CHOSEN.map((n) => GATES.find((g) => g.name === n)).filter((g): g is GateEntry => g !== undefined)

const home = mkdtempSync(join(tmpdir(), 'intutic-sso-gates-'))
const roots = new Map<string, string>()
/** One snapshot per vector case, index-aligned with `VECTORS.cases`. */
const caseSnapshots: string[] = []
let tampered = ''
let pristine = ''

beforeAll(async () => {
  for (const [i, c] of VECTORS.cases.entries()) {
    const dir = join(home, `case-${i}`)
    await writePolicySnapshot(policy({
      ssoGroupPolicy: parseSsoGroupPolicy(VECTORS.policies[c.policy]),
      principal: c.memberGroups === null ? null : member(c.memberGroups),
    }), dir)
    caseSnapshots.push(join(dir, SNAPSHOT_RULES))
  }

  // A member outside sre-oncall, with a BLOCK: SOP rule on Write beside the
  // group refusals — then their group list edited to include sre-oncall.
  const dir = join(home, 'tampered')
  await writePolicySnapshot(policy({
    ssoGroupPolicy: STANDARD,
    principal: member(['eng']),
    sopRules: [{ id: 's_write', toolPattern: 'Write', action: 'block', reason: 'no writes' }],
  }), dir)
  tampered = join(dir, SNAPSHOT_RULES)
  const text = readFileSync(tampered, 'utf8')
  const recordLine = text.split('\n').find((l) => l.startsWith(`${SSO_GROUP_RECORD_TAG}\t`))!
  const record = decodeSsoGroupRecord(recordLine)!
  const edited = encodeSsoGroupRecord({ ...record, member: { memberId: 'mem_1', ssoGroups: ['eng', 'sre-oncall'] } })
  pristine = join(dir, 'pristine.rules')
  writeFileSync(pristine, text)
  chmodSync(tampered, 0o644)
  writeFileSync(tampered, text.replace(recordLine, edited))

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

interface RunResult { status: number; stderr: string; signal: NodeJS.Signals | null }

/** Async spawn, never spawnSync: see the note in generatedGateBehaviour.test.ts. */
function runGate(g: GateEntry, tool: string, snapshot: string): Promise<RunResult> {
  const root = roots.get(g.name)!
  return rerunOnDeadline(() => new Promise((resolve, reject) => {
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
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ status: code === null ? -1 : code, stderr, signal })
    })
    child.stdin.end(JSON.stringify({ tool_name: tool, tool_input: {}, session_id: 'sess_sso' }))
  }), (r) => r.stderr)
}

async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!)
  }))
}

describe('the shared SSO-group vectors through the emitted gates', () => {
  it('has a node gate and a bash gate to run', () => {
    expect(gates.map((g) => g.runner).sort()).toEqual(['bash', 'node'])
    expect(caseSnapshots).toHaveLength(VECTORS.cases.length)
  })

  for (const g of gates) {
    it(`${g.name} (${g.runner}): reaches every vector's clearance, naming the rule on a refusal`, async () => {
      expect(roots.get(`${g.name}:error`), `the ${g.name} writer failed`).toBeUndefined()
      await mapLimit([...VECTORS.cases.entries()], 4, async ([i, c]) => {
        const r = await runGate(g, c.toolName, caseSnapshots[i]!)
        const label = `${g.name}: ${c.name}`
        expect([0, 2], `${label} exited ${r.status}.\nstderr: ${r.stderr.slice(0, 400)}`).toContain(r.status)
        if (c.clearance === 'GRANTED') {
          expect(r.status, `${label}: expected an allow.\nstderr: ${r.stderr.slice(0, 400)}`).toBe(0)
          expect(r.stderr).not.toContain('[sso_group.')
        } else {
          expect(r.status, `${label}: expected a refusal.\nstderr: ${r.stderr.slice(0, 400)}`).toBe(2)
          expect(r.stderr, `${label}: the refusal did not name the rule`).toContain(`[${c.ruleId}]`)
        }
      })
    }, 180_000)
  }
})

describe('an edited group list in the snapshot', () => {
  for (const g of gates) {
    it(`${g.name} (${g.runner}): fails the digest, keeps the group refusals and drops the rest of the dynamic tier`, async () => {
      // Before the edit: Bash refused by group, Write by the SOP rule.
      expect((await runGate(g, 'Bash', pristine)).status).toBe(2)
      expect((await runGate(g, 'Write', pristine)).status).toBe(2)

      const bash = await runGate(g, 'Bash', tampered)
      expect(bash.status, `the edit cleared Bash.\nstderr: ${bash.stderr.slice(0, 400)}`).toBe(2)
      expect(bash.stderr).toContain('[sso_group.high_risk.Bash]')
      // The SOP rule beside it is gone, which is how we know the gate read the
      // snapshot as invalid rather than missing the edit.
      const write = await runGate(g, 'Write', tampered)
      expect(write.status, `the SOP rule survived an invalid snapshot.\nstderr: ${write.stderr.slice(0, 400)}`).toBe(0)
    }, 60_000)
  }
})
