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
 * is another. All three run `shell-parse-vectors.json` in
 * `@intutic/shared-types`.
 *
 * @module
 */

/** Words that open a construct this parser does not model. `alias` is here because it changes what the next word means. */
const CONTROL_WORDS: ReadonlySet<string> = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac',
  'select', 'function', 'coproc', 'alias',
])

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
function isAssignment(text: string, i: number): boolean {
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
        if (CONTROL_WORDS.has(done.argv[0]!)) return null
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
      if ('$*?[~'.includes(c) || (word === null && isAssignment(text, i))) {
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
    if (CONTROL_WORDS.has(done.argv[0]!)) return null
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
    const carries = only.argv[0] === 'echo' || only.argv[0] === 'printf' || (only.argv[0] === 'git' && only.argv[1] === 'commit')
    if (carries) {
      out += text.slice(kept, only.start)
      kept = only.end
    }
  }
  return out + text.slice(kept)
}
