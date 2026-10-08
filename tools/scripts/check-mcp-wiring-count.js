#!/usr/bin/env node
/**
 * Every claim about how many harnesses the MCP governance proxy is wired into
 * must match the code that does the wiring.
 *
 * `injectMcpServer` in services/sync-daemon/src/harness/mcpAutoWrite.ts is the
 * one place the proxy gets wrapped around a harness's MCP servers: its
 * `targets` list names each harness it writes. The docs said "wired
 * automatically into 11 harnesses" and "across eleven harnesses", and nothing
 * compared either with that list. This gate counts the list and fails when a
 * doc, or the module's own header, states a different number.
 *
 * Usage: node tools/scripts/check-mcp-wiring-count.js [repo-root]
 * Exit 1 on any mismatch, on any file it cannot read, or when it checked no
 * claim at all.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const WIRING = join(ROOT, 'services/sync-daemon/src/harness/mcpAutoWrite.ts')

function fail(msg) {
  console.error(`[FAIL] ${msg}`)
  process.exit(1)
}

if (!existsSync(WIRING)) fail(`${WIRING} is missing.`)
const wiringSrc = readFileSync(WIRING, 'utf8')

// The `targets` list inside injectMcpServer: one `['harness-id', injectX]`
// entry per wired harness.
const targetsMatch = wiringSrc.match(/export async function injectMcpServer\([\s\S]*?const targets\b[^\n]*= \[\n([\s\S]*?)\n\s*\]\n/)
if (!targetsMatch) fail(`could not find injectMcpServer's targets list in ${WIRING}.`)
const harnesses = [...targetsMatch[1].matchAll(/\[\s*'([a-z0-9-]+)'\s*,\s*inject\w+\s*\]/g)].map((m) => m[1])
if (harnesses.length < 2) {
  fail(`counted ${harnesses.length} wired harness(es) in ${WIRING} — the parsing regex above likely broke.`)
}
if (new Set(harnesses).size !== harnesses.length) fail(`${WIRING} lists a harness twice: ${harnesses.join(', ')}.`)
const wired = harnesses.length

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven',
  'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty']
const NUMBER = `\\*{0,2}(\\d+|${WORDS.join('|')})\\*{0,2}`
const toNumber = (s) => (/^\d+$/.test(s) ? Number(s) : WORDS.indexOf(s.toLowerCase()))

// Phrasings that state how many harnesses the MCP proxy is wired into. Narrow
// on purpose: harness counts for the hook gates or the whole product are a
// different number, checked by check-harness-counts.js.
const CLAIM_PATTERNS = [
  new RegExp(`wired\\s+(?:automatically\\s+)?into\\s+${NUMBER}\\s+harnesses\\b`, 'gi'),
  new RegExp(`config\\s+paths\\s+across\\s+${NUMBER}\\s+(?:harnesses|\`HarnessType\`\\s+values)\\b`, 'gi'),
]

function walkMarkdown(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.vitepress' || entry.name === 'node_modules' || entry.name === 'public') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walkMarkdown(full, out)
    else if (entry.name.endsWith('.md')) out.push(full)
  }
  return out
}

const docsDir = join(ROOT, 'apps/docs')
if (!existsSync(docsDir)) fail(`${docsDir} is missing.`)
const files = [
  ...walkMarkdown(docsDir),
  WIRING,
  ...['README.md', 'packages/mcp-proxy/README.md', 'services/sync-daemon/README.md']
    .map((f) => join(ROOT, f))
    .filter((f) => existsSync(f)),
]

let checked = 0
let offences = 0
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n')
  // A claim can wrap across two lines of prose.
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i] + (i + 1 < lines.length ? ' ' + lines[i + 1].replace(/^\s*\*?\s*/, '') : '')
    for (const pattern of CLAIM_PATTERNS) {
      for (const m of text.matchAll(pattern)) {
        if (m.index >= lines[i].length) continue // starts on the next line; counted there
        checked += 1
        if (toNumber(m[1]) !== wired) {
          console.error(
            `[FAIL] ${relative(ROOT, file)}:${i + 1}: says "${m[0]}", but injectMcpServer wires ` +
              `${wired} harnesses (${harnesses.join(', ')}).`,
          )
          offences += 1
        }
      }
    }
  }
}

if (checked === 0) fail('no MCP wiring-count claim was found. This gate asserted nothing.')
if (offences > 0) {
  console.error(
    '\ninjectMcpServer in services/sync-daemon/src/harness/mcpAutoWrite.ts is the source of truth. ' +
      'Update the prose to match it.',
  )
  process.exit(1)
}
console.log(`[PASS] MCP wiring count: injectMcpServer wires ${wired} harnesses; ${checked} claim(s) checked.`)
