#!/usr/bin/env node
/**
 * The rule-author skill ships as three byte-identical copies: the one agents
 * in this repo load (`.agents/skills/intutic-rule-author/SKILL.md`), the docs
 * download (`apps/docs/public/downloads/RULE_AUTHOR_SKILL.md`) and the copy
 * `intutic connect` writes into every workspace, embedded as the
 * `RULE_AUTHOR_SKILL` template literal in
 * `services/sync-daemon/src/skillWriter.ts` (the daemon runs outside the
 * repo). The daemon's own test holds the embedded copy to the canonical one;
 * nothing held the download to either, so a fix to one could ship while the
 * page kept handing out the old text.
 *
 * Exit 1 when any copy is missing or differs from the canonical file, naming
 * the first line that differs.
 *
 * Usage: node tools/scripts/check-rule-author-skill-copies.js [repo-root]
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..'))
const CANONICAL = '.agents/skills/intutic-rule-author/SKILL.md'
const DOWNLOAD = 'apps/docs/public/downloads/RULE_AUTHOR_SKILL.md'
const EMBEDDED = 'services/sync-daemon/src/skillWriter.ts'
const CONSTANT = 'RULE_AUTHOR_SKILL'

const failures = []
const read = (rel) => {
  const full = join(ROOT, rel)
  if (!existsSync(full)) {
    failures.push(`${rel} is missing.`)
    return null
  }
  return readFileSync(full, 'utf8')
}

/** The template literal's value: the text between the backticks, unescaped. */
function embeddedSkill(source) {
  const start = source.indexOf(`export const ${CONSTANT} = \``)
  if (start === -1) return { error: `has no \`export const ${CONSTANT} = \`...\`\` template literal` }
  const bodyStart = start + `export const ${CONSTANT} = \``.length
  // The literal ends at the first backtick no backslash escapes.
  let i = bodyStart
  while (i < source.length && source[i] !== '`') i += source[i] === '\\' ? 2 : 1
  if (i >= source.length) return { error: `never closes the ${CONSTANT} template literal` }
  const raw = source.slice(bodyStart, i)
  // An interpolation would make the written file differ from the source text.
  if (/(^|[^\\])\$\{/.test(raw)) return { error: `interpolates into ${CONSTANT}; the skill must be literal text` }
  return { text: raw.replace(/\\([\\`$])/g, '$1') }
}

/** "line N, column C" of the first difference, with the text around it in both. */
function firstDifference(expected, actual) {
  const a = expected.split('\n')
  const b = actual.split('\n')
  for (let n = 0; n < Math.max(a.length, b.length); n += 1) {
    if (a[n] === b[n]) continue
    if (a[n] === undefined || b[n] === undefined) {
      return `line ${n + 1}: ${a[n] === undefined ? 'the copy has lines the canonical file does not' : 'the copy ends early'}`
    }
    let col = 0
    while (a[n][col] === b[n][col]) col += 1
    const around = (line) => JSON.stringify(line.slice(Math.max(0, col - 30), col + 50))
    return `line ${n + 1}, column ${col + 1}: canonical ${around(a[n])}, copy ${around(b[n])}`
  }
  return 'a difference in line endings'
}

const canonical = read(CANONICAL)
const download = read(DOWNLOAD)
const source = read(EMBEDDED)

if (canonical !== null) {
  if (download !== null && download !== canonical) {
    failures.push(`${DOWNLOAD} differs from ${CANONICAL} at ${firstDifference(canonical, download)}. Copy the canonical file over it.`)
  }
  if (source !== null) {
    const embedded = embeddedSkill(source)
    if (embedded.error) failures.push(`${EMBEDDED} ${embedded.error}.`)
    else if (embedded.text !== canonical) {
      failures.push(
        `${EMBEDDED}'s ${CONSTANT} differs from ${CANONICAL} at ${firstDifference(canonical, embedded.text)}. ` +
          'Paste the canonical file into the template literal, escaping backticks.',
      )
    }
  }
}

if (failures.length > 0) {
  for (const f of failures) console.error(`[FAIL] ${f}`)
  process.exit(1)
}
console.log(`[PASS] rule-author skill: ${DOWNLOAD} and ${EMBEDDED}'s ${CONSTANT} match ${CANONICAL}.`)
