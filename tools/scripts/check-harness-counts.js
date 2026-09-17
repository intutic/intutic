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
import { readFileSync, existsSync, readdirSync } from 'node:fs'
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
// Interview-audit closeout Wave 5: the five-file list this gate used to check
// left ~19 hand-stated counts unwatched (an integrations page said 38, a
// guide said 18, four compare pages said 41 where the headline is 39). Every
// docs page, both READMEs and the sandbox guide are read now, and the patterns
// cover the phrasings those sites actually used. "other N harnesses" (an
// integration page counting the rest) is N = count − 1.
const CLAIM_PATTERNS = [
  /\*{0,2}(\d+)\*{0,2}\s+supported\s+harness(?:es)?\b/gi,
  /\*{0,2}(\d+)\*{0,2}\s+harness\s+adapters?\b/gi,
  /\*{0,2}(\d+)\*{0,2}\s+harness\s+integrations\b/gi,
  /Intutic\s+(?:currently\s+)?supports\s+\*{0,2}(\d+)\*{0,2}\s+(?:AI\s+agent\s+)?harnesses\b/gi,
  /works?\s+with\s+\*{0,2}(\d+)\*{0,2}\s+(?:coding\s+)?agents?\b/gi,
  /(?:for\s+)?all\s+\*{0,2}(\d+)\*{0,2}\s+harnesses\b/gi,
  /(?:across|over)\s+\*{0,2}(\d+)\*{0,2}\s+(?:supported\s+)?harnesses\b/gi,
  /\*{0,2}(\d+)\*{0,2}\s+harnesses\s+out-of-the-box\b/gi,
  /\b(\d+)\s+Harness(?:es)?\b(?=\s*(?:<!--|$))/gm,
]
const OTHER_PATTERN = /other\s+\*{0,2}(\d+)\*{0,2}\s+harnesses\b/gi

function walkMarkdown(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.vitepress' || entry.name === 'node_modules' || entry.name === 'public') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walkMarkdown(full, out)
    else if (entry.name.endsWith('.md')) out.push(full)
  }
  return out
}

const TARGET_FILES = [
  ...walkMarkdown(join(ROOT, 'apps/docs')),
  join(ROOT, 'README.md'),
  join(ROOT, 'services/sync-daemon/README.md'),
]
// Enterprise-only files: this script is mirrored to the public repo, where
// `docs/` does not exist. Checked when present, skipped (and said so) when
// not — a missing enterprise-only file is not an assertion failure there.
const OPTIONAL_FILES = [join(ROOT, 'docs/guides/sandbox_and_policy_gates.md')]
for (const file of OPTIONAL_FILES) {
  if (existsSync(file)) TARGET_FILES.push(file)
  else console.log(`[SKIP] ${file} is not in this checkout (enterprise-only).`)
}

let offences = 0
let checked = 0

function checkClaim(file, claimed, quoted, expected) {
  checked += 1
  if (!expected.includes(claimed)) {
    console.error(
      `[FAIL] ${file}: claims ${claimed} harnesses ("${quoted.trim()}"), but ` +
        `HARNESS_COUNT=${realCount} and HARNESS_HEADLINE_COUNT=${headlineCount} ` +
        `(accepted here: ${expected.join(' or ')}).`,
    )
    offences += 1
  }
}

for (const file of TARGET_FILES) {
  if (!existsSync(file)) fail(`${file} is missing — this gate asserted nothing for it.`)
  const text = readFileSync(file, 'utf8')
  for (const pattern of CLAIM_PATTERNS) {
    for (const m of text.matchAll(pattern)) {
      checkClaim(file, Number(m[1]), m[0], [realCount, headlineCount])
    }
  }
  for (const m of text.matchAll(OTHER_PATTERN)) {
    checkClaim(file, Number(m[1]), m[0], [realCount - 1, headlineCount - 1])
  }
}

// ── Website markers (opt-in: --website <checkout>) ──────────────────────
//
// The marketing site keeps its counts between
// `<!-- HARNESS_COUNT:sync -->N<!-- /HARNESS_COUNT:sync -->` markers; nothing
// ever read them until this mode. Every marker must carry the headline count.
const websiteFlag = process.argv.indexOf('--website')
if (websiteFlag !== -1) {
  const site = process.argv[websiteFlag + 1]
  if (!site) fail('--website needs a path to the intutic-website checkout.')
  const index = join(site, 'index.html')
  if (!existsSync(index)) fail(`${index} is missing.`)
  const html = readFileSync(index, 'utf8')
  const markers = [...html.matchAll(/<!-- HARNESS_COUNT:sync -->\s*(\d+)[^<]*<!-- \/HARNESS_COUNT:sync -->/g)]
  if (markers.length === 0) fail(`${index} has no HARNESS_COUNT:sync markers — this mode asserted nothing.`)
  for (const m of markers) checkClaim(index, Number(m[1]), m[0], [headlineCount])
  console.log(`[PASS] website: ${markers.length} HARNESS_COUNT:sync marker(s) in ${index} carry ${headlineCount}.`)
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
