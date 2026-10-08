/**
 * tomlLines.ts — line-level TOML edits that keep the user's comments.
 *
 * Codex's and OpenHands' writers set a key or append a table by editing
 * lines, so the user's comments survive; undoing them the same way keeps
 * that promise. Only the shapes those writers produce are handled: a
 * `key = value` line in the top level or in a `[table]`, and a whole table.
 *
 * @module
 */

import { parse as parseToml } from 'smol-toml'

interface Section {
  /** Table name as written between the brackets, or null for the top level. */
  name: string | null
  /** Index of the header line (-1 for the top level). */
  header: number
  /** One past the last line of the section. */
  end: number
}

/** Splits lines into sections, ignoring `[` lines inside multi-line strings. */
export function tomlSections(lines: readonly string[]): Section[] {
  const sections: Section[] = [{ name: null, header: -1, end: lines.length }]
  let inString: '"""' | "'''" | null = null
  lines.forEach((line, i) => {
    if (inString === null) {
      // `[table]` or `[[array.of.tables]]`; the name is what is between the brackets.
      const header = /^\s*\[\[?\s*([^\][]+?)\s*\]\]?\s*(#.*)?$/.exec(line)
      if (header) {
        sections[sections.length - 1]!.end = i
        sections.push({ name: header[1]!, header: i, end: lines.length })
        return
      }
    }
    for (const quote of ['"""', "'''"] as const) {
      let at = line.indexOf(quote)
      while (at !== -1) {
        if (inString === null) inString = quote
        else if (inString === quote) inString = null
        at = line.indexOf(quote, at + 3)
      }
    }
  })
  return sections
}

/** The value a one-line `key = value` assignment holds, or undefined when the line is not one. */
export function lineValue(line: string, key: string): unknown {
  if (!new RegExp(`^\\s*${key}\\s*=`).test(line)) return undefined
  try {
    return (parseToml(line) as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

/** Index of `key`'s line in the first section named `table` (null: top level), or -1. */
export function findKeyLine(lines: readonly string[], table: string | null, key: string): number {
  const section = tomlSections(lines).find((s) => s.name === table)
  if (!section) return -1
  for (let i = section.header + 1; i < section.end; i++) {
    if (lineValue(lines[i]!, key) !== undefined) return i
  }
  return -1
}

/**
 * Removes the table named `table`, header to end, with the blank line a
 * writer put before it when it appended the table.
 */
export function removeTable(lines: string[], table: string): boolean {
  const section = tomlSections(lines).find((s) => s.name === table)
  if (!section) return false
  let start = section.header
  if (start > 0 && lines[start - 1]!.trim() === '') start--
  lines.splice(start, section.end - start)
  return true
}

/** Removes a `[table]` header with nothing left under it but blank lines. */
export function removeEmptyTable(lines: string[], table: string): boolean {
  const section = tomlSections(lines).find((s) => s.name === table)
  if (!section) return false
  for (let i = section.header + 1; i < section.end; i++) if (lines[i]!.trim() !== '') return false
  return removeTable(lines, table)
}

/**
 * Puts back one key a writer set. When the original text had the key in
 * the same section its line is restored; otherwise the line is removed.
 * Only a line whose value `isIntutic` recognises is touched.
 */
export function restoreKeyLine(
  lines: string[],
  table: string | null,
  key: string,
  originalLines: readonly string[] | null,
  isIntutic: (value: unknown) => boolean,
): boolean {
  const at = findKeyLine(lines, table, key)
  if (at === -1 || !isIntutic(lineValue(lines[at]!, key))) return false
  const was = originalLines ? findKeyLine(originalLines, table, key) : -1
  if (was !== -1) {
    if (lines[at] === originalLines![was]) return false
    lines[at] = originalLines![was]!
  } else {
    lines.splice(at, 1)
  }
  return true
}
