/**
 * A shell command, read as the commands it runs, or not at all.
 *
 * Deliberately a small subset of shell: words, quotes, escapes, comments and
 * the operators `;`, `&`, `&&`, `|`, `|&`, `||` and newline. Anything else (a
 * redirect, subshell, group, substitution, heredoc, control word) returns
 * `null`, and so does anything malformed, because `null` is the answer that
 * fails safe: every caller keeps its old behaviour on it.
 *
 * A port of the proxy's `shell_parse.rs`; intutic-clawde `gate/shell_parse.py`
 * is another. All three run `fixtures/shell-parse-vectors.json`. Self-contained,
 * because `@intutic/gate` keeps a byte-identical copy and the hook gates embed
 * {@link SHELL_PARSE_JS_SOURCE}.
 *
 * @module
 */

/** Words that open a construct this parser does not model. `alias` is here because it changes what the next word means. */
const SHELL_CONTROL_WORDS: readonly string[] = [
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac',
  'select', 'function', 'coproc', 'alias',
]

/** One command and its arguments. */
export interface SimpleCommand {
  /** The words after quote removal. */
  argv: string[]
  /** False when a word still holds an expansion or glob, so `argv` is not exactly what runs. */
  literal: boolean
  /** Where it sits in the text. */
  start: number
  end: number
}

/** `NAME=` at `i`: the word sets a variable for the command after it. */
function shellIsAssignment(text: string, i: number): boolean {
  let j = i
  while (j < text.length && /[A-Za-z0-9_]/.test(text[j]!)) j++
  return j > i && !/[0-9]/.test(text[i]!) && text[j] === '='
}

/** `text` as pipelines of simple commands, or `null` when not understood. */
export function parseShell(text: string): SimpleCommand[][] | null {
  const pipelines: SimpleCommand[][] = []
  let pipeline: SimpleCommand[] = []
  let command: SimpleCommand | null = null
  let word: string[] | null = null
  let pipeOpen = false
  let i = 0

  const startWord = (at: number): void => {
    word ??= []
    command ??= { argv: [], literal: true, start: at, end: at }
  }
  const endWord = (at: number): void => {
    if (word !== null && command !== null) {
      command.argv.push(word.join(''))
      command.end = at
    }
    word = null
  }

  while (i < text.length) {
    const c = text[i]!
    if (c === ' ' || c === '\t') {
      endWord(i)
      i++
    } else if (c === '\\' && text[i + 1] === '\n') {
      i += 2
    } else if (c === '\\') {
      if (i + 1 >= text.length) return null
      startWord(i)
      word!.push(text[i + 1]!)
      i += 2
    } else if (c === "'") {
      startWord(i)
      const close = text.indexOf("'", i + 1)
      if (close === -1) return null
      word!.push(text.slice(i + 1, close))
      i = close + 1
    } else if (c === '"') {
      startWord(i)
      i++
      for (;;) {
        if (i >= text.length) return null
        const q = text[i]!
        if (q === '"') break
        if (q === '`') return null
        if (q === '$') {
          if (text[i + 1] === '(') return null
          command!.literal = false
        }
        if (q === '\\') {
          if (i + 1 >= text.length) return null
          const next = text[i + 1]!
          if (!'$"\\`\n'.includes(next)) word!.push('\\')
          if (next !== '\n') word!.push(next)
          i += 2
          continue
        }
        word!.push(q)
        i++
      }
      i++
    } else if (c === '#' && word === null) {
      while (i < text.length && text[i] !== '\n') i++
    } else if ('<>(){}`'.includes(c)) {
      return null
    } else if (c === '\n' || c === ';' || c === '&' || c === '|') {
      endWord(i)
      const doubled = (c === '&' || c === '|') && text[i + 1] === c
      if (command !== null) {
        const done: SimpleCommand = command
        if (SHELL_CONTROL_WORDS.indexOf(done.argv[0]!) !== -1) return null
        pipeline.push(done)
        command = null
      } else if (c === '\n') {
        // A newline may follow an operator or stand alone.
        i++
        continue
      } else {
        // Any other operator here has nothing to its left.
        return null
      }
      pipeOpen = c === '|' && !doubled
      if (pipeOpen) {
        if (text[i + 1] === '&') i++
      } else {
        pipelines.push(pipeline)
        pipeline = []
      }
      i += doubled ? 2 : 1
    } else {
      if ('$*?[~'.includes(c) || (word === null && shellIsAssignment(text, i))) {
        startWord(i)
        command!.literal = false
      }
      startWord(i)
      word!.push(c)
      i++
    }
  }
  endWord(text.length)
  if (command !== null) {
    const done: SimpleCommand = command
    if (SHELL_CONTROL_WORDS.indexOf(done.argv[0]!) !== -1) return null
    pipeline.push(done)
  } else if (pipeOpen) {
    return null
  }
  if (pipeline.length > 0) pipelines.push(pipeline)
  return pipelines
}

