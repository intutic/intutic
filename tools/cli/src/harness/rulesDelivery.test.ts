/**
 * Rule sets reach each harness where the product reads standing
 * instructions, and nowhere else.
 *
 * `HARNESS_RULES_FILES` (`@intutic/shared-types`) names that file for every
 * harness, citing the product's documentation or source. This drives every
 * adapter's `writeConfig` with a rule set carrying a unique marker and
 * requires the marker to land in exactly the mapped file (or in no file, for
 * a harness the map says reads none), the user's own text in a shared file to
 * survive, and a second write to change nothing. It also holds the other
 * places the mapping is repeated to it: each adapter's `configFileName`, the
 * sync daemon's `HARNESS_FILES`, and the docs table "Where rule sets go".
 *
 * Writers keep some paths in module-level constants computed from the home
 * directory at import time, so HOME is moved before anything is imported.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

const fake = vi.hoisted(() => {
  const base = `${process.env.TMPDIR || '/tmp'}/intutic-rules-delivery-${process.pid}-${Date.now()}`.replace(/\/+/g, '/')
  process.env.HOME = `${base}/home`
  process.env.USERPROFILE = `${base}/home`
  delete process.env.XDG_CONFIG_HOME
  delete process.env.CODEX_HOME
  delete process.env.DSH_HOME
  delete process.env.OPENCLAW_WORKSPACE_DIR
  process.env.N8N_URL = 'http://127.0.0.1:9'
  return { base, home: `${base}/home`, ws: `${base}/home/code/project` }
})

import * as fs from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HARNESS_RULES_FILES, HarnessType, decisionsTargetOf, rulesFileOf, type SyncSopEntry } from '@intutic/shared-types'
import { HARNESS_FILES, RULES_SECTION_START, writeDecisionsTargets } from '@intutic/sync-daemon'
import { ALL_ADAPTERS, getAdapter } from './detector.js'
import { buildSopSections } from './rulesFiles.js'
import { writeHarnessConfigs } from '../commands/connect.js'

const { base, home, ws } = fake
const PROXY = 'http://127.0.0.1:4000'
const MARKER = 'rules-delivery-marker-7f3a'
const DECISIONS_MARKER = 'decisions-delivery-marker-2c9e'
const USER_TEXT = '# Team notes\n\nKeep me.\n'
/** Where earlier versions wrote the rules whole; the user's own copies must be left as they are. */
const LEGACY = ['CLAUDE.md', '.cursorrules', '.windsurfrules', '.roorules']

function sop(id: string, targets: string[], content = `Never print a secret. ${MARKER}`): SyncSopEntry {
  return { sopId: id, title: `Rule ${id}`, content, contentHash: '', harnessTargets: targets as HarnessType[] }
}

/** Every file under `root`, with its bytes. */
async function files(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) await walk(p)
      else out.set(p, await fs.readFile(p, 'utf-8'))
    }
  }
  await walk(root)
  return out
}

const harnesses = Object.values(HarnessType)

