/**
 * daemonClient.ts — IPC socket client helper for communicating with mcp-daemon.
 * LLD #28: MCP Daemon Mode, WS-5MCP
 *
 * @module
 */
import * as net from 'node:net'
import * as path from 'node:path'
import * as os from 'node:os'
import { createStderrLogger as createLogger } from './stderrLog.js'

const log = createLogger('mcp-proxy-daemon-client')

function getSocketPath(): string {
  return process.env['MCP_DAEMON_SOCKET'] ??
    path.join(os.homedir(), '.intutic', 'mcp-proxy.sock')
}

/**
 * Sends a JSON-RPC request to the mcp-daemon Unix domain socket.
 */
export function callDaemonSocket(method: string, params: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(getSocketPath())
    socket.setEncoding('utf8')

    let buffer = ''
    const req = {
      jsonrpc: '2.0',
      id: Date.now().toString() + Math.random().toString(36).substring(2, 7),
      method,
      params,
    }

    socket.on('connect', () => {
      socket.write(JSON.stringify(req) + '\n')
    })

    socket.on('data', (chunk: string) => {
      buffer += chunk
      const lines = buffer.split('\n')
      if (lines.length > 1) {
        const line = lines[0]!.trim()
        if (line) {
          try {
            const res = JSON.parse(line)
            if (res.error) {
              reject(new Error(res.error.message))
            } else {
              resolve(res.result)
            }
          } catch (err) {
            reject(err)
          } finally {
            socket.end()
          }
        }
      }
    })

    socket.on('error', (err) => {
      reject(err)
    })

    // 2s timeout
    socket.setTimeout(2000, () => {
      socket.destroy()
      reject(new Error('Daemon socket timeout'))
    })
  })
}
