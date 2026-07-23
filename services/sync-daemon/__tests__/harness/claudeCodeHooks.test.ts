/**
 * claudeCodeHooks.test.ts — Unit tests for Claude Code hooks compilation.
 *
 * Verifies that SOP markdown content and settings are parsed correctly to
 * extract blacklisted tools and regex patterns, and that the settings.json
 * config is written correctly.
 *
 * LLD #14 — Test Strategy
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import * as node_fs from 'node:fs/promises'
import * as node_path from 'node:path'
import * as node_os from 'node:os'
import { parseSopConstraints, updatePreToolUseHooks } from '../../src/harness/claudeCodeHooks.js'
import { HarnessType, type SyncSopEntry } from '@intutic/shared-types'

describe('Claude Code PreToolUse Hooks Compiler', () => {
  const mockSops: SyncSopEntry[] = [
    {
      sopId: 'sop_1',
      title: 'Security SOP',
      content: `
        This SOP forbids using raw destructive commands.
        High Risk Tool: Bash
        Blacklist Pattern: rm -rf *
        Deny Pattern: truncate table
      `,
      contentHash: 'hash1',
      harnessTargets: [HarnessType.CLAUDE_CODE],
    },
    {
      sopId: 'sop_2',
      title: 'DB SOP',
      content: `
        \`\`\`json
        {
          "highRiskTools": ["Write"],
          "patterns": ["drop database"]
        }
        \`\`\`
      `,
      contentHash: 'hash2',
      harnessTargets: [HarnessType.CLAUDE_CODE],
    },
  ]

  it('correctly parses constraints from markdown text and settings', () => {
    const settings = {
      highRiskTools: ['Read'],
      patterns: ['cat .env'],
    }

    const constraints = parseSopConstraints(mockSops, settings)

    expect(constraints.highRiskTools).toContain('Bash')
    expect(constraints.highRiskTools).toContain('Write')
    expect(constraints.highRiskTools).toContain('Read')

    expect(constraints.patterns).toContain('rm -rf *')
    expect(constraints.patterns).toContain('truncate table')
    expect(constraints.patterns).toContain('drop database')
    expect(constraints.patterns).toContain('cat .env')
  })

  it('writes settings.json and pre-tool-check.js to workspace root', async () => {
    const tempRoot = await node_fs.mkdtemp(node_path.join(node_os.tmpdir(), 'intutic-hooks-test-'))

    await updatePreToolUseHooks(tempRoot, mockSops)

    // Check script creation
    const scriptPath = node_path.join(tempRoot, '.intutic', 'hooks', 'pre-tool-check.js')
    const scriptStat = await node_fs.stat(scriptPath)
    expect(scriptStat.isFile()).toBe(true)

    const scriptContent = await node_fs.readFile(scriptPath, 'utf-8')
    expect(scriptContent).toContain('rm -rf *')
    expect(scriptContent).toContain('drop database')

    // Check local settings.json creation
    const settingsPath = node_path.join(tempRoot, '.claude', 'settings.json')
    const settingsStat = await node_fs.stat(settingsPath)
    expect(settingsStat.isFile()).toBe(true)

    const settings = JSON.parse(await node_fs.readFile(settingsPath, 'utf-8'))
    expect(settings.permissions?.deny).toContain('Bash')
    expect(settings.permissions?.deny).toContain('Write')
    expect(settings.permissions?.deny).toContain('Bash(*rm -rf **)')
    expect(settings.permissions?.deny).toContain('Bash(*drop database*)')
    expect(settings.hooks?.PreToolUse).toBeDefined()
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain('pre-tool-check.js')

    await node_fs.rm(tempRoot, { recursive: true, force: true })
  })
})
