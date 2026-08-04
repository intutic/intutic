#!/usr/bin/env node
/**
 * check-sop-keys.js
 *
 * Every SOP front-matter key the proxy can act on must be documented on a page
 * a public reader can actually open, and must appear in `ENFORCING_FIELDS` so
 * the "nothing here is enforceable" warning names it.
 *
 * Both halves have already failed. `is_enforceable` listed five of nine keys,
 * so a policy declaring only ordering rules loaded, resolved, blocked what it
 * said it would, and was told at boot that every SOP-derived control was inert.
 * And the four ordering keys shipped enforcing with zero user-facing
 * documentation anywhere — the only page covering SOPs is Cloud-badged and is
 * therefore excluded from the public docs build entirely.
 *
 * A feature that kills and cannot be discovered is indistinguishable from one
 * that was never built.
 *
 * Usage: node tools/scripts/check-sop-keys.js
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const sopsRs = join(repoRoot, 'packages', 'proxy', 'src', 'sops.rs')
const refPage = join(repoRoot, 'apps', 'docs', 'reference', 'sop-front-matter.md')

if (!existsSync(sopsRs)) {
  console.log('packages/proxy/src/sops.rs not present — skipping.')
  process.exit(0)
}

const src = readFileSync(sopsRs, 'utf8')

// The keys the parser actually recognises, taken from the parse call sites
// rather than from a list someone maintains by hand.
const keys = new Set()
for (const m of src.matchAll(/parse_items\(\s*front,\s*"([a-z_]+):"/g)) keys.add(m[1])
for (const m of src.matchAll(/parse_rules\(\s*front,\s*"([a-z_]+):"/g)) keys.add(m[1])
for (const m of src.matchAll(/strip_prefix\("([a-z_]+):"\)/g)) keys.add(m[1])
// The five list-valued keys go through a local `list("key:", lower)` closure
// rather than a named parser. The first version of this script matched only the
// three forms above, found 5 of 10 keys, and passed — one over its own
// floor. A check that inspects part of the input and reports success is the
// defect it exists to catch, so the floor is now the real count.
for (const m of src.matchAll(/\blist\("([a-z_]+):"/g)) keys.add(m[1])

// `roles:` is scoping, not enforcement — it selects which roles a SOP applies
// to and blocks nothing on its own.
keys.delete('roles')

const MIN_KEYS = 9
if (keys.size < MIN_KEYS) {
  console.error(
    `✖ found only ${keys.size} front-matter key(s) in sops.rs, expected at least ` +
      `${MIN_KEYS} — the extraction is broken, and a check that inspects part of ` +
      'its input and passes is worse than no check.',
  )
  console.error(`  found: ${[...keys].sort().join(', ')}`)
  process.exit(1)
}

// ENFORCING_FIELDS: the list the startup warning reads from.
const enforcing = src.match(/const ENFORCING_FIELDS: &str = "([\s\S]*?)";/)
if (!enforcing) {
  console.error('✖ could not find ENFORCING_FIELDS in sops.rs')
  process.exit(1)
}
const enforcingText = enforcing[1].replace(/\\\s*\n\s*/g, ' ')

if (!existsSync(refPage)) {
  console.error(`✖ ${refPage} does not exist — the enforceable keys have no public reference.`)
  process.exit(1)
}
const doc = readFileSync(refPage, 'utf8')

// `risk_tier` is parsed but no proxy detector reads it, so it is deliberately
// absent from ENFORCING_FIELDS. It must still be documented, precisely because
// its absence from the enforceable set is the surprising part.
const NOT_ENFORCING = new Set(['risk_tier'])

const undocumented = [...keys].filter((k) => !doc.includes(k))
const missingFromEnforcing = [...keys].filter(
  (k) => !NOT_ENFORCING.has(k) && !enforcingText.includes(k),
)

let failed = false
if (undocumented.length > 0) {
  console.error(`✖ front-matter keys the parser accepts but the reference page never mentions:`)
  for (const k of undocumented) console.error(`    ${k}:`)
  console.error(`  Document them in apps/docs/reference/sop-front-matter.md.`)
  failed = true
}
if (missingFromEnforcing.length > 0) {
  console.error(`✖ enforceable keys missing from ENFORCING_FIELDS in sops.rs:`)
  for (const k of missingFromEnforcing) console.error(`    ${k}`)
  console.error(
    `  The startup warning names that list, so a key missing from it is reported\n` +
      `  as inert while it is blocking — or, worse, its absence hides a typo.`,
  )
  failed = true
}

if (failed) process.exit(1)
console.log(`✓ all ${keys.size} SOP front-matter key(s) documented and accounted for.`)
