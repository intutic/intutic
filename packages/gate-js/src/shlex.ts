/**
 * A minimal POSIX-shell-like tokenizer, standing in for Python's `shlex.split`.
 *
 * Handles single quotes (literal, no escapes), double quotes (backslash
 * escapes `\"`, `\\`, `\$`, `` \` ``), and unquoted backslash escapes.
 * Throws on an unterminated quote, mirroring `shlex.split`'s `ValueError` —
 * callers treat that as "could not tokenise" and fail closed, the same
 * posture `imagecheck.py` documents.
 *
 * This is not a full shell grammar (no `$()`, no globbing, no `&&`
 * splitting) — it only needs to split a single command line into argv-shaped
 * tokens the way `kubectl`/`helm` would see them, which is exactly the scope
 * `shlex.split` covers for the Python port too.
 */
export function shlexSplit(command: string): string[] {
  const tokens: string[] = []
  let current = ''
  let inToken = false
  let i = 0
  const n = command.length

  while (i < n) {
    const ch = command[i]!

    if (ch === "'") {
      inToken = true
      const close = command.indexOf("'", i + 1)
      if (close === -1) throw new Error('shlex: unterminated single-quoted string')
      current += command.slice(i + 1, close)
      i = close + 1
      continue
    }

    if (ch === '"') {
      inToken = true
      i += 1
      let closed = false
      while (i < n) {
        const c = command[i]!
        if (c === '"') {
          closed = true
          i += 1
          break
        }
        if (c === '\\' && i + 1 < n && '"\\$`'.includes(command[i + 1]!)) {
          current += command[i + 1]
          i += 2
          continue
        }
        current += c
        i += 1
      }
      if (!closed) throw new Error('shlex: unterminated double-quoted string')
      continue
    }

    if (/\s/.test(ch)) {
      if (inToken) {
        tokens.push(current)
        current = ''
        inToken = false
      }
      i += 1
      continue
    }

    if (ch === '\\' && i + 1 < n) {
      inToken = true
      current += command[i + 1]
      i += 2
      continue
    }

    inToken = true
    current += ch
    i += 1
  }

  if (inToken) tokens.push(current)
  return tokens
}
