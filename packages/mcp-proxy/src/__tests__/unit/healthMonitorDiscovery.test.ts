/**
 * Which harness configs the MCP daemon discovers servers in. Claude Code keeps
 * them in ~/.claude.json (user scope, and local scope per project) and in each
 * project's .mcp.json — not in ~/.claude/mcp.json, which it never reads.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverServers } from '../../daemon/healthMonitor.js'

describe('discoverServers', () => {
  let home: string
  let project: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'intutic-discover-'))
    project = join(home, 'work', 'repo')
    mkdirSync(project, { recursive: true })
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it("reads Claude Code's user, local and project scopes", () => {
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: { github: { command: 'github-mcp' }, intutic: { command: 'intutic-mcp-proxy' } },
        projects: { [project]: { mcpServers: { linear: { url: 'https://mcp.linear.app/sse' } } } },
      }),
    )
    writeFileSync(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { postgres: { command: 'pg-mcp' } } }))

    const names = discoverServers(home).map((s) => s.name).sort()
    expect(names).toEqual(['github', 'linear', 'postgres'])
    expect(discoverServers(home).find((s) => s.name === 'linear')?.url).toBe('https://mcp.linear.app/sse')
  })

  it('ignores ~/.claude/mcp.json, which Claude Code does not read', () => {
    mkdirSync(join(home, '.claude'))
    writeFileSync(join(home, '.claude', 'mcp.json'), JSON.stringify({ mcpServers: { stale: { command: 'x' } } }))
    expect(discoverServers(home)).toEqual([])
  })

  it('survives a malformed ~/.claude.json or a project without .mcp.json', () => {
    writeFileSync(join(home, '.claude.json'), '{ not json')
    expect(discoverServers(home)).toEqual([])
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [join(home, 'gone')]: {} } }))
    expect(discoverServers(home)).toEqual([])
  })
})
