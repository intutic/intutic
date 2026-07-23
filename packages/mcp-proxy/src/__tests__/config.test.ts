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
})
