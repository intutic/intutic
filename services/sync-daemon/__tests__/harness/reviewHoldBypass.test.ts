/**
 * The review hold and its approved bypass, at EVERY gate.
 *
 * Until gate body v8 a `review_before:` hold existed only in the Claude Code
 * hook, baked in at write time; the other harnesses observed a deploy and
 * let it run. The hold is now one branch in the shared gate bodies, driven by
 * a `hold` rule in the policy snapshot, so this file fans out over the
 * registry the way `generatedGateBehaviour.test.ts` does — the same rule, the
 * same bypass file, the same assertions on every harness.
 *
 * What this pins, per gate:
 *  (a) a hold refuses through the harness's own contract, records
 *      `tool_held`, and appends the v1 hold record the daemon drains;
 *  (b) an expired, non-matching or foreign-workspace bypass entry does NOT
 *      let a held call through — it is still held, exactly as before;
 *  (c) a valid, unexpired, EXACT-match entry DOES let it through (the
 *      ordinary allow path) and records `hold_approved_bypass_used`, naming
 *      the original hold and who approved it;
 *  (d) a different command under the same rule gets its own hash and is held.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { GATES, type GateEntry } from './gateRegistry.js'
import { writeApprovedBypasses, type ApprovedBypassEntry } from '../../src/lib/approvedBypasses.js'
import { NORMALISE_CONTRACT } from '../../src/harness/protectedPaths.js'
import { toRulesLine, REVIEW_REQUESTS_LOG } from '../../src/harness/gateBody.js'
import { buildSnapshotRules } from '../../src/lib/policySnapshot.js'

const WORKSPACE_ID = 'ws_test'
/** The local `review_before: action:deploy` token, as the snapshot names it. */
const SOP_RULE_ID = 'sop.local.review_before.action:deploy'
const COMMAND = 'kubectl apply -f x.yaml'
const TARGET = ''
/** The gate's own key material, mirrored: normalised tool name, and
 *  sha256(normalised command, NUL, normalised target). */
const TOOL_NAME_NORMALIZED = NORMALISE_CONTRACT.js('Bash')
const TARGET_HASH = createHash('sha256')
  .update(NORMALISE_CONTRACT.js(COMMAND) + '\u0000' + NORMALISE_CONTRACT.js(TARGET))
  .digest('hex')

interface RunResult { status: number; stdout: string; stderr: string }

/** The gates whose tool-call contract `runGate`/`wasBlocked` can drive. The
 *  python prompt filter, the n8n workflow hook and the OpenCode plugin have
 *  their own drivers in generatedGateBehaviour.test.ts, where their hold
 *  cases live. */
const DRIVABLE = GATES.filter(
  (g) => g.migrated && (g.contract === 'exit2' || g.contract === 'stdout-cancel' || g.contract === 'stdout-decision-deny'),
)

const home = mkdtempSync(join(tmpdir(), 'intutic-hold-'))
const roots = new Map<string, string>()
const snapshot = join(home, 'hold.rules')

function writeRulesFixture(target: string, rules: ReturnType<typeof buildSnapshotRules>): void {
  const lines = rules.map(toRulesLine)
  const digest = createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 32)
  writeFileSync(target, `#digest ${digest}\n#workspace ${WORKSPACE_ID}\n#generated ${new Date().toISOString()}\n${lines.join('\n')}\n`)
}

beforeAll(async () => {
  // Built the way the daemon builds it: the local token becomes a hold rule.
  writeRulesFixture(
    snapshot,
    buildSnapshotRules(
      { workspaceId: WORKSPACE_ID, interventionMode: 'ENFORCE', sopRules: [], mcpAllowedServers: [], sqlDropStrictBlock: false },
      ['action:deploy'],
    ),
  )
  for (const g of DRIVABLE) {
    const root = join(home, g.name)
    mkdirSync(root, { recursive: true })
    roots.set(g.name, root)
    const prevHome = process.env.HOME
    process.env.HOME = root
    process.env.USERPROFILE = root
    try {
      const mod = await import(g.module)
      await g.invoke(mod, root)
    } finally {
      process.env.HOME = prevHome
    }
  }
}, 120_000)

afterAll(() => {
  // The goose writer hardens its plugin files (chflags uchg), which rmSync
  // cannot undo; a leftover temp tree is not a failure of what this file pins.
  try { rmSync(home, { recursive: true, force: true }) } catch { /* hardened files */ }
})

function runGate(g: GateEntry, payload: unknown): Promise<RunResult> {
  const root = roots.get(g.name)!
  return new Promise((resolve, reject) => {
    const child = spawn(g.runner, [join(root, g.artifact)], {
      env: { ...process.env, HOME: root, USERPROFILE: root, INTUTIC_SNAPSHOT_RULES: snapshot },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ status: code === null ? -1 : code, stdout, stderr }) })
    child.stdin.write(JSON.stringify(payload))
    child.stdin.end()
  })
}

function refused(g: GateEntry, r: RunResult): boolean {
  if (g.contract === 'stdout-cancel' || g.contract === 'stdout-decision-deny') {
    for (const line of r.stdout.split('\n')) {
      try {
        const obj = JSON.parse(line)
        if (obj?.cancel === true || obj?.decision === 'deny') return true
      } catch { /* not the verdict line */ }
    }
    return false
  }
  return r.status === 2
}

/** Every audit line under the gate's root — the writers do not agree on the file name. */
function auditLog(g: GateEntry): string {
  const root = roots.get(g.name)!
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (name.endsWith('.jsonl') && name !== 'review-requests.jsonl') out.push(readFileSync(p, 'utf8'))
    }
  }
  walk(root)
  return out.join('\n')
}

