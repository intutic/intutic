#!/usr/bin/env node
/**
 * The rule DSL may not name a field the guest cannot read.
 *
 * `FIELDS` in `rulePredicateDsl.ts` is the closed vocabulary a generated rule's
 * predicate is written in. It is a hand-maintained mirror of what
 * `packages/wasm-sdk/assembly/index.ts` actually parses — and a mirror that
 * drifts is worse than no mirror here, because a predicate naming a field the
 * guest does not parse renders to a comparison against a zero-valued default.
 * That compiles, installs, passes its own mocks if they happen not to touch the
 * field, and then never fires. The inert control, generated automatically.
 *
 * The reverse direction is not checked: the DSL deliberately omits the
 * structured lists (`tools`, `tool_calls`, `changes`, the four SOP rule arrays)
 * because comparing them needs operators this vocabulary does not have.
 *
 * Sibling of `check-wasm-context-docs.js` and `check-sop-keys.js`.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const GUEST = join(ROOT, 'packages/wasm-sdk/assembly/index.ts')
const DSL = join(ROOT, 'packages/shared-types/src/rulePredicateDsl.ts')

function fail(msg) {
  console.error(`[FAIL] ${msg}`)
  process.exit(1)
}

for (const f of [GUEST, DSL]) {
  if (!existsSync(f)) fail(`${f} is missing — this gate asserted nothing.`)
}

const guestSrc = readFileSync(GUEST, 'utf8')

// The guest class declares the fields; the parser assigns them. A field that is
// declared and never parsed is exactly the bug this guards against, so read the
// PARSER, not the declaration.
// Both assignment styles the parser uses. Matching only `ctx.x =` reported
// `tool_sequence` as unparsed on this gate's first run — it is filled with
// `ctx.tool_sequence.push(...)`, and every list field is filled the same way.
const parsed = new Set([
  ...[...guestSrc.matchAll(/\bctx\.(\w+)\s*=[^=]/g)].map((m) => m[1]),
  ...[...guestSrc.matchAll(/\bctx\.(\w+)\.push\(/g)].map((m) => m[1]),
])

const MIN_PARSED = 25
if (parsed.size < MIN_PARSED) {
  fail(
    `found only ${parsed.size} parsed fields in the guest, expected at least ` +
      `${MIN_PARSED}. The extraction is broken, and a gate inspecting part of the ` +
      'parser is worse than none.',
  )
}

const dslSrc = readFileSync(DSL, 'utf8')
const table = dslSrc.match(/export const FIELDS[^=]*=\s*\{([\s\S]*?)\n\}/)
if (!table) {
  fail(
    `could not find "export const FIELDS" in ${DSL}.\n` +
      'That table is the closed vocabulary. If it was renamed, update this gate\n' +
      'deliberately — do not delete the assertion.',
  )
}

const declared = [...table[1].matchAll(/^\s*(\w+):\s*'(\w+)'/gm)].map((m) => ({
  field: m[1],
  kind: m[2],
}))

if (declared.length === 0) fail('FIELDS is empty — the DSL can express nothing.')

const unreadable = declared.filter((d) => !parsed.has(d.field))
if (unreadable.length > 0) {
  console.error(
    `[FAIL] the rule DSL names ${unreadable.length} field(s) the guest never parses:`,
  )
  for (const d of unreadable) console.error(`    ${d.field}`)
  console.error(
    '\nA predicate on one of these renders to a comparison against a default. The\n' +
      'rule compiles, installs, and never fires. Either add the field to\n' +
      'parseRequestContext in packages/wasm-sdk/assembly/index.ts, or remove it\n' +
      'from FIELDS.',
  )
  process.exit(1)
}

// An `optional` kind is what forces the `!= -1` unknown guard into the rendered
// source. Mislabelling one as a plain numeric silently removes that guard.
const OPTIONAL_IN_GUEST = ['graph_spend_usd', 'graph_budget_usd', 'workflow_spend_usd', 'workflow_budget_usd', 'parent_alive']
for (const name of OPTIONAL_IN_GUEST) {
  const d = declared.find((x) => x.field === name)
  if (!d) continue
  if (!d.kind.startsWith('optional')) {
    fail(
      `${name} is declared as '${d.kind}' but the host sends -1 for unknown.\n` +
        'Only the optional kinds emit the unknown guard, so this renders a rule that\n' +
        'reads "no data" as "under the limit" — or as "over it", depending on the\n' +
        'operator. Both block real work.',
    )
  }
}

console.log(
  `[PASS] all ${declared.length} rule-DSL fields are parsed by the guest.`,
)
