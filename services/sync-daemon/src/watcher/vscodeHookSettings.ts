/**
 * vscodeHookSettings.ts — the two VS Code settings that can switch off the
 * GitHub Copilot gate, and their repair.
 *
 * VS Code loads hook files from `.github/hooks` (workspace) and
 * `~/.copilot/hooks` (user) by default, so the Copilot gate needs no setting,
 * and no VS Code policy locks `chat.hookFilesLocations`. What can switch the
 * gate off is `chat.useHooks: false` (no hooks at all) or an entry in
 * `chat.hookFilesLocations` mapping one of the gate's locations to `false`.
 * The gates refuse an agent's edit that sets either key
 * (`HOOK_SETTING_PATTERNS`); this is the settings guard's half for a change
 * that reaches the file another way. It flips exactly those values back to
 * `true` and leaves every other byte of the file alone, comments included:
 * VS Code reads settings as JSONC, which `JSON.parse` refuses, and rewriting
 * a person's settings file through a JSON round trip would drop them.
 *
 * @module
 */

import * as path from 'node:path'
import * as os from 'node:os'

/** A parsed JSONC value with the offsets of its text in the file. */
type Node =
  | { kind: 'object'; start: number; end: number; members: Array<{ key: string; value: Node }> }
  | { kind: 'array'; start: number; end: number }
  | { kind: 'literal'; start: number; end: number; text: string }

/**
 * Parses JSONC (comments and trailing commas allowed) into {@link Node}s with
 * offsets. Throws on anything else, and the caller then leaves the file alone.
 */
function parseJsonc(text: string): Node {
  let i = 0
  const skip = () => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i]!)) i++
      if (text.startsWith('//', i)) {
        const nl = text.indexOf('\n', i)
        i = nl === -1 ? text.length : nl + 1
      } else if (text.startsWith('/*', i)) {
        const close = text.indexOf('*/', i + 2)
        if (close === -1) throw new Error('unterminated comment')
        i = close + 2
      } else {
        return
      }
    }
  }
  const string = (): string => {
    const start = i++
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1
    if (i >= text.length) throw new Error('unterminated string')
    i++
    return JSON.parse(text.slice(start, i)) as string
  }
  const value = (): Node => {
    skip()
    const start = i
    const c = text[i]
    if (c === '{') {
      i++
      const members: Array<{ key: string; value: Node }> = []
      for (;;) {
        skip()
        if (text[i] === '}') break
        if (text[i] !== '"') throw new Error(`expected a key at ${i}`)
        const key = string()
        skip()
        if (text[i++] !== ':') throw new Error(`expected a colon at ${i - 1}`)
        members.push({ key, value: value() })
        skip()
        if (text[i] === ',') i++
        else if (text[i] !== '}') throw new Error(`expected , or } at ${i}`)
      }
      i++
      return { kind: 'object', start, end: i, members }
    }
    if (c === '[') {
      i++
      for (;;) {
        skip()
        if (text[i] === ']') break
        value()
        skip()
        if (text[i] === ',') i++
        else if (text[i] !== ']') throw new Error(`expected , or ] at ${i}`)
      }
      i++
      return { kind: 'array', start, end: i }
    }
    if (c === '"') {
      string()
      return { kind: 'literal', start, end: i, text: text.slice(start, i) }
    }
    const m = /^(?:true|false|null|-?\d[\d.eE+-]*)/.exec(text.slice(i, i + 64))
    if (!m) throw new Error(`unexpected input at ${i}`)
    i += m[0].length
    return { kind: 'literal', start, end: i, text: m[0] }
  }
  const root = value()
  skip()
  if (i !== text.length) throw new Error(`trailing input at ${i}`)
  return root
}

/** The files the Copilot gate is registered in, workspace and user level. */
export function copilotHookFiles(workspaceRoot: string): string[] {
  return [
    path.join(workspaceRoot, '.github', 'hooks', 'intutic-governance.json'),
    path.join(os.homedir(), '.copilot', 'hooks', 'intutic-governance.json'),
  ]
}

/** Whether a `chat.hookFilesLocations` key names one of the gate's files or a directory above one. */
function coversGate(location: string, workspaceRoot: string): boolean {
  const trimmed = location.trim().replace(/[\\/]+$/, '')
  if (!trimmed) return false
  const resolved =
    trimmed === '~' || trimmed.startsWith('~/')
      ? path.join(os.homedir(), trimmed.slice(1))
      : path.resolve(workspaceRoot, trimmed)
  return copilotHookFiles(workspaceRoot).some((file) => {
    const rel = path.relative(resolved, file)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  })
}

/**
 * The settings file's text with every value that switches the Copilot gate
 * off set back to `true`, and the keys it changed; null when nothing in it
 * does, or when it is not a JSONC object.
 */
export function repairHookSettings(
  text: string,
  workspaceRoot: string,
): { text: string; keys: string[] } | null {
  let root: Node
  try {
    root = parseJsonc(text)
  } catch {
    return null
  }
  if (root.kind !== 'object') return null
  const spans: Array<{ start: number; end: number; key: string }> = []
  for (const { key, value } of root.members) {
    if (key === 'chat.useHooks' && value.kind === 'literal' && value.text === 'false') {
      spans.push({ start: value.start, end: value.end, key })
    }
    if (key === 'chat.hookFilesLocations' && value.kind === 'object') {
      for (const entry of value.members) {
        if (entry.value.kind === 'literal' && entry.value.text === 'false' && coversGate(entry.key, workspaceRoot)) {
          spans.push({ start: entry.value.start, end: entry.value.end, key: `${key}["${entry.key}"]` })
        }
      }
    }
  }
  if (spans.length === 0) return null
  let out = text
  for (const span of [...spans].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, span.start) + 'true' + out.slice(span.end)
  }
  return { text: out, keys: spans.map((s) => s.key) }
}
