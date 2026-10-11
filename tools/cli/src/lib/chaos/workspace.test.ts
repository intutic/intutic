import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { prepareWorkspace } from './workspace.js'

let tmp: string
let host: string
let work: string

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'chaos-workspace-test-'))
  host = path.join(tmp, 'proj')
  work = path.join(tmp, 'rep', 'work')
  await fs.mkdir(host, { recursive: true })
  await fs.mkdir(work, { recursive: true })
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

async function put(root: string, rel: string, text: string, mode?: number): Promise<void> {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true })
  await fs.writeFile(path.join(root, rel), text, mode === undefined ? undefined : { mode })
}
const read = (root: string, rel: string) => fs.readFile(path.join(root, rel), 'utf-8')

/** Claude Code project settings as the sync daemon writes them. */
function claudeSettings(root: string) {
  const entry = (matcher: string) => ({
    matcher,
    hooks: [{ type: 'command', command: `node ${root}/.intutic/hooks/claude-code-check.js`, timeout: 10 }],
  })
  return { permissions: { deny: [] }, hooks: { PreToolUse: [entry('Bash'), entry('mcp__.*')] } }
}
const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n'

describe('prepareWorkspace', () => {
  it('copies untracked gates and settings, rewrites the host root to /work, and leaves the project alone', async () => {
    await put(host, '.intutic/hooks/claude-code-check.js', `const LOG = "${host}/.intutic/events/hook-events.jsonl"\n`, 0o755)
    await put(host, '.intutic/hooks/openclaw/plugin.cjs', `module.exports = "${host}"\n`)
    await put(host, '.claude/settings.local.json', json(claudeSettings(host)))
    // Tracked: the worktree already has the commit's copy, which wins over
    // the host's working copy, and is rewritten in place.
    await put(host, '.codex/hooks.json', json({ PreToolUse: [{ command: `node ${host}/.intutic/hooks/codex-check.js` }] }))
    await put(work, '.codex/hooks.json', json({ PreToolUse: [{ command: `node ${host}/.intutic/hooks/codex-check.js --committed` }] }))
    await put(host, 'home/policy-snapshot.rules', '#digest abc\n')
    await put(host, 'home/approved-bypasses.jsonl', '{"id":"b1"}\n')

    const p = await prepareWorkspace({
      hostRoot: host,
      workspace: work,
      policyDir: '.intutic-chaos/policy',
      snapshotRules: path.join(host, 'home/policy-snapshot.rules'),
      approvedBypasses: path.join(host, 'home/approved-bypasses.jsonl'),
    })

    expect(p.copied).toEqual([
      '.intutic/hooks/claude-code-check.js',
      '.intutic/hooks/openclaw/plugin.cjs',
      '.claude/settings.local.json',
    ])
    expect(p.settings).toEqual(['.claude/settings.local.json', '.codex/hooks.json'])
    expect(p.rewritten).toEqual([
      '.claude/settings.local.json',
      '.codex/hooks.json',
      '.intutic/hooks/claude-code-check.js',
      '.intutic/hooks/openclaw/plugin.cjs',
    ])
    expect(p.gates).toBe(2)
    expect(p.warnings).toEqual([])

    expect(JSON.parse(await read(work, '.claude/settings.local.json'))).toEqual(claudeSettings('/work'))
    expect(await read(work, '.codex/hooks.json')).toContain('node /work/.intutic/hooks/codex-check.js --committed')
    expect(await read(work, '.intutic/hooks/claude-code-check.js')).toBe('const LOG = "/work/.intutic/events/hook-events.jsonl"\n')
    expect((await fs.stat(path.join(work, '.intutic/hooks/claude-code-check.js'))).mode & 0o777).toBe(0o755)
    expect((await fs.stat(path.join(work, '.intutic/events'))).mode & 0o777).toBe(0o777)

    expect(p.env).toEqual({
      INTUTIC_SNAPSHOT_RULES: '/work/.intutic-chaos/policy/policy-snapshot.rules',
      INTUTIC_APPROVED_BYPASSES: '/work/.intutic-chaos/policy/approved-bypasses.jsonl',
    })
    expect(await read(work, '.intutic-chaos/policy/policy-snapshot.rules')).toBe('#digest abc\n')
    expect(await read(work, '.intutic-chaos/policy/approved-bypasses.jsonl')).toBe('{"id":"b1"}\n')

    // The host project is read, never written.
    expect(JSON.parse(await read(host, '.claude/settings.local.json'))).toEqual(claudeSettings(host))
    expect(await read(host, '.intutic/hooks/claude-code-check.js')).toContain(host)
    await expect(fs.stat(path.join(host, '.intutic/events'))).rejects.toThrow()
  })

  it('rewrites the root only as a whole path, and the resolved spelling of it too', async () => {
    const real = await fs.realpath(host)
    const text = [
      `node ${host}/.intutic/hooks/a.js`,
      `"${host}"`,
      `${real}/x`,
      `${host}-other/.intutic/hooks/a.js`,
      `${host}x/y`,
    ].join('\n')
    await put(host, '.claude/settings.json', text)
    const p = await prepareWorkspace({ hostRoot: host, workspace: work, policyDir: '.intutic-chaos/policy' })
    expect(await read(work, '.claude/settings.json')).toBe(
      ['node /work/.intutic/hooks/a.js', '"/work"', '/work/x', `${host}-other/.intutic/hooks/a.js`, `${host}x/y`].join('\n'),
    )
    expect(p.rewritten).toEqual(['.claude/settings.json'])
  })

  it('rewrites a spelling of the root reached through a symlink', async () => {
    const link = path.join(tmp, 'link')
    await fs.symlink(host, link)
    await put(host, '.claude/settings.json', `node ${link}/.intutic/hooks/a.js\nnode ${tmp}/elsewhere/.intutic/hooks/b.js\n`)
    await prepareWorkspace({ hostRoot: host, workspace: work, policyDir: '.intutic-chaos/policy' })
    expect(await read(work, '.claude/settings.json')).toBe(`node /work/.intutic/hooks/a.js\nnode ${tmp}/elsewhere/.intutic/hooks/b.js\n`)
  })

  it('never replaces a gate the commit carries, and leaves binary files alone', async () => {
    await put(host, '.intutic/hooks/claude-code-check.js', `host copy ${host}\n`)
    await put(work, '.intutic/hooks/claude-code-check.js', `committed copy ${host}\n`)
    await put(host, '.intutic/hooks/rule.wasm', `\0asm${host}`)
    const p = await prepareWorkspace({ hostRoot: host, workspace: work, policyDir: '.intutic-chaos/policy' })
    expect(await read(work, '.intutic/hooks/claude-code-check.js')).toBe('committed copy /work\n')
    expect(await read(work, '.intutic/hooks/rule.wasm')).toBe(`\0asm${host}`)
    expect(p.copied).toEqual(['.intutic/hooks/rule.wasm'])
    expect(p.rewritten).toEqual(['.intutic/hooks/claude-code-check.js'])
  })

  it('warns when the project has no generated gates, and when there is no snapshot for them', async () => {
    const none = await prepareWorkspace({ hostRoot: host, workspace: work, policyDir: '.intutic-chaos/policy' })
    expect(none.gates).toBe(0)
    expect(none.warnings).toEqual([expect.stringContaining('no generated gates in')])
    expect(none.warnings[0]).toContain('`intutic connect`')
    expect(none.env).toEqual({})
    await expect(fs.stat(path.join(work, '.intutic/events'))).rejects.toThrow()

    await put(host, '.intutic/hooks/claude-code-check.js', '//\n')
    const noSnapshot = await prepareWorkspace({
      hostRoot: host,
      workspace: work,
      policyDir: '.intutic-chaos/policy',
      snapshotRules: path.join(host, 'missing.rules'),
    })
    expect(noSnapshot.warnings).toEqual([expect.stringMatching(/^no policy snapshot at .*missing\.rules/)])
    expect(noSnapshot.env).toEqual({})
  })
})
