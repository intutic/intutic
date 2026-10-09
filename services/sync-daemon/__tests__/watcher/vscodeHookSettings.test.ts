/**
 * The repair of the VS Code settings that can switch off the GitHub Copilot
 * gate: exactly the values that drop the gate are set back, in JSON or JSONC,
 * and every other byte of the file is kept.
 */
import { describe, it, expect } from 'vitest'
import * as os from 'node:os'
import * as path from 'node:path'
import { repairHookSettings } from '../../src/watcher/vscodeHookSettings.js'

const root = path.join(os.tmpdir(), 'intutic-vscode-ws')

describe('repairHookSettings', () => {
  it('sets chat.useHooks: false back to true', () => {
    expect(repairHookSettings('{"chat.useHooks": false}', root)).toEqual({ text: '{"chat.useHooks": true}', keys: ['chat.useHooks'] })
  })

  it('keeps comments, trailing commas and formatting', () => {
    const text = '// top\n{\n  /* a */ "chat.useHooks" /* b */ : false , // c\n  "x": [1, 2,],\n}\n'
    expect(repairHookSettings(text, root)!.text).toBe(text.replace(': false', ': true'))
  })

  it('sets back every hookFilesLocations entry that drops one of the gate\'s locations', () => {
    const entries = {
      '.github/hooks': false,
      './.github/hooks/': false,
      '.github/hooks/intutic-governance.json': false,
      '.github': false,
      '~/.copilot/hooks': false,
      [path.join(root, '.github', 'hooks')]: false,
    }
    const repaired = repairHookSettings(JSON.stringify({ 'chat.hookFilesLocations': entries }), root)!
    expect(Object.values(JSON.parse(repaired.text)['chat.hookFilesLocations'])).toEqual(Object.keys(entries).map(() => true))
    expect(repaired.keys).toHaveLength(6)
  })

  it('leaves locations that are not the gate\'s, and values that are not false', () => {
    const text = JSON.stringify({
      'chat.useHooks': true,
      'chat.hookFilesLocations': { '.claude/settings.json': false, '.github/hooks-other': false, '.github/hooks': true, 'tools': 'false' },
    })
    expect(repairHookSettings(text, root)).toBeNull()
  })

  it('reads a key only at the top level, as VS Code does', () => {
    expect(repairHookSettings('{"[markdown]": {"chat.useHooks": false}}', root)).toBeNull()
  })

  it('leaves a file that is not a settings object alone', () => {
    expect(repairHookSettings('', root)).toBeNull()
    expect(repairHookSettings('[false]', root)).toBeNull()
    expect(repairHookSettings('{"chat.useHooks": false', root)).toBeNull()
    expect(repairHookSettings('{"chat.useHooks": false} trailing', root)).toBeNull()
  })
})
