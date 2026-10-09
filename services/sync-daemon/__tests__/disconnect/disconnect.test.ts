/**
 * The disconnect pieces the CLI round trips do not reach: the originals
 * record itself, MCP entries wrapped by versions that kept no original,
 * files connect wrote before originals were kept, files shared between
 * harnesses, and the skip lists that keep a disconnected harness
 * disconnected while connect runs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { keepOriginal, noteWritten, readOriginal, forgetOriginal, noteProxyUrl, ledgerDir, writeOwnedFile } from '../../src/disconnect/originals.js'
import { planDisconnect } from '../../src/disconnect/index.js'
import { unwrapEntry, unwrapServerMap, unwrapOpenCodeEntry, unwrapUnmarkedEntry, geminiRemoteShape, antigravityRemoteShape, isIntuticServer } from '../../src/disconnect/mcp.js'
import { injectMcpServer } from '../../src/harness/mcpAutoWrite.js'
import { guardSettingsFile } from '../../src/watcher/settingsGuard.js'

const BIN = '/opt/intutic/node_modules/@intutic/mcp-governance-proxy/dist/index.js'

let base: string
let home: string
let ws: string
const prevHome = process.env.HOME
// Settings paths that follow these would leave the temporary home.
const prevXdg = process.env.XDG_CONFIG_HOME
const prevAppData = process.env.APPDATA

beforeEach(async () => {
  base = await fs.mkdtemp(join(tmpdir(), 'intutic-disconnect-unit-'))
  home = join(base, 'home')
  ws = join(home, 'project')
  await fs.mkdir(ws, { recursive: true })
  process.env.HOME = home
  delete process.env.XDG_CONFIG_HOME
  process.env.APPDATA = join(home, 'AppData', 'Roaming')
})

afterEach(async () => {
  process.env.HOME = prevHome
  if (prevXdg !== undefined) process.env.XDG_CONFIG_HOME = prevXdg
  if (prevAppData === undefined) delete process.env.APPDATA
  else process.env.APPDATA = prevAppData
  await fs.rm(base, { recursive: true, force: true })
})

async function put(path: string, content: string | object): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n')
}

const read = (path: string) => fs.readFile(path, 'utf-8')
const readJson = async (path: string) => JSON.parse(await read(path))

async function disconnect(options: Partial<Parameters<typeof planDisconnect>[0]> = {}) {
  const plan = await planDisconnect({ workspaceRoots: [ws], ...options })
  await plan.apply()
  return plan
}

// ─── The record ──────────────────────────────────────────────────────────────

describe('originals', () => {
  it('keeps the file as it was before the first write only', async () => {
    const file = join(ws, 'CLAUDE.md')
    await put(file, 'mine\n')
    await keepOriginal(file, ws)
    await fs.writeFile(file, 'first intutic write\n')
    await keepOriginal(file, ws)
    const record = await readOriginal(file, ws)
    expect(record?.existed).toBe(true)
    expect(record?.content?.toString()).toBe('mine\n')
  })

  it('records the directories it had to create, and keeps workspace records in the workspace', async () => {
    const file = join(ws, '.github', 'hooks', 'intutic-governance.json')
    await writeOwnedFile(file, ws, '{}\n')
    const record = await readOriginal(file, ws)
    expect(record).toMatchObject({ existed: false, createdDirs: [join(ws, '.github'), join(ws, '.github', 'hooks')] })
    expect(existsSync(ledgerDir(ws))).toBe(true)
    expect(existsSync(ledgerDir(home))).toBe(false)
    // The copies can hold whatever the config held: never committed.
    expect(await read(join(ledgerDir(ws), '.gitignore'))).toBe('*\n')
  })

  it('keeps a user-level file under the home directory, and its permission bits', async () => {
    const file = join(home, '.cursor', 'hooks.json')
    await put(file, '{}\n')
    await fs.chmod(file, 0o600)
    await keepOriginal(file, ws)
    expect(existsSync(ledgerDir(home))).toBe(true)
    expect((await readOriginal(file, ws))?.mode).toBe(0o600)
  })

  it('notes what was written, and forgets on request', async () => {
    const file = join(ws, 'AGENTS.md')
    await writeOwnedFile(file, ws, 'generated\n')
    expect((await readOriginal(file, ws))?.writtenSha256).toMatch(/^[0-9a-f]{64}$/)
    await noteWritten(file, ws, null, { extra: 1 })
    expect((await readOriginal(file, ws))?.meta).toEqual({ extra: 1 })
    await forgetOriginal(file, ws)
    expect(await readOriginal(file, ws)).toBeNull()
  })
})

// ─── MCP entries ─────────────────────────────────────────────────────────────

describe('unwrapping MCP entries', () => {
  it('reads a stdio server wrapped before originals were kept back out of its argv', () => {
    const wrapped = {
      command: 'node',
      args: [BIN, '--workspace-id', 'ws_1', '--server-name', 'gh', '--', 'npx', '-y', 'gh-mcp'],
      env: { GITHUB_TOKEN: 'x', INTUTIC_WORKSPACE_ID: 'ws_1' },
      __intutic_wrapped: true,
    }
    expect(unwrapEntry(wrapped)).toEqual({ command: 'npx', args: ['-y', 'gh-mcp'], env: { GITHUB_TOKEN: 'x' } })
  })

  it('reads a remote server wrapped before originals were kept back out of its argv and environment', () => {
    const wrapped = {
      command: 'node',
      args: [BIN, '--workspace-id', 'ws_1', '--server-name', 'docs', '--remote-url', 'https://m.example/sse', '--remote-transport', 'sse'],
      env: { INTUTIC_WORKSPACE_ID: 'ws_1', INTUTIC_REMOTE_HEADERS: '{"Authorization":"Bearer t"}' },
      __intutic_wrapped: true,
    }
    expect(unwrapEntry(wrapped)).toEqual({ url: 'https://m.example/sse', type: 'sse', headers: { Authorization: 'Bearer t' } })
  })

  it('puts back the recorded original, keys the wrap dropped included', () => {
    const original = { type: 'stdio', command: 'uvx', args: ['mcp-db'], cwd: '/srv', disabled: false, autoApprove: ['q'] }
    const wrapped = {
      command: 'node',
      args: [BIN, '--workspace-id', 'w', '--server-name', 'db', '--', 'uvx', 'mcp-db'],
      env: { INTUTIC_WORKSPACE_ID: 'w' },
      __intutic_wrapped: true,
      __intutic_original: original,
    }
    expect(unwrapEntry(wrapped)).toEqual(original)
  })

  it('trusts the argv over a recorded original that no longer matches it', () => {
    const wrapped = {
      command: 'node',
      args: [BIN, '--workspace-id', 'w', '--server-name', 'db', '--', 'uvx', 'mcp-db', '--readonly'],
      __intutic_wrapped: true,
      __intutic_original: { command: 'uvx', args: ['mcp-db'] },
    }
    expect(unwrapEntry(wrapped)).toEqual({ command: 'uvx', args: ['mcp-db', '--readonly'] })
  })

  it('removes the intutic server and project shadows, and leaves the user\'s servers alone', () => {
    const map: Record<string, unknown> = {
      intutic: { command: 'node', args: [BIN], env: { NODE_ENV: 'production', PINO_DEST: 'stderr' } },
      shared: { command: 'node', args: [BIN, '--', 'x'], __intutic_wrapped: true, __intutic_shadow_of: 'project' },
      mine: { command: 'my-server' },
    }
    expect(unwrapServerMap(map)).toBe(true)
    expect(map).toEqual({ mine: { command: 'my-server' } })
    expect(isIntuticServer({ command: 'node', args: ['/home/me/intutic-like/server.js'] })).toBe(false)
  })

  it('rebuilds a wrapped OpenCode entry, which carries no marker', () => {
    const wrapped = {
      type: 'local',
      command: ['node', BIN, '--workspace-id', 'w', '--server-name', 'r', '--remote-url', 'https://r.example/mcp', '--remote-transport', 'http'],
      environment: { INTUTIC_WORKSPACE_ID: 'w', INTUTIC_REMOTE_HEADERS: '{"A":"b"}' },
      enabled: true,
    }
    expect(unwrapOpenCodeEntry(wrapped)).toEqual({ type: 'remote', url: 'https://r.example/mcp', headers: { A: 'b' }, enabled: true })
  })
})

describe('Gemini CLI and Antigravity MCP servers, which carry no marker', () => {
  it('rebuilds each product\'s entry from the argv, keeping the keys the wrap kept', () => {
    const stdio = {
      command: 'node',
      args: [BIN, '--workspace-id', 'w', '--server-name', 'gh', '--', 'npx', 'gh-mcp'],
      env: { GITHUB_TOKEN: 'x', INTUTIC_WORKSPACE_ID: 'w' },
      cwd: '/work',
      trust: true,
    }
    expect(unwrapUnmarkedEntry(stdio, geminiRemoteShape)).toEqual({
      command: 'npx', args: ['gh-mcp'], env: { GITHUB_TOKEN: 'x' }, cwd: '/work', trust: true,
    })
    const remote = {
      command: 'node',
      args: [BIN, '--workspace-id', 'w', '--server-name', 'r', '--remote-url', 'https://r.example/sse', '--remote-transport', 'sse'],
      env: { INTUTIC_WORKSPACE_ID: 'w' },
    }
    expect(unwrapUnmarkedEntry(remote, geminiRemoteShape)).toEqual({ url: 'https://r.example/sse', type: 'sse' })
    expect(unwrapUnmarkedEntry(remote, antigravityRemoteShape)).toEqual({ serverUrl: 'https://r.example/sse' })
    expect(unwrapUnmarkedEntry({ command: 'npx', args: ['gh-mcp'] }, geminiRemoteShape)).toBeUndefined()
  })

  it('puts both files back as they were after connect wrapped them', async () => {
    const prevPath = process.env.PATH
    process.env.PATH = join(home, 'empty-bin')
    try {
      const gemini = join(home, '.gemini', 'settings.json')
      const antigravity = join(home, '.gemini', 'config', 'mcp_config.json')
      const geminiBefore = {
        theme: 'Default',
        mcpServers: {
          gh: { command: 'npx', args: ['gh-mcp'], cwd: '/work' },
          stream: { httpUrl: 'https://s.example/mcp', type: 'http', timeout: 5000 },
        },
      }
      const antigravityBefore = { mcpServers: { remote: { serverUrl: 'https://m.example/sse' } } }
      await put(gemini, geminiBefore)
      await put(antigravity, antigravityBefore)
      await fs.mkdir(join(home, '.gemini', 'antigravity'), { recursive: true })

      await injectMcpServer(ws, 'ws_1')
      expect((await readJson(gemini)).mcpServers.gh.command).toBe('node')
      expect((await readJson(antigravity)).mcpServers.remote.command).toBe('node')

      await disconnect({ harnesses: ['antigravity'], remaining: [] })
      expect(await readJson(gemini)).toEqual(geminiBefore)
      expect(await readJson(antigravity)).toEqual(antigravityBefore)
    } finally {
      process.env.PATH = prevPath
    }
  })
})

// ─── Files written before originals were kept ────────────────────────────────

describe('files with no record', () => {
  const RULES = '# Intutic Governance Rules (auto-generated)\n# DO NOT EDIT — managed by intutic sync daemon\n\n## SOP\n'

  it('deletes a generated rules file that git does not track', async () => {
    await put(join(ws, 'CLAUDE.md'), RULES)
    await disconnect()
    expect(existsSync(join(ws, 'CLAUDE.md'))).toBe(false)
  })

  it('restores the committed version of a rules file, or leaves a committed generated one with a note', async () => {
    const git = (...args: string[]) => execFileSync('git', ['-C', ws, ...args], { stdio: 'ignore' })
    git('init', '-q')
    git('config', 'user.email', 't@example.com')
    git('config', 'user.name', 't')
    await put(join(ws, 'CLAUDE.md'), 'team rules\n')
    await put(join(ws, 'AGENTS.md'), RULES)
    git('add', '.')
    git('commit', '-qm', 'init')
    await put(join(ws, 'CLAUDE.md'), RULES)

    const plan = await disconnect()
    expect(await read(join(ws, 'CLAUDE.md'))).toBe('team rules\n')
    expect(await read(join(ws, 'AGENTS.md'))).toBe(RULES)
    expect(plan.notes.map((n) => n.path)).toContain(join(ws, 'AGENTS.md'))
  })

  it('never touches a rules file the user wrote', async () => {
    await put(join(ws, 'CLAUDE.md'), '# My rules\n')
    await disconnect()
    expect(await read(join(ws, 'CLAUDE.md'))).toBe('# My rules\n')
  })

  it('removes only the gate entries from a hooks file, and the file when nothing else is left', async () => {
    const gate = `node "${join(ws, '.intutic', 'hooks', 'cursor-check.js')}"`
    await put(join(home, '.cursor', 'hooks.json'), {
      version: 1,
      hooks: { beforeShellExecution: [{ command: './audit.sh' }, { command: gate, failClosed: true }] },
    })
    await put(join(ws, '.cursor', 'hooks.json'), { version: 1, hooks: { preToolUse: [{ command: gate, matcher: 'Write|Delete', failClosed: true }] } })
    await disconnect()
    expect(await readJson(join(home, '.cursor', 'hooks.json'))).toEqual({ version: 1, hooks: { beforeShellExecution: [{ command: './audit.sh' }] } })
    expect(existsSync(join(ws, '.cursor', 'hooks.json'))).toBe(false)
  })

  it('removes proxy settings it recognises as Intutic\'s, says so, and leaves anyone else\'s', async () => {
    await noteProxyUrl('http://localhost:4000')
    const settings = join(home, '.codeium', 'windsurf', 'settings.json')
    await put(settings, { 'editor.fontSize': 13, 'http.proxy': 'http://127.0.0.1:4000', 'http.proxyStrictSSL': false, 'codeium.proxy': 'http://127.0.0.1:4000' })
    const plan = await disconnect()
    expect(await readJson(settings)).toEqual({ 'editor.fontSize': 13 })
    expect(plan.notes.some((n) => n.path === settings && n.message.includes('earlier'))).toBe(true)

    await put(settings, { 'http.proxy': 'http://corp-proxy:3128' })
    await disconnect()
    expect(await readJson(settings)).toEqual({ 'http.proxy': 'http://corp-proxy:3128' })
  })

  it('removes the proxy settings from the file Windsurf reads as well as the old location', async () => {
    const { windsurfSettingsPath } = await import('../../src/harness/windsurfHooks.js')
    const settings = windsurfSettingsPath()
    await put(settings, { 'http.proxy': 'http://127.0.0.1:4100', 'http.proxyStrictSSL': false, 'codeium.proxy': 'http://127.0.0.1:4100', theme: 'x' })
    await disconnect()
    expect(await readJson(settings)).toEqual({ theme: 'x' })
  })

  it('recognises the Windsurf proxy settings by the shape connect writes them in', async () => {
    const settings = join(home, '.codeium', 'windsurf', 'settings.json')
    await put(settings, { 'http.proxy': 'http://127.0.0.1:4100', 'http.proxyStrictSSL': false, 'codeium.proxy': 'http://127.0.0.1:4100', theme: 'x' })
    await disconnect()
    expect(await readJson(settings)).toEqual({ theme: 'x' })
  })

  it('learns the proxy URL from a generated file when connect predates the recorded list', async () => {
    await put(join(ws, '.env.intutic'), '# Intutic Governance Rules (auto-generated)\nexport INTUTIC_PROXY_URL="http://localhost:4100"\n')
    // Where Pi reads it, and where earlier versions wrote it.
    for (const file of [join(home, '.pi', 'agent', 'models.json'), join(home, '.pi', 'models.json')]) {
      await put(file, { providers: { openai: { baseUrl: 'http://localhost:4100/v1' }, google: { baseUrl: 'https://g' } } })
    }
    await disconnect()
    expect(await readJson(join(home, '.pi', 'agent', 'models.json'))).toEqual({ providers: { google: { baseUrl: 'https://g' } } })
    expect(await readJson(join(home, '.pi', 'models.json'))).toEqual({ providers: { google: { baseUrl: 'https://g' } } })
  })

  it('takes the inserted line back out of the Codex config, comments and all', async () => {
    await noteProxyUrl('http://localhost:4000')
    const config = join(home, '.codex', 'config.toml')
    const mine = '# my config\nmodel = "o4"\n'
    await put(config, `# Set by Intutic: routes Codex's built-in OpenAI provider through the Intutic proxy.\nopenai_base_url = "http://localhost:4000/v1"\n\n${mine}`)
    await disconnect()
    expect(await read(config)).toBe(mine)
  })

  it('says so when a deny list may hold rules it cannot tell apart', async () => {
    const gate = `node ${join(ws, '.intutic', 'hooks', 'claude-code-check.js')}`
    await put(join(ws, '.claude', 'settings.json'), {
      permissions: { deny: ['Bash'] },
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: gate }] }] },
    })
    const plan = await disconnect()
    expect(await readJson(join(ws, '.claude', 'settings.json'))).toEqual({ permissions: { deny: ['Bash'] } })
    expect(plan.notes.some((n) => n.message.includes('permissions.deny'))).toBe(true)
  })
})

// ─── Shared files and one harness at a time ──────────────────────────────────

describe('--harness', () => {
  it('leaves AGENTS.md while another harness that writes it stays connected', async () => {
    await put(join(ws, 'AGENTS.md'), 'mine\n')
    await writeOwnedFile(join(ws, 'AGENTS.md'), ws, '# Intutic Governance Rules (auto-generated)\n')
    await disconnect({ harnesses: ['grok'], remaining: ['muse-code'] })
    expect(await read(join(ws, 'AGENTS.md'))).toContain('Intutic')
    await disconnect({ harnesses: ['muse-code'], remaining: [] })
    expect(await read(join(ws, 'AGENTS.md'))).toBe('mine\n')
  })

  it('is safe when connect only got part of the way', async () => {
    await writeOwnedFile(join(ws, '.github', 'hooks', 'intutic-governance.json'), ws, '{"_comment":"Intutic governance hook"}\n')
    await fs.rm(join(ws, '.github', 'hooks', 'intutic-governance.json'))
    await disconnect()
    expect(existsSync(join(ws, '.github'))).toBe(false)
    expect(existsSync(ledgerDir(ws))).toBe(false)
  })

  it('keeps MCP wrapping away from a disconnected harness', async () => {
    await injectMcpServer(ws, 'ws_1', { skip: ['cursor'] })
    expect(existsSync(join(ws, '.cursor', 'mcp.json'))).toBe(false)
    expect(existsSync(join(ws, '.cline', 'mcp.json'))).toBe(true)
  })

  it('keeps tamper restore away from a disconnected harness', async () => {
    const hooks = join(home, '.cursor', 'hooks.json')
    await put(hooks, { hooks: {} })
    expect(await guardSettingsFile(hooks, ws, [], '', undefined, new Set(['cursor']))).toBe(false)
    expect(await readJson(hooks)).toEqual({ hooks: {} })
  })
})
