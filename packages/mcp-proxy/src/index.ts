#!/usr/bin/env node
/**
 * index.ts — CLI entry point for @intutic/mcp-governance-proxy.
 *
 * CRITICAL: In the MCP proxy, stdout is exclusively reserved for JSON-RPC frames.
 * All logging MUST go to stderr. We redirect pino's output to fd 2 (stderr)
 * by overriding the destination before any logger is instantiated.
 *
 * Usage:
 *   intutic-mcp-proxy [--workspace-id <id>] -- <real-mcp-server> [args...]
 *
 * Example (harness config):
 *   {
 *     "command": "node",
 *     "args": ["/path/to/@intutic/mcp-governance-proxy/dist/index.js",
 *              "--workspace-id", "ws_xxx",
 *              "--",
 *              "npx", "-y", "@modelcontextprotocol/server-filesystem", "/projects"]
 *   }
 *
 * @module
 */

import { loadConfig } from './config.js'
import { McpGovernanceProxy } from './proxy.js'
import { createStderrLogger as createLogger } from './stderrLog.js'

const log = createLogger('mcp-proxy-main')

async function main(): Promise<void> {
  let config
  try {
    config = await loadConfig()
  } catch (err) {
    // Write to stderr — never stdout
    process.stderr.write(`[intutic-mcp-proxy] Configuration error: ${(err as Error).message}\n`)
    process.exit(1)
  }

  const proxy = new McpGovernanceProxy(config)

  try {
    await proxy.run()
  } catch (err) {
    log.error({ action: 'proxy_fatal', err: (err as Error).message }, 'Proxy exited with error')
    process.exit(1)
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`[intutic-mcp-proxy] Fatal error: ${String(err)}\n`)
  process.exit(1)
})
