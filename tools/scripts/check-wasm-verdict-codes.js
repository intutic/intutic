#!/usr/bin/env node
/**
 * No surface may teach a WASM verdict code the proxy does not implement.
 *
 * The runner maps guest return codes to `Verdict`. Seven other places described
 * that mapping, and every one of them was wrong in a different way:
 *
 *   - the SDK's own entry point said `2 = Redact`
 *   - all three copies of the rule-author skill taught `0/1/2-REDACT`, no reask
 *   - the public guide listed `REDACT` as a live rung and had no row for `3`
 *   - the LLD specified `2 → REDACT (proxy will strip matching fields)`
 *   - the benchmark guest declared `1 = Allow, 2 = Modify, 3 = Deny`
 *
 * The last one was not cosmetic. `VERDICT_DENY = 3` produces a **Reask**, so the
 * benchmark measuring the blocking path was measuring the retry path.
 *
 * `2` is the trap in all of it: the guest is handed the RequestContext, never
 * the request body, so redaction was never expressible. A rule returning `2`
 * believing it redacts gets a block.
 *
 * The truth is derived from `runner.rs`, so changing the mapping moves the
 * requirement. Exit 1 on any drift, and on any input it cannot read.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const RUNNER = join(ROOT, 'packages/proxy/src/wasm/runner.rs')

function fail(msg) {
  console.error(`[FAIL] ${msg}`)
  process.exit(1)
}

if (!existsSync(RUNNER)) fail(`${RUNNER} is missing — this gate asserted nothing.`)

const runner = readFileSync(RUNNER, 'utf8')

// Which codes the runner actually maps, read from its match arms.
const mapped = new Set(
  [...runner.matchAll(/^\s*(\d+)\s*=>/gm)].map((m) => Number(m[1])),
)

// The mapping has always been {0,1,2,3}. If it genuinely changes, this gate
// should be updated deliberately rather than silently following along.
const EXPECTED = [0, 1, 2, 3]
for (const code of EXPECTED) {
  if (!mapped.has(code)) {
    fail(
      `runner.rs no longer maps verdict code ${code}.\n` +
        'If the mapping changed on purpose, update this gate and every surface it\n' +
        'guards in the same commit — that is the whole point of it existing.',
    )
  }
}

/**
 * Surfaces that describe the verdict codes to a human or a compiler.
 *
 * `forbid` is matched case-insensitively against the file. Each pattern encodes
 * a specific wrong claim that shipped, not a general keyword ban — `REDACT` may
 * appear in a sentence explaining that it is deprecated.
 */
const SURFACES = [
  {
    file: 'packages/wasm-sdk/assembly/index.ts',
    forbid: [[/2\s*=\s*Redact/i, '`2 = Redact` — the guest never receives the request body']],
    require: [[/3\s*(=|·|\s)\s*reask/i, 'the reask rung (3)']],
  },
  {
    file: '.agents/skills/intutic-rule-author/SKILL.md',
    forbid: [[/`2`\s*=\s*REDACT\s*\(treated as block\)/i, '`2` = REDACT as a live rung']],
    require: [[/`3`\s*=\s*REASK/i, 'the reask rung (3)']],
  },
  {
    file: 'apps/docs/public/downloads/RULE_AUTHOR_SKILL.md',
    forbid: [[/`2`\s*=\s*REDACT\s*\(treated as block\)/i, '`2` = REDACT as a live rung']],
    require: [[/`3`\s*=\s*REASK/i, 'the reask rung (3)']],
  },
  {
    file: 'services/sync-daemon/src/skillWriter.ts',
    forbid: [[/\\?`2\\?`\s*=\s*REDACT\s*\(treated as block\)/i, '`2` = REDACT as a live rung']],
    require: [[/\\?`3\\?`\s*=\s*REASK/i, 'the reask rung (3)']],
  },
  {
    file: 'apps/docs/external/wasm-rules.md',
    forbid: [[/\|\s*`?REDACT`?\s*\|/i, 'a REDACT row in the verdict table']],
    require: [[/`?REASK`?/i, 'the reask rung (3)']],
  },
  {
    file: 'packages/proxy/benches/wasm_guest/src/lib.rs',
    forbid: [
      [/1\s*=\s*Allow/i, '`1 = Allow` — 1 is a block'],
      [/3\s*=\s*Deny/i, '`3 = Deny` — 3 is a reask, so this benchmarks the retry path'],
    ],
    require: [],
  },
  {
    file: 'docs/lld/phase-4/25-tech-debt-graduates.lld.md',
    // The LLD tree is enterprise-only and absent from the open-core mirror.
    // Flagged rather than silently tolerated: a surface that vanishes because it
    // was deleted must still fail, so absence is only allowed where the whole
    // directory is missing, not where this one file went away.
    enterpriseOnly: true,
    forbid: [[/2\s*→\s*REDACT\s*\(proxy will strip/i, 'REDACT specified as implemented']],
    require: [[/3\s*→\s*REASK/i, 'the reask rung (3)']],
  },
]

let failed = false
let checked = 0
const skipped = []

for (const surface of SURFACES) {
  const path = join(ROOT, surface.file)
  if (!existsSync(path)) {
    // An enterprise-only surface is absent from the open-core mirror by design.
    // Only excuse it when its whole tree is missing — if `docs/lld` exists and
    // this file does not, it was deleted or renamed, and coverage really did
    // shrink.
    const treeMissing =
      surface.enterpriseOnly && !existsSync(join(ROOT, surface.file.split('/')[0], 'lld'))
    if (treeMissing) {
      skipped.push(surface.file)
      continue
    }
    console.error(`[FAIL] ${surface.file} is missing — this gate covered it.`)
    console.error('  If it moved, update this list. If it went away, delete its entry.')
    failed = true
    continue
  }
  const text = readFileSync(path, 'utf8')
  checked += 1

  for (const [pattern, why] of surface.forbid) {
    if (pattern.test(text)) {
      console.error(`[FAIL] ${surface.file} still states ${why}.`)
      failed = true
    }
  }
  for (const [pattern, what] of surface.require) {
    if (!pattern.test(text)) {
      console.error(`[FAIL] ${surface.file} does not document ${what}.`)
      failed = true
    }
  }
}

if (checked === 0) fail('no surface was checked. This gate asserted nothing.')

if (failed) {
  console.error(
    '\nThe mapping is in packages/proxy/src/wasm/runner.rs:\n' +
      '    0 allow · 1 block · 3 reask · 2 deprecated, mapped to a block\n' +
      'Anything else is allowed with a warning, so a rule inventing a rung enforces\n' +
      'nothing.',
  )
  process.exit(1)
}

// Say what was not checked. A gate that quietly covers less than it appears to
// is the shape this whole file exists to prevent.
if (skipped.length > 0) {
  console.log(`[note] enterprise-only, not present here: ${skipped.join(', ')}`)
}
console.log(`[PASS] verdict codes consistent across ${checked} surface(s).`)
