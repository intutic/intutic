/**
 * skillScan.ts against a benign-skill corpus — the false-positive measurement
 * TD-358 was held open for.
 *
 * `corpus/skills/` vendors 350 real `SKILL.md` files from four MIT/Apache-2.0
 * collections at pinned upstream commits (see `PROVENANCE.md` there). None was
 * written or chosen for this scanner: every hit below is a false positive by
 * construction, and each one was read and confirmed benign before being
 * recorded in {@link REVIEWED_FALSE_POSITIVES}.
 *
 * What this pins:
 *
 * 1. The exact set of (pattern, file) hits. A new hit fails — it has to be
 *    reviewed, not absorbed into a number. A vanished hit fails too — a
 *    pattern that got narrower changes what the baseline claims.
 * 2. `SKILL_CONTENT_BLOCK_PATTERN_IDS` ⊆ patterns with zero hits. The block
 *    tier is licensed by this measurement and by nothing else.
 * 3. `BASELINE.txt` is what this run produces. Regenerate deliberately with
 *    `INTUTIC_WRITE_BASELINE=1 pnpm --filter @intutic/shared-types exec vitest run skillScanCorpus`
 *    and read the diff.
 *
 * The corpus is vendored rather than fetched so this test cannot skip: a
 * missing file is a failure, not a pass.
 *
 * @module
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { SKILL_CONTENT_BLOCK_PATTERN_IDS, SKILL_SCAN_PATTERNS, scanSkillContent } from '../skillScan.js'

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), 'corpus', 'skills')

/** Below this, "zero false positives" is too weak a statement to license a block. */
const MIN_CORPUS_SKILLS = 100

/**
 * Every corpus hit, each read in full context and confirmed benign. The
 * `why` is the reviewer's verdict, kept short; the excerpt is in BASELINE.txt.
 */
const REVIEWED_FALSE_POSITIVES: ReadonlyArray<{ pattern: string; file: string; why: string }> = [
  { pattern: 'read-sensitive-path', file: 'k-dense-scientific-skills/skills/autoskill/SKILL.md', why: 'tells the user to open the tool\'s own report under ~/.autoskill/' },
  { pattern: 'read-sensitive-path', file: 'k-dense-scientific-skills/skills/database-lookup/SKILL.md', why: 'negated: "do not read or display the whole .env"' },
  { pattern: 'read-sensitive-path', file: 'k-dense-scientific-skills/skills/exa-search/SKILL.md', why: 'loads the skill\'s own EXA_API_KEY from the project .env via dotenv' },
  { pattern: 'read-sensitive-path', file: 'k-dense-scientific-skills/skills/hypogenic/SKILL.md', why: 'negated: scripts "never ... load .env"' },
  { pattern: 'read-sensitive-path', file: 'k-dense-scientific-skills/skills/labarchive-integration/SKILL.md', why: 'negated: scripts "never load .env files"' },
  { pattern: 'read-sensitive-path', file: 'k-dense-scientific-skills/skills/latchbio-integration/SKILL.md', why: 'negated: "do not read, print, copy, or parse ~/.latch/token"' },
  { pattern: 'read-sensitive-path', file: 'k-dense-scientific-skills/skills/omero-integration/SKILL.md', why: 'negated: planners "never load .env files"' },
  { pattern: 'read-sensitive-path', file: 'k-dense-scientific-skills/skills/paperclip/SKILL.md', why: 'negated: "does not automatically load a project .env"' },
  { pattern: 'read-sensitive-path', file: 'k-dense-scientific-skills/skills/peer-review/SKILL.md', why: 'in a list of things the skill must NOT do' },
  { pattern: 'read-sensitive-path', file: 'k-dense-scientific-skills/skills/protocolsio-integration/SKILL.md', why: 'negated: scripts "never load .env files"' },
  { pattern: 'read-sensitive-path', file: 'wshobson-agents/plugins/block-no-verify/skills/block-no-verify-hook/SKILL.md', why: 'setup snippet writing ~/.claude/settings.json (cat > heredoc), not reading a secret' },
]

interface ManifestRow {
  dest: string
  repo: string
  commit: string
}

function readManifest(): ManifestRow[] {
  return readFileSync(join(CORPUS, 'MANIFEST.tsv'), 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const [dest, repo, commit] = l.split('\t')
      return { dest: dest!, repo: repo!, commit: commit! }
    })
}

function readSums(): Map<string, string> {
  const sums = new Map<string, string>()
  for (const line of readFileSync(join(CORPUS, 'SHA256SUMS'), 'utf8').split('\n')) {
    const m = /^([0-9a-f]{64}) {2}\.\/(.+)$/.exec(line)
    if (m) sums.set(m[2]!, m[1]!)
  }
  return sums
}

const manifest = readManifest()
const skills = manifest.filter((r) => r.dest.endsWith('/SKILL.md'))

interface Hit {
  pattern: string
  file: string
  excerpt: string
}

