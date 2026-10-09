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
 * It also checks the two places a copied rule breaks silently: every `evaluate`
 * signature the WASM pages show must match how `runner.rs` calls it, and every
 * `"risk_tier"` value in an example must be a `RiskLevel` variant.
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

// A field marked `#[serde(skip)]` is never serialised, so a rule never sees it
// (`turn_tool_calls`, which only the Rego host reads). Its attributes sit
// between the previous field and its own declaration.
const fields = []
let previousEnd = 0
for (const m of struct[1].matchAll(/^\s*pub\s+(\w+)\s*:/gm)) {
  if (!/#\[serde\(skip\)\]/.test(struct[1].slice(previousEnd, m.index))) fields.push(m[1])
  previousEnd = m.index + m[0].length
}

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

// ── The ABI and enum values the pages show ─────────────────────────────────
//
// The architecture page showed `evaluate(requestContextJson: ArrayBuffer)` while
// the host called `evaluate(offset, len)`, and its context example carried
// `"risk_tier": "HIGH"` while the host serialises `High` — a rule copied from
// it compared against a value that never arrives. Both are read from the Rust
// source here, so the pages cannot drift from it again.

const RUNNER_RS = join(ROOT, 'packages/proxy/src/wasm/runner.rs')
const ARCH_PAGE = join(ROOT, 'apps/docs/external/wasm-rules.md')
const SKILL = join(ROOT, 'apps/docs/public/downloads/RULE_AUTHOR_SKILL.md')
for (const f of [RUNNER_RS, ARCH_PAGE, SKILL]) {
  if (!existsSync(f)) fail(`${f} is missing — this gate asserted nothing.`)
}

const sig = readFileSync(RUNNER_RS, 'utf8').match(
  /get_typed_func::<\(([^)]*)\),\s*(\w+)>\([^)]*"evaluate"\)/,
)
if (!sig) {
  fail(
    `could not find how ${RUNNER_RS} calls "evaluate". If the call moved, update this\n` +
      'gate deliberately — do not delete the assertion.',
  )
}
const hostParams = sig[1].split(',').map((t) => t.trim())
const hostResult = sig[2]

const variants = rs.match(/pub enum RiskLevel\s*\{([\s\S]*?)\}/)
if (!variants) fail(`could not find "pub enum RiskLevel" in ${CONTEXT_RS}.`)
const riskLevels = [...variants[1].matchAll(/^\s*(\w+)\s*,/gm)].map((m) => m[1])
if (riskLevels.length < 2) fail(`extracted only ${riskLevels.length} RiskLevel variants.`)

let abiDrift = false
for (const page of [PAGE, ARCH_PAGE]) {
  const text = readFileSync(page, 'utf8')
  const shown = [...text.matchAll(/export function evaluate\(([^)]*)\)\s*:\s*(\w+)/g)]
  // The architecture page is where the ABI is specified, so it must show it;
  // the guide shows it only inside examples, which are checked when present.
  if (shown.length === 0 && page === ARCH_PAGE) {
    console.error(`[FAIL] ${page} never shows the evaluate signature.`)
    abiDrift = true
  }
  for (const [whole, params, result] of shown) {
    const types = params.split(',').map((p) => p.split(':')[1]?.trim())
    if (types.join(',') !== hostParams.join(',') || result !== hostResult) {
      console.error(
        `[FAIL] ${page} shows \`${whole}\`; the host calls ` +
          `evaluate(${hostParams.join(', ')}) -> ${hostResult}.`,
      )
      abiDrift = true
    }
  }
}
for (const page of [PAGE, ARCH_PAGE, SKILL]) {
  const text = readFileSync(page, 'utf8')
  for (const [, value] of text.matchAll(/"risk_tier"\s*:\s*"([^"]*)"/g)) {
    if (!riskLevels.includes(value)) {
      console.error(
        `[FAIL] ${page} shows "risk_tier": "${value}"; the host sends one of ` +
          `${riskLevels.join(', ')}.`,
      )
      abiDrift = true
    }
  }
}
if (abiDrift) process.exit(1)

console.log(
  `[PASS] all ${fields.length} RequestContext fields are documented in wasm-rules.md; ` +
    'evaluate signatures and risk_tier values match the host.',
)
