#!/usr/bin/env node
/**
 * The Kitkat skill ships as several byte-identical copies: the one agents in
 * this repo load (`.agents/skills/intutic-governance-kitkat/SKILL.md`), the
 * docs download (`apps/docs/public/downloads/SKILL.md`) and, where the
 * dashboard exists, the dashboard download. They drifted apart before — one
 * listed commands the CLI never had — so every copy present must match the
 * first.
 *
 * Copies that agree can still all be out of date, so the canonical copy must
 * also name every refusal code in
 * `packages/shared-types/fixtures/refusal-codes.json`: a code an agent can
 * receive that the skill does not explain is one it will guess about.
 *
 * Exit 1 on any difference, on a missing code, or if the canonical copy is
 * missing.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CANONICAL = '.agents/skills/intutic-governance-kitkat/SKILL.md'
const COPIES = ['apps/docs/public/downloads/SKILL.md', 'apps/dashboard/public/downloads/SKILL.md']

if (!existsSync(join(ROOT, CANONICAL))) {
  console.error(`[FAIL] ${CANONICAL} is missing.`)
  process.exit(1)
}
const canonical = readFileSync(join(ROOT, CANONICAL), 'utf8')

let checked = 0
let failed = 0
for (const copy of COPIES) {
  const full = join(ROOT, copy)
  if (!existsSync(full)) continue
  checked += 1
  if (readFileSync(full, 'utf8') !== canonical) {
    console.error(`[FAIL] ${copy} differs from ${CANONICAL}. Copy the canonical file over it.`)
    failed += 1
  }
}

const REFUSAL_CODES = 'packages/shared-types/fixtures/refusal-codes.json'
const surfaces = JSON.parse(readFileSync(join(ROOT, REFUSAL_CODES), 'utf8'))
const codes = new Set(
  ['proxy', 'gate', 'hook', 'mcp'].flatMap((surface) => surfaces[surface].refusals.map((r) => r.code)),
)
const unexplained = [...codes].filter((code) => !canonical.includes(`\`${code}\``))
if (codes.size < 20) {
  console.error(`[FAIL] ${REFUSAL_CODES} lists ${codes.size} refusal codes — this check asserted nothing.`)
  failed += 1
}
if (unexplained.length > 0) {
  console.error(`[FAIL] ${CANONICAL} does not explain these refusal codes from ${REFUSAL_CODES}: ${unexplained.join(', ')}`)
  failed += 1
}

if (checked === 0) {
  console.error('[FAIL] no copy of the Kitkat skill was found to compare — this check asserted nothing.')
  process.exit(1)
}
if (failed > 0) process.exit(1)
console.log(`[PASS] Kitkat skill: ${checked} cop${checked === 1 ? 'y matches' : 'ies match'} ${CANONICAL}, which explains all ${codes.size} refusal codes.`)
