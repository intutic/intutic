/**
 * devInventory.test.ts — what a machine's AI inventory may say about paths
 * and MCP server URLs: home-relative paths only, and no credential in a URL.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { homeRelativePath, sanitizeMcpEndpoint, REDACTED_PATH, REDACTED_SEGMENT } from '../devInventory.js'

describe('homeRelativePath', () => {
  it('reports a path inside the home directory relative to it', () => {
    expect(homeRelativePath('/Users/dev/code/app/.intutic/hooks/cursor-check.js', '/Users/dev')).toBe(
      '~/code/app/.intutic/hooks/cursor-check.js',
    )
    expect(homeRelativePath('/Users/dev', '/Users/dev')).toBe('~')
    expect(homeRelativePath('/Users/dev/x', '/Users/dev/')).toBe('~/x')
  })

  it('redacts a path outside the home directory, including a sibling that shares the prefix', () => {
    expect(homeRelativePath('/etc/cursor/hooks.json', '/Users/dev')).toBe(REDACTED_PATH)
    expect(homeRelativePath('/Users/developer/secret', '/Users/dev')).toBe(REDACTED_PATH)
    expect(homeRelativePath('/anything', '')).toBe(REDACTED_PATH)
  })

  it('handles a Windows home directory', () => {
    expect(homeRelativePath('C:\\Users\\dev\\repo\\x.js', 'C:\\Users\\dev')).toBe('~/repo/x.js')
  })
})

describe('sanitizeMcpEndpoint', () => {
  it('drops the user name, password, query string and fragment', () => {
    // Assembled at run time so no credential-shaped literal sits in source.
    const password = ['hunter', '2'].join('')
    const raw = `https://alice:${password}@mcp.example.com/v1/sse?api_key=${'k'.repeat(8)}&x=1#frag`
    const clean = sanitizeMcpEndpoint(raw)
    expect(clean).toBe('https://mcp.example.com/v1/sse')
    expect(clean).not.toContain(password)
    expect(clean).not.toContain('api_key')
  })

  it('redacts a path segment that looks like a token, keeping readable route segments', () => {
    const token = ['a1B2c3D4', 'e5F6g7H8', 'i9'].join('')
    expect(sanitizeMcpEndpoint(`https://actions.example.com/mcp/${token}/sse`)).toBe(
      `https://actions.example.com/mcp/${REDACTED_SEGMENT}/sse`,
    )
    expect(sanitizeMcpEndpoint('https://mcp.example.com/mcp-server/streamable-http')).toBe(
      'https://mcp.example.com/mcp-server/streamable-http',
    )
  })

  it('keeps the port and drops a bare trailing slash', () => {
    expect(sanitizeMcpEndpoint('http://localhost:8080/')).toBe('http://localhost:8080')
    expect(sanitizeMcpEndpoint('wss://mcp.example.com:8443/ws')).toBe('wss://mcp.example.com:8443/ws')
  })

  it('returns undefined for anything that is not an http(s) or ws(s) URL', () => {
    expect(sanitizeMcpEndpoint('npx -y @modelcontextprotocol/server-github')).toBeUndefined()
    expect(sanitizeMcpEndpoint('file:///Users/dev/server.js')).toBeUndefined()
    expect(sanitizeMcpEndpoint('https://${MCP_HOST}/sse')).toBeUndefined()
  })
})
