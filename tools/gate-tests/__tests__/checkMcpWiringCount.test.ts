/**
 * The MCP wiring-count gate (tools/scripts/check-mcp-wiring-count.js).
 *
 * The docs said the MCP governance proxy is "wired automatically into 11
 * harnesses" and nothing compared that with the harnesses `injectMcpServer`
 * actually writes. These run the real script against fixture trees, since the
 * thing under test is its exit code.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SCRIPT = resolve(import.meta.dirname, '../../scripts/check-mcp-wiring-count.js')

function runGate(root: string): Promise<{ status: number; out: string }> {
  return new Promise((res, reject) => {
    const child = spawn('node', [SCRIPT, root], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => {
      out += d
    })
    child.stderr.on('data', (d: string) => {
      out += d
    })
    child.on('error', reject)
    child.on('close', (code) => res({ status: code === null ? -1 : code, out }))
  })
}

/** An injectMcpServer with the given harnesses, shaped like the real one. */
function wiring(harnesses: string[]): string {
  const entries = harnesses.map((h) => `    ['${h}', inject${h.replace(/-/g, '')}],`).join('\n')
  return [
    'export async function injectMcpServer(',
    '  workspaceRoot: string,',
    '): Promise<void> {',
    '  const targets: [string, (workspaceId: string, workspaceRoot: string) => Promise<void>][] = [',
    entries,
    '  ]',
    '  const skip = new Set(options.skip ?? [])',
    '}',
    '',
  ].join('\n')
}

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mcpwiring-'))
  await mkdir(join(root, 'apps/docs/guide'), { recursive: true })
  await mkdir(join(root, 'services/sync-daemon/src/harness'), { recursive: true })
  await writeFile(
    join(root, 'services/sync-daemon/src/harness/mcpAutoWrite.ts'),
    wiring(['claude-code', 'cursor', 'cline']),
  )
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const page = (body: string) => writeFile(join(root, 'apps/docs/guide/mcp.md'), body)

describe('MCP wiring count', () => {
  it.each([
    'The proxy is wired automatically into 3 harnesses.',
    'Claude Code, Cursor and Cline — five config paths across three harnesses.',
    '| **MCP governance** | wired automatically into **3** harnesses |',
  ])('passes "%s"', async (line) => {
    await page(`${line}\n`)
    const r = await runGate(root)
    expect(r.status, r.out).toBe(0)
    expect(r.out).toContain('[PASS]')
  })

  it.each([
    'The proxy is wired automatically into 11 harnesses.',
    'Claude Code, Cursor and Cline — five config paths across\neleven harnesses.',
  ])('fails "%s"', async (line) => {
    await page(`${line}\n`)
    const r = await runGate(root)
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain('apps/docs/guide/mcp.md:1')
    expect(r.out).toContain('wires 3 harnesses')
  })

  it('fails when no doc states the count, rather than passing on nothing', async () => {
    await page('The proxy fronts MCP servers.\n')
    const r = await runGate(root)
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain('asserted nothing')
  })

  it('fails when the wiring list cannot be read', async () => {
    await writeFile(join(root, 'services/sync-daemon/src/harness/mcpAutoWrite.ts'), 'export {}\n')
    await page('wired automatically into 3 harnesses\n')
    const r = await runGate(root)
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain('targets list')
  })
})