function holdLog(g: GateEntry): string {
  const p = join(roots.get(g.name)!, REVIEW_REQUESTS_LOG)
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}

function bypassEntry(overrides: Partial<ApprovedBypassEntry> = {}): ApprovedBypassEntry {
  const now = Date.now()
  return {
    workspaceId: WORKSPACE_ID,
    sopRuleId: SOP_RULE_ID,
    toolNameNormalized: TOOL_NAME_NORMALIZED,
    targetHash: TARGET_HASH,
    holdId: 'hold_original_abc123',
    decidedBy: 'mbr_reviewer',
    decidedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 5 * 60_000).toISOString(), // valid unless overridden
    ...overrides,
  }
}

const payload = { tool_name: 'Bash', tool_input: { command: COMMAND }, session_id: 'sess_test' }

describe('review hold registry coverage', () => {
  it('fans out over every migrated tool-call gate', () => {
    expect(DRIVABLE.map((g) => g.name)).toEqual(
      GATES.filter((g) => g.migrated && !['python-raise', 'js-throw', 'plugin-throw', 'waterfall-reject'].includes(g.contract)).map((g) => g.name),
    )
    expect(DRIVABLE.length).toBeGreaterThan(10)
  })
})

for (const g of DRIVABLE) {
  describe(`${g.name}: review_before hold and bypass`, () => {
    const bypassDir = () => join(roots.get(g.name)!, '.intutic', 'hooks')
    const clearBypass = () => rmSync(join(bypassDir(), 'approved-bypasses.jsonl'), { force: true })

    it('holds the call when no bypass cache exists at all, and records it for review', async () => {
      clearBypass()
      const before = holdLog(g)
      const r = await runGate(g, payload)
      expect(refused(g, r), `${g.name} let a held deploy run. stderr: ${r.stderr.slice(0, 300)}`).toBe(true)
      expect(r.stderr).toMatch(/HELD/)
      expect(r.stderr).toMatch(/intutic decision approve hold_/)
      expect(auditLog(g)).toMatch(/tool_held/)

      const added = holdLog(g).slice(before.length).trim().split('\n').filter(Boolean)
      expect(added, `${g.name} wrote no hold record at ${REVIEW_REQUESTS_LOG}`).toHaveLength(1)
      const record = JSON.parse(added[0]!)
      expect(record.v, 'the drain rejects an unversioned record').toBe(1)
      expect(record.holdId).toMatch(/^hold_/)
      expect(record.reason).toBe(SOP_RULE_ID)
      expect(record.workspaceId).toBe(WORKSPACE_ID)
      expect(record.toolNameNormalized).toBe(TOOL_NAME_NORMALIZED)
      expect(record.targetHash, 'the bypass key the control plane will echo').toBe(TARGET_HASH)
    })

    it('does NOT bypass on an EXPIRED exact-match entry — fails closed toward the hold', async () => {
      await writeApprovedBypasses([bypassEntry({ expiresAt: new Date(Date.now() - 60_000).toISOString() })], WORKSPACE_ID, bypassDir())
      const r = await runGate(g, payload)
      expect(refused(g, r), 'an expired bypass must not let the call through').toBe(true)
      expect(r.stderr).toMatch(/HELD/)
      expect(r.stderr).not.toMatch(/BYPASSED/)
    })

    it('does NOT bypass on a NON-matching entry (different targetHash) — exact match only', async () => {
      await writeApprovedBypasses([bypassEntry({ targetHash: 'f'.repeat(64) })], WORKSPACE_ID, bypassDir())
      const r = await runGate(g, payload)
      expect(refused(g, r), 'a mismatched bypass must not let the call through').toBe(true)
    })

    it('does NOT bypass when the cache is for a different workspace', async () => {
      await writeApprovedBypasses([bypassEntry({ workspaceId: 'ws_other' })], 'ws_other', bypassDir())
      const r = await runGate(g, payload)
      expect(refused(g, r), 'a foreign workspace bypass must be refused').toBe(true)
    })

    it('DOES bypass on a valid, unexpired, exact-match entry — and records the use loudly', async () => {
      await writeApprovedBypasses([bypassEntry()], WORKSPACE_ID, bypassDir())
      const holdBefore = holdLog(g)
      const r = await runGate(g, payload)
      expect(refused(g, r), `${g.name} refused an approved call. stderr: ${r.stderr.slice(0, 300)}`).toBe(false)
      expect(r.status, 'an allow exits 0').toBe(0)
      expect(r.stderr).toMatch(/BYPASSED/)

      const audit = auditLog(g)
      expect(audit, 'the bypass-use event must be recorded, not silent').toMatch(/hold_approved_bypass_used/)
      // Names the original hold and who approved it — the audit trail this
      // whole mechanism exists to produce.
      expect(audit).toContain('hold_original_abc123')
      expect(audit).toContain('mbr_reviewer')
      // No NEW hold was written for this already-approved call.
      expect(holdLog(g)).toBe(holdBefore)
    })

    it('still holds a DIFFERENT command under the same rule (no fuzzy matching)', async () => {
      await writeApprovedBypasses([bypassEntry()], WORKSPACE_ID, bypassDir())
      const r = await runGate(g, { tool_name: 'Bash', tool_input: { command: 'kubectl apply -f other.yaml' }, session_id: 'sess_test' })
      expect(refused(g, r), 'a different command must get its own hash and be held').toBe(true)
    })
  })
}
