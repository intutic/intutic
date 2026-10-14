/**
 * The rule-author skill's copy gate (tools/scripts/check-rule-author-skill-copies.js).
 *
 * The docs download and the copy `intutic connect` writes (embedded in
 * skillWriter.ts) must both be the canonical .agents file, byte for byte.
 * These run the real script against a fixture tree.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'

const SCRIPT = resolve(import.meta.dirname, '../../scripts/check-rule-author-skill-copies.js')

function runGate(root: string): Promise<{ status: number; out: string }> {
  return new Promise((res, reject) => {
    const child = spawn('node', [SCRIPT, root], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => (out += d))
    child.stderr.on('data', (d: string) => (out += d))
    child.on('error', reject)
    child.on('close', (code) => res({ status: code === null ? -1 : code, out }))
  })
}

const SKILL = '# Rule Author\n\nRun `intutic policy test` first; a rule that breaks the sandbox is refused.\n'
// The template literal as skillWriter.ts holds it: backticks escaped.
const embedded = (text: string) =>
  `export const RULE_AUTHOR_SKILL_PATH = 'x'\n\nexport const RULE_AUTHOR_SKILL = \`${text.replace(/[\\`$]/g, (c) => `\\${c}`)}\`\n\nexport const OTHER = 1\n`

let root: string
const put = async (rel: string, body: string) => {
  await mkdir(dirname(join(root, rel)), { recursive: true })
  await writeFile(join(root, rel), body)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ruleauthorskill-'))
  await put('.agents/skills/intutic-rule-author/SKILL.md', SKILL)
  await put('apps/docs/public/downloads/RULE_AUTHOR_SKILL.md', SKILL)
  await put('services/sync-daemon/src/skillWriter.ts', embedded(SKILL))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('rule-author skill copies', () => {
  it('passes when the download and the embedded copy are the canonical file', async () => {
    const r = await runGate(root)
    expect(r.status, r.out).toBe(0)
    expect(r.out).toContain('[PASS]')
  })

  it('fails a download that kept the old text, naming the line and column', async () => {
    await put('apps/docs/public/downloads/RULE_AUTHOR_SKILL.md', SKILL.replace('is refused', 'is silently disabled'))
    const r = await runGate(root)
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain('apps/docs/public/downloads/RULE_AUTHOR_SKILL.md differs from .agents/skills/intutic-rule-author/SKILL.md at line 3, column')
    expect(r.out).toContain('silently disabled')
  })

  it('fails an embedded copy that differs, after unescaping its backticks', async () => {
    await put('services/sync-daemon/src/skillWriter.ts', embedded(SKILL.replace('first', 'later')))
    const r = await runGate(root)
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain("services/sync-daemon/src/skillWriter.ts's RULE_AUTHOR_SKILL differs")
  })

  it('fails an embedded copy that interpolates', async () => {
    await put('services/sync-daemon/src/skillWriter.ts', 'export const RULE_AUTHOR_SKILL = `# Rule ${name}`\n')
    const r = await runGate(root)
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain('must be literal text')
  })

  it('fails when the download is missing', async () => {
    await rm(join(root, 'apps/docs/public/downloads/RULE_AUTHOR_SKILL.md'))
    const r = await runGate(root)
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain('RULE_AUTHOR_SKILL.md is missing')
  })
})
