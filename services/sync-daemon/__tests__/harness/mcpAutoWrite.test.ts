/**
 * mcpAutoWrite.ts — write-if-changed idempotency and discoverMcpServers.
 *
 * Phase D makes `injectMcpServer` a continuous sync-loop invariant instead of
 * a one-shot run only from `intutic connect` (see syncLoop.ts step 3c). That
 * only works if re-running the wrap on an already-wrapped, unchanged config
 * writes zero bytes — otherwise every ~30s sync cycle churns every harness
 * config's mtime and fires a spurious filesystem-watch event. These tests pin
 * that write-if-changed behaviour, plus the new `discoverMcpServers` read-only
 * extraction that `agentReporter.ts` now uses for the `mcp_tools` facet.
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseDocument } from 'yaml'
import { injectMcpServer, discoverMcpServers, resolveProxyBin } from '../../src/harness/mcpAutoWrite.js'

/** Loosely-typed shape for reading back a wrapped Goose `mcp:` entry in
 *  assertions — this file doesn't need `McpServerEntry`'s full precision. */
interface McpTestEntry {
  command?: string
  args?: string[]
  env?: Record<string, string>
  __intutic_wrapped?: boolean
}

interface Ctx {
  home: string
  root: string
  prevHome: string | undefined
  prevUserProfile: string | undefined
}

function setup(): Ctx {
  const home = mkdtempSync(join(tmpdir(), 'intutic-mcpautowrite-home-'))
  const root = mkdtempSync(join(tmpdir(), 'intutic-mcpautowrite-root-'))
  const prevHome = process.env.HOME
  const prevUserProfile = process.env.USERPROFILE
  process.env.HOME = home
  process.env.USERPROFILE = home
  return { home, root, prevHome, prevUserProfile }
}

function teardown(ctx: Ctx): void {
  process.env.HOME = ctx.prevHome
  process.env.USERPROFILE = ctx.prevUserProfile
  rmSync(ctx.home, { recursive: true, force: true })
  rmSync(ctx.root, { recursive: true, force: true })
}

const claudeCodePath = (home: string) => join(home, '.claude.json')

