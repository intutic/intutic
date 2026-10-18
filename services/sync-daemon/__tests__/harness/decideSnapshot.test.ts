/**
 * Decide rules in the policy snapshot (format 2): the writer's line
 * order and digest, the stamp each rule gets, the fallback lines, and the
 * local SOPs' rules. The gates' side is in `generatedGateBehaviour.test.ts`
 * (v22 cases) and `decideOldGate.test.ts` (a 2.9.0 gate on this snapshot).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import {
  decideRuleHash,
  decodeDecideRecord,
  validateDecideRule,
  type DecideRecord,
} from '@intutic/shared-types'
import {
  buildSnapshotRules,
  localDecideRules,
  refreshPolicySnapshot,
  snapshotRulesVerify,
  writeLocalPolicySnapshot,
  writePolicySnapshot,
  SNAPSHOT_JSON,
  SNAPSHOT_RULES,
  type ResolvedPolicy,
  type ServedDecideRule,
} from '../../src/lib/policySnapshot.js'
import { GATE_VERSION } from '../../src/harness/gateBody.js'

const VECTORS = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../../packages/shared-types/fixtures/decide-vectors.json'), 'utf8'),
) as { record: { valid: Array<{ name: string; line: string; record: DecideRecord }> } }

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const check = (ir: unknown) => {
  const v = validateDecideRule(ir)
  return v.ok ? decideRuleHash(v.rule, sha256) : null
}

const RULE = {
  id: 'prod-data-export',
  on: 'tool_call',
  tools: ['Bash'],
  questions: { exports: { type: 'yes_no', ask: 'Does this command copy customer data out of the production database?' } },
  when: 'exports',
  rollout: 'enforce',
}
const PIN = { modelDigest: 'sha256:5f1c0e2a9b7d', evalRunId: 'eval_local_01', source: 'local' as const }

function served(over: Partial<ServedDecideRule> & { rule?: Record<string, unknown> } = {}): ServedDecideRule {
  const { rule, ...rest } = over
  return { sopId: 'sop_1', sopTitle: 'Production data handling', ruleText: 'Customer data stays in production.', ir: rule ?? RULE, pins: [PIN], ...rest }
}

function policy(over: Partial<ResolvedPolicy> = {}): ResolvedPolicy {
  return { workspaceId: 'ws_test', interventionMode: 'TRANSPARENT', sopRules: [], mcpAllowedServers: [], sqlDropStrictBlock: false, ...over }
}

const dirs: string[] = []
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'intutic-decide-snap-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const dataLines = (dir: string) => readFileSync(join(dir, SNAPSHOT_RULES), 'utf8').split('\n').filter((l) => l && !l.startsWith('#'))
const records = (dir: string) => dataLines(dir).filter((l) => l.startsWith('@decide\t')).map((l) => decodeDecideRecord(l, check))

describe('writePolicySnapshot — decide lines', () => {
  it('writes the records after the other records and the fallback lines right after the SSO-group rules, all inside the digest', async () => {
    const dir = tempDir()
    await writePolicySnapshot(
      policy({
        interventionMode: 'OPAQUE',
        sopRules: [{ id: 's1', toolPattern: 'Write', action: 'block', reason: 'no writes' }],
        mcpAllowedServers: ['github'],
        mcpRegistry: { defaultPolicy: 'deny', approvedServers: ['github'], blockedServers: [], heldServers: [], disabledTools: {} },
        ssoGroupPolicy: { highRiskTools: ['Write'], requiredGroups: ['sre'], requireOboFor: [] },
        principal: null,
        decideRules: [
          served({ sopId: 'sop_a', rule: { ...RULE, id: 'first' } }),
          served({ sopId: 'sop_a', rule: { ...RULE, id: 'second', rollout: 'shadow' } }),
          served({ sopId: 'sop_b', rule: { ...RULE, id: 'third', tools: ['mcp__pg__query', 'Bash'] } }),
        ],
      }),
      dir,
    )
    const lines = dataLines(dir)
    const ids = lines.map((l) => l.split('\t')[0]!)
    const fb = (rule: string, sop: string) => `decide-fallback:${rule}@${sha256(sop).slice(0, 12)}`
    expect(ids.slice(0, 8)).toEqual(['@format', '@intervention_mode', '@sso_groups', '@mcp_registry', '@mcp_allowlist', '@decide', '@decide', '@decide'])
    expect(lines[0]).toBe('@format\t2')
    expect(records(dir).map((r) => r?.ref)).toEqual(['sop_a#first', 'sop_a#second', 'sop_b#third'])
    expect(ids.slice(8, 11)).toEqual(['sso_group.high_risk.Write', fb('first', 'sop_a'), fb('third', 'sop_b')])
    expect(ids[11]).toBe('sop.s1')
    expect(lines.find((l) => l.startsWith(fb('third', 'sop_b')))).toBe(
      `${fb('third', 'sop_b')}\tblock\t-\ttool\tDecide rule third (Production data handling): upgrade to Intutic 3.0 to evaluate this rule\t (Bash|mcp__pg__query) `,
    )

    const text = readFileSync(join(dir, SNAPSHOT_RULES), 'utf8')
    expect(text).toContain(`#digest ${sha256(lines.join('\n')).slice(0, 32)}\n`)
    expect(snapshotRulesVerify(text)).toBe(true)
    // An edited record fails the digest, as any data line does.
    expect(snapshotRulesVerify(text.replace('\tsop_a#first', '\tsop_a#firsts').replace(/(@decide\t[^\t]*\t)enforce/, '$1shadow'))).toBe(false)

    const doc = JSON.parse(readFileSync(join(dir, SNAPSHOT_JSON), 'utf8'))
    expect(doc.version).toBe(2)
    expect(doc.gateVersion).toBe(GATE_VERSION)
    expect(doc.decideRules.map((r: ServedDecideRule) => r.sopId)).toEqual(['sop_a', 'sop_a', 'sop_b'])
  })

  it('writes nothing new for a workspace with no decide rule', async () => {
    const [a, b] = [tempDir(), tempDir()]
    await writePolicySnapshot(policy(), a)
    await writePolicySnapshot(policy({ decideRules: [] }), b)
    const strip = (d: string) => readFileSync(join(d, SNAPSHOT_RULES), 'utf8').replace(/#generated .*\n/, '')
    expect(strip(b)).toBe(strip(a))
    expect(strip(a)).not.toMatch(/^@format|^@decide|decide-fallback:/m)
    expect(JSON.parse(readFileSync(join(a, SNAPSHOT_JSON), 'utf8')).version).toBe(1)
  })

  it('stamps a rule enforce only with its own rollout, a pin, no server shadow and no SILENT_LOG', async () => {
    const stamp = async (p: ResolvedPolicy) => {
      const dir = tempDir()
      await writePolicySnapshot(p, dir)
      const [r] = records(dir)
      return { rollout: r!.rollout, stampedBy: r!.stampedBy, fallback: r!.fallbackId !== null, lines: dataLines(dir).filter((l) => l.startsWith('decide-fallback:')).length }
    }
    expect(await stamp(policy({ decideRules: [served()] }))).toEqual({ rollout: 'enforce', stampedBy: 'rule', fallback: true, lines: 1 })
    expect(await stamp(policy({ decideRules: [served({ rule: { ...RULE, rollout: 'shadow' } })] }))).toEqual({ rollout: 'shadow', stampedBy: 'rule', fallback: false, lines: 0 })
    expect(await stamp(policy({ decideRules: [served({ rule: { ...RULE, rollout: undefined } })] }))).toEqual({ rollout: 'shadow', stampedBy: 'rule', fallback: false, lines: 0 })
    expect(await stamp(policy({ decideRules: [served({ rollout: 'shadow' })] }))).toEqual({ rollout: 'shadow', stampedBy: 'server-shadow', fallback: false, lines: 0 })
    expect(await stamp(policy({ interventionMode: 'SILENT_LOG', decideRules: [served()] }))).toEqual({ rollout: 'shadow', stampedBy: 'silent-log', fallback: false, lines: 0 })
    expect(await stamp(policy({ decideRules: [served({ pins: [] })] }))).toEqual({ rollout: 'shadow', stampedBy: 'no-pins', fallback: false, lines: 0 })
    // Pins earned by another rule (the server hashed something else) do not apply.
    expect(await stamp(policy({ decideRules: [served({ ruleHash: '0'.repeat(64) })] }))).toEqual({ rollout: 'shadow', stampedBy: 'no-pins', fallback: false, lines: 0 })
    expect(await stamp(policy({ decideRules: [served({ ruleHash: check(RULE)! })] }))).toEqual({ rollout: 'enforce', stampedBy: 'rule', fallback: true, lines: 1 })
  })

  it('refuses the tools of a line it cannot read, every tool when it names none, and writes no record for it', () => {
    const hash = sha256('sop_1').slice(0, 12)
    const rules = buildSnapshotRules(
      policy({
        decideRules: [
          served({ rule: { ...RULE, id: 'half-written', when: 'exports AND' } }),
          served({ ir: 'not json at all' }),
          served(),
          served({ rule: { ...RULE, rollout: 'shadow' } }),
        ],
      }),
    ).filter((r) => r.id.startsWith('decide-fallback:'))
    expect(rules.map((r) => [r.id, r.source, r.severity])).toEqual([
      [`decide-fallback:unreadable.1@${hash}`, ' (Bash) ', 'block'],
      [`decide-fallback:unreadable.2@${hash}`, ' [^ ]+ ', 'block'],
      [`decide-fallback:prod-data-export@${hash}`, ' (Bash) ', 'block'],
      // The same id twice in one SOP: the second line is unreadable.
      [`decide-fallback:unreadable.4@${hash}`, ' (Bash) ', 'block'],
    ])
    expect(rules[0]!.reason).toBe(
      'Decide rule half-written (Production data handling) does not read, so the calls it covers are refused: decide: when: expected a question name, NOT or ( at column 12',
    )
    expect(rules[1]!.reason).toContain('Decide rule on decide line 2 (Production data handling) does not read')
    // Observe-only: the line is recorded, not enforced.
    const silent = buildSnapshotRules(policy({ interventionMode: 'SILENT_LOG', decideRules: [served({ ir: '' })] }))
    expect(silent.find((r) => r.id.startsWith('decide-fallback:'))!.severity).toBe('shadow')
  })

  it("leaves a response rule to the gateway: no record and no fallback line", async () => {
    const dir = tempDir()
    const response = { ...RULE, on: 'response', tools: undefined }
    await writePolicySnapshot(policy({ decideRules: [served({ rule: response })] }), dir)
    expect(dataLines(dir).some((l) => l.startsWith('@decide\t') || l.startsWith('decide-fallback:'))).toBe(false)
  })

  it('reads decideRules off the resolve response, and keeps them when it forgets the member', async () => {
    const dir = tempDir()
    const opts = { controlPlaneUrl: 'https://cp.example', apiKey: 'k', workspaceId: 'ws_test', snapshotDir: dir }
    const respond = (status: number, body: unknown = {}) =>
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: status === 200, status, json: async () => body })) as unknown as typeof fetch)
    respond(200, {
      workspaceId: 'ws_test', interventionMode: 'TRANSPARENT', sopRules: [],
      ssoGroupPolicy: { highRiskTools: ['Write'], requiredGroups: ['sre'], requireOboFor: [] },
      principal: { memberId: 'mem_1', ssoGroups: ['sre'] },
      decideRules: [{ ...served(), pins: [PIN, { modelDigest: '', evalRunId: 'x', source: 'local' }] }, 'not a rule'],
    })
    await refreshPolicySnapshot(opts)
    const before = dataLines(dir).filter((l) => l.startsWith('@decide\t') || l.startsWith('decide-fallback:'))
    expect(before).toHaveLength(2)
    expect(records(dir)[0]!.pins).toEqual([PIN])

    respond(401)
    await refreshPolicySnapshot(opts)
    expect(dataLines(dir).filter((l) => l.startsWith('@decide\t') || l.startsWith('decide-fallback:'))).toEqual(before)
    expect(dataLines(dir).map((l) => l.split('\t')[0])).toContain('sso_group.high_risk.Write')
  })
})

describe('localDecideRules — the local SOPs', () => {
  const SOP =
    '---\n' +
    'decide: {"id":"prod-data-export","on":"tool_call","tools":["Bash"],"questions":{"exports":{"type":"yes_no","ask":"Does this command copy customer data out of the production database?"},"dest":{"type":"choice","ask":"Where does the data go?","options":["local_file","cloud_bucket","external_host"]}},"when":"exports AND dest != none_of_these","band":{"yes_at":0.85,"no_below":0.15},"escalate":"ask","rollout":"enforce"}\n' +
    '---\n' +
    '# Production data handling\n\n' +
    'Customer data never leaves production except through the approved export job.\n'
  const entry = (content: string) => ({ sopId: 'local:data.md', title: 'Local SOP: data.md', content, contentHash: '', harnessTargets: [] })

  it("writes the LLD's worked example byte for byte, with the pin a decide eval left", async () => {
    const decideDir = tempDir()
    const evals = join(decideDir, 'evals', 'be5cbda58b93cf90e90d1b994c32331b05459aefba564ab9e2d190396a1b3291')
    mkdirSync(evals, { recursive: true })
    writeFileSync(join(evals, 'sha256-5f1c0e2a9b7d.json'), JSON.stringify(PIN))
    writeFileSync(join(evals, 'notes.txt'), 'ignored')
    writeFileSync(join(evals, 'broken.json'), '{')

    const rules = await localDecideRules([entry(SOP)], { decideDir })
    expect(rules).toEqual([expect.objectContaining({ sopId: 'local:data.md', sopTitle: 'Production data handling', pins: [PIN] })])
    const dir = tempDir()
    await writeLocalPolicySnapshot({ snapshotDir: dir, decideRules: rules })
    const lines = dataLines(dir)
    const vector = VECTORS.record.valid.find((c) => c.name.startsWith('the LLD example'))!
    expect(lines.slice(0, 3)).toEqual([
      '@format\t2',
      vector.line,
      'decide-fallback:prod-data-export@6bcd6b021e7d\tblock\t-\ttool\tDecide rule prod-data-export (Production data handling): upgrade to Intutic 3.0 to evaluate this rule\t (Bash) ',
    ])
  })

  it('keys pins by rule hash: one changed word leaves the rule no pins (shadow); a flipped rollout keeps them', async () => {
    const decideDir = tempDir()
    const evals = join(decideDir, 'evals', 'be5cbda58b93cf90e90d1b994c32331b05459aefba564ab9e2d190396a1b3291')
    mkdirSync(evals, { recursive: true })
    writeFileSync(join(evals, 'sha256-5f1c0e2a9b7d.json'), JSON.stringify(PIN))
    const stamp = async (content: string) => {
      const dir = tempDir()
      await writeLocalPolicySnapshot({ snapshotDir: dir, decideRules: await localDecideRules([entry(content)], { decideDir }) })
      const r = records(dir)[0]!
      return { ruleHash: r.ruleHash, rollout: r.rollout, stampedBy: r.stampedBy, pins: r.pins.length }
    }
    const pinned = await stamp(SOP)
    expect(pinned).toEqual({ ruleHash: 'be5cbda58b93cf90e90d1b994c32331b05459aefba564ab9e2d190396a1b3291', rollout: 'enforce', stampedBy: 'rule', pins: 1 })

    const reworded = await stamp(SOP.replace('copy customer data', 'copy customer records'))
    expect(reworded.ruleHash).not.toBe(pinned.ruleHash)
    expect(reworded).toMatchObject({ rollout: 'shadow', stampedBy: 'no-pins', pins: 0 })

    // Shadow to enforce and back: the same hash, so the same evidence.
    const flipped = await stamp(SOP.replace('"rollout":"enforce"', '"rollout":"shadow"'))
    expect(flipped).toEqual({ ...pinned, rollout: 'shadow' })
  })

  it('keeps each line as written, unreadable ones included, and reads no pins for them', async () => {
    const decideDir = tempDir()
    const rules = await localDecideRules(
      [entry('---\ndeny_tools: WebFetch\n  decide: {"id":"x"}\ndecide:\n---\nbody'), entry('no front matter'), { ...entry(SOP), sopId: 'local:ops:deploy.md' }],
      { decideDir },
    )
    expect(rules.map((r) => [r.sopId, r.ir, r.pins])).toEqual([
      ['local:data.md', ' {"id":"x"}', []],
      ['local:data.md', '', []],
      ['local:ops:deploy.md', SOP.split('\n')[1]!.slice('decide:'.length), []],
    ])
    expect(rules[0]!.sopTitle).toBe('Local SOP: data.md')
  })
})
