/**
 * `intutic gates install`: what it refuses, what `--dry-run` and `--harness`
 * change, that a second run changes nothing, and the two clean-ups it makes
 * (a stale `runtime.env` key, an oversized hook events log).
 *
 * Writers keep some paths in module-level constants computed from the home
 * directory at import time, so HOME is moved before anything is imported.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

const fake = vi.hoisted(() => {
  const base = `${process.env.TMPDIR || '/tmp'}/intutic-gates-test-${process.pid}-${Date.now()}`.replace(/\/+/g, '/')
  process.env.HOME = `${base}/home`
  process.env.USERPROFILE = `${base}/home`
  delete process.env.XDG_CONFIG_HOME
  delete process.env.CODEX_HOME
  delete process.env.DSH_HOME
  delete process.env.PORT
  delete process.env.INTUTIC_PROXY_URL
  delete process.env.INTUTIC_SNAPSHOT_RULES
  return { base, home: `${base}/home`, ws: `${base}/home/code/project` }
})

import * as fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { runGatesInstall, CONNECTED_REFUSAL } from './gates.js'
import { HOOK_EVENTS_ROTATE_BYTES, localGatesInstalled } from '../lib/localGates.js'

const { base, home, ws } = fake
const intutic = join(home, '.intutic')
const snapshotRules = join(intutic, 'hooks', 'policy-snapshot.rules')
const cursorGate = join(ws, '.intutic', 'hooks', 'cursor-check.js')
const claudeGate = join(ws, '.intutic', 'hooks', 'claude-code-check.js')

async function put(path: string, content: string | object): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n')
}

async function saveConfig(harnesses: string[]): Promise<void> {
  await put(join(intutic, 'config.json'), { workspaceRoot: ws, harnesses, configVersion: 0, devMode: false })
}

/** Runs the command, returning everything it printed and its exit code. */
async function gates(opts: Parameters<typeof runGatesInstall>[0] = {}): Promise<{ out: string; code: number }> {
  const lines: string[] = []
  const capture = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
  const spies = [vi.spyOn(console, 'log').mockImplementation(capture), vi.spyOn(console, 'error').mockImplementation(capture), vi.spyOn(console, 'warn').mockImplementation(capture)]
  process.exitCode = undefined
  try {
    await runGatesInstall(opts)
    return { out: lines.join('\n'), code: Number(process.exitCode ?? 0) }
  } finally {
    for (const s of spies) s.mockRestore()
    process.exitCode = undefined
  }
}

beforeEach(async () => {
  await fs.rm(base, { recursive: true, force: true })
  await fs.mkdir(ws, { recursive: true })
})

afterAll(async () => {
  await fs.rm(base, { recursive: true, force: true })
})

