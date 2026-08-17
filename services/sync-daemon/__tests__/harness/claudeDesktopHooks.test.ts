/**
 * claudeDesktopHooks.test.ts — matcher-registration coverage for the Claude
 * Desktop writer (M3).
 *
 * No test file existed for this writer before M3. Scoped narrowly to the
 * fact this phase changed — the `mcp__.*` PreToolUse matcher — rather than
 * re-covering ground `generatedGateBehaviour.test.ts`'s gate matrix (via
 * `gateRegistry.ts`'s `claudeDesktop` row) and `generatedShellIntegrity.test.ts`
 * already exercise for every writer, including this one.
 *
 * @module
 */
import { describe, it, expect } from 'vitest'
import * as node_fs from 'node:fs/promises'
import * as node_path from 'node:path'
import * as node_os from 'node:os'
import { writeClaudeDesktopHooks } from '../../src/harness/claudeDesktopHooks.js'

describe('Claude Desktop hooks writer', () => {
  it('registers a mcp__.* PreToolUse matcher alongside Bash/Edit/Write/MultiEdit (M3)', async () => {
    // Without this matcher, an mcp__<server>__<tool> call never reaches the
    // gate script at all — the v6 gate body's #mcpservers allowlist check and
    // any workspace SOP rule shaped like BLOCK:mcp__github__.* are both dead
    // code on Claude Desktop without it.
    const tempRoot = await node_fs.mkdtemp(node_path.join(node_os.tmpdir(), 'intutic-desktop-mcp-test-'))
    const home = await node_fs.mkdtemp(node_path.join(node_os.tmpdir(), 'intutic-desktop-home-'))
    const prevHome = process.env.HOME
    try {
      process.env.HOME = home
      await writeClaudeDesktopHooks(tempRoot, 'http://127.0.0.1:4000', 'ws_test')
      const configPath = node_path.join(
        home,
        'Library',
        'Application Support',
        'Claude',
        'claude_desktop_config.json',
      )
      const config = JSON.parse(await node_fs.readFile(configPath, 'utf-8'))
      const matchers = config.hooks.PreToolUse.map((h: { matcher: string }) => h.matcher)
      expect(matchers).toEqual(expect.arrayContaining(['Bash', 'Edit', 'Write', 'MultiEdit', 'mcp__.*']))
    } finally {
      process.env.HOME = prevHome
      await node_fs.rm(tempRoot, { recursive: true, force: true })
      await node_fs.rm(home, { recursive: true, force: true })
    }
  })
})
