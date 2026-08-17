/**
 * syncLoop.ts step 3c — injectMcpServer runs every sync cycle, not just once
 * at `intutic connect` time.
 *
 * Before Phase D, `injectMcpServer` had exactly one production call site
 * (tools/cli/src/commands/connect.ts). A server added to a harness config
 * after the user's first `connect` was never wrapped and stayed invisible to
 * governance. This drives `runSyncIteration` — the exported single-cycle unit
 * `startSyncLoop`'s polling loop calls repeatedly — directly, against a
 * minimal faked control plane, and asserts a pre-existing unwrapped MCP
 * server ends up proxy-wrapped after one cycle. `sops: []` in the fake
 * config keeps `extractHarnesses` empty, which keeps the per-harness
 * reportStatus/agent-report/session steps (5, 5b, 5c) no-ops — this test is
 * scoped to proving step 3c's wiring, not those unrelated steps.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSyncIteration } from '../src/syncLoop.js'

describe('sync loop wraps MCP servers every cycle', () => {
  let home: string
  let root: string
  let prevHome: string | undefined
  let prevUserProfile: string | undefined
  let originalFetch: typeof fetch

  afterEach(() => {
    process.env.HOME = prevHome
    process.env.USERPROFILE = prevUserProfile
    globalThis.fetch = originalFetch
    rmSync(home, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  })

  it('wraps a server that was never registered through `connect`, on the very first cycle it sees it', async () => {
    home = mkdtempSync(join(tmpdir(), 'intutic-syncloop-home-'))
    root = mkdtempSync(join(tmpdir(), 'intutic-syncloop-root-'))
    prevHome = process.env.HOME
    prevUserProfile = process.env.USERPROFILE
    process.env.HOME = home
    process.env.USERPROFILE = home

    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(
      join(home, '.claude', 'mcp.json'),
      JSON.stringify({ mcpServers: { github: { command: 'npx', args: ['-y', 'server-github'] } } }, null, 2),
    )

    originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/api/v1/sync/config')) {
        return new Response(JSON.stringify({
          workspaceId: 'ws_test',
          configVersion: 1,
          sops: [],
          proxyUrl: 'http://127.0.0.1:4000',
          settings: {},
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      // Every other endpoint this iteration might touch (sop-hash,
      // agents/report, sessions, intutic/egress): succeed harmlessly.
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch

    const result = await runSyncIteration({
      controlPlaneUrl: 'http://fake-control-plane.test',
      apiKey: 'test-key',
      workspaceId: 'ws_test',
      workspaceRoot: root,
    })

    expect(result.configVersion).toBe(1)

    const written = JSON.parse(readFileSync(join(home, '.claude', 'mcp.json'), 'utf-8'))
    expect(written.mcpServers.github.__intutic_wrapped).toBe(true)
    expect(written.mcpServers.github.args).toContain('--server-name')
    expect(written.mcpServers.intutic).toBeDefined()
  })
})
