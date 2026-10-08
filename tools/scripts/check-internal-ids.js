#!/usr/bin/env node
/**
 * Published docs carry no internal tracker ids or links into the internal
 * docs/ tree.
 *
 * On 2026-10-08 docs.intutic.ai carried 64 tech-debt ids, a design-doc
 * reference and links to docs/TECH_DEBT.md — a file the public repo does not
 * have, so every one of those links was a 404 and every id
 * pointed a reader at a record they cannot open. This fails on any of them
 * coming back in the docs site (apps/docs) or the root README:
 *
 * - a tech-debt id (TD-<n>) or a design-doc reference (LLD #<n>, LLD-<n>);
 * - any mention of TECH_DEBT.md;
 * - a link into the repo's top-level docs/ directory, either relative
 *   (resolved against the page) or as a GitHub URL.
 *
 * State the limitation itself instead of pointing at the record of it.
 *
 * Usage: node tools/scripts/check-internal-ids.js [repo-root]
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..'))
const INTERNAL_DOCS = join(ROOT, 'docs') + sep

const SOURCES = [
  { dir: 'apps/docs', ext: ['.md'], skip: ['node_modules', 'public', 'dist', 'cache'] },
  { file: 'apps/docs/Dockerfile' },
  { file: 'README.md' },
]

const PATTERNS = [
  [/\bTD-\d+\b/, 'an internal tech-debt id'],
  [/\bLLD(?:\s*#\s*|-)\d+/, 'an internal design-doc reference'],
  [/TECH_DEBT\.md/, 'the internal tech-debt tracker'],
  [/github\.com\/intutic\/[\w.-]+\/(?:blob|tree)\/[^/\s)]+\/docs\//, 'a link into the internal docs/ tree'],
]

function files(source) {
  if (source.file) return existsSync(join(ROOT, source.file)) ? [join(ROOT, source.file)] : []
  const base = join(ROOT, source.dir)
  if (!existsSync(base)) return []
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith('.') || source.skip.includes(entry)) continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (source.ext.some((e) => entry.endsWith(e))) out.push(full)
    }
  }
  walk(base)
  return out
}

/** Relative markdown link targets on a line that resolve into <root>/docs/. */
function internalDocsLinks(file, line) {
  const hits = []
  for (const m of line.matchAll(/\]\(([^)\s#]+)[^)]*\)/g)) {
    const target = m[1]
    if (/^[a-z][\w+.-]*:/i.test(target) || target.startsWith('/')) continue
    if ((resolve(dirname(file), target) + sep).startsWith(INTERNAL_DOCS)) hits.push(target)
  }
  return hits
}

const failures = []
let scanned = 0
for (const source of SOURCES) {
  for (const file of files(source)) {
    scanned++
    const rel = relative(ROOT, file)
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      for (const [pattern, why] of PATTERNS) {
        const m = line.match(pattern)
        if (m) failures.push(`${rel}:${i + 1}  "${m[0]}" — ${why}`)
      }
      for (const target of internalDocsLinks(file, line)) {
        failures.push(`${rel}:${i + 1}  "${target}" — a link into the internal docs/ tree`)
      }
    })
  }
}

if (failures.length) {
  console.error(`[FAIL] ${failures.length} internal reference(s) in published docs:\n`)
  for (const f of failures) console.error(`  ${f}`)
  console.error('\nReaders cannot open these. State the limitation or status itself instead.')
  process.exit(1)
}
console.log(`[PASS] ${scanned} published file(s): no internal ids or internal docs/ links.`)
