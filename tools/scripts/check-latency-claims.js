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
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const ROOT = new URL('../..', import.meta.url).pathname

/**
 * Every published tree **in this repository**.
 *
 * The marketing site is a separate, private repo, and its only workflow was
 * `deploy.yml` with no lint step at all. So this gate existed, ran in CI, and
 * would have flagged six lines of the homepage on sight — while nine
 * unsupported performance figures sat on the page prospects actually read. A
 * claim gate scoped to the tree least likely to be read is the same defect as a
 * control with no caller.
 *
 * The fix for that is **not** to default to a sibling checkout. That was tried,
 * and it fails in the one place it matters: a CI runner checks out one
 * repository, no cross-repo credential exists, and the public mirror runs this
 * same script where granting one would be a disclosure problem — so the gate
 * hard-failed on every PR over a tree no PR in this repo could fix.
 *
 * Enforcement belongs to the repo that owns the tree. `intutic/website` runs
 * this script over itself, from a pinned checkout of the public mirror, as a
 * prerequisite of its own deploy — so an unsupported claim blocks publication
 * rather than annotating it. Roots come from argv precisely so it can do that
 * without a second copy of the pattern list; a second copy is how the first
 * eleven protected-path lists drifted.
 *
 * What keeps this honest here is the PASS line, which names every root it
 * opened. A pass can state less than you hoped; it can never state more than it
 * checked.
 */
const DEFAULT_ROOTS = [join(ROOT, 'apps/docs')]

const argRoots = process.argv.slice(2).filter((a) => !a.startsWith('-'))
const ROOTS = argRoots.length > 0 ? argRoots.map((r) => resolve(r)) : DEFAULT_ROOTS

/** Claims about how fast something *is*. */
const FORBIDDEN = [
  /sub-millisecond/i,
  /sub-\s?\d+\s?ms/i,
  // "in" is not required. This read `/in under .../` and walked straight past
  // `Synchronous interceptor (under 50ms)` in a compare page, because the
  // parenthesised form has no preceding "in". A gate that only catches the
  // phrasing it was written against is the shape of hole this file exists for.
  /\bunder \*{0,2}\d+\s?m?s\b/i,
  /\bunder \d+\s?milliseconds\b/i,
  // Any "less than N ms" in any wrapper — table cell, prose, or an ASCII
  // diagram. The first version keyed on the table form `| < 1ms |` and walked
  // straight past `(< 1ms on hit)` two lines above it in the same file. A
  // pattern narrow enough to miss the neighbouring line is a gate with a hole
  // in the shape of whatever it was written against.
  /<\s*\d+(\.\d+)?\s?ms\b/i,
  /\b\d+(\.\d+)?\s?ms\s+(latency|overhead|p\d{2})\b/i,
  // A bare speed claim with no comparator at all — "38 WASM rules evaluate in
  // 1.2 ms". Nothing in either repo produces that figure, and none of the
  // patterns above sees it because it says neither "under" nor "<".
  /\b(evaluat|execut|complet|run|process|scan|respond)\w*\s+in\s+[\d.]+\s?m?s\b/i,
]

/**
 * Phrasings that name an enforced ceiling rather than a measured speed.
 *
 * Matched NEAR the offending figure, not against the whole line.
 *
 * Whole-line matching let one sentence make both claims and be exempted on the
 * strength of the first: "executed inside the proxy's isolated, fuel-limited
 * WASM sandbox with a negligible latency overhead (<1ms)" names a real ceiling
 * AND publishes an unsupported speed, and the word `fuel` excused the whole
 * thing. A ceiling mentioned anywhere on a line became a licence to assert a
 * speed anywhere else on it.
 */
const CEILING_CONTEXT = [
  /wasmtime/i,
  /\bfuel\b/i,
  /execution timeout/i,
  /\btimeout\b/i,
  /node:vm/i,
]

/** Published source: prose AND markup. The homepage is `.html`. */
const PUBLISHED = /\.(md|html?)$/i

// ── The routing-quality ban ─────────────────────────────────────────────────
//
// The Response Integrity Score detects malformed, truncated and unusable
// responses. It does NOT detect wrong-but-well-formed ones — code that compiles
// and is incorrect, a plausible wrong root cause, the right tool with wrong
// values — and that is most of the real harm from downgrading a model.
//
// So routing may be described as guarded against unusable responses, and never
// as preserving quality. The phrasing below is banned outright rather than
// reviewed, because it is the one claim the measurement cannot support and the
// one a reader will most reasonably believe.
const QUALITY_CLAIMS = [
  /no quality loss/i,
  /without (?:any )?quality loss/i,
  /preserves? (?:the )?(?:same )?quality/i,
  /quality is preserved/i,
  /same quality/i,
  /without sacrificing quality/i,
  /identical quality/i,
]


/**
 * What the reader sees, not what the file contains.
 *
 * HTML escapes the character every "less than" pattern keys on, so
 * `<strong>&lt;1ms P50</strong>` is invisible to `/<\s*\d+\s?ms/` while rendering
 * as exactly the claim this gate forbids. Six of the nine unsupported figures on
 * the marketing homepage hid behind `&lt;`. Decode entities and drop tags first;
 * match against the sentence a prospect actually reads.
 */
