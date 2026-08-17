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
import { injectMcpServer, discoverMcpServers } from '../../src/harness/mcpAutoWrite.js'

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

  it('does not corrupt a remote (url-based) MCP server entry — no command to wrap', async () => {
    ctx = setup()
    mkdirSync(join(ctx.home, '.claude'), { recursive: true })
    writeFileSync(
      claudeCodePath(ctx.home),
      JSON.stringify({
        mcpServers: {
          'remote-sse': { url: 'https://example.com/mcp', type: 'sse' },
        },
      }, null, 2),
    )

    await injectMcpServer(ctx.root, 'ws_test')

    const written = JSON.parse(readFileSync(claudeCodePath(ctx.home), 'utf-8'))
    // Left alone: still url-based, no command, not marked wrapped.
    expect(written.mcpServers['remote-sse'].url).toBe('https://example.com/mcp')
    expect(written.mcpServers['remote-sse'].command).toBeUndefined()
    expect(written.mcpServers['remote-sse'].__intutic_wrapped).toBeUndefined()
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
