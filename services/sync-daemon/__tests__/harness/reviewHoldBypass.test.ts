/**
 * The review_before bypass — the gate half of BUG B's fix.
 *
 * Scope note, stated rather than left implicit: `review_before` holds are
 * implemented ONLY by `claudeCodeHooks.ts` today. A repo-wide grep
 * (`grep -rl "reviewBefore" src/harness/`) turns up exactly one file. None of
 * the other fourteen writers `generatedGateBehaviour.test.ts` fans out over
 * implement a review hold at all — there is no bash-family review_before
 * enforcement to test the bypass against, because there is no bash-family
 * review_before enforcement, period. So unlike that file's per-tool matrix,
 * this one is NOT fanned out across GATES: it drives claudeCodeHooks.ts
 * directly, the one place `_intuticApprovedBypass` exists. If a second harness
 * ever grows its own review_before hold, its bypass check belongs in a sibling
 * file next to this one, not folded in here.
 *
 * What this pins:
 *  (a) an expired or non-matching bypass entry does NOT let a held call
 *      through — the call still gets HELD (exit 2) exactly as before;
 *  (b) a valid, unexpired, EXACT-match entry DOES let it through (exit 0,
 *      falling into the ordinary allow path) and records
 *      `hold_approved_bypass_used`, naming the original hold and who
 *      approved it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { updatePreToolUseHooks } from '../../src/harness/claudeCodeHooks.js'
import { writeApprovedBypasses, type ApprovedBypassEntry } from '../../src/lib/approvedBypasses.js'
import { NORMALISE_CONTRACT } from '../../src/harness/protectedPaths.js'

const WORKSPACE_ID = 'ws_test'
const SOP_RULE_ID = 'action:deploy' // the review_before token that matches "kubectl apply"
const COMMAND = 'kubectl apply -f x.yaml'
const TARGET = '' // no path-shaped field on this tool_input

const TOOL_NAME_NORMALIZED = NORMALISE_CONTRACT.js('Bash')
// NUL-joined, matching claudeCodeHooks.ts's `_intuticTargetHash` exactly — a
// plain-space join would let command="a b" target="" collide with
// command="a" target="b", which the NUL separator exists to prevent.
const NUL = String.fromCharCode(0)
const TARGET_HASH = createHash('sha256')
  .update(NORMALISE_CONTRACT.js(COMMAND) + NUL + NORMALISE_CONTRACT.js(TARGET))
  .digest('hex')

interface RunResult { status: number; stdout: string; stderr: string; signal: NodeJS.Signals | null }

function runGate(artifact: string, home: string, payload: unknown): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [artifact], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
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
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ status: code === null ? -1 : code, stdout, stderr, signal })
    })
    child.stdin.write(JSON.stringify(payload))
    child.stdin.end()
  })
}

function auditLog(root: string): string {
  const p = join(root, '.intutic', 'events', 'hook-events.jsonl')
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}

function holdLog(root: string): string {
  const p = join(root, '.intutic', 'events', 'review-requests.jsonl')
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

describe('claudeCodeHooks review_before bypass', () => {
  let root: string

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'intutic-bypass-'))
    mkdirSync(root, { recursive: true })
    const prevHome = process.env.HOME
    process.env.HOME = root
    process.env.USERPROFILE = root
    try {
      // `settings.reviewBefore` is the direct-settings delivery path
      // `parseSopConstraints` reads — no SOP markdown needed for this test.
      await updatePreToolUseHooks(root, [], { reviewBefore: [SOP_RULE_ID] }, 'https://proxy.test', WORKSPACE_ID)
    } finally {
      process.env.HOME = prevHome
    }
  }, 30_000)

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const artifact = () => join(root, '.intutic', 'hooks', 'claude-code-check.js')
  const payload = { tool_name: 'Bash', tool_input: { command: COMMAND }, session_id: 'sess_test' }

  it('holds the call when no bypass cache exists at all (baseline)', async () => {
    const r = await runGate(artifact(), root, payload)
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/HELD/)
    expect(auditLog(root)).toMatch(/tool_blocked/)
  })

  it('does NOT bypass on an EXPIRED exact-match entry — fails closed toward the hold', async () => {
    await writeApprovedBypasses(
      [bypassEntry({ expiresAt: new Date(Date.now() - 60_000).toISOString() })],
      WORKSPACE_ID,
      join(root, '.intutic', 'hooks'),
    )
    const r = await runGate(artifact(), root, payload)
    expect(r.status, 'an expired bypass must not let the call through').toBe(2)
    expect(r.stderr).toMatch(/HELD/)
    expect(auditLog(root)).not.toMatch(/hold_approved_bypass_used/)
  })

  it('does NOT bypass on a NON-matching entry (different targetHash) — exact match only', async () => {
    await writeApprovedBypasses(
      [bypassEntry({ targetHash: 'f'.repeat(64) })],
      WORKSPACE_ID,
      join(root, '.intutic', 'hooks'),
    )
    const r = await runGate(artifact(), root, payload)
    expect(r.status, 'a mismatched bypass must not let the call through').toBe(2)
  })

  it('does NOT bypass when the cache is for a different workspace', async () => {
    await writeApprovedBypasses(
      [bypassEntry({ workspaceId: 'ws_other' })],
      'ws_other', // writer stamps its own #workspace header
      join(root, '.intutic', 'hooks'),
    )
    const r = await runGate(artifact(), root, payload)
    expect(r.status, 'a foreign workspace bypass must be refused').toBe(2)
  })

  it('DOES bypass on a valid, unexpired, exact-match entry — and records the use loudly', async () => {
    const holdBefore = holdLog(root)
    await writeApprovedBypasses(
      [bypassEntry()],
      WORKSPACE_ID,
      join(root, '.intutic', 'hooks'),
    )
    const r = await runGate(artifact(), root, payload)
    expect(r.status, `expected an allow (0), got ${r.status}. stderr: ${r.stderr}`).toBe(0)
    expect(r.stderr).toMatch(/BYPASSED/)

    const audit = auditLog(root)
    expect(audit, 'the bypass-use event must be recorded, not silent').toMatch(/hold_approved_bypass_used/)
    // Names the original hold and who approved it — the audit trail this
    // whole mechanism exists to produce.
    expect(audit).toContain('hold_original_abc123')
    expect(audit).toContain('mbr_reviewer')

    // No NEW hold was written for this already-approved call.
    expect(holdLog(root)).toBe(holdBefore)
  })

  it('still holds a DIFFERENT command under the same review_before rule (no fuzzy matching)', async () => {
    await writeApprovedBypasses(
      [bypassEntry()], // approved for COMMAND above
      WORKSPACE_ID,
      join(root, '.intutic', 'hooks'),
    )
    const differentCommand = { tool_name: 'Bash', tool_input: { command: 'kubectl apply -f other.yaml' }, session_id: 'sess_test' }
    const r = await runGate(artifact(), root, differentCommand)
    expect(r.status, 'a different command must get its own hash and be held').toBe(2)
  })
})
