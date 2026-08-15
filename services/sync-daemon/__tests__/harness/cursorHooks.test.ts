import { describe, it, expect } from 'vitest'
import { buildHooksConfig, systemHooksDirFor } from '../../src/harness/cursorHooks.js'

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
  it('wires every hook event to the given script with failClosed set', () => {
    const config = buildHooksConfig('/tmp/cursor-check.js')
    expect(config.failClosed).toBe(true)
    expect(Object.keys(config.hooks)).toEqual(['beforeShellExecution', 'beforeMCPExecution', 'beforeFileEdit'])
    for (const hook of Object.values(config.hooks)) {
      expect(hook.command).toBe('node "/tmp/cursor-check.js"')
      expect(hook.failClosed).toBe(true)
    }
  })

  it('quotes the script path so a space in it does not break the command', () => {
    const config = buildHooksConfig('/tmp/a path/cursor-check.js')
    expect(config.hooks.beforeShellExecution.command).toBe('node "/tmp/a path/cursor-check.js"')
  })
})
