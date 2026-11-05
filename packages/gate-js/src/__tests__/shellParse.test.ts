import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseShell } from '../shellParse.js'

const VECTORS = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../shared-types/fixtures/shell-parse-vectors.json'), 'utf-8'),
) as { cases: Array<{ text: string; parsed: unknown }> }

describe('parseShell', () => {
  it('has its vectors', () => {
    expect(VECTORS.cases.length).toBeGreaterThan(40)
  })

  it.each(VECTORS.cases.map((c) => [c.text, c.parsed] as const))('reads %j', (text, parsed) => {
    const got = parseShell(text)
    expect(got && got.map((p) => p.map(({ argv, literal }) => ({ argv, literal })))).toEqual(parsed)
  })
})
