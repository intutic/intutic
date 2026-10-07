#!/usr/bin/env node
/**
 * Plans have one name each, everywhere a customer reads them, and docs
 * badges say which plan a page needs in one vocabulary.
 *
 * On 2026-10-07 the docs still sold "Pro / Team / Enterprise", 25 pages wore
 * a "Cloud / Team" badge for a plan nobody could buy, the dashboard said
 * "Enterprise Advanced" and "Enterprise License" where the website said
 * "Enterprise" and "Self-host", and emails told people to "Upgrade to Pro".
 * This fails on any of those coming back:
 *
 * - retired plan names (Pro, Team, Biz Scale, Enterprise Sub) and the old
 *   long names (Enterprise Advanced, Enterprise License) in docs pages, the
 *   docs sidebar, dashboard source and the control plane's customer copy;
 * - a docs badge outside the vocabulary in guide/plans.md#badges, plus the
 *   descriptive badges listed below.
 *
 * The plan names themselves come from planSkuMap.ts `displayName`. Files that
 * do not exist are skipped, so this runs in the public checkout too (docs
 * only).
 *
 * Usage: node tools/scripts/check-plan-names.js [repo-root]
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..'))

/** Customer-facing text: where a plan is named to a reader. */
const SOURCES = [
  { dir: 'apps/docs', ext: ['.md'], skip: ['node_modules', 'public', 'dist', 'cache'] },
  { file: 'apps/docs/.vitepress/config.ts' },
  { dir: 'apps/dashboard/src', ext: ['.ts', '.tsx'], skip: [] },
  { file: 'services/control-plane/src/services/emailService.ts' },
  { file: 'services/control-plane/src/lib/planCatalog.ts' },
  { file: 'services/control-plane/src/routes/trial.ts' },
]

const RETIRED = [
  [/\b(Pro|Team|Biz Scale) (plan|tier|Plan|Tier)s?\b/, 'a retired plan'],
  [/\bPro\s*\/\s*Team\b/, 'retired plans'],
  [/\bUpgrade to Pro\b/, 'a retired plan'],
  [/\bEnterprise (Advanced|License|Licensed|Sub|Subscription|Tier)\b/, 'an old plan name (say Enterprise or Self-host)'],
  [/\bEnterprise \((Sub|Advanced|Licensed)\)/, 'an old plan name (say Enterprise or Self-host)'],
  [/\bSelf Serve\b/, 'the plan is spelled "Self-serve"'],
  [/\b(Cloud|Commercial) \/ Team\b/, 'a retired plan badge'],
]

/** The plan badges (guide/plans.md#badges) and the descriptive ones that name no plan. */
const BADGES = new Set([
  'Open-Core', 'Cloud', 'Self-serve+', 'Biz Org+', 'Enterprise', 'Self-host',
  'Preview', 'Guides', 'Standalone/hosted', 'Server-side platform', 'Embedded only',
  'Connected mode only', 'FinOps & Latency', 'FinOps & Governance',
])

function files(source) {
  if (source.file) return existsSync(join(ROOT, source.file)) ? [join(ROOT, source.file)] : []
  const base = join(ROOT, source.dir)
  if (!existsSync(base)) return []
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith('.') || source.skip.includes(entry)) continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (source.ext.some((e) => entry.endsWith(e)) && !/\.test\.tsx?$/.test(entry)) out.push(full)
    }
  }
  walk(base)
  return out
}

const failures = []
let scanned = 0
for (const source of SOURCES) {
  for (const file of files(source)) {
    scanned++
    const rel = relative(ROOT, file)
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      for (const [pattern, why] of RETIRED) {
        const m = line.match(pattern)
        if (m) failures.push(`${rel}:${i + 1}  "${m[0]}" — ${why}`)
      }
      if (rel.endsWith('.md')) {
        for (const m of line.matchAll(/<Badge[^>]*\btext="([^"]*)"/g)) {
          if (!BADGES.has(m[1])) failures.push(`${rel}:${i + 1}  badge "${m[1]}" is not in the vocabulary (guide/plans.md#badges)`)
        }
      }
    })
  }
}

if (failures.length) {
  console.error(`[FAIL] ${failures.length} plan name(s) or badge(s) out of line:\n`)
  for (const f of failures) console.error(`  ${f}`)
  console.error('\nPlans are Free, Self-serve, Biz Org, Enterprise and Self-host (planSkuMap.ts displayName).')
  process.exit(1)
}
console.log(`[PASS] ${scanned} customer-facing file(s): current plan names and badges only.`)
