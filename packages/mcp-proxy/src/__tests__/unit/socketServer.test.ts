import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as net from 'node:net'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs/promises'
import { createSocketServer } from '../../daemon/socketServer.js'

describe('socketServer Unit Tests', () => {
  const socketPath = path.join(os.tmpdir(), `mcp-proxy-test-${Date.now()}.sock`)
  let server: net.Server

  beforeAll(async () => {
    process.env['MCP_DAEMON_SOCKET'] = socketPath
    await fs.rm(socketPath, { force: true })
    server = createSocketServer()
    await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()))
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fs.rm(socketPath, { force: true })
  })

  it('binds to unix socket and responds to proxy.health_check JSON-RPC', async () => {
    const response = await new Promise<any>((resolve, reject) => {
      const client = net.createConnection(socketPath)
      client.setEncoding('utf8')

      let buffer = ''
      const req = {
        jsonrpc: '2.0',
        id: 'req_123',
        method: 'proxy.health_check',
        params: {},
      }

      client.on('connect', () => {
        client.write(JSON.stringify(req) + '\n')
      })

      client.on('data', (chunk) => {
        buffer += chunk
        if (buffer.includes('\n')) {
          try {
            resolve(JSON.parse(buffer.trim()))
          } catch (err) {
            reject(err)
          } finally {
            client.end()
          }
        }
      })

      client.on('error', reject)
    })

    expect(response.jsonrpc).toBe('2.0')
    expect(response.id).toBe('req_123')
    expect(response.result).toBeDefined()
    expect(response.result.status).toBe('ok')
  })

  it('responds to policy.get JSON-RPC', async () => {
    const response = await new Promise<any>((resolve, reject) => {
      const client = net.createConnection(socketPath)
      client.setEncoding('utf8')

      let buffer = ''
      const req = {
        jsonrpc: '2.0',
        id: 'req_policy_get',
        method: 'policy.get',
        params: { workspaceId: 'ws_test' },
      }

      client.on('connect', () => {
        client.write(JSON.stringify(req) + '\n')
      })

      client.on('data', (chunk) => {
        buffer += chunk
        if (buffer.includes('\n')) {
          try {
            resolve(JSON.parse(buffer.trim()))
          } catch (err) {
            reject(err)
          } finally {
            client.end()
          }
        }
      })

      client.on('error', reject)
    })

    expect(response.jsonrpc).toBe('2.0')
    expect(response.id).toBe('req_policy_get')
    expect(response.result).toBeDefined()
  })

  it('responds to policy.invalidate JSON-RPC', async () => {
    const response = await new Promise<any>((resolve, reject) => {
      const client = net.createConnection(socketPath)
      client.setEncoding('utf8')

      let buffer = ''
      const req = {
        jsonrpc: '2.0',
        id: 'req_policy_invalidate',
        method: 'policy.invalidate',
        params: { workspaceId: 'ws_test' },
      }

      client.on('connect', () => {
        client.write(JSON.stringify(req) + '\n')
      })

      client.on('data', (chunk) => {
        buffer += chunk
        if (buffer.includes('\n')) {
          try {
            resolve(JSON.parse(buffer.trim()))
          } catch (err) {
            reject(err)
          } finally {
            client.end()
          }
        }
      })

      client.on('error', reject)
    })

    expect(response.jsonrpc).toBe('2.0')
    expect(response.id).toBe('req_policy_invalidate')
    expect(response.result.invalidated).toBe(true)
  })

  it('responds to telemetry.enqueue JSON-RPC', async () => {
    const response = await new Promise<any>((resolve, reject) => {
      const client = net.createConnection(socketPath)
      client.setEncoding('utf8')

      let buffer = ''
      const req = {
        jsonrpc: '2.0',
        id: 'req_telemetry_enqueue',
        method: 'telemetry.enqueue',
        params: {
          event: 'tool_allowed',
          toolName: 'read_file',
          workspaceId: 'ws_test',
          harnessType: 'mcp-governance-proxy',
          timestamp: new Date().toISOString()
        },
      }

      client.on('connect', () => {
        client.write(JSON.stringify(req) + '\n')
      })

      client.on('data', (chunk) => {
        buffer += chunk
        if (buffer.includes('\n')) {
          try {
            resolve(JSON.parse(buffer.trim()))
          } catch (err) {
            reject(err)
          } finally {
            client.end()
          }
        }
      })

      client.on('error', reject)
    })

    expect(response.jsonrpc).toBe('2.0')
    expect(response.id).toBe('req_telemetry_enqueue')
    expect(response.result.queued).toBe(true)
  })

  it('responds to proxy.tool_call JSON-RPC', async () => {
    const response = await new Promise<any>((resolve, reject) => {
      const client = net.createConnection(socketPath)
      client.setEncoding('utf8')

      let buffer = ''
      const req = {
        jsonrpc: '2.0',
        id: 'req_tool_call',
        method: 'proxy.tool_call',
        params: { workspaceId: 'ws_test' },
      }

      client.on('connect', () => {
        client.write(JSON.stringify(req) + '\n')
      })

      client.on('data', (chunk) => {
        buffer += chunk
        if (buffer.includes('\n')) {
          try {
            resolve(JSON.parse(buffer.trim()))
          } catch (err) {
            reject(err)
          } finally {
            client.end()
          }
        }
      })

      client.on('error', reject)
    })

    expect(response.jsonrpc).toBe('2.0')
    expect(response.id).toBe('req_tool_call')
    expect(response.result.allowed).toBeDefined()
  })
})
