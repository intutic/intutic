#!/usr/bin/env node
/**
 * Every dashboard link a notification builds must point at a route that exists.
 *
 * All five "View in Dashboard" buttons in the Slack adapter were 404s. They were
 * built from a plausible REST shape — `/incidents/{id}`, `/sops/{id}`,
 * `/decisions/{id}`, `/anomalies/{id}`, `/settings/budget` — and the dashboard
 * has never had a detail route for any of them. Nothing failed, because nothing
 * on either side knows about the other: the router is a TSX file, the links are
 * template literals in a service, and a broken URL is only discovered by a person
 * clicking it and giving up.
 *
 * So this compares the two directly. It reads the registered paths out of the
 * router and every `${APP_URL}/...` template out of the notification adapters,
 * and fails when a link cannot be matched to a route.
 *
 * Query strings are stripped before matching: `/incidents?tab=anomalies` is a
 * link into `/incidents`, and whether that page honours `tab` is the page's
 * business, not this check's.
 *
 * Usage: node tools/scripts/check-dashboard-links.js
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ROUTER = join(repoRoot, 'apps/dashboard/src/main.tsx')
const ADAPTER_DIR = join(repoRoot, 'services/control-plane/src/services/adapters')

/** Registered route paths, e.g. `/incidents`, `/login/magic`. */
function registeredRoutes() {
  const src = readFileSync(ROUTER, 'utf8')
  return new Set([...src.matchAll(/path:\s*'([^']+)'/g)].map((m) => m[1]))
}

/**
 * Does `link` resolve to a registered route?
 *
 * A route with a `$param` segment matches any single segment in that position,
 * so a future `/incidents/$incidentId` would legitimately accept
 * `/incidents/inc_123`.
 */
function matchesRoute(link, routes) {
  if (routes.has(link)) return true
  const parts = link.split('/').filter(Boolean)
  for (const route of routes) {
    const rp = route.split('/').filter(Boolean)
    if (rp.length !== parts.length) continue
    if (rp.every((seg, i) => seg.startsWith('$') || seg === parts[i])) return true
  }
  return false
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (statSync(full).isFile() && full.endsWith('.ts')) out.push(full)
  }
  return out
}

const routes = registeredRoutes()
if (routes.size === 0) {
  console.error('[FAIL] no routes parsed from the dashboard router — this check would pass vacuously.')
  process.exit(1)
}

const broken = []
let checked = 0

for (const file of walk(ADAPTER_DIR)) {
  const src = readFileSync(file, 'utf8')
  src.split('\n').forEach((line, i) => {
    // Literal characters or a whole `${...}` group. A naive `[^`'"]*` stops at
    // the quote inside `${meta.id ?? ''}` and reports a truncated path.
    for (const m of line.matchAll(/\$\{APP_URL\}((?:[^`$\s,)]|\$\{[^}]*\})*)/g)) {
      if (!m[1].startsWith('/')) continue
      // Collapse `${...}` interpolations to `:id` *before* splitting on `?` —
      // otherwise a nullish coalesce inside the interpolation (`${x ?? ''}`) is
      // mistaken for the start of a query string and the path is truncated.
      // An interpolated segment is an id, and an id segment only resolves if the
      // route declares a `$param` in that position.
      const path =
        m[1].replace(/\$\{[^}]*\}/g, ':id').split('?')[0].replace(/\/+$/, '') || '/'

      // API callbacks are served by the control plane, not the dashboard router.
      if (path.startsWith('/api/')) continue

      checked++
      if (!matchesRoute(path, routes)) {
        broken.push({ file: relative(repoRoot, file), line: i + 1, path, raw: m[0] })
      }
    }
  })
}

if (broken.length > 0) {
  console.error(`\n[FAIL] ${broken.length} dashboard link(s) point at routes that do not exist:\n`)
  for (const b of broken) {
    console.error(`  ${b.file}:${b.line}`)
    console.error(`    ${b.raw}`)
    console.error(`    resolves to ${b.path}, which is not a registered route\n`)
  }
  console.error('Registered routes:')
  console.error('  ' + [...routes].sort().join('\n  '))
  console.error(
    '\nEither link to a route that exists, or add the detail route to ' +
      'apps/dashboard/src/main.tsx.\n',
  )
  process.exit(1)
}

console.log(
  `✓ all ${checked} dashboard link(s) in the notification adapters resolve to ` +
    `one of ${routes.size} registered route(s).`,
)
