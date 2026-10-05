#!/usr/bin/env node
/**
 * Every dashboard link the backend emits must point at a route that exists.
 *
 * All five "View in Dashboard" buttons in the Slack adapter were 404s. They were
 * built from a plausible REST shape — `/incidents/{id}`, `/sops/{id}`,
 * `/decisions/{id}`, `/anomalies/{id}`, `/settings/budget` — and the dashboard
 * has never had a detail route for any of them. Nothing failed, because nothing
 * on either side knows about the other: the router is a TSX file, the links are
 * template literals in a service, and a broken URL is only discovered by a person
 * clicking it and giving up.
 *
 * The first version of this check only read `${APP_URL}/…` templates in the
 * Slack adapters and `url: \`/…\`` notification metadata, so it missed six
 * more 404s elsewhere: in-app `action_url`s (`/incidents/${id}`, `/sops/${id}`),
 * Stripe `success_url`/`cancel_url`s (`/settings/org`, `/marketplace`), and
 * onboarding-email links built on `getAppUrl()` (`/pricing`,
 * `/guide/getting-started`).
 *
 * So it now parses every non-test `.ts` file under `services/control-plane/src`
 * (routes, services, adapters, crons) with the TypeScript parser and collects:
 *
 *   - app-url links: a string or template literal where a `/path` follows an
 *     app-URL expression — `APP_URL`, `appUrl`, `getAppUrl()`,
 *     `process.env.APP_URL`, or any local bound from one of those (e.g.
 *     `const base = getAppUrl().replace(…)`) — including mid-template, as in
 *     an email's `href="${appUrl}/…"`, and `APP_URL + '/…'`;
 *   - relative links: a `/path` string or template (single-, double-quoted or
 *     backticked, through `?:`, `??` and `||`) assigned to a property named
 *     `url`, `*Url`, `*_url`, `*URL`, `href` or `link`.
 *
 * Paths are matched against the `path: '…'` routes in the dashboard router.
 * A `${…}` segment becomes `:id`, which only a `$param` route segment accepts
 * (`/findings/incidents/${id}` matches `/findings/incidents/$incidentId`). Query strings are
 * stripped first: whether a page honours `?tab=` is the page's business.
 * `/api/…` links are served by the control plane and skipped.
 *
 * Resolving is not enough once pages move. The dashboard keeps every old path
 * alive as a redirect (`LEGACY_REDIRECTS` in apps/dashboard/src/routes/
 * legacyRedirects.ts) because sent emails, Slack messages and Stripe sessions
 * carry them — but a link the backend emits *today* must name the canonical
 * page, not lean on a redirect. So every link is also checked against the
 * `from: '…'` paths of that file (`$param` segments match any one segment) and
 * a match fails with the redirect's target. The file is a list of old paths,
 * never a source of links, and its paths are not routes. When it is absent
 * (before the redirects exist), this half has nothing to check.
 *
 * Usage: node tools/scripts/check-dashboard-links.js [repo-root]
 *
 * Mirrored to the public repo, which has no dashboard or control plane: there
 * it skips.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROUTER = 'apps/dashboard/src/main.tsx'
const LEGACY_REDIRECTS = 'apps/dashboard/src/routes/legacyRedirects.ts'
const CONTROL_PLANE_SRC = 'services/control-plane/src'

const URL_KEY = /^(url|href|link)$|(Url|_url|URL)$/
const APP_URL_NAMES = ['APP_URL', 'appUrl']
// Rendered in place of an app-URL interpolation, so a `/path` after it is found
// by a plain regex wherever it sits in the template.
const APP = '\u0000APP\u0000'
const APP_LINK = new RegExp(`${APP}(\\/(?:[^\\s"'<>\`,)\\\\]|\\$\\{[^}]*\\})*)`, 'g')

/** Registered route paths, e.g. `/findings/incidents`, `/login/magic`, `/policies/guidelines/$sopId`. */
export function registeredRoutes(routerSource) {
  return new Set([...routerSource.matchAll(/path:\s*'([^']+)'/g)].map((m) => m[1]))
}

/**
 * The old paths in legacyRedirects.ts, `from` → `to` (`to` may be null when an
 * entry computes it). Only `from:` and `to:` string literals are read.
 */
export function legacyRedirects(source) {
  const legacy = new Map()
  const froms = [...source.matchAll(/\bfrom:\s*(['"`])([^'"`]+)\1/g)]
  froms.forEach((m, i) => {
    const rest = source.slice(m.index + m[0].length, froms[i + 1]?.index ?? source.length)
    const to = rest.match(/\bto:\s*(['"`])([^'"`]+)\1/)
    legacy.set(linkPath(m[2]), to ? to[2] : null)
  })
  return legacy
}

/**
 * Collapse `${...}` interpolations to `:id` *before* splitting on `?` —
 * otherwise a nullish coalesce inside the interpolation (`${x ?? ''}`) is
 * mistaken for the start of a query string and the path is truncated.
 */
export function linkPath(raw) {
  return raw.replace(/\$\{[^}]*\}/g, ':id').split(/[?#]/)[0].replace(/\/+$/, '') || '/'
}

/**
 * Does `path` resolve to a registered route? A `$param` route segment matches
 * any single segment in that position, including an interpolated `:id`.
 */
export function matchesRoute(path, routes) {
  if (routes.has(path)) return true
  const parts = path.split('/').filter(Boolean)
  for (const route of routes) {
    const rp = route.split('/').filter(Boolean)
    if (rp.length !== parts.length) continue
    if (rp.every((seg, i) => seg.startsWith('$') || seg === parts[i])) return true
  }
  return false
}

/**
 * Every dashboard link in one TS source: [{ line, kind, raw }], where `raw` is
 * the `/path…` with interpolations written as `${…}`.
 */
export function extractLinks(ts, source, fileName) {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const appNames = new Set(APP_URL_NAMES)
  const links = []
  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1

  const isAppUrl = (e) => {
    if (!e) return false
    if (ts.isParenthesizedExpression(e)) return isAppUrl(e.expression)
    if (ts.isIdentifier(e)) return appNames.has(e.text)
    if (ts.isPropertyAccessExpression(e)) {
      return e.getText(sf) === 'process.env.APP_URL'
    }
    if (ts.isCallExpression(e)) {
      if (ts.isIdentifier(e.expression)) return e.expression.text === 'getAppUrl'
      // getAppUrl().replace(/\/$/, ''), APP_URL.trim(), …
      if (ts.isPropertyAccessExpression(e.expression)) return isAppUrl(e.expression.expression)
    }
    if (ts.isBinaryExpression(e) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(e.operatorToken.kind)) {
      return isAppUrl(e.left)
    }
    return false
  }

  // Locals bound from an app-URL expression: `const base = getAppUrl().replace(…)`.
  const bind = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && isAppUrl(node.initializer)) {
      appNames.add(node.name.text)
    }
    ts.forEachChild(node, bind)
  }
  bind(sf)

  /**
   * A template or string rendered to text, app-URL interpolations as APP.
   * `appLines[k]` is the source line just after the k-th APP, where its path
   * starts (a multi-line email template's link is not on the template's first line).
   */
  const renderWithLines = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { text: node.text, appLines: [] }
    if (ts.isTemplateExpression(node)) {
      let text = node.head.text
      const appLines = []
      for (const span of node.templateSpans) {
        if (isAppUrl(span.expression)) {
          text += APP
          appLines.push(lineOf(span.literal))
        } else {
          text += '${…}'
        }
        text += span.literal.text
      }
      return { text, appLines }
    }
    return null
  }
  const render = (node) => renderWithLines(node)?.text ?? null

  /** Relative-link candidates in a url-ish property's initializer. */
  const relativeCandidates = (e) => {
    if (!e) return []
    if (ts.isParenthesizedExpression(e)) return relativeCandidates(e.expression)
    if (ts.isConditionalExpression(e)) return [...relativeCandidates(e.whenTrue), ...relativeCandidates(e.whenFalse)]
    if (ts.isBinaryExpression(e) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(e.operatorToken.kind)) {
      return [...relativeCandidates(e.left), ...relativeCandidates(e.right)]
    }
    const text = render(e)
    return text != null && text.startsWith('/') && !text.startsWith('//') ? [{ node: e, text }] : []
  }

  const visit = (node) => {
    const rendered = renderWithLines(node)
    if (rendered && rendered.appLines.length > 0) {
      for (const m of rendered.text.matchAll(APP_LINK)) {
        const k = rendered.text.slice(0, m.index).split(APP).length - 1
        links.push({ line: rendered.appLines[k], kind: 'app-url', raw: m[1] })
      }
    }
    if (
      ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      isAppUrl(node.left) && (ts.isStringLiteral(node.right) || ts.isNoSubstitutionTemplateLiteral(node.right)) &&
      node.right.text.startsWith('/')
    ) {
      links.push({ line: lineOf(node), kind: 'app-url', raw: node.right.text })
    }
    if (ts.isPropertyAssignment(node)) {
      const key = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : null
      if (key && URL_KEY.test(key)) {
        for (const c of relativeCandidates(node.initializer)) {
          links.push({ line: lineOf(c.node), kind: 'relative', raw: c.text })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return links
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== 'node_modules') walk(full, out)
    } else if (
      entry.isFile() && full.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(full) && !full.endsWith('.d.ts') &&
      !full.endsWith(LEGACY_REDIRECTS)
    ) {
      out.push(full)
    }
  }
  return out
}

export async function main(argv) {
  const root = resolve(argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..', '..'))
  if (!existsSync(join(root, ROUTER)) || !existsSync(join(root, CONTROL_PLANE_SRC))) {
    console.log(`${ROUTER} or ${CONTROL_PLANE_SRC} does not exist. Skipping dashboard link check (dashboard and control plane are private).`)
    return 0
  }
  const { default: ts } = await import('typescript')

  const routes = registeredRoutes(readFileSync(join(root, ROUTER), 'utf8'))
  if (routes.size === 0) {
    console.error('[FAIL] no routes parsed from the dashboard router — this check would pass vacuously.')
    return 1
  }

  const legacyFile = join(root, LEGACY_REDIRECTS)
  const legacy = existsSync(legacyFile) ? legacyRedirects(readFileSync(legacyFile, 'utf8')) : null
  if (legacy && legacy.size === 0) {
    console.error(`[FAIL] no \`from:\` paths parsed from ${LEGACY_REDIRECTS} — the legacy-path half would pass vacuously.`)
    return 1
  }
  const legacyPaths = new Set(legacy?.keys() ?? [])

  const counts = { 'app-url': 0, relative: 0 }
  const broken = []
  const stale = []
  for (const file of walk(join(root, CONTROL_PLANE_SRC))) {
    for (const link of extractLinks(ts, readFileSync(file, 'utf8'), file)) {
      const path = linkPath(link.raw)
      if (path === '/api' || path.startsWith('/api/')) continue
      counts[link.kind]++
      const old = [...legacyPaths].find((from) => matchesRoute(path, new Set([from])))
      if (old) stale.push({ file: relative(root, file), ...link, path, from: old, to: legacy.get(old) })
      else if (!matchesRoute(path, routes)) broken.push({ file: relative(root, file), ...link, path })
    }
  }
  for (const [kind, n] of Object.entries(counts)) {
    if (n === 0) {
      console.error(`[FAIL] no ${kind} dashboard links found under ${CONTROL_PLANE_SRC} — the Slack adapter and notification router both emit them, so the extractor is broken and this half would pass vacuously.`)
      return 1
    }
  }

  if (stale.length > 0) {
    console.error(`\n[FAIL] ${stale.length} dashboard link(s) use a legacy path that only survives as a redirect:\n`)
    for (const b of stale) {
      console.error(`  ${b.file}:${b.line}  (${b.kind})`)
      console.error(`    ${b.raw}`)
      console.error(`    ${b.path} matches the legacy path ${b.from}${b.to ? `, which redirects to ${b.to}` : ''}\n`)
    }
    console.error(`Link to the canonical page instead; ${LEGACY_REDIRECTS} is for URLs already sent.\n`)
  }

  if (broken.length > 0) {
    const missing = new Map()
    for (const b of broken) missing.set(b.path, (missing.get(b.path) ?? 0) + 1)
    console.error(`\n[FAIL] ${broken.length} dashboard link(s) point at routes that do not exist:\n`)
    for (const b of broken) {
      console.error(`  ${b.file}:${b.line}  (${b.kind})`)
      console.error(`    ${b.raw}`)
      console.error(`    resolves to ${b.path}, which is not a registered route\n`)
    }
    console.error('Missing routes:')
    for (const [path, n] of [...missing].sort()) console.error(`  ${path}  (${n} link${n === 1 ? '' : 's'})`)
    console.error('\nRegistered routes:')
    console.error('  ' + [...routes].sort().join('\n  '))
    console.error(`\nEither link to a route that exists, or add the route to ${ROUTER}.\n`)
  }
  if (stale.length > 0 || broken.length > 0) return 1

  console.log(
    `✓ all ${counts['app-url'] + counts.relative} dashboard link(s) under ${CONTROL_PLANE_SRC} ` +
      `(${counts['app-url']} app-URL, ${counts.relative} relative) resolve to one of ${routes.size} registered route(s)` +
      (legacy ? ` and none uses one of ${legacy.size} legacy path(s).` : ` (no ${LEGACY_REDIRECTS}, so no legacy-path check).`),
  )
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv)
}
