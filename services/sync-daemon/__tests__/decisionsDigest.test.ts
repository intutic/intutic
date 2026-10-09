/**
 * Governed decisions log — the sync-daemon side of the fetch-and-write cycle.
 *
 * 1. Rendering is a pure function of the digest, so an unchanged digest
 *    renders byte-identical files across cycles.
 * 2. The newest entries reach every active harness where it reads its
 *    instructions (`decisionsTargetOf`): Claude Code through
 *    `.claude/rules/intutic-decisions.md`, with or without a `CLAUDE.md`,
 *    which is never created or written; `AGENTS.md` readers through one
 *    section of their own, apart from the rules section.
 * 3. Claude Code does not read the log twice: its own file is left out when
 *    it also reads an `AGENTS.md` that carries the section.
 * 4. The section earlier versions wrote into `CLAUDE.md` comes out, leaving
 *    the user's text byte for byte.
 *
 * HOME is a temporary directory per test: Claude Code's user settings and
 * OpenClaw's agent workspace are read from it.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { HarnessType, decisionsTargetOf } from '@intutic/shared-types'
import {
  renderDecisionsMarkdown,
  renderDecisionsSectionBody,
  refreshDecisionsDigest,
  retireClaudeMdDigest,
  writeDecisionsTargets,
  DECISIONS_LOG_RELATIVE_PATH,
  type DecisionsDigestEntry,
} from '../src/lib/decisionsDigest.js'
import { DECISIONS_MARKERS, RULES_MARKERS, writeRulesSection } from '../src/harness/rulesSection.js'
import { readOriginal, writeOwnedFile } from '../src/disconnect/originals.js'

const ENTRIES: DecisionsDigestEntry[] = [
  { id: 'decision:1', kind: 'decision', timestamp: '2026-08-17T10:00:00.000Z', summary: 'Decision: rollout approved → approved' },
  { id: 'incident:1', kind: 'incident', timestamp: '2026-08-16T09:00:00.000Z', summary: 'Incident resolved: SCOPE_VIOLATION (HIGH) — RESOLVED' },
]
const BODY = renderDecisionsSectionBody(ENTRIES)
const CLAUDE_DECISIONS = path.join('.claude', 'rules', 'intutic-decisions.md')

let base: string
let ws: string
const prevHome = process.env.HOME

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'decisions-digest-'))
  process.env.HOME = path.join(base, 'home')
  ws = path.join(base, 'home', 'code', 'project')
  await fs.mkdir(ws, { recursive: true })
})

afterEach(async () => {
  vi.unstubAllGlobals()
  process.env.HOME = prevHome
  await fs.rm(base, { recursive: true, force: true })
})

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(() => true, () => false)
}

function stubDigestFetch(entries: DecisionsDigestEntry[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ workspaceId: 'wk_test', entries }) })) as unknown as typeof fetch,
  )
}

const refresh = (harnesses: HarnessType[]) =>
  refreshDecisionsDigest({ controlPlaneUrl: 'http://cp.test', apiKey: 'vk_test', workspaceId: 'wk_test', workspaceRoot: ws, harnesses })

async function setClaudeProjectInstructions(value: string): Promise<void> {
  const file = path.join(process.env.HOME!, '.claude', 'settings.json')
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify({ pluginConfigs: { 'cc-plugin-agents-md@builtin': { options: { instructionFiles: value } } } }))
}

describe('rendering', () => {
  it('is deterministic, and says so when there is nothing yet', () => {
    expect(renderDecisionsMarkdown(ENTRIES)).toBe(renderDecisionsMarkdown(ENTRIES))
    expect(renderDecisionsMarkdown(ENTRIES)).toContain('Decision: rollout approved')
    expect(renderDecisionsMarkdown([])).toContain('No governance decisions recorded yet')
    expect(renderDecisionsSectionBody([])).toContain('No governance decisions recorded yet')
  })

  it('bounds the delivered entries', () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ ...ENTRIES[0]!, id: `d${i}`, summary: `entry ${i}` }))
    const body = renderDecisionsSectionBody(many, 10)
    expect(body).toContain('entry 9')
    expect(body).not.toContain('entry 10')
  })
})

describe('Claude Code', () => {
  it('gets the log in .claude/rules/ without a CLAUDE.md, and none is created', async () => {
    stubDigestFetch(ENTRIES)
    expect(await refresh([HarnessType.CLAUDE_CODE])).toEqual({ entriesWritten: 2 })
    const text = await fs.readFile(path.join(ws, CLAUDE_DECISIONS), 'utf-8')
    // No `paths:` front matter: loaded at launch.
    expect(text.startsWith('# Intutic Governed Decisions Log (auto-generated)\n')).toBe(true)
    expect(text).toContain('Decision: rollout approved')
    expect(await exists(path.join(ws, 'CLAUDE.md'))).toBe(false)
  })

  it('gets it there too when the workspace has a CLAUDE.md, which stays as it was', async () => {
    const own = '# Team notes\n\nUse tabs.\n'
    await fs.writeFile(path.join(ws, 'CLAUDE.md'), own)
    stubDigestFetch(ENTRIES)
    await refresh([HarnessType.CLAUDE_CODE])
    expect(await fs.readFile(path.join(ws, CLAUDE_DECISIONS), 'utf-8')).toContain('Decision: rollout approved')
    expect(await fs.readFile(path.join(ws, 'CLAUDE.md'), 'utf-8')).toBe(own)
  })

  it('is written once: a second cycle with the same digest changes no byte and no modification time', async () => {
    stubDigestFetch(ENTRIES)
    await refresh([HarnessType.CLAUDE_CODE, HarnessType.CODEX, HarnessType.CURSOR])
    const files = [DECISIONS_LOG_RELATIVE_PATH, 'AGENTS.md', path.join('.cursor', 'rules', 'intutic-decisions.mdc')].map((f) => path.join(ws, f))
    const before = await Promise.all(files.map(async (f) => [await fs.readFile(f, 'utf-8'), (await fs.stat(f)).mtimeMs]))
    await new Promise((r) => setTimeout(r, 20))
    stubDigestFetch(ENTRIES)
    await refresh([HarnessType.CLAUDE_CODE, HarnessType.CODEX, HarnessType.CURSOR])
    const after = await Promise.all(files.map(async (f) => [await fs.readFile(f, 'utf-8'), (await fs.stat(f)).mtimeMs]))
    expect(after.map((a) => a[0])).toEqual(before.map((b) => b[0]))
    // DECISIONS.md is regenerated whole each cycle; the files harnesses read are not touched.
    expect(after.slice(1).map((a) => a[1])).toEqual(before.slice(1).map((b) => b[1]))
  })
})

describe('AGENTS.md', () => {
  it('carries the log in a section of its own, apart from the rules, after the user\'s text', async () => {
    await fs.writeFile(path.join(ws, 'AGENTS.md'), '# Team\n\nRun the tests.\n')
    await writeRulesSection(path.join(ws, 'AGENTS.md'), ws, '# Rules\n\nNever print a secret.')
    stubDigestFetch(ENTRIES)
    await refresh([HarnessType.CODEX, HarnessType.OPENCODE, HarnessType.GROK])
    const text = await fs.readFile(path.join(ws, 'AGENTS.md'), 'utf-8')
    expect(text.startsWith('# Team\n\nRun the tests.\n\n')).toBe(true)
    expect(text.match(/INTUTIC:DECISIONS_LOG:START/g)).toHaveLength(1)
    expect(text.match(/INTUTIC:RULES:START/g)).toHaveLength(1)
    const rules = text.slice(text.indexOf(RULES_MARKERS.start), text.indexOf(RULES_MARKERS.end))
    expect(rules).not.toContain('Decision: rollout approved')
    expect(text.indexOf(DECISIONS_MARKERS.start)).toBeGreaterThan(text.indexOf(RULES_MARKERS.end))
  })
})

describe('Claude Code reads the log once', () => {
  const harnesses = [HarnessType.CLAUDE_CODE, HarnessType.CODEX]

  it('without a CLAUDE.md it reads AGENTS.md, so its own file is left out, and taken back if an earlier cycle wrote it', async () => {
    stubDigestFetch(ENTRIES)
    await refresh([HarnessType.CLAUDE_CODE])
    expect(await exists(path.join(ws, CLAUDE_DECISIONS))).toBe(true)

    stubDigestFetch(ENTRIES)
    await refresh(harnesses)
    expect(await exists(path.join(ws, CLAUDE_DECISIONS))).toBe(false)
    expect(await fs.readFile(path.join(ws, 'AGENTS.md'), 'utf-8')).toContain('Decision: rollout approved')
  })

  it('with a CLAUDE.md it does not read AGENTS.md, so it gets its own file', async () => {
    await fs.writeFile(path.join(ws, 'CLAUDE.md'), '# Team\n')
    stubDigestFetch(ENTRIES)
    await refresh(harnesses)
    expect(await exists(path.join(ws, CLAUDE_DECISIONS))).toBe(true)
    expect(await fs.readFile(path.join(ws, 'AGENTS.md'), 'utf-8')).toContain('Decision: rollout approved')
  })

  it('a CLAUDE.md in a parent directory, or CLAUDE.local.md, counts; the user\'s ~/.claude/CLAUDE.md does not', async () => {
    await fs.mkdir(path.join(process.env.HOME!, '.claude'), { recursive: true })
    await fs.writeFile(path.join(process.env.HOME!, '.claude', 'CLAUDE.md'), '# Mine\n')
    stubDigestFetch(ENTRIES)
    await refresh(harnesses)
    expect(await exists(path.join(ws, CLAUDE_DECISIONS))).toBe(false)

    await fs.writeFile(path.join(ws, '..', 'CLAUDE.local.md'), '# Mine\n')
    stubDigestFetch(ENTRIES)
    await refresh(harnesses)
    expect(await exists(path.join(ws, CLAUDE_DECISIONS))).toBe(true)
  })

  it('follows the user\'s Project instructions setting', async () => {
    await fs.writeFile(path.join(ws, 'CLAUDE.md'), '# Team\n')
    await setClaudeProjectInstructions('claude-md-and-agents-md')
    stubDigestFetch(ENTRIES)
    await refresh(harnesses)
    expect(await exists(path.join(ws, CLAUDE_DECISIONS))).toBe(false)

    await fs.rm(path.join(ws, 'CLAUDE.md'))
    await setClaudeProjectInstructions('claude-md')
    stubDigestFetch(ENTRIES)
    await refresh(harnesses)
    expect(await exists(path.join(ws, CLAUDE_DECISIONS))).toBe(true)
  })
})

describe('every harness that reads an instructions file gets the log there', () => {
  it.each(Object.values(HarnessType))('%s', async (harness) => {
    await writeDecisionsTargets(ws, [harness], BODY)
    const target = decisionsTargetOf(harness)
    const expected =
      target === null
        ? null
        : target.kind === 'section' && target.scope === 'user'
          ? path.join(process.env.HOME!, target.path)
          : path.join(ws, target.path)
    const written: string[] = []
    const walk = async (dir: string): Promise<void> => {
      for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) await walk(p)
        else if ((await fs.readFile(p, 'utf-8')).includes('Decision: rollout approved')) written.push(p)
      }
    }
    await walk(process.env.HOME!)
    expect(written).toEqual(expected ? [expected] : [])
    expect(await exists(path.join(ws, 'CLAUDE.md'))).toBe(false)
    if (harness === HarnessType.AIDER) {
      expect(await fs.readFile(path.join(ws, '.aider.conf.yml'), 'utf-8')).toContain(`- ${expected}`)
    }
  })
})

describe('retireClaudeMdDigest: the section earlier versions put in CLAUDE.md', () => {
  const SECTION = `${DECISIONS_MARKERS.start}\n## Recent Governed Decisions\n\n- old entry\n${DECISIONS_MARKERS.end}`

  it('comes out, and the user\'s file is back byte for byte', async () => {
    const own = '# Team notes\n\nUse tabs.\n'
    await fs.writeFile(path.join(ws, 'CLAUDE.md'), `${own}\n${SECTION}\n`, { mode: 0o640 })
    await retireClaudeMdDigest(ws)
    expect(await fs.readFile(path.join(ws, 'CLAUDE.md'), 'utf-8')).toBe(own)
    expect((await fs.stat(path.join(ws, 'CLAUDE.md'))).mode & 0o777).toBe(0o640)
  })

  it('comes out of the middle of the file, the text around it kept', async () => {
    await fs.writeFile(path.join(ws, 'CLAUDE.md'), `# Top\n\n${SECTION}\n# Bottom\n`)
    await retireClaudeMdDigest(ws)
    expect(await fs.readFile(path.join(ws, 'CLAUDE.md'), 'utf-8')).toBe('# Top\n\n# Bottom\n')
  })

  it('a CLAUDE.md Intutic created goes with its record once nothing else is left', async () => {
    const file = path.join(ws, 'CLAUDE.md')
    const legacy = '# Intutic Governance Rules (auto-generated)\n# DO NOT EDIT — managed by intutic sync daemon\n\n## Old rule\n'
    await writeOwnedFile(file, ws, legacy)
    await fs.appendFile(file, `\n${SECTION}\n`)
    await retireClaudeMdDigest(ws)
    expect(await exists(file)).toBe(false)
    expect(await readOriginal(file, ws)).toBeNull()

    await writeOwnedFile(file, ws, '')
    await fs.writeFile(file, `${SECTION}\n`)
    await retireClaudeMdDigest(ws)
    expect(await exists(file)).toBe(false)
    expect(await readOriginal(file, ws)).toBeNull()
  })

  it('leaves a CLAUDE.md without the section alone', async () => {
    await fs.writeFile(path.join(ws, 'CLAUDE.md'), '# Mine\n')
    const before = (await fs.stat(path.join(ws, 'CLAUDE.md'))).mtimeMs
    await retireClaudeMdDigest(ws)
    expect((await fs.stat(path.join(ws, 'CLAUDE.md'))).mtimeMs).toBe(before)
  })
})

describe('refreshDecisionsDigest failures', () => {
  it('returns null and writes nothing when the control plane is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch)
    expect(await refresh([HarnessType.CLAUDE_CODE])).toBeNull()
    await expect(fs.readFile(path.join(ws, DECISIONS_LOG_RELATIVE_PATH), 'utf-8')).rejects.toThrow()
    expect(await exists(path.join(ws, CLAUDE_DECISIONS))).toBe(false)
  })
})