describe('injectMcpServer — write-if-changed', () => {
  let ctx: Ctx

  afterEach(() => {
    if (ctx) teardown(ctx)
  })

  it('injecting into an unwrapped config writes new, wrapped content', async () => {
    ctx = setup()
    mkdirSync(join(ctx.home, '.claude'), { recursive: true })
    writeFileSync(
      claudeCodePath(ctx.home),
      JSON.stringify({ mcpServers: { github: { command: 'npx', args: ['-y', 'server-github'] } } }, null, 2),
    )

    await injectMcpServer(ctx.root, 'ws_test')

    const written = JSON.parse(readFileSync(claudeCodePath(ctx.home), 'utf-8'))
    expect(written.mcpServers.github.__intutic_wrapped).toBe(true)
    expect(written.mcpServers.github.command).toBe('node')
    expect(written.mcpServers.github.args).toContain('--server-name')
    expect(written.mcpServers.github.args[written.mcpServers.github.args.indexOf('--server-name') + 1]).toBe('github')
    // Original command survives after the `--` separator.
    expect(written.mcpServers.github.args).toContain('npx')
    expect(written.mcpServers.intutic).toBeDefined()
  })

  it('re-injecting into an already-wrapped, unchanged config writes ZERO bytes', async () => {
    ctx = setup()
    mkdirSync(join(ctx.home, '.claude'), { recursive: true })
    writeFileSync(
      claudeCodePath(ctx.home),
      JSON.stringify({ mcpServers: { github: { command: 'npx', args: ['-y', 'server-github'] } } }, null, 2),
    )

    await injectMcpServer(ctx.root, 'ws_test')
    const afterFirst = statSync(claudeCodePath(ctx.home))
    const contentAfterFirst = readFileSync(claudeCodePath(ctx.home), 'utf-8')

    await injectMcpServer(ctx.root, 'ws_test')
    const afterSecond = statSync(claudeCodePath(ctx.home))
    const contentAfterSecond = readFileSync(claudeCodePath(ctx.home), 'utf-8')

    expect(afterSecond.mtimeMs).toBe(afterFirst.mtimeMs)
    expect(contentAfterSecond).toBe(contentAfterFirst)
  })

  it('a newly-added unwrapped server is wrapped on the next cycle, leaving the already-wrapped one untouched', async () => {
    ctx = setup()
    mkdirSync(join(ctx.home, '.claude'), { recursive: true })
    writeFileSync(
      claudeCodePath(ctx.home),
      JSON.stringify({ mcpServers: { github: { command: 'npx', args: ['-y', 'server-github'] } } }, null, 2),
    )

    await injectMcpServer(ctx.root, 'ws_test')
    const wrappedGithub = JSON.parse(readFileSync(claudeCodePath(ctx.home), 'utf-8')).mcpServers.github

    // Simulate the user manually adding a new server between sync cycles —
    // read-modify-write the same way a human editor would, leaving the
    // already-wrapped entry byte-for-byte as this daemon last wrote it.
    const current = JSON.parse(readFileSync(claudeCodePath(ctx.home), 'utf-8'))
    current.mcpServers.figma = { command: 'npx', args: ['-y', 'figma-mcp'] }
    writeFileSync(claudeCodePath(ctx.home), JSON.stringify(current, null, 2) + '\n')

    await injectMcpServer(ctx.root, 'ws_test')

    const after = JSON.parse(readFileSync(claudeCodePath(ctx.home), 'utf-8'))
    // Already-wrapped entry: untouched (same structure, not double-wrapped).
    expect(after.mcpServers.github).toEqual(wrappedGithub)
    // New entry: now wrapped.
    expect(after.mcpServers.figma.__intutic_wrapped).toBe(true)
    expect(after.mcpServers.figma.args).toContain('--server-name')
  })

  // M2: TD-354's stdio→HTTP bridge phase supersedes the old "remote entries
  // are left alone" behaviour — a remote (url-based) entry now gets wrapped
  // into the proxy's bridge mode (`--remote-url`/`--remote-transport`),
  // exactly like a stdio entry gets wrapped with `--`.
  it('wraps a remote (url-based) MCP server entry into the proxy\'s bridge mode', async () => {
    ctx = setup()
    mkdirSync(join(ctx.home, '.claude'), { recursive: true })
    writeFileSync(
      claudeCodePath(ctx.home),
      JSON.stringify({
        mcpServers: {
          'remote-sse': { url: 'https://example.com/mcp', type: 'sse' },
          'remote-http': { url: 'https://example.com/other', headers: { Authorization: 'Bearer secret-token' } },
        },
      }, null, 2),
    )

    await injectMcpServer(ctx.root, 'ws_test')

    const written = JSON.parse(readFileSync(claudeCodePath(ctx.home), 'utf-8'))

    const sse = written.mcpServers['remote-sse']
    expect(sse.__intutic_wrapped).toBe(true)
    expect(sse.command).toBe('node')
    expect(sse.args).toContain('--remote-url')
    expect(sse.args[sse.args.indexOf('--remote-url') + 1]).toBe('https://example.com/mcp')
    expect(sse.args).toContain('--remote-transport')
    expect(sse.args[sse.args.indexOf('--remote-transport') + 1]).toBe('sse')
    expect(sse.args).toContain('--server-name')
    expect(sse.args[sse.args.indexOf('--server-name') + 1]).toBe('remote-sse')
    // No stdio `--` separator — there is no downstream command to pass after it.
    expect(sse.args).not.toContain('--')
    // Original url/type preserved for unwrap + honest discovery reporting.
    expect(sse.__intutic_original).toEqual({ url: 'https://example.com/mcp', type: 'sse' })
    // No headers on the original entry — no INTUTIC_REMOTE_HEADERS env var.
    expect(sse.env.INTUTIC_REMOTE_HEADERS).toBeUndefined()

    const http = written.mcpServers['remote-http']
    expect(http.__intutic_wrapped).toBe(true)
    expect(http.args[http.args.indexOf('--remote-transport') + 1]).toBe('http') // default when `type` absent
    // Headers ride via env, never argv — `ps` visibility.
    expect(http.args.join(' ')).not.toContain('secret-token')
    expect(JSON.parse(http.env.INTUTIC_REMOTE_HEADERS)).toEqual({ Authorization: 'Bearer secret-token' })
    expect(http.__intutic_original).toEqual({ url: 'https://example.com/other', headers: { Authorization: 'Bearer secret-token' } })
  })

  it('re-injecting an already-wrapped remote entry writes ZERO bytes (idempotence, same as the stdio-wrap case)', async () => {
    ctx = setup()
    mkdirSync(join(ctx.home, '.claude'), { recursive: true })
    writeFileSync(
      claudeCodePath(ctx.home),
      JSON.stringify({ mcpServers: { 'remote-sse': { url: 'https://example.com/mcp', type: 'sse' } } }, null, 2),
    )

    await injectMcpServer(ctx.root, 'ws_test')
    const afterFirst = statSync(claudeCodePath(ctx.home))
    const contentAfterFirst = readFileSync(claudeCodePath(ctx.home), 'utf-8')

    await injectMcpServer(ctx.root, 'ws_test')
    const afterSecond = statSync(claudeCodePath(ctx.home))
    const contentAfterSecond = readFileSync(claudeCodePath(ctx.home), 'utf-8')

    expect(afterSecond.mtimeMs).toBe(afterFirst.mtimeMs)
    expect(contentAfterSecond).toBe(contentAfterFirst)
  })
})

