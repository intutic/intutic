/**
 * config.test.ts — Unit tests for MCP Governance Proxy configuration loading.
 *
 * Zero vi.mock — tests the actual env parsing and CLI arguments using temporary disk files.
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as node_fs from 'node:fs/promises'
import * as node_os from 'node:os'
import * as node_path from 'node:path'
import { loadConfig } from '../config.js'

describe('loadConfig', () => {
  const runtimeEnvPath = node_path.join(node_os.homedir(), '.intutic', 'env', 'runtime.env')
  const backupPath = runtimeEnvPath + '.bak'
  let hadOriginalFile = false

  beforeAll(async () => {
    try {
      // Backup original runtime.env if it exists
      await node_fs.access(runtimeEnvPath)
      await node_fs.copyFile(runtimeEnvPath, backupPath)
      hadOriginalFile = true
    } catch {
      hadOriginalFile = false
    }

    // Ensure directory exists
    await node_fs.mkdir(node_path.dirname(runtimeEnvPath), { recursive: true })
  })

  afterAll(async () => {
    // Restore backup
    try {
      await node_fs.unlink(runtimeEnvPath).catch(() => {})
      if (hadOriginalFile) {
        await node_fs.copyFile(backupPath, runtimeEnvPath)
        await node_fs.unlink(backupPath).catch(() => {})
      }
    } catch {
      // Cleanup failed
    }
  })

  it('loads variables from runtime.env and parses CLI arguments', async () => {
    // Write test runtime.env
    const testEnvContent = [
      '# Test config',
      'INTUTIC_CONTROL_PLANE_URL=http://test-control-plane:3005',
      'INTUTIC_API_KEY=sk-test-api-key-value',
      'INTUTIC_WORKSPACE_ID=ws-test-1234',
      'INTUTIC_MCP_FAIL_OPEN=false',
      'INTUTIC_MCP_PROXY_MODE=daemon',
    ].join('\n')

    await node_fs.writeFile(runtimeEnvPath, testEnvContent, 'utf-8')

    const config = await loadConfig(['--workspace-id', 'cli-override-ws', '--', 'node', 'server.js', '--port', '8080'])

    expect(config.controlPlaneUrl).toBe('http://test-control-plane:3005')
    expect(config.apiKey).toBe('sk-test-api-key-value')
    // CLI takes precedence over runtime.env for workspaceId
    expect(config.workspaceId).toBe('cli-override-ws')
    expect(config.failOpen).toBe(false)
    expect(config.mcpProxyMode).toBe('daemon')
    expect(config.realServerCommand).toEqual(['node', 'server.js', '--port', '8080'])
  })

  it('defaults failOpen to true when not specified', async () => {
    const testEnvContent = [
      'INTUTIC_WORKSPACE_ID=ws-test-1234',
    ].join('\n')

    await node_fs.writeFile(runtimeEnvPath, testEnvContent, 'utf-8')

    const config = await loadConfig(['--', 'node', 'server.js'])
    expect(config.failOpen).toBe(true)
    expect(config.workspaceId).toBe('ws-test-1234')
  })

  // Phase D threaded --server-name onto every wrapped invocation
  // (mcpAutoWrite.ts's wrapWithProxy); nothing consumed it until this phase's
  // server-level allowlist (interceptor.ts) and TOFU pinning (tofu.ts) needed
  // to know which real server this proxy process fronts.
  it('parses --server-name from CLI arguments', async () => {
    await node_fs.writeFile(runtimeEnvPath, 'INTUTIC_WORKSPACE_ID=ws-test\n', 'utf-8')

    const config = await loadConfig([
      '--workspace-id', 'ws-cli',
      '--server-name', 'github',
      '--',
      'node', 'server.js',
    ])
    expect(config.serverName).toBe('github')
  })

  it('defaults serverName to "unknown" when --server-name is not passed', async () => {
    await node_fs.writeFile(runtimeEnvPath, 'INTUTIC_WORKSPACE_ID=ws-test\n', 'utf-8')

    const config = await loadConfig(['--', 'node', 'server.js'])
    expect(config.serverName).toBe('unknown')
  })

  // M2: remote (HTTP/SSE) bridge mode — --remote-url and --remote-transport,
  // and the standalone-detection update that must not treat a remote-bridge
  // invocation as standalone (no downstream server) mode.
  describe('remote bridge mode', () => {
    it('parses --remote-url and defaults --remote-transport to "http"', async () => {
      await node_fs.writeFile(runtimeEnvPath, 'INTUTIC_WORKSPACE_ID=ws-test\n', 'utf-8')

      const config = await loadConfig([
        '--workspace-id', 'ws-cli',
        '--server-name', 'linear',
        '--remote-url', 'https://mcp.example.com/sse',
      ])
      expect(config.remoteUrl).toBe('https://mcp.example.com/sse')
      expect(config.remoteTransport).toBe('http')
      expect(config.realServerCommand).toEqual([])
      // Remote bridge mode is a real upstream, not "no downstream server" —
      // must not be misdetected as standalone (the `intutic` harness entry).
      expect(config.standalone).toBe(false)
    })

    it('parses an explicit --remote-transport sse', async () => {
      await node_fs.writeFile(runtimeEnvPath, 'INTUTIC_WORKSPACE_ID=ws-test\n', 'utf-8')

      const config = await loadConfig([
        '--remote-url', 'https://mcp.example.com/sse',
        '--remote-transport', 'sse',
      ])
      expect(config.remoteTransport).toBe('sse')
    })

    it('rejects an unrecognised --remote-transport value', async () => {
      await node_fs.writeFile(runtimeEnvPath, 'INTUTIC_WORKSPACE_ID=ws-test\n', 'utf-8')

      await expect(
        loadConfig(['--remote-url', 'https://mcp.example.com', '--remote-transport', 'websocket']),
      ).rejects.toThrow(/--remote-transport must be "sse" or "http"/)
    })

    it('rejects --remote-url combined with a positional stdio command as a config error', async () => {
      await node_fs.writeFile(runtimeEnvPath, 'INTUTIC_WORKSPACE_ID=ws-test\n', 'utf-8')

      await expect(
        loadConfig(['--remote-url', 'https://mcp.example.com', '--', 'node', 'server.js']),
      ).rejects.toThrow(/mutually exclusive/)
    })

    it('leaves remoteUrl undefined and standalone true when neither --remote-url nor a stdio command is given', async () => {
      await node_fs.writeFile(runtimeEnvPath, 'INTUTIC_WORKSPACE_ID=ws-test\n', 'utf-8')

      const config = await loadConfig([])
      expect(config.remoteUrl).toBeUndefined()
      expect(config.remoteTransport).toBeUndefined()
      expect(config.standalone).toBe(true)
    })

    it('parses INTUTIC_REMOTE_HEADERS from the environment, never from argv', async () => {
      await node_fs.writeFile(runtimeEnvPath, 'INTUTIC_WORKSPACE_ID=ws-test\n', 'utf-8')
      const prev = process.env['INTUTIC_REMOTE_HEADERS']
      process.env['INTUTIC_REMOTE_HEADERS'] = JSON.stringify({ Authorization: 'Bearer sekrit-token' })
      try {
        const config = await loadConfig(['--remote-url', 'https://mcp.example.com'])
        expect(config.remoteHeaders).toEqual({ Authorization: 'Bearer sekrit-token' })
      } finally {
        if (prev === undefined) delete process.env['INTUTIC_REMOTE_HEADERS']
        else process.env['INTUTIC_REMOTE_HEADERS'] = prev
      }
    })

    it('defaults remoteHeaders to {} when INTUTIC_REMOTE_HEADERS is unset', async () => {
      await node_fs.writeFile(runtimeEnvPath, 'INTUTIC_WORKSPACE_ID=ws-test\n', 'utf-8')
      const prev = process.env['INTUTIC_REMOTE_HEADERS']
      delete process.env['INTUTIC_REMOTE_HEADERS']
      try {
        const config = await loadConfig(['--remote-url', 'https://mcp.example.com'])
        expect(config.remoteHeaders).toEqual({})
      } finally {
        if (prev !== undefined) process.env['INTUTIC_REMOTE_HEADERS'] = prev
      }
    })

    it('falls back to {} when INTUTIC_REMOTE_HEADERS is malformed JSON', async () => {
      await node_fs.writeFile(runtimeEnvPath, 'INTUTIC_WORKSPACE_ID=ws-test\n', 'utf-8')
      const prev = process.env['INTUTIC_REMOTE_HEADERS']
      process.env['INTUTIC_REMOTE_HEADERS'] = '{not json'
      try {
        const config = await loadConfig(['--remote-url', 'https://mcp.example.com'])
        expect(config.remoteHeaders).toEqual({})
      } finally {
        if (prev === undefined) delete process.env['INTUTIC_REMOTE_HEADERS']
        else process.env['INTUTIC_REMOTE_HEADERS'] = prev
      }
    })
  })
})
