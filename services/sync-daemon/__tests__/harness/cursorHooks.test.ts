import { describe, it, expect } from 'vitest'
import { buildHooksConfig, mergeHooksConfig, systemHooksDirFor } from '../../src/harness/cursorHooks.js'

describe('systemHooksDirFor', () => {
  it('targets the real macOS app-support dir, not the nonexistent /etc/cursor', () => {
    expect(systemHooksDirFor('darwin')).toBe('/Library/Application Support/Cursor')
  })

  it('targets /etc/cursor on non-macOS platforms', () => {
    expect(systemHooksDirFor('linux')).toBe('/etc/cursor')
    expect(systemHooksDirFor('win32')).toBe('/etc/cursor')
  })
})

describe('buildHooksConfig', () => {
  it('uses Cursor\'s hooks.json schema: version 1 and a list of fail-closed entries per event', () => {
    const config = buildHooksConfig('/tmp/cursor-check.js')
    expect(config.version).toBe(1)
    expect(Object.keys(config.hooks)).toEqual(['beforeShellExecution', 'beforeMCPExecution', 'preToolUse'])
    for (const entries of Object.values(config.hooks)) {
      expect(entries).toHaveLength(1)
      expect(entries[0].command).toBe('node "/tmp/cursor-check.js"')
      expect(entries[0].failClosed).toBe(true)
    }
    expect(config.hooks.preToolUse[0].matcher).toBe('Write|Delete')
  })

  it('quotes the script path so a space in it does not break the command', () => {
    const config = buildHooksConfig('/tmp/a path/cursor-check.js')
    expect(config.hooks.beforeShellExecution[0].command).toBe('node "/tmp/a path/cursor-check.js"')
  })
})

describe('mergeHooksConfig', () => {
  it('keeps the user\'s hooks, replaces its own, and drops the shape earlier versions wrote', () => {
    const legacy = {
      _comment: 'Intutic governance hooks — auto-generated. DO NOT EDIT.',
      failClosed: true,
      hooks: {
        beforeShellExecution: { command: 'node "/tmp/cursor-check.js"', failClosed: true },
        beforeFileEdit: { command: 'node "/tmp/cursor-check.js"', failClosed: true },
        afterFileEdit: [{ command: './format.sh' }],
        beforeMCPExecution: [{ command: './my-mcp-audit.sh' }],
      },
    }
    const once = mergeHooksConfig(legacy, '/tmp/cursor-check.js')
    const twice = mergeHooksConfig(once, '/tmp/cursor-check.js')
    expect(twice).toEqual(once)
    expect(once).toEqual({
      version: 1,
      hooks: {
        afterFileEdit: [{ command: './format.sh' }],
        beforeMCPExecution: [{ command: './my-mcp-audit.sh' }, { command: 'node "/tmp/cursor-check.js"', timeout: 10, failClosed: true }],
        beforeShellExecution: [{ command: 'node "/tmp/cursor-check.js"', timeout: 10, failClosed: true }],
        preToolUse: [{ command: 'node "/tmp/cursor-check.js"', matcher: 'Write|Delete', timeout: 10, failClosed: true }],
      },
    })
  })
})