describe('discoverMcpServers', () => {
  let ctx: Ctx

  afterEach(() => {
    if (ctx) teardown(ctx)
  })

  it('discovers an object-shaped harness config (Claude Code) without writing anything', async () => {
    ctx = setup()
    mkdirSync(join(ctx.home, '.claude'), { recursive: true })
    writeFileSync(
      claudeCodePath(ctx.home),
      JSON.stringify({ mcpServers: { github: { command: 'npx', args: ['-y', 'server-github'] } } }, null, 2),
    )
    const before = readFileSync(claudeCodePath(ctx.home), 'utf-8')

    const found = await discoverMcpServers(ctx.root)

    const after = readFileSync(claudeCodePath(ctx.home), 'utf-8')
    expect(after).toBe(before) // read-only

    expect(found).toContainEqual({ server: 'github', harness: 'claude-code', transport: 'stdio', wrapped: false })
  })

  it('discovers an array-shaped harness config (Continue)', async () => {
    ctx = setup()
    mkdirSync(join(ctx.home, '.continue'), { recursive: true })
    writeFileSync(
      join(ctx.home, '.continue', 'config.json'),
      JSON.stringify({ mcpServers: [{ name: 'figma', command: 'npx', args: ['-y', 'figma-mcp'] }] }, null, 2),
    )

    const found = await discoverMcpServers(ctx.root)

    expect(found).toContainEqual({ server: 'figma', harness: 'continue', transport: 'stdio', wrapped: false })
  })

  it('discovers Goose\'s YAML mcp: block via line scan', async () => {
    ctx = setup()
    mkdirSync(join(ctx.home, '.config', 'goose'), { recursive: true })
    writeFileSync(
      join(ctx.home, '.config', 'goose', 'config.yaml'),
      ['mcp:', '  github:', '    command: npx', '    args: ["-y", "server-github"]', 'other: value', ''].join('\n'),
    )

    const found = await discoverMcpServers(ctx.root)

    expect(found).toContainEqual({ server: 'github', harness: 'goose', transport: 'stdio', wrapped: false })
  })

  it('classifies a remote url-based entry as http/sse and never reports it wrapped', async () => {
    ctx = setup()
    mkdirSync(join(ctx.home, '.claude'), { recursive: true })
    writeFileSync(
      claudeCodePath(ctx.home),
      JSON.stringify({
        mcpServers: {
          'remote-sse': { url: 'https://example.com/mcp', type: 'sse' },
          'remote-http': { url: 'https://example.com/other' },
        },
      }, null, 2),
    )

    const found = await discoverMcpServers(ctx.root)

    expect(found).toContainEqual({ server: 'remote-sse', harness: 'claude-code', transport: 'sse', wrapped: false })
    expect(found).toContainEqual({ server: 'remote-http', harness: 'claude-code', transport: 'http', wrapped: false })
  })

  // M2: `classifyEntry` must read `__intutic_original` FIRST — a wrapped
  // remote entry's top-level shape is `command: 'node'` (the bridge), which
  // would misreport as stdio if that were checked first. Visibility must
  // stay honest per the task's own framing.
  it('reports a WRAPPED remote entry\'s true transport (http/sse), never stdio, once bridge-wrapped', async () => {
    ctx = setup()
    mkdirSync(join(ctx.home, '.claude'), { recursive: true })
    writeFileSync(
      claudeCodePath(ctx.home),
      JSON.stringify({
        mcpServers: {
          'remote-sse': { url: 'https://example.com/mcp', type: 'sse' },
          'remote-http': { url: 'https://example.com/other' },
        },
      }, null, 2),
    )

    await injectMcpServer(ctx.root, 'ws_test')
    const found = await discoverMcpServers(ctx.root)

    expect(found).toContainEqual({ server: 'remote-sse', harness: 'claude-code', transport: 'sse', wrapped: true })
    expect(found).toContainEqual({ server: 'remote-http', harness: 'claude-code', transport: 'http', wrapped: true })
    expect(found.find((s) => s.server === 'remote-sse')?.transport).not.toBe('stdio')
  })

  it('excludes the intutic server itself and reflects wrapped:true after injection', async () => {
    ctx = setup()
    mkdirSync(join(ctx.home, '.claude'), { recursive: true })
    writeFileSync(
      claudeCodePath(ctx.home),
      JSON.stringify({ mcpServers: { github: { command: 'npx', args: ['-y', 'server-github'] } } }, null, 2),
    )

    await injectMcpServer(ctx.root, 'ws_test')
    const found = await discoverMcpServers(ctx.root)

    expect(found.some((s) => s.server === 'intutic')).toBe(false)
    expect(found).toContainEqual({ server: 'github', harness: 'claude-code', transport: 'stdio', wrapped: true })
  })

  it('returns an empty list when no harness config exists anywhere', async () => {
    ctx = setup()
    const found = await discoverMcpServers(ctx.root)
    expect(found).toEqual([])
  })
})

