/**
 * The standalone server's tools and the MCP Proxy page must name the same set.
 *
 * The page lists them by hand, in the execution-modes table and the table of
 * tools that answer a refusal, so a tool added to proxy.ts reached agents with
 * no line anywhere a reader could find it, and a renamed one would have kept
 * its old name on the page.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf-8')

/** Every `server.tool('<name>'` in the source. */
function registeredTools(src: string): Set<string> {
  return new Set([...src.matchAll(/\.tool\(\s*'([a-z0-9_]+)'/g)].map((m) => m[1]!))
}

/**
 * Every `intutic_*` name in the page's tool tables: the section from the
 * execution modes to the next rule. The rest of the page names servers and
 * Terraform resources the same way.
 */
function documentedTools(doc: string): Set<string> {
  const start = doc.indexOf('| **Standalone Governance Server**')
  const end = doc.indexOf('\n---', start)
  if (start === -1 || end === -1) throw new Error('mcp-proxy.md no longer has the execution-modes table this test reads')
  return new Set([...doc.slice(start, end).matchAll(/`(intutic_[a-z0-9_]+)`/g)].map((m) => m[1]!))
}

describe('the standalone server tools on the MCP Proxy page', () => {
  const registered = registeredTools(read('../proxy.ts'))
  const documented = documentedTools(read('../../../../apps/docs/integrations/mcp-proxy.md'))

  it('reads a non-trivial set from both', () => {
    expect(registered.size).toBeGreaterThanOrEqual(6)
    expect(documented.size).toBeGreaterThanOrEqual(6)
  })

  it('documents every tool proxy.ts registers', () => {
    expect([...registered].filter((t) => !documented.has(t))).toEqual([])
  })

  it('documents no tool proxy.ts does not register', () => {
    expect([...documented].filter((t) => !registered.has(t))).toEqual([])
  })

  it('catches a drift in either direction', () => {
    const src = "server.tool(\n  'intutic_a', 'x')\nserver.tool('intutic_b', 'y')"
    const doc = '| **Standalone Governance Server** | x | `intutic_a`, `intutic_c` |\n\n---\n`intutic_not_a_tool`'
    expect([...registeredTools(src)]).toEqual(['intutic_a', 'intutic_b'])
    expect([...documentedTools(doc)]).toEqual(['intutic_a', 'intutic_c'])
  })
})
