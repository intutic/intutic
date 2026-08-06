#!/usr/bin/env node
/**
 * Fail the build on a large binary entering git history.
 *
 * # Why
 *
 * `release-artifacts/` held four standalone CLI binaries and seven tarballs —
 * 380 MB — tracked in a repository whose entire pack was 184 MiB. They arrived
 * in one commit (`2e547530`, the v1.5.0 release) and were read by nothing:
 * `.dockerignore` already excluded them from the image context, and the actual
 * distribution path is the GitHub Release that `publish.yml` builds fresh.
 *
 * The cost is not only size. A checked-in binary is a **stale** binary by
 * construction: those embedded a TOON decoder that was fixed long afterwards, so
 * anyone running a shipped v1.5.0 CLI saw a CRITICAL governance incident print
 * as its trace id, while the source in the same commit was correct.
 *
 * A `.gitignore` entry stops the directory coming back under that name. It does
 * nothing about the next 80 MB binary committed somewhere else, which is what
 * this checks. Git itself cannot be made to refuse — a pre-commit hook is local
 * and opt-in, so the gate belongs in CI where it applies to everyone.
 *
 * # What it does not do
 *
 * It does not shrink history. The v1.5.0 blobs stay reachable from that commit;
 * removing them rewrites every SHA after it and invalidates every clone, which
 * is a coordinated operation and not one a lint script should perform.
 */
import { execFileSync } from 'node:child_process'
import { statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('../..', import.meta.url).pathname

/** Bytes above which a tracked file must justify itself. */
const MAX_TRACKED_BYTES = 5 * 1024 * 1024

/**
 * Files permitted to exceed the ceiling, each with a reason.
 *
 * An entry without a reason is how a real problem gets parked, so this list is
 * matched exactly — no globs, no prefixes. A new large file is a decision
 * someone makes on purpose, in a diff a reviewer can see.
 */
const ALLOWED = new Map([
  [
    'packages/proxy/Cargo.lock',
    'a lockfile, and it must be tracked — the proxy image builds with ' +
      'packages/proxy as its Docker context, so COPY needs it present',
  ],
  [
    'packages/theme/assets/bg/hero-loop.mp4',
    'the SOURCE of the hero video, not a build product. `sync-assets.ts` copies ' +
      'it into apps/dashboard/public at theme build time; that copy is ignored',
  ],
])

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
}

const offenders = []
for (const rel of trackedFiles()) {
  if (ALLOWED.has(rel)) continue
  const abs = join(ROOT, rel)
  // A tracked path can be absent from the working tree mid-rebase.
  if (!existsSync(abs)) continue
  let size
  try {
    size = statSync(abs).size
  } catch {
    continue
  }
  if (size > MAX_TRACKED_BYTES) offenders.push({ rel, size })
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`

if (offenders.length === 0) {
  const allowed = [...ALLOWED.keys()]
  console.log(
    `[PASS] no tracked file over ${mb(MAX_TRACKED_BYTES)}` +
      (allowed.length ? ` (${allowed.length} allowed by name: ${allowed.join(', ')})` : ''),
  )
  process.exit(0)
}

offenders.sort((a, b) => b.size - a.size)
console.error(`[FAIL] ${offenders.length} tracked file(s) over ${mb(MAX_TRACKED_BYTES)}:\n`)
for (const o of offenders) console.error(`  ${mb(o.size).padStart(9)}  ${o.rel}`)
console.error(
  '\nBuild output does not belong in git. It is stale the moment the source it\n' +
    'was built from changes, and the divergence is invisible — the v1.5.0 CLI\n' +
    'binaries shipped a decoder that had been fixed, in a commit whose source was\n' +
    'correct.\n\n' +
    'Publish it as a release asset instead (see .github/workflows/publish.yml,\n' +
    'which builds fresh and uploads to the GitHub Release), and add the path to\n' +
    '.gitignore. If a large file genuinely must be tracked, add it to ALLOWED in\n' +
    'this script with the reason — in a diff someone will review.\n',
)
process.exit(1)