// M2: Goose's config.yaml is now structurally parsed and edited (the `yaml`
// package's `parseDocument`) instead of append-only string injection, so a
// remote MCP server declared there gets the SAME bridge-wrap coverage a
// remote entry in any JSON-shaped harness config gets. These tests pin the
// two properties that make that safe on a user's hand-maintained file:
// comments/formatting survive an edit that doesn't touch them, and a file
// that does not parse as YAML at all falls back to the pre-existing
// append-only injection rather than being corrupted.
describe('Goose YAML structural editing', () => {
  let ctx: Ctx
  const gooseConfigPath = (home: string) => join(home, '.config', 'goose', 'config.yaml')

  afterEach(() => {
    if (ctx) teardown(ctx)
  })

  it('wraps a stdio and a remote Goose MCP entry while preserving unrelated comments and keys', async () => {
    ctx = setup()
    mkdirSync(join(ctx.home, '.config', 'goose'), { recursive: true })
    const original = [
      '# hand-maintained goose config — do not reorder',
      'provider:',
      '  host: https://api.example.com  # my provider host',
      'mcp:',
      '  github:',
      '    command: npx',
      '    args: ["-y", "server-github"]',
      '  remote-thing:',
      '    url: https://example.com/mcp',
      '    type: sse',
      '',
    ].join('\n')
    writeFileSync(gooseConfigPath(ctx.home), original)

    await injectMcpServer(ctx.root, 'ws_test')

    const written = readFileSync(gooseConfigPath(ctx.home), 'utf-8')
    // Unrelated content survives byte-for-byte in spirit: comment text and
    // the untouched `provider:` block are still present.
    expect(written).toContain('# hand-maintained goose config — do not reorder')
    expect(written).toContain('host: https://api.example.com')
    expect(written).toContain('my provider host')

    const doc = parseDocument(written)
    const parsed = doc.toJS() as { mcp: Record<string, McpTestEntry> }
    expect(parsed.mcp.intutic).toBeDefined()
    expect(parsed.mcp.github.__intutic_wrapped).toBe(true)
    expect(parsed.mcp.github.command).toBe('node')
    expect(parsed.mcp.github.args).toContain('npx')
    expect(parsed.mcp['remote-thing'].__intutic_wrapped).toBe(true)
    expect(parsed.mcp['remote-thing'].args).toContain('--remote-url')
    expect(parsed.mcp['remote-thing'].args).toContain('--remote-transport')
  })

  it('re-injecting an already-wrapped Goose config writes ZERO bytes (idempotence)', async () => {
    ctx = setup()
    mkdirSync(join(ctx.home, '.config', 'goose'), { recursive: true })
    writeFileSync(
      gooseConfigPath(ctx.home),
      ['mcp:', '  github:', '    command: npx', '    args: ["-y", "server-github"]', ''].join('\n'),
    )

    await injectMcpServer(ctx.root, 'ws_test')
    const afterFirst = statSync(gooseConfigPath(ctx.home))
    const contentAfterFirst = readFileSync(gooseConfigPath(ctx.home), 'utf-8')

    await injectMcpServer(ctx.root, 'ws_test')
    const afterSecond = statSync(gooseConfigPath(ctx.home))
    const contentAfterSecond = readFileSync(gooseConfigPath(ctx.home), 'utf-8')

    expect(afterSecond.mtimeMs).toBe(afterFirst.mtimeMs)
    expect(contentAfterSecond).toBe(contentAfterFirst)
  })

  it('falls back to append-only text injection when config.yaml does not parse as YAML, without corrupting it', async () => {
    ctx = setup()
    mkdirSync(join(ctx.home, '.config', 'goose'), { recursive: true })
    // Tabs as indentation are invalid YAML — parseDocument reports an error.
    const malformed = 'mcp:\n  github:\n  command: npx\n\tbad_tab: true\n'
    writeFileSync(gooseConfigPath(ctx.home), malformed)

    await injectMcpServer(ctx.root, 'ws_test')

    const written = readFileSync(gooseConfigPath(ctx.home), 'utf-8')
    // The malformed original content is still present, untouched...
    expect(written).toContain(malformed.trimEnd())
    // ...with the append-only `intutic:` block appended after it, the same
    // shape the pre-YAML-dep fallback always produced.
    expect(written).toContain('intutic:')
    expect(written.indexOf(malformed.trimEnd())).toBeLessThan(written.indexOf('intutic:'))
  })

  it('creates a fresh mcp: block via structural YAML when config.yaml has no mcp: section yet', async () => {
    ctx = setup()
    mkdirSync(join(ctx.home, '.config', 'goose'), { recursive: true })
    writeFileSync(gooseConfigPath(ctx.home), 'provider:\n  host: https://api.example.com\n')

    await injectMcpServer(ctx.root, 'ws_test')

    const written = readFileSync(gooseConfigPath(ctx.home), 'utf-8')
    const doc = parseDocument(written)
    const parsed = doc.toJS() as { provider: { host: string }; mcp: Record<string, McpTestEntry> }
    expect(parsed.provider.host).toBe('https://api.example.com')
    expect(parsed.mcp.intutic).toBeDefined()
  })
})