describe('HARNESS_RULES_FILES', () => {
  it('decides every harness, and cites the product for every file', () => {
    expect(Object.keys(HARNESS_RULES_FILES).sort()).toEqual([...harnesses].sort())
    for (const [harness, target] of Object.entries(HARNESS_RULES_FILES)) {
      if (target.kind === 'none') expect(target.reason.length, harness).toBeGreaterThan(20)
      else expect(target.source, harness).toMatch(/^https:\/\//)
    }
  })

  it('names no CLAUDE.md for rule sets or the decisions log: it is the team\'s file, and creating one hides AGENTS.md from Claude Code', () => {
    for (const h of harnesses) {
      const target = HARNESS_RULES_FILES[h]
      const paths = target.kind === 'none' ? [] : target.kind === 'file' ? [target.path, target.decisionsPath] : [target.path]
      for (const p of paths) expect(p.split('/').pop()?.toUpperCase(), h).not.toMatch(/^CLAUDE(\.LOCAL)?\.MD$/)
    }
  })

  it('every adapter tracks drift on its rules file', () => {
    for (const adapter of ALL_ADAPTERS) {
      const file = rulesFileOf(adapter.type)
      if (file !== null) expect(adapter.configFileName, adapter.type).toBe(file)
    }
  })

  it('the sync daemon captures, watches and edits the same file', () => {
    for (const h of harnesses) {
      const file = rulesFileOf(h)
      if (file !== null) expect(HARNESS_FILES[h], h).toBe(file)
    }
  })

  it('matches the docs table "Where rule sets go"', async () => {
    const docs = await fs.readFile(fileURLToPath(new URL('../../../../apps/docs/guide/how-it-works.md', import.meta.url)), 'utf-8')
    const table = docs.slice(docs.indexOf('## Where rule sets go'))
    const rows = new Map<string, string>()
    const decisions = new Map<string, string>()
    for (const m of table.matchAll(/^\| [^|]+ \| `([a-z0-9-]+)` \| ([^|]+) \| ([^|]+) \|/gm)) {
      rows.set(m[1]!, m[2]!.trim())
      decisions.set(m[1]!, m[3]!.trim())
    }
    expect([...rows.keys()].sort()).toEqual([...harnesses].sort())
    for (const h of harnesses) {
      const target = HARNESS_RULES_FILES[h]
      const want = target.kind === 'none' ? 'No instructions file' : `\`${target.scope === 'user' ? '~/' : ''}${target.path}\``
      expect(rows.get(h), h).toContain(want)
      const log = decisionsTargetOf(h)
      const wantLog = log === null ? 'Does not reach it' : log.kind === 'section' ? 'Its own section' : `\`${log.path}\``
      expect(decisions.get(h), h).toContain(wantLog)
    }
  })
})

describe('each adapter writes its rule sets where the product reads them', () => {
  beforeEach(async () => {
    await fs.rm(home, { recursive: true, force: true })
    await fs.mkdir(ws, { recursive: true })
  })

  afterAll(async () => {
    await fs.rm(base, { recursive: true, force: true })
  })

  it('has an adapter for every harness that reads a file', () => {
    for (const h of harnesses) {
      if (HARNESS_RULES_FILES[h].kind !== 'none') expect(getAdapter(h), h).toBeDefined()
    }
  })

  it.each(ALL_ADAPTERS.map((a) => [a.type, a] as const))('%s', async (harness, adapter) => {
    const target = HARNESS_RULES_FILES[harness]
    const expected = target.kind === 'none' ? null : join(target.scope === 'user' ? home : ws, target.path)
    if (expected && target.kind === 'section') {
      await fs.mkdir(join(expected, '..'), { recursive: true })
      await fs.writeFile(expected, USER_TEXT)
    }
    for (const legacy of LEGACY) await fs.writeFile(join(ws, legacy), `${legacy}: the user's own\n`)

    await adapter.writeConfig(ws, [sop('one', [harness])], PROXY)
    await writeDecisionsTargets(ws, [harness], `## Recent Governed Decisions\n\n- ${DECISIONS_MARKER}`)

    const after = await files(home)
    const logCarriers = [...after].filter(([, text]) => text.includes(DECISIONS_MARKER)).map(([p]) => p)
    const log = decisionsTargetOf(harness)
    const expectedLog = log === null ? null : join(log.kind === 'section' && log.scope === 'user' ? home : ws, log.path)
    expect(logCarriers, `decisions log written to ${logCarriers.map((p) => relative(home, p)).join(', ')}`).toEqual(expectedLog ? [expectedLog] : [])
    const carrying = [...after].filter(([, text]) => text.includes(MARKER)).map(([p]) => p)
    expect(carrying, `rule text written to ${carrying.map((p) => relative(home, p)).join(', ')}`).toEqual(expected ? [expected] : [])
    for (const legacy of LEGACY) expect(after.get(join(ws, legacy))).toBe(`${legacy}: the user's own\n`)

    if (expected && target.kind === 'section') {
      const text = after.get(expected)!
      expect(text.startsWith(`${USER_TEXT}\n${RULES_SECTION_START}\n`)).toBe(true)
    }
    if (harness === HarnessType.AIDER) {
      // Aider loads nothing unless listed, and resolves the entry against the directory it runs in.
      expect(after.get(join(ws, '.aider.conf.yml'))).toMatch(new RegExp(`^read:\\n {2}- ${expected!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'))
    }

    await new Promise((r) => setTimeout(r, 5))
    await adapter.writeConfig(ws, [sop('one', [harness])], PROXY)
    const again = await files(home)
    for (const [p, text] of after) if (text.includes(MARKER)) expect(again.get(p), `${relative(home, p)} changed on a repeat`).toBe(text)
  })

  it('carries the sop:// pointer of a synced SOP, and none for a local one', () => {
    const text = buildSopSections([
      { ...sop('sop_1', []), sopRef: '<!-- sop://intutic/sop_1 | Rule sop_1 -->' },
      sop('local:a:b.md', []),
    ])
    expect(text).toContain(`## Rule sop_1\n\nNever print a secret. ${MARKER}\n<!-- sop://intutic/sop_1 | Rule sop_1 -->`)
    expect(text.match(/sop:\/\//g)).toHaveLength(1)
  })
})

describe('AGENTS.md, shared by every harness that reads it', () => {
  beforeEach(async () => {
    await fs.rm(home, { recursive: true, force: true })
    await fs.mkdir(ws, { recursive: true })
  })

  it('holds the rule sets aimed at any of them once, after the user\'s own text, and a resync changes nothing', async () => {
    const agentsMd = join(ws, 'AGENTS.md')
    await fs.writeFile(agentsMd, USER_TEXT)
    const readers = [HarnessType.CODEX, HarnessType.OPENCODE, HarnessType.GROK, HarnessType.MUSE_CODE]
    const sops = [sop('for-codex', [HarnessType.CODEX], 'Codex rule.'), sop('for-opencode', [HarnessType.OPENCODE], 'OpenCode rule.')]

    expect(await writeHarnessConfigs(readers, ws, sops, PROXY, false)).toBe(2)
    const text = await fs.readFile(agentsMd, 'utf-8')
    expect(text.startsWith(`${USER_TEXT}\n${RULES_SECTION_START}\n`)).toBe(true)
    expect(text.match(/Codex rule\./g)).toHaveLength(1)
    expect(text.match(/OpenCode rule\./g)).toHaveLength(1)

    await writeHarnessConfigs(readers, ws, sops, PROXY, false)
    expect(await fs.readFile(agentsMd, 'utf-8')).toBe(text)
  })

  it('does not take a rule set aimed at a harness that is not configured here', async () => {
    await writeHarnessConfigs([HarnessType.CODEX], ws, [sop('a', [HarnessType.CODEX], 'Codex rule.'), sop('b', [HarnessType.PI], 'Pi rule.')], PROXY, false)
    const text = await fs.readFile(join(ws, 'AGENTS.md'), 'utf-8')
    expect(text).toContain('Codex rule.')
    expect(text).not.toContain('Pi rule.')
  })
})

describe('no writer creates CLAUDE.md', () => {
  beforeEach(async () => {
    await fs.rm(home, { recursive: true, force: true })
    await fs.mkdir(ws, { recursive: true })
  })

  it('the rules and the decisions log for every harness at once leave the workspace without one', async () => {
    const all = ALL_ADAPTERS.map((a) => a.type)
    for (const adapter of ALL_ADAPTERS) await adapter.writeConfig(ws, [sop('one', all)], PROXY)
    await writeDecisionsTargets(ws, all, `## Recent Governed Decisions\n\n- ${DECISIONS_MARKER}`)
    for (const name of ['CLAUDE.md', join('.claude', 'CLAUDE.md'), 'CLAUDE.local.md']) {
      await expect(fs.access(join(ws, name)), name).rejects.toThrow()
    }
  })
})

describe('Claude Code does not load a rule set twice', () => {
  const claudeRules = () => join(ws, '.claude', 'rules', 'intutic-governance.md')
  const both = [HarnessType.CLAUDE_CODE, HarnessType.CODEX]

  beforeEach(async () => {
    await fs.rm(home, { recursive: true, force: true })
    await fs.mkdir(ws, { recursive: true })
  })

  it('without a CLAUDE.md it reads AGENTS.md, so a rule set aimed at it and Codex is only there', async () => {
    await writeHarnessConfigs(both, ws, [sop('shared', both, 'Shared rule.'), sop('mine', [HarnessType.CLAUDE_CODE], 'Claude-only rule.')], PROXY, false)
    const own = await fs.readFile(claudeRules(), 'utf-8')
    expect(own).toContain('Claude-only rule.')
    expect(own).not.toContain('Shared rule.')
    const agents = await fs.readFile(join(ws, 'AGENTS.md'), 'utf-8')
    expect(agents).toContain('Shared rule.')
    expect(agents).not.toContain('Claude-only rule.')
  })

  it('takes its own file away when every rule set aimed at it comes through AGENTS.md', async () => {
    await writeHarnessConfigs([HarnessType.CLAUDE_CODE], ws, [sop('shared', both, 'Shared rule.')], PROXY, false)
    expect(await fs.readFile(claudeRules(), 'utf-8')).toContain('Shared rule.')
    await writeHarnessConfigs(both, ws, [sop('shared', both, 'Shared rule.')], PROXY, false)
    await expect(fs.access(claudeRules())).rejects.toThrow()
  })

  it('with a CLAUDE.md it does not read AGENTS.md, so its own file carries everything aimed at it', async () => {
    await fs.writeFile(join(ws, 'CLAUDE.md'), '# Team\n')
    await writeHarnessConfigs(both, ws, [sop('shared', both, 'Shared rule.')], PROXY, false)
    expect(await fs.readFile(claudeRules(), 'utf-8')).toContain('Shared rule.')
    expect(await fs.readFile(join(ws, 'CLAUDE.md'), 'utf-8')).toBe('# Team\n')
  })
})
