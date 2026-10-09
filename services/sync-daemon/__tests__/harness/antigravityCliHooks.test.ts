/**
 * antigravityCliHooks.test.ts — the Google Antigravity gate.
 *
 * The registration is merged into `~/.gemini/config/hooks.json` without
 * touching the user's own hooks, and the gate is driven with the payload
 * Antigravity documents (`{toolCall: {name, args}}`, its own tool and argument
 * names) rather than the Claude-Code shape the shared matrix sends.
 *
 * HOME is a temp directory: the writer resolves the hooks file from it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { toRulesLine, REVIEW_REQUESTS_LOG } from '../../src/harness/gateBody.js'
import { DESTRUCTIVE_COMMAND_PATTERNS, UNIVERSAL_PROTECTED_PATHS, type GuardPattern } from '../../src/harness/protectedPaths.js'
import { writeAntigravityCliHooks, ANTIGRAVITY_HOOK_NAME } from '../../src/harness/antigravityCliHooks.js'

const PROXY_URL = 'http://127.0.0.1:4000'

function writeRules(target: string, patterns: readonly GuardPattern[]): string {
  const lines = patterns.map(toRulesLine)
  const digest = createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 32)
  writeFileSync(target, `#digest ${digest}\n#workspace ws_test\n#generated ${new Date().toISOString()}\n${lines.join('\n')}\n`)
  return target
}

interface RunResult { status: number | null; stdout: string; stderr: string }

function run(script: string, payload: unknown, env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [script], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', reject)
    child.on('close', (status) => resolve({ status, stdout, stderr }))
    // A string goes to stdin as it is, for input that is not JSON.
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload))
  })
}

/** The PreToolUse output fields and decisions https://antigravity.google/docs/hooks/ documents. */
const DOCUMENTED_FIELDS = ['decision', 'reason', 'permissionOverrides', 'overwrite']
const DOCUMENTED_DECISIONS = ['allow', 'deny', 'ask', 'force_ask', 'deny_unless_prior_grant']

/**
 * The one JSON object the gate printed, checked against the documented
 * output: stdout holds that object and nothing else, every field in it is a
 * documented one, and a decision is a documented value. `decision` is left
 * optional, the one departure from the documentation: an allowed call
 * prints none (see antigravityCliHooks.ts).
 */
function documentedResult(r: RunResult): Record<string, unknown> {
  const lines = r.stdout.split('\n').filter((line) => line.trim() !== '')
  expect(lines, r.stdout).toHaveLength(1)
  const obj: unknown = JSON.parse(lines[0]!)
  expect(typeof obj === 'object' && obj !== null && !Array.isArray(obj)).toBe(true)
  const result = obj as Record<string, unknown>
  for (const key of Object.keys(result)) expect(DOCUMENTED_FIELDS).toContain(key)
  if ('decision' in result) expect(DOCUMENTED_DECISIONS).toContain(result.decision)
  if ('reason' in result) expect(typeof result.reason).toBe('string')
  return result
}

/** Antigravity's documented PreToolUse payload. */
function toolCall(name: string, args: Record<string, unknown>) {
  return {
    toolCall: { name, args },
    stepIdx: 3,
    conversationId: 'conv_test',
    workspacePaths: ['/w'],
    transcriptPath: '/tmp/t.jsonl',
    artifactDirectoryPath: '/tmp/a',
    modelName: 'gemini-test',
  }
}