describe('injectMcpServer — OpenCode opencode.json mcp block (TD-487)', () => {
  let ctx: Ctx
  let prevXdg: string | undefined

  afterEach(() => {
    if (ctx) teardown(ctx)
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prevXdg
  })

  function setupOpenCode(): Ctx {
    prevXdg = process.env.XDG_CONFIG_HOME
    delete process.env.XDG_CONFIG_HOME
    return setup()
  }

  const projectPath = (c: Ctx) => join(c.root, 'opencode.json')
  const globalPath = (c: Ctx) => join(c.home, '.config', 'opencode', 'opencode.json')

  const userConfig = {
    $schema: 'https://opencode.ai/config.json',
    provider: { anthropic: { options: { baseURL: 'http://127.0.0.1:4000' } } },
    permission: { bash: { 'rm -rf *': 'deny' } },
    mcp: {
      github: {
        type: 'local',
        command: ['npx', '-y', 'server-github'],
        environment: { GITHUB_TOKEN: '{env:GITHUB_TOKEN}' },
        enabled: true,
        timeout: 9000,
      },
      docs: { type: 'remote', url: 'https://docs.example/mcp', headers: { 'X-Team': 'core' } },
      sso: { type: 'remote', url: 'https://sso.example/mcp', oauth: { clientId: 'abc' } },
    },
    theme: 'opencode',
  }

  it('wraps a local server: ["node", <proxy>, "--workspace-id", ws, "--server-name", name, "--", ...original]', async () => {
    ctx = setupOpenCode()
    writeFileSync(projectPath(ctx), JSON.stringify(userConfig, null, 2) + '\n')

    await injectMcpServer(ctx.root, 'ws_test')

    const written = JSON.parse(readFileSync(projectPath(ctx), 'utf-8'))
    const gh = written.mcp.github
    expect(gh.type).toBe('local')
    expect(gh.command[0]).toBe('node')
    expect(gh.command[1]).toMatch(/mcp-(governance-)?proxy[\\/]dist[\\/]index\.js$/)
    expect(gh.command.slice(2)).toEqual([
      '--workspace-id', 'ws_test', '--server-name', 'github', '--', 'npx', '-y', 'server-github',
    ])
    expect(gh.environment).toEqual({ GITHUB_TOKEN: '{env:GITHUB_TOKEN}', INTUTIC_WORKSPACE_ID: 'ws_test' })
    // OpenCode keys survive; no marker key the OpenCode schema does not define.
    expect(gh.enabled).toBe(true)
    expect(gh.timeout).toBe(9000)
    expect(Object.keys(gh).sort()).toEqual(['command', 'enabled', 'environment', 'timeout', 'type'])
    expect(written.mcp.intutic).toMatchObject({ type: 'local' })
    expect(written.mcp.intutic.command[0]).toBe('node')
  })

  it('wraps a remote server through the bridge, headers in env, and leaves an OAuth remote alone', async () => {
    ctx = setupOpenCode()
    writeFileSync(projectPath(ctx), JSON.stringify(userConfig, null, 2) + '\n')

    await injectMcpServer(ctx.root, 'ws_test')

    const written = JSON.parse(readFileSync(projectPath(ctx), 'utf-8'))
    const docs = written.mcp.docs
    expect(docs.type).toBe('local')
    expect(docs.command.slice(2)).toEqual([
      '--workspace-id', 'ws_test', '--server-name', 'docs',
      '--remote-url', 'https://docs.example/mcp', '--remote-transport', 'http',
    ])
    expect(JSON.parse(docs.environment.INTUTIC_REMOTE_HEADERS)).toEqual({ 'X-Team': 'core' })
    expect(Object.keys(docs).sort()).toEqual(['command', 'environment', 'type'])
    // The bridge forwards static headers only; an OAuth server would stop authenticating.
    expect(written.mcp.sso).toEqual(userConfig.mcp.sso)
  })

  it('never touches non-mcp keys, keeps their order and the file\'s indentation', async () => {
    ctx = setupOpenCode()
    writeFileSync(projectPath(ctx), JSON.stringify(userConfig, null, 4) + '\n')

    await injectMcpServer(ctx.root, 'ws_test')

    const raw = readFileSync(projectPath(ctx), 'utf-8')
    const written = JSON.parse(raw)
    expect(Object.keys(written)).toEqual(Object.keys(userConfig))
    for (const k of ['$schema', 'provider', 'permission', 'theme'] as const) {
      expect(written[k]).toEqual(userConfig[k])
    }
    expect(raw).toMatch(/^\{\n {4}"\$schema"/)
    expect(raw.endsWith('}\n')).toBe(true)
  })

  it('is idempotent: an already-wrapped config (detected from the command shape) is written zero times', async () => {
    ctx = setupOpenCode()
    writeFileSync(projectPath(ctx), JSON.stringify(userConfig, null, 2) + '\n')
    await injectMcpServer(ctx.root, 'ws_test')
    const first = readFileSync(projectPath(ctx), 'utf-8')
    const mtime = statSync(projectPath(ctx)).mtimeMs

    await injectMcpServer(ctx.root, 'ws_test')

    expect(readFileSync(projectPath(ctx), 'utf-8')).toBe(first)
    expect(statSync(projectPath(ctx)).mtimeMs).toBe(mtime)
    const gh = JSON.parse(first).mcp.github
    expect(gh.command.filter((a: string) => a === '--workspace-id')).toHaveLength(1)
  })

  it('wraps the global config too, never creates a missing file, and skips a JSONC file rather than stripping its comments', async () => {
    ctx = setupOpenCode()
    mkdirSync(join(ctx.home, '.config', 'opencode'), { recursive: true })
    writeFileSync(globalPath(ctx), JSON.stringify({ mcp: { fs: { type: 'local', command: ['mcp-fs', '/tmp'] } } }))
    const jsonc = '{\n  // my servers\n  "mcp": { "x": { "type": "local", "command": ["x"] } }\n}\n'
    const otherRoot = mkdtempSync(join(tmpdir(), 'intutic-mcpautowrite-oc-'))
    try {
      writeFileSync(join(otherRoot, 'opencode.json'), jsonc)

      await injectMcpServer(ctx.root, 'ws_test')
      await injectMcpServer(otherRoot, 'ws_test')

      const global = JSON.parse(readFileSync(globalPath(ctx), 'utf-8'))
      expect(global.mcp.fs.command.slice(-3)).toEqual(['--', 'mcp-fs', '/tmp'])
      expect(() => statSync(projectPath(ctx))).toThrow()
      expect(readFileSync(join(otherRoot, 'opencode.json'), 'utf-8')).toBe(jsonc)
    } finally {
      rmSync(otherRoot, { recursive: true, force: true })
    }
  })

  it('discoverMcpServers reports OpenCode servers with their true transport and wrapped status', async () => {
    ctx = setupOpenCode()
    writeFileSync(projectPath(ctx), JSON.stringify(userConfig, null, 2) + '\n')

    const before = (await discoverMcpServers(ctx.root)).filter((s) => s.harness === 'opencode')
    expect(before).toEqual(expect.arrayContaining([
      { server: 'github', harness: 'opencode', transport: 'stdio', wrapped: false },
      { server: 'docs', harness: 'opencode', transport: 'http', wrapped: false },
    ]))

    await injectMcpServer(ctx.root, 'ws_test')

    const after = (await discoverMcpServers(ctx.root)).filter((s) => s.harness === 'opencode')
    expect(after).toEqual(expect.arrayContaining([
      { server: 'github', harness: 'opencode', transport: 'stdio', wrapped: true },
      { server: 'docs', harness: 'opencode', transport: 'http', wrapped: true },
      { server: 'sso', harness: 'opencode', transport: 'http', wrapped: false },
    ]))
    expect(after.some((s) => s.server === 'intutic')).toBe(false)
  })
})

describe('Claude Code target — ~/.claude.json, merged', () => {
  let ctx: Ctx

  afterEach(() => {
    if (ctx) teardown(ctx)
  })

  it('wraps user- and local-scope servers and keeps the rest of Claude Code\'s state', async () => {
    ctx = setup()
    writeFileSync(claudeCodePath(ctx.home), JSON.stringify({
      numStartups: 7,
      mcpServers: { github: { command: 'npx', args: ['-y', 'gh-mcp'] } },
      projects: {
        [ctx.root]: { allowedTools: ['Bash'], mcpServers: { db: { command: 'db-mcp' } } },
        '/other/project': { mcpServers: { other: { command: 'other-mcp' } } },
      },
    }))

    await injectMcpServer(ctx.root, 'ws_test')

    const written = JSON.parse(readFileSync(claudeCodePath(ctx.home), 'utf-8'))
    expect(written.numStartups).toBe(7)
    expect(written.mcpServers.github.__intutic_wrapped).toBe(true)
    expect(written.mcpServers.intutic).toBeDefined()
    expect(written.projects[ctx.root].allowedTools).toEqual(['Bash'])
    expect(written.projects[ctx.root].mcpServers.db.__intutic_wrapped).toBe(true)
    // Another project's local servers are that project's business.
    expect(written.projects['/other/project'].mcpServers.other).toEqual({ command: 'other-mcp' })
  })

  it('does not create ~/.claude.json, and leaves one that does not parse untouched', async () => {
    ctx = setup()
    await injectMcpServer(ctx.root, 'ws_test')
    expect(() => statSync(claudeCodePath(ctx.home))).toThrow()

    const broken = '{ "mcpServers": { }, \n'
    writeFileSync(claudeCodePath(ctx.home), broken)
    await injectMcpServer(ctx.root, 'ws_test')
    expect(readFileSync(claudeCodePath(ctx.home), 'utf-8')).toBe(broken)
  })
})

describe("Claude Code project scope — the repo's .mcp.json, governed through local-scope shadows", () => {
  let ctx: Ctx

  afterEach(() => {
    if (ctx) teardown(ctx)
  })

  const projectMcp = (root: string) => join(root, '.mcp.json')
  const read = () => JSON.parse(readFileSync(claudeCodePath(ctx.home), 'utf-8'))

  function withProject(project: Record<string, unknown>, servers: Record<string, unknown>): void {
    writeFileSync(claudeCodePath(ctx.home), JSON.stringify({ projects: { [ctx.root]: project } }))
    writeFileSync(projectMcp(ctx.root), JSON.stringify({ mcpServers: servers }, null, 2))
  }

  it('shadows each approved server at local scope, wrapped, and never writes the shared .mcp.json', async () => {
    ctx = setup()
    withProject(
      { enabledMcpjsonServers: ['linear', 'pg'] },
      {
        linear: { type: 'sse', url: 'https://mcp.linear.app/sse' },
        pg: { command: 'pg-mcp', args: ['--ro'] },
        unapproved: { command: 'sketchy-mcp' },
      },
    )
    const before = readFileSync(projectMcp(ctx.root), 'utf-8')

    await injectMcpServer(ctx.root, 'ws_test')

    expect(readFileSync(projectMcp(ctx.root), 'utf-8')).toBe(before)
    const local = read().projects[ctx.root].mcpServers
    expect(local.pg).toMatchObject({ command: 'node', __intutic_wrapped: true, __intutic_shadow_of: 'project' })
    expect(local.pg.args.slice(-4)).toEqual(['pg', '--', 'pg-mcp', '--ro'])
    expect(local.linear).toMatchObject({ __intutic_wrapped: true, __intutic_shadow_of: 'project' })
    expect(local.linear.args).toContain('--remote-url')
    // Claude Code never started it without approval, and neither does a shadow.
    expect(local.unapproved).toBeUndefined()
  })

  it("leaves a user's own local-scope server of the same name alone", async () => {
    ctx = setup()
    withProject(
      { enableAllProjectMcpServers: true, mcpServers: { pg: { command: 'my-own-pg' } } },
      { pg: { command: 'team-pg' } },
    )
    await injectMcpServer(ctx.root, 'ws_test')
    const pg = read().projects[ctx.root].mcpServers.pg
    expect(pg.__intutic_wrapped).toBe(true)
    expect(pg.__intutic_shadow_of).toBeUndefined()
    expect(pg.args).toContain('my-own-pg')
    expect(pg.args).not.toContain('team-pg')
  })

  it('honours approvals in settings files, and a disable anywhere wins', async () => {
    ctx = setup()
    withProject({}, { a: { command: 'a-mcp' }, b: { command: 'b-mcp' } })
    mkdirSync(join(ctx.root, '.claude'), { recursive: true })
    writeFileSync(join(ctx.root, '.claude', 'settings.json'), JSON.stringify({ enableAllProjectMcpServers: true }))
    writeFileSync(join(ctx.root, '.claude', 'settings.local.json'), JSON.stringify({ disabledMcpjsonServers: ['b'] }))
    await injectMcpServer(ctx.root, 'ws_test')
    const local = read().projects[ctx.root].mcpServers
    expect(local.a.__intutic_shadow_of).toBe('project')
    expect(local.b).toBeUndefined()
  })

  it('is idempotent, follows the source, and removes a shadow whose server or approval is gone', async () => {
    ctx = setup()
    withProject({ enabledMcpjsonServers: ['pg', 'gone'] }, { pg: { command: 'pg-mcp' }, gone: { command: 'gone-mcp' } })
    await injectMcpServer(ctx.root, 'ws_test')
    const mtime = statSync(claudeCodePath(ctx.home)).mtimeMs
    await new Promise((r) => setTimeout(r, 20))
    await injectMcpServer(ctx.root, 'ws_test')
    expect(statSync(claudeCodePath(ctx.home)).mtimeMs).toBe(mtime)

    // The team changes pg's command and drops `gone`.
    writeFileSync(projectMcp(ctx.root), JSON.stringify({ mcpServers: { pg: { command: 'pg-mcp-v2' } } }))
    await injectMcpServer(ctx.root, 'ws_test')
    let local = read().projects[ctx.root].mcpServers
    expect(local.pg.args).toContain('pg-mcp-v2')
    expect(local.gone).toBeUndefined()

    // The user revokes approval: the shadow goes, and the project is back to what .mcp.json says.
    const state = read()
    state.projects[ctx.root].enabledMcpjsonServers = []
    writeFileSync(claudeCodePath(ctx.home), JSON.stringify(state))
    await injectMcpServer(ctx.root, 'ws_test')
    local = read().projects[ctx.root].mcpServers
    expect(local).toEqual({})
  })

  it('does nothing for a project Claude Code has never opened', async () => {
    ctx = setup()
    writeFileSync(claudeCodePath(ctx.home), JSON.stringify({ projects: {} }))
    writeFileSync(projectMcp(ctx.root), JSON.stringify({ mcpServers: { pg: { command: 'pg-mcp' } } }))
    await injectMcpServer(ctx.root, 'ws_test')
    expect(read().projects[ctx.root]).toBeUndefined()
  })

  it('reports a shadowed project server as wrapped, and an unapproved one as not', async () => {
    ctx = setup()
    withProject({ enabledMcpjsonServers: ['pg'] }, { pg: { command: 'pg-mcp' }, other: { command: 'other-mcp' } })
    await injectMcpServer(ctx.root, 'ws_test')
    const found = (await discoverMcpServers(ctx.root)).filter((s) => s.harness === 'claude-code')
    expect(found.find((s) => s.server === 'pg')).toMatchObject({ wrapped: true, transport: 'stdio' })
    expect(found.find((s) => s.server === 'other')).toMatchObject({ wrapped: false })
  })
})

describe('resolveProxyBin', () => {
  it('finds the proxy installed alongside the daemon, not under the user\'s project', () => {
    // A project with no node_modules and no packages/ — the global-install case.
    const project = mkdtempSync(join(tmpdir(), 'intutic-proxybin-'))
    try {
      const bin = resolveProxyBin(project)
      expect(bin.startsWith(project)).toBe(false)
      expect(statSync(bin).isFile()).toBe(true)
      expect(bin).toMatch(/(?:@intutic[\\/]mcp-governance-proxy|packages[\\/]mcp-proxy)[\\/]dist[\\/]index\.js$/)
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })
})
