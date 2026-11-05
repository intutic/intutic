import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { commandsOutsideAllow, parseShell } from '../shellParse.js'

const VECTORS = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../shared-types/fixtures/shell-parse-vectors.json'), 'utf-8'),
) as { cases: Array<{ text: string; parsed: unknown }>; allow: Array<{ allow: string[]; text: string; outside: string[] }> }

describe('parseShell', () => {
  it('has its vectors', () => {
    expect(VECTORS.cases.length).toBeGreaterThan(40)
  })

  it.each(VECTORS.cases.map((c) => [c.text, c.parsed] as const))('reads %j', (text, parsed) => {
    const got = parseShell(text)
    expect(got && got.map((p) => p.map(({ argv, literal }) => ({ argv, literal })))).toEqual(parsed)
  })
})

describe('commandsOutsideAllow', () => {
  it.each(VECTORS.allow.map((c) => [c.text, c.allow, c.outside] as const))('reads %j against %j', (text, allow, outside) => {
    expect(commandsOutsideAllow(text, allow)).toEqual(outside)
  })
})