function asRendered(line) {
  return line
    .replace(/<[^>]*>/g, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    // Collapse runs. Stripping tags inserts one space per tag, so
    // `<span>&lt;5</span><span>ms</span>` yields `<5  ms` with TWO spaces and
    // slips past a pattern allowing one. The homepage's headline metric card is
    // built exactly that way.
    .replace(/\s+/g, ' ')
}

function* publishedFiles(dir) {
  for (const name of readdirSync(dir)) {
    // `.git` matters now that a root can be a whole repo rather than a docs
    // subtree — packed refs contain arbitrary bytes that match anything.
    if (name === '.git' || name === 'dist' || name === 'build') continue
    // The website repo obtains this gate by checking the public mirror out into
    // `.gate` and then scanning `.`, so the mirror sits *inside* the root being
    // scanned. Without this, that run walks the mirror's own `apps/docs` and
    // reports enterprise documentation offences as website offences.
    if (name === '.gate') continue
    // Build output and dependency caches are not published source. They lag the
    // source by whenever someone last ran a build, so scanning them reports
    // fixed pages as broken and unfixed ones as fine.
    if (name === '.vitepress' || name === 'node_modules') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* publishedFiles(p)
    else if (PUBLISHED.test(name)) yield p
  }
}

const offences = []
const scanned = []
const missing = []

for (const root of ROOTS) {
  if (!existsSync(root)) {
    missing.push(root)
    continue
  }
  scanned.push(root)
  for (const file of publishedFiles(root)) {
    const lines = readFileSync(file, 'utf-8').split('\n')
    lines.forEach((raw, i) => {
      const line = asRendered(raw)

      // The routing-quality ban. Not exemptible by nearby wording, unlike the
      // latency figures: there is no context in which this claim becomes true.
      const claim = QUALITY_CLAIMS.find((re) => re.test(line))
      if (claim) {
        offences.push({
          file: relative(process.cwd(), file),
          line: i + 1,
          text: raw.trim().slice(0, 160),
          quality: true,
        })
      }

      const hit = FORBIDDEN.find((re) => re.test(line))
      if (!hit) return
      // Exempt only if the ceiling wording sits beside the figure itself.
      const at = line.search(hit)
      const near = line.slice(Math.max(0, at - 60), at + 60)
      if (CEILING_CONTEXT.some((re) => re.test(near))) return
      offences.push({ file: relative(process.cwd(), file), line: i + 1, text: raw.trim().slice(0, 160) })
    })
  }
}

// A root that is not there is a hard failure, never a silent skip. "Nothing to
// scan" and "nothing wrong" produce identical output otherwise, which is the
// failure this whole file is about.
//
// Every root now either lives in this repository or was named on the command
// line, so a missing one is a real mistake — a moved docs tree, or a caller
// passing a path that is not there — and not the ordinary state of a machine
// that happens to have one checkout and not another.
if (missing.length > 0) {
  for (const m of missing) console.error(`[FAIL] not checked out: ${m}`)
  console.error(
    '\nA root was named and is not present, so this run would have asserted less\n' +
      'than it appears to. Pass the roots you actually want:\n' +
      '    node tools/scripts/check-latency-claims.js apps/docs\n',
  )
  process.exit(1)
}
if (scanned.length === 0) {
  console.error('[FAIL] no root was scanned. This gate asserted nothing.')
  process.exit(1)
}

if (offences.length === 0) {
  // Named, not counted. "2 published tree(s)" reads as coverage without saying
  // of what, and this gate's whole history is passes that meant less than they
  // looked like. A reader can check this line against what they expected.
  console.log(
    `[PASS] no unsupported latency claim in: ${scanned
      .map((r) => relative(process.cwd(), r) || '.')
      .join(', ')}`,
  )
  process.exit(0)
}

const quality = offences.filter((o) => o.quality)
const latency = offences.filter((o) => !o.quality)

if (quality.length > 0) {
  console.error(`[FAIL] ${quality.length} claim(s) that routing preserves quality:\n`)
  for (const o of quality) console.error(`  ${o.file}:${o.line}\n    ${o.text}\n`)
  console.error(
    'The Response Integrity Score detects malformed, truncated and unusable\n' +
      'responses. It does NOT detect wrong-but-well-formed ones — code that compiles\n' +
      'and is incorrect, a plausible wrong root cause, the right tool with wrong\n' +
      'values — and that is most of the real harm from downgrading a model.\n\n' +
      'Say routing is guarded against unusable responses. Do not say it preserves\n' +
      'quality; nothing measures that.\n',
  )
}

if (latency.length === 0) process.exit(1)

console.error(`[FAIL] ${latency.length} unsupported latency claim(s) in published source:\n`)
for (const o of latency) console.error(`  ${o.file}:${o.line}\n    ${o.text}\n`)
console.error(
  'These describe how fast something IS. No benchmark in this repository supports\n' +
    'such a figure, and the first one that ran disproved the last one published.\n\n' +
    'Either state the architectural property a reader can check from source — "in\n' +
    'process", "no model call", "no network hop" — or land a benchmark under\n' +
    'packages/proxy/benches naming the hardware and payload size, and then add the\n' +
    'phrasing to this script deliberately.\n',
)
process.exit(1)