function scanCorpus(): Hit[] {
  const hits: Hit[] = []
  for (const { dest } of skills) {
    const result = scanSkillContent(readFileSync(join(CORPUS, dest), 'utf8'))
    for (const f of result.findings) hits.push({ pattern: f.patternId, file: dest, excerpt: f.excerpt ?? '' })
  }
  return hits
}

function renderBaseline(hits: Hit[]): string {
  const bySource = new Map<string, { repo: string; commit: string; n: number }>()
  for (const r of skills) {
    const source = r.dest.split('/')[0]!
    const entry = bySource.get(source) ?? { repo: r.repo, commit: r.commit, n: 0 }
    entry.n += 1
    bySource.set(source, entry)
  }
  const lines: string[] = [
    'skillScan.ts — benign-skill corpus baseline (TD-358)',
    '====================================================',
    '',
    'Produced by:',
    '    INTUTIC_WRITE_BASELINE=1 pnpm --filter @intutic/shared-types exec vitest run skillScanCorpus',
    '',
    'Every file below is a real, published, benign SKILL.md. Nothing was written or',
    'chosen for this scanner, so every hit is a false positive by construction. Each',
    'hit was read in context and confirmed benign before being recorded.',
    '',
    `Corpus: ${skills.length} SKILL.md files`,
  ]
  for (const [source, { repo, commit, n }] of [...bySource].sort()) {
    lines.push(`  ${source.padEnd(28)} ${String(n).padStart(4)}  github.com/${repo} @ ${commit}`)
  }
  lines.push('', '  pattern                          | files_hit | rate    | content tier', '  ---------------------------------|-----------|---------|-------------')
  for (const p of SKILL_SCAN_PATTERNS) {
    const n = new Set(hits.filter((h) => h.pattern === p.id).map((h) => h.file)).size
    const rate = `${((100 * n) / skills.length).toFixed(2)}%`
    const tier = SKILL_CONTENT_BLOCK_PATTERN_IDS.includes(p.id) ? 'block-eligible' : 'warn (report-only)'
    lines.push(`  ${p.id.padEnd(32)} | ${String(n).padStart(9)} | ${rate.padStart(7)} | ${tier}`)
  }
  lines.push(
    '',
    'WHAT ZERO MEANS HERE',
    '',
    `  Zero hits in ${skills.length} files bounds the per-skill false-positive rate at about`,
    `  ${((300 / skills.length)).toFixed(2)}% (rule of three, 95% upper bound) — not zero. The corpus is curated,`,
    '  published skill collections; locally written skills are a longer, messier tail.',
    '  No recall is claimed: there is no vendored corpus of real poisoned skills.',
    '',
    'Benign files that tripped a pattern, with the excerpt the scanner reports:',
  )
  for (const h of [...hits].sort((a, b) => (a.pattern + a.file).localeCompare(b.pattern + b.file))) {
    lines.push(`  ${h.pattern}  ${h.file}`, `      ${h.excerpt}`)
  }
  return lines.join('\n') + '\n'
}

describe('skillScan benign-skill corpus (TD-358)', () => {
  it(`is vendored, intact, and at least ${MIN_CORPUS_SKILLS} skills`, () => {
    expect(skills.length).toBeGreaterThanOrEqual(MIN_CORPUS_SKILLS)
    const sums = readSums()
    for (const { dest } of manifest) {
      const path = join(CORPUS, dest)
      expect(existsSync(path), `${dest} is missing — run corpus/skills/fetch.sh`).toBe(true)
      const actual = createHash('sha256').update(readFileSync(path)).digest('hex')
      expect(actual, `${dest} does not match SHA256SUMS`).toBe(sums.get(dest))
    }
    expect(sums.size).toBe(manifest.length)
  })

  const hits = scanCorpus()

  it('fires exactly on the reviewed false positives — no new ones, none vanished', () => {
    const actual = hits.map((h) => `${h.pattern}  ${h.file}`).sort()
    const reviewed = REVIEWED_FALSE_POSITIVES.map((r) => `${r.pattern}  ${r.file}`).sort()
    expect(actual).toEqual(reviewed)
  })

  it('licenses the content block tier only for patterns with zero corpus hits', () => {
    for (const id of SKILL_CONTENT_BLOCK_PATTERN_IDS) {
      const fired = hits.filter((h) => h.pattern === id).map((h) => h.file)
      expect(fired, `${id} is block-eligible but fires on benign skills`).toEqual([])
    }
  })

  it('matches the committed BASELINE.txt', () => {
    const rendered = renderBaseline(hits)
    const path = join(CORPUS, 'BASELINE.txt')
    if (process.env.INTUTIC_WRITE_BASELINE) writeFileSync(path, rendered)
    expect(
      rendered,
      'BASELINE.txt is stale. Re-run with INTUTIC_WRITE_BASELINE=1 and READ the diff before committing it.',
    ).toBe(readFileSync(path, 'utf8'))
  })
})
