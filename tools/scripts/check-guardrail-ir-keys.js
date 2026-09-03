#!/usr/bin/env node
/**
 * The Guardrail IR may not name a front-matter key the proxy cannot read.
 *
 * `IR_KINDS` in `packages/shared-types/src/guardrailIr.ts` is the closed set
 * of clauses a policy compiler may emit (LLD #71). Six of them render to SOP
 * front-matter lines that `packages/proxy/src/sops.rs` parses. A kind the
 * parser does not read would render to a line the proxy ignores — a rule that
 * loads, is listed, and never fires. The inert control, generated
 * automatically.
 *
 * The keys are extracted from the parser's call sites with the same regexes
 * `check-sop-keys.js` uses, never from a list maintained by hand. The reverse
 * direction is not checked: the IR deliberately omits the three allowlist keys
 * (`allow_harnesses`, `plan_steps`, `scope_paths`), and says so.
 *
 * Sibling of `check-rule-dsl-fields.js` and `check-sop-keys.js`.
 */
const { readFileSync, existsSync } = require('node:fs')
const { join } = require('node:path')

const ROOT = join(__dirname, '..', '..')
const IR = join(ROOT, 'packages/shared-types/src/guardrailIr.ts')
const RENDER = join(ROOT, 'packages/shared-types/src/guardrailRender.ts')
const SOPS_RS = join(ROOT, 'packages/proxy/src/sops.rs')

function fail(msg) {
  console.error(`[FAIL] ${msg}`)
  process.exit(1)
}

for (const f of [IR, RENDER, SOPS_RS]) {
  if (!existsSync(f)) fail(`${f} is missing — this gate asserted nothing.`)
}

const irSrc = readFileSync(IR, 'utf8')
const kindsBlock = irSrc.match(/export const IR_KINDS = \[([\s\S]*?)\] as const/)
if (!kindsBlock) fail('could not find `export const IR_KINDS = [...] as const` in guardrailIr.ts')
const kinds = [...kindsBlock[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
if (kinds.length < 9) fail(`found only ${kinds.length} IR kind(s); expected at least 9 — the extraction is broken.`)

const fmBlock = irSrc.match(/export const FRONT_MATTER_KINDS = \[([\s\S]*?)\] as const/)
if (!fmBlock) fail('could not find `export const FRONT_MATTER_KINDS = [...] as const` in guardrailIr.ts')
const frontMatterKinds = [...fmBlock[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
if (frontMatterKinds.length < 6) fail(`found only ${frontMatterKinds.length} front-matter kind(s); expected at least 6.`)

for (const k of frontMatterKinds) {
  if (!kinds.includes(k)) fail(`FRONT_MATTER_KINDS names "${k}", which is not in IR_KINDS.`)
}

// The parser's keys, from its call sites (same extraction as check-sop-keys.js).
const rs = readFileSync(SOPS_RS, 'utf8')
const proxyKeys = new Set()
for (const m of rs.matchAll(/parse_items\(\s*front,\s*"([a-z_]+):"/g)) proxyKeys.add(m[1])
for (const m of rs.matchAll(/parse_rules\(\s*front,\s*"([a-z_]+):"/g)) proxyKeys.add(m[1])
for (const m of rs.matchAll(/strip_prefix\("([a-z_]+):"\)/g)) proxyKeys.add(m[1])
for (const m of rs.matchAll(/\blist\("([a-z_]+):"/g)) proxyKeys.add(m[1])
if (proxyKeys.size < 9) fail(`found only ${proxyKeys.size} front-matter key(s) in sops.rs; expected at least 9 — the extraction is broken.`)

const unreadable = frontMatterKinds.filter((k) => !proxyKeys.has(k))
if (unreadable.length > 0) {
  fail(
    `the Guardrail IR renders ${unreadable.length} kind(s) to a front-matter key sops.rs never parses: ${unreadable.join(', ')}.\n` +
      'A rule of that kind would load, be listed, and never fire. Either the proxy parses it, or the IR does not offer it.',
  )
}

// The renderer must emit every front-matter kind as its key line.
const renderSrc = readFileSync(RENDER, 'utf8')
const unrendered = frontMatterKinds.filter((k) => !renderSrc.includes(`\`${k}: `))
if (unrendered.length > 0) {
  fail(`guardrailRender.ts never emits a \`${unrendered[0]}: \` line, so that IR kind renders to nothing.`)
}

// The non-front-matter kinds are exactly the three the design names.
const other = kinds.filter((k) => !frontMatterKinds.includes(k)).sort()
const expectedOther = ['hook_rule', 'none', 'wasm_predicate']
if (JSON.stringify(other) !== JSON.stringify(expectedOther)) {
  fail(`IR kinds outside front matter are ${JSON.stringify(other)}; this gate knows only ${JSON.stringify(expectedOther)}. A new kind needs its own enforcer and its own line here.`)
}

console.log(
  `[PASS] all ${frontMatterKinds.length} front-matter IR kinds are parsed by sops.rs and rendered; ${other.length} non-front-matter kind(s) accounted for.`,
)