/** `text` without the text no command consumes: a lone `echo`, `printf` or `git commit`. Unchanged unless the whole of it parsed. */
export function dropCarriedText(text: string): string {
  const pipelines = parseShell(text)
  if (pipelines === null) return text
  let out = ''
  let kept = 0
  for (const pipeline of pipelines) {
    if (pipeline.length !== 1) continue
    const only = pipeline[0]!
    // `printf -v` keeps the text for whatever reads the variable.
    const carries = only.argv[0] === 'echo' || (only.argv[0] === 'printf' && only.argv[1] !== '-v') || (only.argv[0] === 'git' && only.argv[1] === 'commit')
    if (carries) {
      out += text.slice(kept, only.start)
      kept = only.end
    }
  }
  return out + text.slice(kept)
}

/** One `allow_commands:` entry as the words it allows, and whether more may follow them. */
interface AllowEntry {
  argv: string[]
  open: boolean
}

/**
 * An `allow_commands:` entry, or null when it is not one plain command: `git
 * status`, or `npm test *` for any further arguments. A word that could
 * expand matches nothing exactly, so an entry may not hold one.
 */
function allowEntry(entry: string): AllowEntry | null {
  const open = entry.endsWith(' *')
  const parsed = parseShell(open ? entry.slice(0, -2) : entry)
  if (parsed === null || parsed.length !== 1 || parsed[0]!.length !== 1) return null
  const only = parsed[0]![0]!
  if (!only.literal || only.argv.some((w) => /[$*?[~]/.test(w))) return null
  return { argv: only.argv, open }
}

/** Whether `entry` is one `allow_commands:` can use. */
export function isAllowEntry(entry: string): boolean {
  return allowEntry(entry) !== null
}

/**
 * The commands in `text` that `allow` does not allow, as written, in order.
 * All of `text` when it did not parse, or when an entry cannot be read: an
 * allow list that reaches no verdict allows nothing, the opposite of
 * {@link dropCarriedText}, which keeps its old behaviour on the same input.
 */
export function commandsOutsideAllow(text: string, allow: readonly string[]): string[] {
  const parsed = parseShell(text)
  const entries = allow.map(allowEntry)
  if (parsed === null || entries.some((e) => e === null)) return [text]
  const out: string[] = []
  for (const pipeline of parsed) {
    for (const c of pipeline) {
      const allowed = entries.some((e) => {
        const n = e!.argv.length
        if (e!.open ? c.argv.length < n : !c.literal || c.argv.length !== n) return false
        return e!.argv.every((w, i) => w === c.argv[i])
      })
      if (!allowed) out.push(text.slice(c.start, c.end))
    }
  }
  return out
}

/** The parser and the allow list as JavaScript source, for the hook gates to embed. */
export const SHELL_PARSE_JS_SOURCE = [
  `const SHELL_CONTROL_WORDS = ${JSON.stringify(SHELL_CONTROL_WORDS)};`,
  ...[shellIsAssignment, parseShell, dropCarriedText, allowEntry, isAllowEntry, commandsOutsideAllow].map((fn) => fn.toString()),
].join('\n')
