/**
 * What the generated hook actually writes when a review hold fires.
 *
 * Everything downstream of a hold is built on this file, and it is generated —
 * so asserting the generator's *inputs* proves nothing. These tests run the real
 * emitted script under `node`, feed it a real tool-use payload, and read what
 * lands on disk.
 *
 * Three things this catches that a unit test cannot:
 *
 * 1. **The append.** It was a single `.json` written with `writeFileSync`, so a
 *    second hold in one drain window destroyed the first — and holds cluster.
 * 2. **The emitted redactor evaluating at all.** Serialised functions can
 *    reference bindings that exist in the module and not in the hook. That
 *    throws inside the hold-write catch, which produces no snapshot and no
 *    error — a silent hole exactly where the secrets are.
 * 3. **The exit code.** Exit 2 blocks; exit 1 is a hook *error* and Claude Code
 *    runs the tool anyway. The whole gate was dead for that reason once.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { updatePreToolUseHooks, REVIEW_REQUESTS_LOG } from '../../src/harness/claudeCodeHooks.js'

/** Assembled at runtime — a credential-shaped literal in source is the hazard. */
const AWS_KEY = 'AK' + 'IA' + 'QRSTUVWX34567890'

function run(
  cmd: string,
  args: string[],
  input: string,
): Promise<{ status: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d: string) => {
      stderr += d
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ status: code === null ? -1 : code, stderr }))
    child.stdin.write(input)
    child.stdin.end()
  })
}

let root: string
let hookPath: string
let logPath: string

/** A SOP whose fenced block and front matter both declare the hold. */
const SOP = [
  'review_before: action:deploy',
  '',
  '```json',
  JSON.stringify({ highRiskTools: [], patterns: [], reviewBefore: ['action:deploy'] }),
  '```',
].join('\n')

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'intutic-holdwriter-'))
  logPath = join(root, REVIEW_REQUESTS_LOG)
  await writeFile(join(root, 'SOP.md'), SOP)
  await updatePreToolUseHooks(root, [
    { sopId: 'sop_hold', title: 'Hold', content: SOP, contentHash: 'h', harnessTargets: [] },
  ] as never)
  hookPath = join(root, '.intutic', 'hooks', 'claude-code-check.js')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const payload = (command: string) =>
  JSON.stringify({
    tool_name: 'Bash',
    session_id: 'ses_hold_1',
    tool_input: { command },
  })

describe('the generated hook records a hold', () => {
  it('blocks with exit 2, not exit 1', async () => {
    const r = await run('node', [hookPath], payload('git push origin main'))
    expect(
      r.status,
      `exit 1 is a hook error — Claude Code runs the tool anyway, so the hold is a no-op. stderr: ${r.stderr}`,
    ).toBe(2)
    expect(r.stderr, r.stderr).toMatch(/HELD/)
  })

  it('appends rather than overwriting, so clustered holds all survive', async () => {
    await run('node', [hookPath], payload('git push origin main'))
    await run('node', [hookPath], payload('kubectl apply -f deploy.yaml'))

    const lines = (await readFile(logPath, 'utf-8')).trim().split('\n')
    expect(lines, 'the single-file writer left only the second hold').toHaveLength(2)

    const commands = lines.map((l) => JSON.parse(l).context.toolInput.command)
    expect(commands[0]).toContain('git push')
    expect(commands[1]).toContain('kubectl apply')
  })

  it('carries the provenance the decision row needs', async () => {
    const r = await run('node', [hookPath], payload('git push origin main'))
    // The write sits inside a catch. Without this the whole class of failure —
    // an undefined binding in the emitted script — passes as "no file yet".
    expect(r.stderr, r.stderr).not.toContain('could not record')

    const record = JSON.parse((await readFile(logPath, 'utf-8')).trim())

    expect(record.v, 'the drain rejects an unversioned record').toBe(1)
    expect(record.holdId).toMatch(/^hold_/)
    expect(record.reason).toBe('action:deploy')
    expect(record.tool).toBe('Bash')
    expect(record.sessionId, 'the trace is resolved on this').toBe('ses_hold_1')
    expect(() => new Date(record.at).toISOString()).not.toThrow()
    expect(record.context, 'the block mock for any rule mined from this').toBeTruthy()
    expect(record.context.toolInput.command).toContain('git push')
  })

  it('redacts a credential before it reaches the disk', async () => {
    // The emitted redactor has to evaluate inside the hook. If it throws — a
    // binding it references not existing there, say — the write is inside a
    // catch and fails silently, leaving no snapshot and no complaint.
    await run('node', [hookPath], payload(`git push && aws configure set key ${AWS_KEY}`))

    const raw = await readFile(logPath, 'utf-8')
    expect(raw, 'a credential was written to disk in plaintext').not.toContain(AWS_KEY)
    expect(raw).toContain('[redacted]')

    const record = JSON.parse(raw.trim())
    expect(record.context.toolInput.command, 'over-redaction destroys the mock').toContain('git push')
  })

  it('writes nothing when the tool is not held', async () => {
    const r = await run('node', [hookPath], payload('pnpm test'))
    expect(r.status).toBe(0)
    await expect(readFile(logPath, 'utf-8')).rejects.toThrow()
  })
})
