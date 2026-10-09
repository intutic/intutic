/**
 * A `.rules` text as the sync daemon writes it: a `#digest` line over the
 * data lines, then the lines. Every reader treats a file without a digest as
 * unverified and drops its rules, so a fixture that wants its rules loaded
 * carries one.
 */
import { createHash } from 'node:crypto'

export function rulesText(lines: readonly string[]): string {
  const digest = createHash('sha256').update(lines.join('\n'), 'utf-8').digest('hex').slice(0, 32)
  return `#digest ${digest}\n${lines.join('\n')}\n`
}
