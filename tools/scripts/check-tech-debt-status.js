#!/usr/bin/env node
/**
 * Every tech-debt entry must declare its state in one readable place.
 *
 * `check-tech-debt-claims.js` verifies that a RESOLVED entry cites code that
 * still exists. This checks the prior question: can a reader tell whether the
 * entry is resolved at all?
 *
 * On 2026-08-10 the registry answered that three different ways. Some entries
 * had `**Status:** ✅ Resolved …`; some had a `- **✅ RESOLVED:**` bullet and no
 * Status line; some had neither. Counting the open set therefore gave a
 * different answer depending on which pattern you grepped for — 33 by one
 * measure, 11 by another — and the honest number was knowable only by reading
 * 181 entries by hand.
 *
 * Worse, **nine entries carried a `✅ RESOLVED` claim that a later annotation
 * in the same entry contradicted** ("⚠️ Superseded …", "this gap is not
 * closed", "the resolution cited a flag that does not exist"). To anyone
 * skimming for the marker they read as done. That is the registry reproducing
 * the exact defect it exists to track: a control that looks like it says
 * something and does not.
 *
 * So: one `**Status:**` line per entry, first bullet, carrying one of the
 * known markers. A registry you cannot count is a registry that misleads, and
 * an inventory of technical debt is worth precisely what its accuracy is.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DOC = join(ROOT, 'docs', 'TECH_DEBT.md')

if (!existsSync(DOC)) {
  console.log('[skip] no docs/TECH_DEBT.md in this tree')
  process.exit(0)
}

/** Markers an entry may declare. Anything else is a typo, not a state. */
const MARKERS = ['✅', '⚠️', '🟡', '🟢', '🔵', '⏸️', '🔴', '🟠']

const src = readFileSync(DOC, 'utf8')
// `TD-\d+` is not the only id shape: TD-SEC-001, TD-GG-01, TD-COST-001,
// TD-DLP-001, TD-CRM-02 and friends are twenty-one further entries. A numeric
// -only pattern split on them and then matched none, so they were skipped
// while the summary still printed a total — a gate reporting complete coverage
// of the subset it happened to recognise.
const TD_ID = /^### (TD-[A-Z0-9-]+?) [—-]/
const blocks = src.split(/\n(?=### TD-)/)

const missing = []
const unknown = []
const duplicated = []
const counts = Object.create(null)

for (const b of blocks) {
  const head = TD_ID.exec(b)
  if (!head) continue
  const id = head[1]
  // Anchored to a bullet at line start. An unanchored match counts prose that
  // MENTIONS `**Status:**` — including an entry explaining why it used to have
  // two — and the gate then reports a duplicate that does not exist. A checker
  // that fires on discussion of the thing it checks is noise, and noise is how
  // a gate gets switched off.
  const all = [...b.matchAll(/^- \*\*Status:\*\*\s*(\S+)/gm)]
  if (all.length === 0) {
    missing.push(id)
    continue
  }
  if (all.length > 1) duplicated.push(`${id} (${all.length} Status lines)`)
  const marker = all[0][1]
  if (!MARKERS.some((m) => marker.startsWith(m))) {
    unknown.push(`${id} → ${marker}`)
    continue
  }
  const key = MARKERS.find((m) => marker.startsWith(m))
  counts[key] = (counts[key] ?? 0) + 1
}

const problems = []
if (missing.length) {
  problems.push(
    `${missing.length} entr(ies) declare no state: ${missing.join(', ')}\n` +
      `    Add a first bullet: \`- **Status:** ✅ Resolved <date> — …\` or \`🔵 Open\`.`,
  )
}
if (unknown.length) {
  problems.push(
    `${unknown.length} entr(ies) use an unrecognised marker: ${unknown.join(', ')}\n` +
      `    Known: ${MARKERS.join(' ')}`,
  )
}
if (duplicated.length) {
  problems.push(
    `${duplicated.length} entr(ies) declare state twice: ${duplicated.join(', ')}\n` +
      `    Two Status lines is two answers; the reader cannot tell which is current.`,
  )
}

if (problems.length) {
  console.error('✖ tech-debt status:\n')
  for (const p of problems) console.error(`    ${p}\n`)
  console.error(
    'An entry whose state cannot be read is worse than no entry: it is counted\n' +
      'in the backlog by whoever greps for one pattern and skipped by whoever\n' +
      'greps for another. Nine entries here once carried a ✅ RESOLVED claim that\n' +
      'a later line in the same entry contradicted.',
  )
  process.exit(1)
}

const total = Object.values(counts).reduce((a, b) => a + b, 0)
const resolved = counts['✅'] ?? 0
const summary = Object.entries(counts)
  .map(([m, n]) => `${m}${n}`)
  .join('  ')
console.log(
  `[PASS] ${total} tech-debt entr(ies), each declaring one state: ${summary} ` +
    `(${total - resolved} not resolved)`,
)
