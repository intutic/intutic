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
import { injectMcpServer, discoverMcpServers } from '../../src/harness/mcpAutoWrite.js'

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

const claudeCodePath = (home: string) => join(home, '.claude', 'mcp.json')

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
