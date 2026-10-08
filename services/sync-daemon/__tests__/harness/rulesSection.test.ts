/**
 * rulesSection.test.ts — the rules section in an instructions file the user
 * also writes (`GEMINI.md`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  injectRulesSection,
  removeRulesSection,
  rulesSectionOf,
  writeRulesSection,
  RULES_SECTION_START,
  RULES_SECTION_END,
} from '../../src/harness/rulesSection.js'
import { readOriginal } from '../../src/disconnect/originals.js'

const BODY = '# Rules\n\nNever print a secret.'
const SECTION = `${RULES_SECTION_START}\n${BODY}\n${RULES_SECTION_END}`

describe('injectRulesSection / removeRulesSection', () => {
  it('appends the section after a blank line, keeping the user\'s text', () => {
    expect(injectRulesSection('# Mine\n\nUse tabs.\n', BODY)).toBe(`# Mine\n\nUse tabs.\n\n${SECTION}\n`)
    expect(injectRulesSection('# Mine', BODY)).toBe(`# Mine\n\n${SECTION}\n`)
    expect(injectRulesSection('', BODY)).toBe(`${SECTION}\n`)
  })

  it('replaces the section in place, wherever it is, and is idempotent', () => {
    const moved = `# Top\n\n${injectRulesSection('', 'old rules')}\n# Bottom\n`
    const once = injectRulesSection(moved, BODY)
    expect(once).toBe(`# Top\n\n${SECTION}\n\n# Bottom\n`)
    expect(injectRulesSection(once, BODY)).toBe(once)
  })

  it('pairs an end marker with the nearest start marker before it', () => {
    const stray = `${RULES_SECTION_START} quoted in the user's notes\n\nkeep me\n`
    const text = injectRulesSection(stray, BODY)
    expect(rulesSectionOf(text)).toBe(SECTION)
    expect(removeRulesSection(text)).toBe(stray)
  })

  it('removes exactly what was added', () => {
    for (const original of ['# Mine\n\nUse tabs.\n', '# Mine\n', 'a\n\n\nb\n', '']) {
      expect(removeRulesSection(injectRulesSection(original, BODY))).toBe(original)
    }
    // Without a final line break the file comes back with one; disconnect
    // restores the original bytes from the copy it kept.
    expect(removeRulesSection(injectRulesSection('# Mine', BODY))).toBe('# Mine\n')
  })

  it('removes a section the user moved to the top, with the line break after it', () => {
    expect(removeRulesSection(`${SECTION}\n# Mine\n`)).toBe('# Mine\n')
  })

  it('reports no section in a file without one', () => {
    expect(removeRulesSection('# Mine\n')).toBeNull()
    expect(rulesSectionOf('# Mine\n')).toBeNull()
    expect(rulesSectionOf(`${RULES_SECTION_END}\n${RULES_SECTION_START}\n`)).toBeNull()
  })
})

describe('writeRulesSection', () => {
  let root: string
  const file = () => path.join(root, 'GEMINI.md')

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'intutic-rules-section-'))
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('keeps the user\'s file and its mode, records the original, and rewrites nothing on a repeat', async () => {
    await fs.writeFile(file(), '# Mine\n', { mode: 0o640 })
    await writeRulesSection(file(), root, BODY)

    expect(await fs.readFile(file(), 'utf-8')).toBe(`# Mine\n\n${SECTION}\n`)
    expect((await fs.stat(file())).mode & 0o777).toBe(0o640)
    expect((await readOriginal(file(), root))?.content?.toString('utf-8')).toBe('# Mine\n')

    const mtime = (await fs.stat(file())).mtimeMs
    await new Promise((r) => setTimeout(r, 20))
    await writeRulesSection(file(), root, BODY)
    expect((await fs.stat(file())).mtimeMs).toBe(mtime)
  })

  it('creates a missing file and records that it did', async () => {
    await writeRulesSection(file(), root, BODY)
    expect(await fs.readFile(file(), 'utf-8')).toBe(`${SECTION}\n`)
    expect((await readOriginal(file(), root))?.existed).toBe(false)
  })
})
