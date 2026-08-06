#!/usr/bin/env node
/**
 * Every field the host sends a WASM rule must be documented.
 *
 * `apps/docs/guide/wasm-rules.md` carried a ten-field excerpt of a
 * twenty-nine-field struct and pointed at the SDK source for "the rest". That is
 * how a rule author ends up not knowing that `forbid_after`, `changes`,
 * `new_tool_calls` and `injection_findings` are already in their hand — and it
 * is the documentation half of the same defect the SDK parser had, where the
 * guest could not see thirteen of the fields the host was sending.
 *
 * The field list is derived from the serde struct in
 * `packages/proxy/src/wasm/context.rs`, so adding a field to the host moves the
 * requirement automatically. A hardcoded list here would go stale in exactly the
 * way the page did.
 *
 * Sibling of `check-sop-keys.js`, which does the same for SOP front-matter keys.
 *
 * Exit 1 on any undocumented field, and on any input it cannot read — a gate
 * that cannot find its sources must not report success.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CONTEXT_RS = join(ROOT, 'packages/proxy/src/wasm/context.rs')
const PAGE = join(ROOT, 'apps/docs/guide/wasm-rules.md')

function fail(msg) {
  console.error(`[FAIL] ${msg}`)
  process.exit(1)
}

for (const f of [CONTEXT_RS, PAGE]) {
  if (!existsSync(f)) fail(`${f} is missing — this gate asserted nothing.`)
}

const rs = readFileSync(CONTEXT_RS, 'utf8')

const struct = rs.match(/pub struct RequestContext\s*\{([\s\S]*?)\n\}/)
if (!struct) {
  fail(
    `could not find "pub struct RequestContext" in ${CONTEXT_RS}.\n` +
      'That struct is the contract between host and guest. If it was renamed, update\n' +
      'this gate deliberately — do not delete the assertion.',
  )
}

const fields = [...struct[1].matchAll(/^\s*pub\s+(\w+)\s*:/gm)].map((m) => m[1])

// A struct this small silently shrinking to nothing is the failure mode a
// regex-based extractor has. Refuse to pass on a suspiciously short list.
const MIN_FIELDS = 20
if (fields.length < MIN_FIELDS) {
  fail(
    `extracted only ${fields.length} fields from RequestContext, expected at least ` +
      `${MIN_FIELDS}.\nThe extraction is broken, and a gate inspecting part of the ` +
      'struct is worse than none.',
  )
}

const doc = readFileSync(PAGE, 'utf8')

// Documented means it has its own TABLE ROW — a line whose first cell is the
// field name in backticks. Accepting a match anywhere in the page passed while
// `injection_findings` was deleted from the table, because the name also appears
// in a prose warning two sections down. A field mentioned in a sentence about
// something else is not documented; a reader scanning for it will not find it.
const documented = new Set(
  [...doc.matchAll(/^\|\s*`(\w+)`\s*\|/gm)].map((m) => m[1]),
)

const missing = fields.filter((f) => !documented.has(f))

if (missing.length > 0) {
  console.error(
    `[FAIL] ${missing.length} field(s) the host sends are undocumented in ` +
      'apps/docs/guide/wasm-rules.md:',
  )
  for (const f of missing) console.error(`    ${f}`)
  console.error(
    '\nA rule author cannot use a field they cannot find. Add each to the context\n' +
      'tables on that page, with what it is and how to read an absent value.',
  )
  process.exit(1)
}

console.log(
  `[PASS] all ${fields.length} RequestContext fields are documented in wasm-rules.md.`,
)
