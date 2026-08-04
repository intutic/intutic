#!/usr/bin/env node
/**
 * Fail the build on a published latency claim that no benchmark supports.
 *
 * # Why this exists
 *
 * The plan's Phase 0 retracted a `<5ms evaluation chain` claim from thirteen
 * documentation pages. Running the benchmark for the first time had turned that
 * claim from *unsupported* into *disproved*: `dlp::scan` measured 165× slower
 * than the loop it replaced, and a 32 KB body spent ~5 ms in DLP alone — the
 * entire advertised budget, in one gate.
 *
 * That retraction was a one-time edit with nothing holding it, and it was
 * incomplete. Five source pages kept the claim, including the two most specific:
 * `external/litellm.md` promising the whole Layer 1 chain "in under **5ms**",
 * and `guide/drift-detection.md` still advertising a "sub-millisecond fast
 * path" — the exact phrase `benches/anomaly_bench.rs` says "has now been removed
 * from the docs". A committed source file asserted a docs edit that had not
 * happened, which is this codebase's signature defect pointed at its own
 * remediation.
 *
 * A retraction nothing enforces is a retraction that comes back.
 *
 * # What is allowed
 *
 * Numbers that describe an **enforced ceiling** a reader can verify from
 * source, not a measured speed. The wasmtime sandbox's limits are the only ones
 * that qualify today: 16 MB, 1,000,000 fuel, 5 ms, checked at
 * `packages/proxy/src/wasm/runner.rs`. Those say "we stop it here", which is a
 * property of the code; "it takes under 5ms" is a claim about a machine nobody
 * named running a workload nobody specified.
 *
 * To publish a real latency figure, put the benchmark in `packages/proxy/benches`
 * first, state the hardware and the payload size, and add the phrasing here
 * deliberately.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('../..', import.meta.url).pathname
const DOCS = join(ROOT, 'apps/docs')

/** Claims about how fast something *is*. */
const FORBIDDEN = [
  /sub-millisecond/i,
  /sub-\s?\d+\s?ms/i,
  /in under \*{0,2}\d+\s?m?s\b/i,
  /\bunder \d+\s?milliseconds\b/i,
  // Any "less than N ms" in any wrapper — table cell, prose, or an ASCII
  // diagram. The first version keyed on the table form `| < 1ms |` and walked
  // straight past `(< 1ms on hit)` two lines above it in the same file. A
  // pattern narrow enough to miss the neighbouring line is a gate with a hole
  // in the shape of whatever it was written against.
  /<\s*\d+(\.\d+)?\s?ms\b/i,
  /\b\d+(\.\d+)?\s?ms\s+(latency|overhead|p\d{2})\b/i,
]

/**
 * Phrasings that name an enforced ceiling rather than a measured speed.
 *
 * Matched against the whole line, so a line that states a limit is exempt even
 * if a forbidden pattern also appears in it.
 */
const CEILING_CONTEXT = [
  /wasmtime/i,
  /\bfuel\b/i,
  /execution timeout/i,
  /\btimeout\b/i,
  /node:vm/i,
]

function* markdownFiles(dir) {
  for (const name of readdirSync(dir)) {
    // Build output and dependency caches are not published source. They lag the
    // source by whenever someone last ran a build, so scanning them reports
    // fixed pages as broken and unfixed ones as fine.
    if (name === '.vitepress' || name === 'node_modules') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* markdownFiles(p)
    else if (name.endsWith('.md')) yield p
  }
}

const offences = []
for (const file of markdownFiles(DOCS)) {
  const lines = readFileSync(file, 'utf-8').split('\n')
  lines.forEach((line, i) => {
    if (CEILING_CONTEXT.some((re) => re.test(line))) return
    const hit = FORBIDDEN.find((re) => re.test(line))
    if (hit) offences.push({ file: relative(ROOT, file), line: i + 1, text: line.trim().slice(0, 160) })
  })
}

if (offences.length === 0) {
  console.log('[PASS] no unsupported latency claim in published docs.')
  process.exit(0)
}

console.error(`[FAIL] ${offences.length} unsupported latency claim(s) in published docs:\n`)
for (const o of offences) console.error(`  ${o.file}:${o.line}\n    ${o.text}\n`)
console.error(
  'These describe how fast something IS. No benchmark in this repository supports\n' +
    'such a figure, and the first one that ran disproved the last one published.\n\n' +
    'Either state the architectural property a reader can check from source — "in\n' +
    'process", "no model call", "no network hop" — or land a benchmark under\n' +
    'packages/proxy/benches naming the hardware and payload size, and then add the\n' +
    'phrasing to this script deliberately.\n',
)
process.exit(1)