describe('intutic gates install', () => {
  it('refuses on a machine with a login: connect owns the gates there', async () => {
    await saveConfig(['cursor'])
    await put(join(intutic, 'credentials.json'), {
      workspaceId: 'ws_test',
      apiKey: ['vk', 'fixture'].join('_'),
      email: 'dev@example.com',
      storedAt: new Date().toISOString(),
    })
    const { out, code } = await gates()
    expect(code).toBe(1)
    expect(out).toContain(CONNECTED_REFUSAL)
    expect(existsSync(snapshotRules)).toBe(false)
    expect(existsSync(cursorGate)).toBe(false)
  })

  it('refuses before `intutic init`', async () => {
    const { out, code } = await gates()
    expect(code).toBe(1)
    expect(out).toContain('Workspace not initialized. Run `intutic init` first.')
    expect(existsSync(snapshotRules)).toBe(false)
  })

  it('writes nothing on --dry-run, and says what it would write', async () => {
    await saveConfig(['cursor', 'claude-code'])
    const { out, code } = await gates({ dryRun: true })
    expect(code).toBe(0)
    expect(out).toContain('would write ~/.intutic/hooks/policy-snapshot.rules')
    expect(out).toContain('Nothing was written')
    expect(existsSync(snapshotRules)).toBe(false)
    expect(existsSync(cursorGate)).toBe(false)
    expect(existsSync(join(ws, '.claude', 'settings.json'))).toBe(false)
  })

  it('installs every recorded harness, and is unchanged by a second run', async () => {
    await saveConfig(['cursor', 'claude-code'])
    await put(join(ws, '.intutic', 'sops', 'review.md'), '---\nreview_before: Write\n---\n# Review writes\n\nAsk before writing.\n')
    const first = await gates()
    expect(first.code).toBe(0)
    expect(first.out).toContain('Undo with `intutic disconnect`.')
    expect(first.out).toContain(cursorGate.replace(home, '~'))
    expect(await localGatesInstalled()).toBe(true)

    const read = async () => ({
      settings: await fs.readFile(join(ws, '.claude', 'settings.json'), 'utf-8'),
      cursorHooks: await fs.readFile(join(home, '.cursor', 'hooks.json'), 'utf-8'),
      rules: await fs.readFile(join(ws, '.cursor', 'rules', 'intutic-governance.mdc'), 'utf-8'),
      digest: (await fs.readFile(snapshotRules, 'utf-8')).split('\n').find((l) => l.startsWith('#digest ')),
    })
    const before = await read()
    expect(JSON.parse(before.settings).hooks.PreToolUse).toHaveLength(5)

    const second = await gates()
    expect(second.code).toBe(0)
    const after = await read()
    expect(after.settings).toBe(before.settings)
    expect(after.cursorHooks).toBe(before.cursorHooks)
    expect(after.digest).toBe(before.digest)
    // Only the generation stamp in the header moves.
    expect(after.rules.replace(/Last sync: .*/, '')).toBe(before.rules.replace(/Last sync: .*/, ''))
  })

  it('--harness installs one recorded harness, refuses an unrecorded one, and --add records it', async () => {
    await saveConfig(['cursor'])
    const unrecorded = await gates({ harness: 'claude-code' })
    expect(unrecorded.code).toBe(1)
    expect(unrecorded.out).toContain('claude-code is not recorded')
    expect(existsSync(claudeGate)).toBe(false)

    const added = await gates({ harness: 'claude-code', add: true })
    expect(added.code).toBe(0)
    expect(existsSync(claudeGate)).toBe(true)
    // Only the named harness.
    expect(existsSync(cursorGate)).toBe(false)
    const config = JSON.parse(await fs.readFile(join(intutic, 'config.json'), 'utf-8'))
    expect(config.harnesses).toEqual(['cursor', 'claude-code'])

    const unknown = await gates({ harness: 'no-such-harness' })
    expect(unknown.code).toBe(1)
    expect(unknown.out).toContain('Unknown harness "no-such-harness"')
  })

  it('does not route unless asked', async () => {
    await saveConfig(['cursor'])
    const { out } = await gates()
    expect(out).toContain('Routing')
    expect(out).toContain('add --route')
    expect(existsSync(join(home, '.intutic', 'originals', 'proxy-urls.json'))).toBe(false)
  })

  it('blanks an API key a past connect left in runtime.env, so no gate posts to that control plane', async () => {
    await saveConfig(['cursor'])
    const runtimeEnv = join(intutic, 'env', 'runtime.env')
    await put(runtimeEnv, `INTUTIC_HOST=https://cp.example.test\nINTUTIC_API_KEY=${['vk', 'stale'].join('_')}\nINTUTIC_WORKSPACE_ID=ws_old\n`)
    await gates()
    const text = await fs.readFile(runtimeEnv, 'utf-8')
    expect(text).toMatch(/^INTUTIC_API_KEY=$/m)
    expect(text).toMatch(/^INTUTIC_HOST=$/m)
    expect(text).not.toContain('stale')
  })

  it('compiles the local decide: lines into the snapshot, and names a line that does not read', async () => {
    await saveConfig(['claude-code'])
    const rule = {
      id: 'prod-data-export', on: 'tool_call', tools: ['Bash'],
      questions: { exports: { type: 'yes_no', ask: 'Does this command copy customer data out of the production database?' } },
      when: 'exports', rollout: 'enforce',
    }
    await put(join(ws, '.intutic', 'sops', 'data.md'), `---\ndecide: ${JSON.stringify(rule)}\ndecide: {"id":"half"}\n---\n# Production data handling\n\nStay in production.\n`)
    // The pin an eval pass left for this rule's hash.
    const evals = join(intutic, 'decide', 'evals', '5ea09c50d1d33141b613fff751953cc43e3046334451132712479468a46d2d91')
    await put(join(evals, 'model.json'), { modelDigest: 'sha256:5f1c0e2a9b7d', evalRunId: 'eval_local_01', source: 'local' })

    const r = await gates()
    expect(r.code).toBe(0)
    expect(r.out).toContain('.intutic/sops/data.md: decide line 2 does not read, so its tools are refused: decide: on is required')
    const lines = (await fs.readFile(snapshotRules, 'utf-8')).split('\n')
    expect(lines).toContain('@format\t2')
    const record = lines.find((l) => l.startsWith('@decide\t'))!
    expect(record.split('\t').slice(0, 4)).toEqual(['@decide', 'decide-fallback:prod-data-export@6bcd6b021e7d', 'enforce', 'Bash'])
    expect(lines.filter((l) => l.startsWith('decide-fallback:')).map((l) => l.split('\t')[0])).toEqual([
      'decide-fallback:prod-data-export@6bcd6b021e7d',
      'decide-fallback:unreadable.2@6bcd6b021e7d',
    ])
  })

  it('rotates a hook events log past the limit, keeping one previous copy', async () => {
    await saveConfig(['cursor'])
    const log = join(ws, '.intutic', 'events', 'hook-events.jsonl')
    await put(log, 'x'.repeat(HOOK_EVENTS_ROTATE_BYTES + 1))
    await put(`${log}.1`, 'older\n')
    await gates()
    expect(existsSync(log)).toBe(false)
    expect((await fs.stat(`${log}.1`)).size).toBe(HOOK_EVENTS_ROTATE_BYTES + 1)
  })
})
