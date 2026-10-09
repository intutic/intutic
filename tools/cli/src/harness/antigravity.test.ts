/**
 * antigravity.test.ts — where the Antigravity / Gemini CLI adapter puts the
 * rule sets: a marked section of the workspace's `GEMINI.md`, the file both
 * products load as instructions, and not `.gemini/settings.json`, which
 * neither reads instructions from.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SyncSopEntry } from '@intutic/shared-types'
import { RULES_SECTION_START, RULES_SECTION_END } from '@intutic/sync-daemon'
import { antigravityAdapter } from './antigravity.js'

const PROXY = 'http://localhost:4000'
const SOPS: SyncSopEntry[] = [
  { sopId: 'sop_1', title: 'No secrets', content: 'Never print a secret.', contentHash: '', harnessTargets: [] },
]
const MINE = '# Project notes\n\nPrefer small diffs.\n'

describe('antigravityAdapter.writeConfig', () => {
  let ws: string
  const gemini = () => join(ws, 'GEMINI.md')

  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), 'intutic-agy-rules-'))
  })

  afterEach(async () => {
    await rm(ws, { recursive: true, force: true })
  })

  it('writes the rule sets into GEMINI.md between the markers, and nothing into .gemini/settings.json', async () => {
    const settings = join(ws, '.gemini', 'settings.json')
    await mkdir(join(ws, '.gemini'), { recursive: true })
    await writeFile(settings, '{\n  "theme": "dark"\n}\n')

    expect(await antigravityAdapter.writeConfig(ws, SOPS, PROXY)).toBe(gemini())

    const text = await readFile(gemini(), 'utf-8')
    expect(text.startsWith(`${RULES_SECTION_START}\n# Intutic Governance Rules (auto-generated)\n`)).toBe(true)
    expect(text).toContain('## No secrets\n\nNever print a secret.')
    expect(text.endsWith(`${RULES_SECTION_END}\n`)).toBe(true)
    expect(await readFile(settings, 'utf-8')).toBe('{\n  "theme": "dark"\n}\n')
  })

  it('keeps the user\'s own GEMINI.md content and adds the section after it', async () => {
    await writeFile(gemini(), MINE)
    await antigravityAdapter.writeConfig(ws, SOPS, PROXY)
    const text = await readFile(gemini(), 'utf-8')
    expect(text.startsWith(`${MINE}\n${RULES_SECTION_START}\n`)).toBe(true)
  })

  it('is idempotent, and replaces the section when the rule sets change', async () => {
    await writeFile(gemini(), MINE)
    await antigravityAdapter.writeConfig(ws, SOPS, PROXY)
    const once = await readFile(gemini(), 'utf-8')
    await antigravityAdapter.writeConfig(ws, SOPS, PROXY)
    expect(await readFile(gemini(), 'utf-8')).toBe(once)

    await antigravityAdapter.writeConfig(ws, [{ ...SOPS[0]!, content: 'Never print a token.' }], PROXY)
    const changed = await readFile(gemini(), 'utf-8')
    expect(changed.split(RULES_SECTION_START)).toHaveLength(2)
    expect(changed).toContain('Never print a token.')
    expect(changed).not.toContain('Never print a secret.')
    expect(changed.startsWith(MINE)).toBe(true)
  })

  it('writes nothing without rule sets', async () => {
    expect(await antigravityAdapter.writeConfig(ws, [], PROXY)).toBeNull()
    expect(existsSync(gemini())).toBe(false)
  })

  it('hashes the section only: the user\'s edits elsewhere in the file are not drift', async () => {
    expect(await antigravityAdapter.readCurrentHash(ws)).toBeNull()
    await writeFile(gemini(), MINE)
    expect(await antigravityAdapter.readCurrentHash(ws)).toBeNull()

    await antigravityAdapter.writeConfig(ws, SOPS, PROXY)
    const hash = await antigravityAdapter.readCurrentHash(ws)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)

    const text = await readFile(gemini(), 'utf-8')
    await writeFile(gemini(), text.replace('Prefer small diffs.', 'Prefer large diffs.'))
    expect(await antigravityAdapter.readCurrentHash(ws)).toBe(hash)

    await writeFile(gemini(), text.replace('Never print a secret.', 'Print anything.'))
    expect(await antigravityAdapter.readCurrentHash(ws)).not.toBe(hash)
  })
})
