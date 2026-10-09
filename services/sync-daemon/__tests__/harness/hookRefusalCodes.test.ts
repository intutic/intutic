/**
 * The refusal code and rule id in a hook gate's JSON decision.
 *
 * Cline, Grok Build and Antigravity read a refusal from stdout rather than
 * from the exit code. Each refusal there carries `code` (HOOK_REFUSAL_CODES,
 * the `hook` list in refusal-codes.json) and the deciding `ruleId`, as the
 * SDK gates and the MCP proxy name theirs. Every kind of refusal is driven
 * through the three emitted gates, with a snapshot the real
 * `writePolicySnapshot` wrote.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { GATES, type GateEntry } from './gateRegistry.js'
import { HOOK_REFUSAL_CODES } from '../../src/harness/gateBody.js'
import { writePolicySnapshot, SNAPSHOT_RULES } from '../../src/lib/policySnapshot.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SHARED = JSON.parse(readFileSync(join(HERE, '../../../../packages/shared-types/fixtures/refusal-codes.json'), 'utf8')).hook
  .refusals as Array<{ code: string; meaning: string }>

describe('hook refusal codes', () => {
  it('are the shared list', () => {
    expect([...HOOK_REFUSAL_CODES]).toEqual(SHARED.map((r) => r.code))
  })

  it('are each documented in the harness security matrix', () => {
    const doc = readFileSync(join(HERE, '../../../../apps/docs/reference/harness-security-matrix.md'), 'utf8')
    const section = doc.slice(doc.indexOf('{#hook-refusal-codes}'))
    const documented = [...section.slice(0, section.indexOf('\n## ')).matchAll(/^\| `([A-Z_]+)` \| (.+) \|$/gm)]
    expect(documented.map((m) => m[1])).toEqual(SHARED.map((r) => r.code))
    expect(documented.map((m) => m[2])).toEqual(SHARED.map((r) => r.meaning))
  })
})

const CHOSEN = ['cline', 'grok', 'antigravityCli'] as const
const gates = CHOSEN.map((n) => GATES.find((g) => g.name === n)).filter((g): g is GateEntry => g !== undefined)

const home = mkdtempSync(join(tmpdir(), 'intutic-hook-codes-'))
const roots = new Map<string, string>()
let snapshot = ''

beforeAll(async () => {
  const dir = join(home, 'snapshot')
  await writePolicySnapshot(
    {
      workspaceId: 'ws_test',
      interventionMode: 'TRANSPARENT',
      sopRules: [{ id: 's_edit', toolPattern: 'Edit', action: 'block', reason: 'no edits' }],
      mcpAllowedServers: ['github', 'pastebin'],
      sqlDropStrictBlock: false,
      ssoGroupPolicy: { highRiskTools: ['Bash'], requiredGroups: ['sre'], requireOboFor: [] },
      principal: { memberId: 'mem_1', ssoGroups: [] },
      mcpRegistry: { defaultPolicy: 'allow', approvedServers: [], blockedServers: ['pastebin'], heldServers: [], disabledTools: {} },
    },
    dir,
    ['NotebookEdit'],
  )
  snapshot = join(dir, SNAPSHOT_RULES)

  for (const g of gates) {
    const root = join(home, g.name)
    mkdirSync(root, { recursive: true })
    process.env.HOME = root
    process.env.USERPROFILE = root
    try {
      await g.invoke(await import(g.module), root)
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

/** Async spawn, never spawnSync: see the note in generatedGateBehaviour.test.ts. */
function runGate(g: GateEntry, stdin: string): Promise<Record<string, unknown>> {
  const root = roots.get(g.name)!
  return new Promise((resolve, reject) => {
    const child = spawn(g.runner, [join(root, g.artifact)], {
      env: { ...process.env, HOME: root, USERPROFILE: root, INTUTIC_SNAPSHOT_RULES: snapshot, INTUTIC_REVIEW_REQUESTS: join(root, 'holds.jsonl') },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d: string) => { stdout += d })
    child.stderr.resume()
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('close', () => {
      clearTimeout(timer)
      const line = stdout.trim().split('\n').pop() ?? ''
      try {
        resolve(JSON.parse(line) as Record<string, unknown>)
      } catch {
        resolve({ unparsed: stdout })
      }
    })
    child.stdin.end(stdin)
  })
}

const call = (tool: string, input: Record<string, unknown> = {}) => JSON.stringify({ tool_name: tool, tool_input: input, session_id: 'sess_codes' })

const CASES: Array<[string, string, string | null]> = [
  ['BUILT_IN_RULE', call('Write', { file_path: '.claude/settings.json', content: '{}' }), null],
  ['SNAPSHOT', call('Edit'), 'sop.s_edit'],
  ['SSO_GROUP', call('Bash', { command: 'ls' }), 'sso_group.high_risk.Bash'],
  ['HELD', call('NotebookEdit'), 'sop.local.review_before.NotebookEdit'],
  ['SERVER_BLOCKED', call('mcp__pastebin__paste'), 'mcp_registry.pastebin'],
  ['SERVER_NOT_ALLOWED', call('mcp__other__query'), 'mcp_allowlist'],
  ['COMMAND_TOO_LARGE', call('Bash', { command: `echo ${'x'.repeat(300 * 1024)}` }), null],
  ['UNREADABLE_CALL', '{}', null],
  ['GATE_CRASHED', 'not json', null],
]

describe('a JSON decision names the code and the rule', () => {
  for (const g of gates) {
    it(`${g.name} (${g.contract})`, async () => {
      expect(roots.get(`${g.name}:error`), `the ${g.name} writer failed`).toBeUndefined()
      for (const [code, stdin, ruleId] of CASES) {
        const out = await runGate(g, stdin)
        const label = `${g.name}: ${code}: ${JSON.stringify(out).slice(0, 300)}`
        if (g.contract === 'stdout-cancel') {
          expect(out['cancel'], label).toBe(true)
          expect(String(out['errorMessage']), label).not.toBe('')
        } else {
          expect(out['decision'], label).toBe('deny')
          expect(String(out['reason']), label).not.toBe('')
        }
        if (g.name === 'antigravityCli') {
          // Antigravity's decision carries only the fields its hook contract
          // documents: the code is in the reason, the rule id in brackets.
          expect(Object.keys(out).sort(), label).toEqual(['decision', 'reason'])
          expect(String(out['reason']), label).toMatch(new RegExp(`\\(refusal code ${code}\\)$`))
          if (ruleId) expect(String(out['reason']), label).toContain(`[${ruleId}]`)
          continue
        }
        expect(out['code'], label).toBe(code)
        if (code === 'BUILT_IN_RULE') {
          expect(String(out['ruleId']), label).toMatch(/^[a-z_]+\./)
        } else {
          expect(out['ruleId'], label).toBe(ruleId)
        }
        if (code === 'HELD') expect(String(out['holdId']), label).toMatch(/^hold_/)
      }
    }, 120_000)
  }
})
