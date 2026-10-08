/**
 * inventory.test.ts — what one machine's AI inventory says, and what it must
 * never carry: file contents, environment values, MCP command lines, or a
 * URL's credentials and query string.
 *
 * @module
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { collectDeviceInventory, reportDeviceInventory } from '../src/inventory.js'
import { recordGateSightings } from '../src/harness/gateSightings.js'

let home: string
let root: string
const prevHome = process.env.HOME
const prevUserProfile = process.env.USERPROFILE

function setup(): void {
  home = mkdtempSync(join(tmpdir(), 'intutic-inventory-home-'))
  root = join(home, 'code', 'app')
  mkdirSync(root, { recursive: true })
  process.env.HOME = home
  process.env.USERPROFILE = home
  // The local proxy is not running in a test; the probe facet is simply absent.
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch)
}

afterEach(() => {
  vi.unstubAllGlobals()
  process.env.HOME = prevHome
  process.env.USERPROFILE = prevUserProfile
  rmSync(home, { recursive: true, force: true })
})

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
}

// Assembled at run time: no credential-shaped literal in source.
const SECRET = ['s3cr', 'et-', 'v4lue-', 'do-not-send'].join('')

describe('collectDeviceInventory', () => {
  it('reports configured and detected harnesses with their gate state', async () => {
    setup()
    write(join(root, '.intutic', 'hooks', 'cursor-check.js'), '// gate')
    await recordGateSightings(root, [
      { event: 'tool_allowed', harnessType: 'cursor', timestamp: '2026-10-08T10:00:00.000Z' },
      { event: 'guards_disabled', harnessType: 'cursor', timestamp: '2026-10-08T09:00:00.000Z' },
    ])

    const inv = await collectDeviceInventory({
      workspaceRoot: root,
      configured: ['cursor', 'claude-code'],
      detected: [{ type: 'cursor' }, { type: 'cline', version: '3.2.1' }, { type: 'langchain' }, { type: 'aider' }],
      home,
    })

    const byType = Object.fromEntries(inv.harnesses.map((h) => [h.type, h]))
    expect(Object.keys(byType)).toEqual(['aider', 'claude-code', 'cline', 'cursor', 'langchain'])
    expect(byType.cursor).toEqual({
      type: 'cursor',
      configured: true,
      gateKind: 'hook',
      gateInstalled: true,
      gateFile: '~/code/app/.intutic/hooks/cursor-check.js',
      lastHookEventAt: '2026-10-08T10:00:00.000Z',
      guardsDisabledAt: '2026-10-08T09:00:00.000Z',
    })
    // Configured but its gate file is gone.
    expect(byType['claude-code']).toMatchObject({ configured: true, gateKind: 'hook', gateInstalled: false, lastHookEventAt: null })
    expect(byType['claude-code']).not.toHaveProperty('gateFile')
    // Detected, never connected.
    expect(byType.cline).toMatchObject({ configured: false, version: '3.2.1', gateInstalled: false })
    // Not a file the daemon writes, so nothing to check on disk.
    expect(byType.langchain).toMatchObject({ gateKind: 'sdk', gateInstalled: null })
    expect(byType.aider).toMatchObject({ gateKind: 'none', gateInstalled: null })
    expect(inv.workspace).toBe('~/code/app')
    expect(inv.schemaVersion).toBe(1)
    expect(inv).not.toHaveProperty('guardProbes')
  })

  it('reports MCP servers without command lines, env values or URL credentials', async () => {
    setup()
    write(join(home, '.claude.json'), JSON.stringify({
      mcpServers: {
        github: { command: 'npx', args: ['-y', 'server-github', `--token=${SECRET}`], env: { GITHUB_TOKEN: SECRET } },
        remote: { url: `https://user:${SECRET}@mcp.example.com/v1/sse?key=${SECRET}`, type: 'sse', headers: { Authorization: SECRET } },
      },
    }))

    const inv = await collectDeviceInventory({ workspaceRoot: root, configured: [], detected: [], home })

    expect(inv.mcpServers).toEqual(expect.arrayContaining([
      { server: 'github', harness: 'claude-code', transport: 'stdio', wrapped: false },
      { server: 'remote', harness: 'claude-code', transport: 'sse', wrapped: false, endpoint: 'https://mcp.example.com/v1/sse' },
    ]))
    expect(JSON.stringify(inv)).not.toContain(SECRET)
    expect(JSON.stringify(inv)).not.toContain('server-github')
  })

  it('reports skill bundles by name, source and hash, never their contents', async () => {
    setup()
    write(join(root, '.agents', 'skills', 'deploy', 'SKILL.md'), `# Deploy\nUse ${SECRET} to deploy.\n`)
    write(join(root, '.agents', 'skills', 'deploy', 'run.sh'), `echo ${SECRET}\n`)
    write(join(home, '.claude', 'skills', 'review', 'SKILL.md'), '# Review\n')

    const inv = await collectDeviceInventory({ workspaceRoot: root, configured: [], detected: [], home })

    expect(inv.skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'deploy', source: '.agents/skills', scanned: true, scriptCount: 1, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }),
      expect.objectContaining({ name: 'review', source: '~/.claude/skills', scanned: true, scriptCount: 0 }),
    ]))
    expect(JSON.stringify(inv)).not.toContain(SECRET)
    expect(JSON.stringify(inv)).not.toContain(home)
  })

  it('carries the local proxy’s guard-probe result when it answers', async () => {
    setup()
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ probes: [{ probe_id: 'p1', passed: false }], total: 4, failed: 1, ran_at: 1700000000 }),
    })) as unknown as typeof fetch)
    const inv = await collectDeviceInventory({ workspaceRoot: root, configured: [], detected: [], home })
    expect(inv.guardProbes).toEqual({ total: 4, failed: 1, ranAt: 1700000000 })
  })
})

describe('reportDeviceInventory', () => {
  it('posts an inventory-only report to the agent report path', async () => {
    setup()
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }))
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
    const inventory = await collectDeviceInventory({ workspaceRoot: root, configured: [], detected: [], home })
    const device = { fingerprint: 'f'.repeat(32), hostname: 'dev-laptop', platform: 'darwin', cliVersion: '2.2.0' }

    expect(await reportDeviceInventory('http://cp.test', 'vk_test', device, inventory)).toBe(true)

    const [url, init] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit]
    expect(url).toBe('http://cp.test/api/v1/agents/report')
    const body = JSON.parse(String(init.body))
    expect(body.device).toEqual(device)
    expect(body.facets.inventory).toEqual(inventory)
    expect(body).not.toHaveProperty('agentKey')
  })

  it('returns false, never throws, when the control plane refuses or is down', async () => {
    setup()
    const inventory = await collectDeviceInventory({ workspaceRoot: root, configured: [], detected: [], home })
    const device = { fingerprint: 'f'.repeat(32), hostname: 'h', platform: 'linux' }
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 400 })) as unknown as typeof fetch)
    expect(await reportDeviceInventory('http://cp.test', 'vk_test', device, inventory)).toBe(false)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down') }) as unknown as typeof fetch)
    expect(await reportDeviceInventory('http://cp.test', 'vk_test', device, inventory)).toBe(false)
  })
})