describe('writeAntigravityCliHooks', () => {
  let root: string
  let home: string
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'intutic-agy-'))
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'intutic-agy-home-'))
    process.env.HOME = home
    process.env.USERPROFILE = home
  })

  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(home, { recursive: true, force: true })
  })

  const hooksFile = () => path.join(home, '.gemini', 'config', 'hooks.json')
  const script = () => path.join(root, '.intutic', 'hooks', 'antigravity-cli-check.js')
  const gateEnv = (rules: string): NodeJS.ProcessEnv => ({ ...process.env, HOME: home, INTUTIC_SNAPSHOT_RULES: rules })

  it('registers a PreToolUse hook for every tool and keeps the user\'s own hooks', async () => {
    const mine = { PostToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: './lint.sh' }] }] }
    await fs.mkdir(path.dirname(hooksFile()), { recursive: true })
    await fs.writeFile(hooksFile(), JSON.stringify({ 'my-linter': mine }))

    await writeAntigravityCliHooks(root, PROXY_URL, 'ws_test')
    await writeAntigravityCliHooks(root, PROXY_URL, 'ws_test')

    const doc = JSON.parse(await fs.readFile(hooksFile(), 'utf-8'))
    expect(doc['my-linter']).toEqual(mine)
    expect(Object.keys(doc)).toEqual(['my-linter', ANTIGRAVITY_HOOK_NAME])
    expect(doc[ANTIGRAVITY_HOOK_NAME].enabled).toBe(true)
    const [entry] = doc[ANTIGRAVITY_HOOK_NAME].PreToolUse
    expect(entry.matcher).toBe('*')
    expect(entry.hooks).toEqual([{ type: 'command', command: `node ${JSON.stringify(script())}` }])
  })

  it('leaves a hooks file that is not plain JSON untouched', async () => {
    await fs.mkdir(path.dirname(hooksFile()), { recursive: true })
    await fs.writeFile(hooksFile(), '{ // mine\n}')
    await writeAntigravityCliHooks(root, PROXY_URL, 'ws_test')
    expect(await fs.readFile(hooksFile(), 'utf-8')).toBe('{ // mine\n}')
  })

  it('denies a destructive run_command and prints no decision for an ordinary one', async () => {
    await writeAntigravityCliHooks(root, PROXY_URL, 'ws_test')
    const rules = writeRules(path.join(root, 'snapshot.rules'), DESTRUCTIVE_COMMAND_PATTERNS)

    const denied = await run(script(), toolCall('run_command', { CommandLine: 'rm -rf .intutic/hooks', Cwd: '/w' }), gateEnv(rules))
    expect(denied.status).toBe(0)
    expect(documentedResult(denied)).toEqual({ decision: 'deny', reason: expect.stringContaining('.intutic/hooks') })

    // No decision: `allow` would auto-approve past the user's own prompts,
    // `ask` would add prompts.
    const allowed = await run(script(), toolCall('run_command', { CommandLine: 'npm test', Cwd: '/w' }), gateEnv(rules))
    expect(allowed.status).toBe(0)
    expect(documentedResult(allowed)).toEqual({})
  })

  it('denies a write_to_file to a protected path named by TargetFile', async () => {
    await writeAntigravityCliHooks(root, PROXY_URL, 'ws_test')
    const r = await run(
      script(),
      toolCall('write_to_file', { TargetFile: '/w/.claude/settings.json', CodeContent: '{}' }),
      gateEnv(path.join(root, 'no-such.rules')),
    )
    expect(documentedResult(r).decision).toBe('deny')
  })

  // The files the gate is registered in. An agent that could rewrite them
  // could remove its own gate before its next call, or register a hook that
  // runs ahead of it, so every gate refuses an edit to either, as it does for
  // every other harness's gate file.
  it.each([
    ['the user-level registration', '~/.gemini/config/hooks.json'],
    ['the project-level hooks file', '/w/.agents/hooks.json'],
  ])('denies an edit to %s, by file write and by shell', async (_, file) => {
    expect(UNIVERSAL_PROTECTED_PATHS).toContain(file.replace(/^~\/|^\/w\//, ''))
    await writeAntigravityCliHooks(root, PROXY_URL, 'ws_test')
    const noRules = gateEnv(path.join(root, 'no-such.rules'))
    const write = await run(script(), toolCall('write_to_file', { TargetFile: file, CodeContent: '{}' }), noRules)
    expect(documentedResult(write)).toEqual({ decision: 'deny', reason: expect.stringContaining(path.basename(file)) })
    const shell = await run(script(), toolCall('run_command', { CommandLine: `echo '{}' > ${file}`, Cwd: '/w' }), noRules)
    expect(documentedResult(shell).decision).toBe('deny')
  })

  it('holds a deploy run_command under review_before: action:deploy', async () => {
    await writeAntigravityCliHooks(root, PROXY_URL, 'ws_test')
    const rules = writeRules(path.join(root, 'hold.rules'), [{
      id: 'sop.local.review_before.action:deploy', source: ' (action:deploy) ', subject: 'action', ignoreCase: true, severity: 'hold',
      reason: 'Held for human review: action:deploy — declared in review_before:', rationale: '', matches: [], notMatches: [],
    }])

    const held = await run(script(), toolCall('run_command', { CommandLine: 'git push origin main', Cwd: '/w' }), gateEnv(rules))
    expect(documentedResult(held).decision).toBe('deny')
    expect(held.stderr).toMatch(/HELD/)
    const records = (await fs.readFile(path.join(root, REVIEW_REQUESTS_LOG), 'utf-8')).trim().split('\n')
    expect(records).toHaveLength(1)
    expect(JSON.parse(records[0]!)).toMatchObject({ v: 1, reason: 'sop.local.review_before.action:deploy', workspaceId: 'ws_test' })
  })

  it('fails closed with a documented result on input that is not JSON', async () => {
    await writeAntigravityCliHooks(root, PROXY_URL, 'ws_test')
    const r = await run(script(), 'not json', gateEnv(path.join(root, 'no-such.rules')))
    expect(r.status).toBe(0)
    expect(documentedResult(r).decision).toBe('deny')
  })

  it('refuses a payload carrying no tool call', async () => {
    await writeAntigravityCliHooks(root, PROXY_URL, 'ws_test')
    const r = await run(script(), { conversationId: 'conv_test' }, gateEnv(path.join(root, 'no-such.rules')))
    expect(documentedResult(r).decision).toBe('deny')
  })
})
