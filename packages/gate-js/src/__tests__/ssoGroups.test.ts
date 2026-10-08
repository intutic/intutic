/**
 * The gate-js half of the SSO-group conformance suite.
 *
 * `packages/shared-types/fixtures/sso-group-clearance-vectors.json` is run by
 * the control plane's `resolveSsoGroupPrivilege`, the MCP proxy, the emitted
 * harness gates and intutic-clawde. This runs it through this package's port
 * of the evaluator, and then through `Gate.guard` reading a real policy
 * snapshot file, which is how the port is reached in production.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { IntuticGateRefusal } from '../errors.js'
import { Gate } from '../gate.js'
import { loadSnapshot } from '../snapshot.js'
import { evaluateSsoGroupClearance, parseSsoGroupPolicy } from '../ssoGroups.js'

interface Vectors {
  policies: Record<string, unknown>
  cases: Array<{ name: string; policy: string; memberGroups: string[] | null; toolName: string; clearance: string; ruleId: string | null }>
}

const VECTORS: Vectors = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../shared-types/fixtures/sso-group-clearance-vectors.json'), 'utf8'),
)

const dir = mkdtempSync(join(tmpdir(), 'intutic-gate-sso-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** The `@sso_groups` line exactly as the sync daemon writes it. */
function recordLine(policy: unknown, memberGroups: string[] | null): string {
  const record = {
    policy,
    member: memberGroups === null ? null : { memberId: 'mem_1', ssoGroups: memberGroups },
    issuedAt: '2026-10-08T00:00:00.000Z',
  }
  return `@sso_groups\t${Buffer.from(JSON.stringify(record), 'utf8').toString('base64')}`
}

let n = 0
/** A snapshot file whose digest covers `body`, unless `digestOf` says otherwise. */
function snapshotFile(body: string[], digestOf: string[] = body): string {
  const digest = createHash('sha256').update(digestOf.join('\n')).digest('hex').slice(0, 32)
  const path = join(dir, `snap-${n++}.rules`)
  writeFileSync(path, `#digest ${digest}\n#workspace ws_test\n#generated ${new Date().toISOString()}\n${body.join('\n')}\n`)
  return path
}

async function guard(snapshot: string, tool: string): Promise<IntuticGateRefusal | null> {
  const previous = process.env.INTUTIC_SNAPSHOT_RULES
  process.env.INTUTIC_SNAPSHOT_RULES = snapshot
  try {
    await new Gate({ workspaceId: 'ws_test', useHookGate: false, useSopRules: false }, null).guard(tool, {})
    return null
  } catch (err) {
    if (err instanceof IntuticGateRefusal) return err
    throw err
  } finally {
    if (previous === undefined) delete process.env.INTUTIC_SNAPSHOT_RULES
    else process.env.INTUTIC_SNAPSHOT_RULES = previous
  }
}

describe('the shared SSO-group vectors', () => {
  it('reads a non-empty vector file', () => {
    expect(VECTORS.cases.length).toBeGreaterThanOrEqual(20)
  })

  for (const c of VECTORS.cases) {
    it(`evaluator: ${c.name}`, () => {
      const d = evaluateSsoGroupClearance(parseSsoGroupPolicy(VECTORS.policies[c.policy]), c.toolName, c.memberGroups)
      expect(d.clearance).toBe(c.clearance)
      expect(d.ruleId).toBe(c.ruleId)
    })

    it(`Gate.guard over a snapshot: ${c.name}`, async () => {
      const policy = VECTORS.policies[c.policy]
      // No policy is no record, which is what the daemon writes for it.
      const body = policy === null ? [] : [recordLine(policy, c.memberGroups)]
      const refusal = await guard(snapshotFile(body), c.toolName)
      if (c.clearance === 'GRANTED') {
        expect(refusal, refusal?.reason).toBeNull()
      } else {
        expect(refusal?.code).toBe('SSO_GROUP')
        expect(refusal?.reason.endsWith(`[${c.ruleId}]`)).toBe(true)
      }
    })
  }
})

describe('an edited snapshot', () => {
  const policy = { highRiskTools: ['Bash'], requiredGroups: ['sre-oncall'], requireOboFor: [] }

  it('fails the digest when the group list is edited, and the edit clears nothing', async () => {
    const original = recordLine(policy, ['eng'])
    const edited = recordLine(policy, ['eng', 'sre-oncall'])
    const path = snapshotFile([edited], [original])

    const snap = loadSnapshot('ws_test', path)
    expect(snap.state).toBe('invalid')
    expect(snap.ssoGroups?.member).toBeNull()

    const refusal = await guard(path, 'Bash')
    expect(refusal?.reason).toBe(
      "SSO group policy: Bash requires one of the SSO groups sre-oncall, and this gate does not know the member's groups [sso_group.high_risk.Bash]",
    )
  })

  it('refuses even a member the policy cleared once the snapshot fails its check', async () => {
    const cleared = recordLine(policy, ['sre-oncall'])
    expect(await guard(snapshotFile([cleared]), 'Bash')).toBeNull()
    expect(await guard(snapshotFile([cleared], ['something else']), 'Bash')).not.toBeNull()
  })

  it('is not disarmed by INTUTIC_GUARD_DISABLE', async () => {
    process.env.INTUTIC_GUARD_DISABLE = '1'
    try {
      expect(await guard(snapshotFile([recordLine(policy, ['eng'])]), 'Bash')).not.toBeNull()
    } finally {
      delete process.env.INTUTIC_GUARD_DISABLE
    }
  })
})
