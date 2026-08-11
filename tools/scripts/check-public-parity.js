#!/usr/bin/env node
/**
 * check-public-parity.js
 *
 * The open-core packages exist in two repositories. TD-298 unified eleven
 * divergent harness protected-path lists here and never reached the public
 * tree, so the cross-harness tamper matrix it fixed stayed live in the repo
 * anyone can clone — while the entry read ✅ Resolved and both CIs were green.
 * The test that guards the invariant was enterprise-only, so it proved nothing
 * about the copy that had the defect.
 *
 * A fix that lands in one of two copies is not a fix. This gate compares the
 * shared source trees and fails when a file present in both has drifted.
 *
 * Rules:
 *   - a file in BOTH repos must be byte-identical
 *   - a file only in this repo is fine (enterprise-only code is expected)
 *   - a file only in the public repo is reported: this repo is the source of
 *     truth, so that means something was added there directly
 *
 * Usage:
 *   node tools/scripts/check-public-parity.js [path-to-public-checkout]
 *
 * With no argument it looks for a sibling `intutic` checkout, and skips with a
 * clear message if there is none — so a laptop without both repos does not fail
 * the build, while CI (which clones it) does the real comparison.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const publicRoot = process.argv[2] ?? join(repoRoot, '..', 'intutic')

/** Trees that exist in both repos and must not drift. */
const SHARED = [
  // Every package that exists in both repos, not just the proxy. The first
  // version of this list covered six paths and missed a real divergence in
  // packages/shared-types — a shared type that differs between repos is how
  // the next one hides.
  'packages/anomaly-taxonomy',
  'packages/clawde-sdk',
  'packages/id',
  // The Python SDK, including the intutic_clawde.gate enforcement point. Its
  // tests pin behavior against the proxy's actions.rs and the control plane's
  // matchSopRule, so a copy that drifts enforces a different policy than the
  // one those tests prove.
  'packages/intutic-clawde',
  'packages/logger',
  'packages/mcp-proxy',
  'packages/proxy/src',
  'packages/proxy/scripts',
  'packages/proxy/tests',
  'packages/shared-types',
  'packages/theme',
  'packages/vscode-extension',
  'packages/wasm-sdk',
  'tools/cli/src',
  // The sandbox base image + entrypoint (LLD #63 §6) — genuinely shared, but
  // missed until now: this SHARED list is a manual enumeration, and a new
  // directory outside it is invisible to the parity check by construction,
  // not because it was judged enterprise-only. Found when TD-333's
  // attestation change to entrypoint.sh had silently drifted between repos.
  'tools/cli/resources',
  'tools/scripts',
  'services/sync-daemon/src',
  'services/sync-daemon/__tests__',
  'apps/docs',
]

/**
 * Files that differ on purpose. Each needs a reason — an unexplained entry here
 * is how a real divergence gets parked and forgotten, which is the defect this
 * script exists to catch.
 */
const ALLOWED_DIVERGENCE = new Map([
  // Empty, and that is the goal. The one entry that lived here justified the
  // divergence by naming INTUTIC_OPEN_SOURCE / INTUTIC_MODE — two flags nothing
  // in either repo reads. An allowlist entry that cites a dead reason is worse
  // than the drift it excuses, because it stops anyone looking again.
])

/**
 * Build output and local state, never compared.
 *
 * `.vitepress` was here as a whole, and it is not build output. It holds
 * `config.ts`, `theme/` and `public/` — the files that configure the entire
 * docs site, inside `apps/docs`, which IS a shared tree. So the gate compared
 * the documentation while skipping the file that decides how it is built and
 * what it links to, and `config.ts` was edited during this change set.
 *
 * Only `cache`, `cache_temp` and `dist` beneath it are generated; those are
 * named directly. `dist` was already listed.
 */
const IGNORED_DIRS = new Set(['node_modules', '.turbo', 'cache', 'cache_temp', 'dist', 'target', '.git', '.venv', '__pycache__', 'build'])

const IGNORED_FILES = /\.tsbuildinfo$|\.log$|^\.DS_Store$/

function walk(root, dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(root, full, out)
    // Build artifacts, not source. `.tsbuildinfo` in particular is a local
    // incremental-compile cache that differs on every machine.
    else if (statSync(full).isFile() && !IGNORED_FILES.test(entry.name)) out.push(relative(root, full))
  }
  return out
}

if (!existsSync(publicRoot)) {
  console.log(`No public checkout at ${publicRoot} — skipping parity check.`)
  console.log('CI clones it; pass a path explicitly to run this locally.')
  process.exit(0)
}

const drifted = []
const publicOnly = []
let compared = 0

for (const tree of SHARED) {
  const ours = new Set(walk(repoRoot, join(repoRoot, tree)))
  const theirs = new Set(walk(publicRoot, join(publicRoot, tree)))

  for (const rel of ours) {
    if (!theirs.has(rel)) continue // enterprise-only: expected
    compared++
    const a = readFileSync(join(repoRoot, rel))
    const b = readFileSync(join(publicRoot, rel))
    if (!a.equals(b) && !ALLOWED_DIVERGENCE.has(rel)) drifted.push(rel)
  }
  for (const rel of theirs) if (!ours.has(rel)) publicOnly.push(rel)
}

if (publicOnly.length > 0) {
  console.log(`\nPresent only in the public repo (${publicOnly.length}):`)
  for (const f of publicOnly) console.log(`    ${f}`)
  console.log('  This repo is the source of truth, so these were added directly downstream.')
}

if (drifted.length > 0) {
  console.error(`\n✖ ${drifted.length} shared file(s) have drifted between the two repos:\n`)
  for (const f of drifted) console.error(`    ${f}`)
  console.error(
    '\nA fix that lands in one of two copies is not a fix. TD-298 unified eleven\n' +
    'harness protected-path lists here and never reached the public tree, so the\n' +
    'gap it closed stayed open where anyone could clone it — for as long as the\n' +
    'registry read RESOLVED and both CIs were green.\n\n' +
    'Sync the files above, or move the enterprise-only ones out of the shared trees.',
  )
  process.exit(1)
}

for (const [file, reason] of ALLOWED_DIVERGENCE) {
  console.log(`  (allowed divergence) ${file} — ${reason}`)
}
console.log(`\n✓ ${compared} shared file(s) compared; no unexplained drift.`)
