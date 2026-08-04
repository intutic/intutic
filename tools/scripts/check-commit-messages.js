#!/usr/bin/env node
/**
 * check-commit-messages.js
 *
 * This repository is public. Its commit messages are as readable as its code,
 * and they were leaking things the code does not: the existence and contents of
 * a private mirror, internal ticket ids pointing at a registry no reader can
 * open, test counts for unreleased private services, and the shape of a
 * commercial tier that has not been announced.
 *
 * Same idea as the banned-terms gate in apps/docs/.vitepress/config.ts, applied
 * to history instead of pages: name the terms that must not ship, and fail
 * rather than trust everyone to remember.
 *
 * Usage:
 *   node tools/scripts/check-commit-messages.js [<range>]
 *
 * Default range is `origin/main..HEAD` when it resolves, else the last tag to
 * HEAD. CI passes an explicit range for the PR's commits.
 *
 * Exit 0 clean, 1 on any violation.
 */
import { execSync } from 'node:child_process'

/**
 * Each rule is a pattern plus what to write instead. The guidance matters as
 * much as the pattern — a linter that only says "no" gets worked around.
 *
 * Deliberately NOT banned: "control plane" on its own. This proxy really does
 * talk to one, `CONTROL_PLANE_URL` is a documented public setting, and a commit
 * that cannot say so would have to lie. Only the hosted specifics are banned.
 */
const RULES = [
  {
    // INTUTIC_ENTERPRISE_BUILD is exempt: it is a real build flag set in this
    // repo's own Dockerfile, so a commit that touches it has to be able to name
    // it. The negative lookbehind keeps the flag legal and the adjective banned.
    pattern: /(?<!INTUTIC_)\benterprise\b(?!_BUILD)/i,
    why: 'names a commercial tier that has not been announced',
    instead: 'describe the capability, not the tier. For a cross-repo sync, say what changed here.',
  },
  { pattern: /\bSaaS\b/i, why: 'names an unannounced hosted offering', instead: 'omit, or say "hosted".' },
  { pattern: /\bpaid[- ]tier\b/i, why: 'reveals the commercial split', instead: 'omit.' },
  { pattern: /\bIntutic Cloud\b/i, why: 'names an unannounced product', instead: 'omit.' },
  {
    pattern: /\bTD-\d+\b/,
    why: 'cites an internal ticket in a registry no reader of this repo can open',
    instead: 'state the defect in the message itself — it should stand alone anyway.',
  },
  { pattern: /TECH_DEBT/i, why: 'names a private document', instead: 'describe the finding directly.' },
  {
    pattern: /\b\d+\s+(?:control-plane|dashboard)\s+tests?\b/i,
    why: 'discloses the size of an unreleased private service',
    instead: 'quote only the test counts for code that ships from this repo.',
  },
  {
    pattern: /\bGKE\b|GCP Secret Manager|\bapp\.intutic\.ai\b|\bapi\.intutic\.ai\b/,
    why: 'discloses hosted infrastructure an open-core user has no access to',
    instead: 'omit, or describe it generically.',
  },
  { pattern: /sync-to-public/i, why: 'reveals the private-to-public sync mechanism', instead: 'omit.' },
  {
    pattern: /\bprivate (?:repo|mirror)\b|\bthe other repo\b/i,
    why: 'confirms a private mirror exists',
    instead: 'describe the change on its own terms.',
  },
]

const range = process.argv[2] ?? defaultRange()

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim()
}

function defaultRange() {
  try {
    sh('git rev-parse --verify origin/main')
    return 'origin/main..HEAD'
  } catch {
    /* no remote ref locally */
  }
  try {
    return `${sh('git describe --tags --abbrev=0')}..HEAD`
  } catch {
    return 'HEAD~20..HEAD'
  }
}

let hashes = []
try {
  const out = sh(`git log --format=%H ${range}`)
  hashes = out ? out.split('\n') : []
} catch (err) {
  console.error(`Could not resolve range "${range}": ${err.message}`)
  process.exit(1)
}

if (hashes.length === 0) {
  console.log(`No commits in ${range} — nothing to check.`)
  process.exit(0)
}

let violations = 0
for (const h of hashes) {
  const msg = sh(`git log -1 --format=%B ${h}`)
  const subject = msg.split('\n')[0]
  const hits = RULES.filter((r) => r.pattern.test(msg))
  if (hits.length === 0) continue

  violations++
  console.error(`\n✖ ${h.slice(0, 8)}  ${subject}`)
  for (const hit of hits) {
    const m = msg.match(hit.pattern)
    console.error(`    "${m[0]}" — ${hit.why}`)
    console.error(`      → ${hit.instead}`)
  }
}

if (violations > 0) {
  console.error(
    `\n${violations} of ${hashes.length} commit message(s) in ${range} disclose something this repo does not.\n` +
      'Amend or rebase them before pushing. These messages are public the moment they land.',
  )
  process.exit(1)
}

console.log(`✓ ${hashes.length} commit message(s) in ${range} are clean.`)
