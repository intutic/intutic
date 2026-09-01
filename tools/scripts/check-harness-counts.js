#!/usr/bin/env node
/**
 * Every published harness-count claim must match the real enum.
 *
 * `services/sync-daemon/__tests__/harness/generatedGateBehaviour.test.ts`
 * already asserts `GATES ∪ NO_GATE` covers every `HarnessType` member, so the
 * code side has never drifted — there is no registry to build here. What
 * drifted was prose: six sites once claimed 39, 40 or 41 by hand, and the
 * harness-security-matrix's 42 data rows against a 41-member enum looked
 * like an off-by-one until you read row 29's own Notes cell (Anthropic
 * Managed Agents — a deliberate, documented, no-`HarnessType` exception, not
 * a bug).
 *
 * `packages/shared-types/src/enums.ts` exports two numbers precisely so no
 * doc ever has to state one by hand again:
 *   - `HARNESS_COUNT` — the real total (`Object.keys(HarnessType).length`).
 *   - `HARNESS_HEADLINE_COUNT` — `HARNESS_COUNT` minus harnesses with a
 *     confirmed, currently-open TECH_DEBT support gap, safe for
 *     marketing/headline copy.
 *
 * This gate reads `enums.ts` as text (not compiled output — every sibling
 * `check-*.js` in this chain does the same, so the gate needs no build step
 * to run) and independently recomputes both numbers, then checks every
 * targeted doc claim and the matrix's row count against them.
 *
 * Exit 1 on any mismatch or on any file it cannot read.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ENUMS_TS = join(ROOT, 'packages/shared-types/src/enums.ts')
const MATRIX = join(ROOT, 'apps/docs/reference/harness-security-matrix.md')

function fail(msg) {
  console.error(`[FAIL] ${msg}`)
  process.exit(1)
}

if (!existsSync(ENUMS_TS)) fail(`${ENUMS_TS} is missing.`)
const enumsSrc = readFileSync(ENUMS_TS, 'utf8')

// Isolate the `HarnessType = { ... } as const` object body so member-shaped
// lines elsewhere in the file (other enums) cannot be counted by accident.
const bodyMatch = enumsSrc.match(/export const HarnessType = \{([\s\S]*?)\n\} as const/)
if (!bodyMatch) {
  fail(`could not find "export const HarnessType = { ... } as const" in ${ENUMS_TS}.`)
}
const harnessBody = bodyMatch[1]
// One member per `KEY: 'value'` line — comments, blank lines and multi-line
// doc blocks in between are not members.
const memberLines = harnessBody
  .split('\n')
  .filter((l) => /^\s*[A-Z][A-Z0-9_]*:\s*'[^']+',?\s*(\/\/.*)?$/.test(l))
const realCount = memberLines.length

if (realCount < 30 || realCount > 60) {
  fail(
    `counted ${realCount} HarnessType members from ${ENUMS_TS} — that is ` +
      'outside a sane range, so the parsing regex above likely broke. Fix the ' +
      'regex rather than the range.',
  )
}

// Cross-check against the file's own exported HARNESS_COUNT/HARNESS_HEADLINE_COUNT
// declarations, so a hand-edit to either constant that disagrees with the real
// member count — or with its own exclusion list — is caught here rather than
// only at the doc sites below.
if (!enumsSrc.includes('export const HARNESS_COUNT = Object.keys(HarnessType).length')) {
  fail(`${ENUMS_TS} no longer defines HARNESS_COUNT as Object.keys(HarnessType).length.`)
}
const headlineMatch = enumsSrc.match(
  /export const HARNESS_HEADLINE_COUNT =\s*\n?\s*HARNESS_COUNT - \[([^\]]*)\]\.length/,
)
if (!headlineMatch) {
  fail(`could not find HARNESS_HEADLINE_COUNT's exclusion list in ${ENUMS_TS}.`)
}
const exclusionCount = headlineMatch[1].split(',').filter((s) => s.trim().length > 0).length
const headlineCount = realCount - exclusionCount

// ── Matrix row count ────────────────────────────────────────────────────
if (!existsSync(MATRIX)) fail(`${MATRIX} is missing.`)
const matrixText = readFileSync(MATRIX, 'utf8')
const rowLines = matrixText.match(/^\| \d+ \|.*$/gm) ?? []
const dataRows = rowLines
// Rows explicitly documented as carrying no HarnessType (the Anthropic
// Managed Agents precedent) are additive, not part of the enum-backed count.
// Anchored on "carries no `HarnessType`" specifically, not the broader
// "no `HarnessType`" phrase — a row can legitimately MENTION a different,
// non-row sub-concept that has no HarnessType (AWS Bedrock AgentCore's
// Gateway, inside the enum-backed `agentcore-runtime` row) without the ROW
// ITSELF being an exception.
const documentedExceptions = rowLines.filter((l) => l.includes('carries no `HarnessType`')).length
const enumBackedRows = dataRows.length - documentedExceptions
if (enumBackedRows !== realCount) {
  fail(
    `${MATRIX} has ${dataRows.length} data row(s), ${documentedExceptions} ` +
      `documented as carrying no HarnessType (${enumBackedRows} enum-backed), ` +
      `but HarnessType has ${realCount} member(s). Either a row is missing/extra, ` +
      `or a genuinely-undocumented no-HarnessType row needs the same "no ` +
      "\`HarnessType\`\" Notes-column phrasing the Anthropic Managed Agents row uses.",
  )
}

// ── Doc claims ───────────────────────────────────────────────────────────
// Deliberately narrow patterns, not a generic "any number near the word
// harness" scan — this codebase also states auto-detection subset counts
// ("40 of Intutic's 41") that are correct and must NOT be flagged as if they
// were total-count claims. Each pattern below only matches a phrasing that
// is actually asserting the total (or headline) count.
// `\*{0,2}` around each number tolerates markdown bold (`**41**`) — the same
// convention check-detector-coverage-claims.js's own pattern uses for the
// identical reason.
const CLAIM_PATTERNS = [
  /\*{0,2}(\d+)\*{0,2}\s+supported\s+harness(?:es)?\b/gi,
  /\*{0,2}(\d+)\*{0,2}\s+harness\s+adapters?\b/gi,
  /Intutic\s+(?:currently\s+)?supports\s+\*{0,2}(\d+)\*{0,2}\s+harnesses\b/gi,
  /works?\s+with\s+\*{0,2}(\d+)\*{0,2}\s+(?:coding\s+)?agents?\b/gi,
  /(?:for\s+)?all\s+\*{0,2}(\d+)\*{0,2}\s+harnesses\b/gi,
]

const TARGET_FILES = [
  join(ROOT, 'apps/docs/guide/getting-started.md'),
  join(ROOT, 'apps/docs/guide/settings.md'),
  join(ROOT, 'apps/docs/guide/how-it-works.md'),
  join(ROOT, 'apps/docs/guide/concepts.md'),
  join(ROOT, 'README.md'),
]

let offences = 0
let checked = 0

for (const file of TARGET_FILES) {
  if (!existsSync(file)) fail(`${file} is missing — this gate asserted nothing for it.`)
  const text = readFileSync(file, 'utf8')
  for (const pattern of CLAIM_PATTERNS) {
    for (const m of text.matchAll(pattern)) {
      const claimed = Number(m[1])
      checked += 1
      if (claimed !== realCount && claimed !== headlineCount) {
        console.error(
          `[FAIL] ${file}: claims ${claimed} harnesses ("${m[0]}"), but ` +
            `HARNESS_COUNT=${realCount} and HARNESS_HEADLINE_COUNT=${headlineCount}.`,
        )
        offences += 1
      }
    }
  }
}

if (checked === 0) fail('no harness-count claim was checked. This gate asserted nothing.')

if (offences > 0) {
  console.error(
    `\nHARNESS_COUNT/HARNESS_HEADLINE_COUNT (packages/shared-types/src/enums.ts) are the ` +
      'source of truth. Update the prose to match, or use the correct constant if the ' +
      'claim is meant to be marketing-safe (headline) rather than the full count.',
  )
  process.exit(1)
}

console.log(
  `[PASS] harness counts: HARNESS_COUNT=${realCount}, HARNESS_HEADLINE_COUNT=${headlineCount}, ` +
    `matrix has ${dataRows.length} row(s) (${documentedExceptions} documented no-HarnessType ` +
    `exception(s)), ${checked} doc claim(s) checked.`,
)
