#!/usr/bin/env node
/**
 * Every docs link in the dashboard must open a page, and a heading, that exist.
 *
 * The dashboard's help links ("Docs" on a settings card, a page's guide link)
 * are literal `https://docs.intutic.ai/…` strings. On 2026-10-06, 14 of its 22
 * answered 404: docs.intutic.ai was built open-source-only and left out the
 * Cloud and Enterprise pages they point at, and three Settings anchors
 * (`#members`, `#routing-proxy`, `#integrations`) named headings that the page
 * had never had. Nothing failed, because the links live in TSX and the pages in
 * Markdown.
 *
 * So this reads every non-test `.ts`/`.tsx` file under apps/dashboard/src,
 * collects each `https://docs.intutic.ai/<path>[#anchor]`, and checks:
 *   - the page: `apps/docs/<path>.md`, or `<path>/index.md` for `/` or a
 *     directory (VitePress clean URLs);
 *   - the anchor, if any: a heading of that page whose slug (VitePress's
 *     slugify of the heading's text, or an explicit `{#id}`) equals it.
 * The pages are checked in the full edition, which every link must resolve in:
 * the Self-host bundle serves it at /docs/ (DOCS_EDITION=full in
 * apps/docs/Dockerfile, with the INTUTIC_REQUIRE_FULL guard in
 * apps/docs/.vitepress/config.ts), and docs.intutic.ai will at launch. Until
 * then docs.intutic.ai carries the open-source pages only, and so does not
 * answer the links to paid-tier pages; the dashboard is not released either.
 *
 * And every page the navigation lists (AREAS in
 * apps/dashboard/src/components/layout/areas.tsx) must carry a help link: its
 * route module (the `import('./routes/…')` main.tsx registers for the path)
 * must contain one, unless NO_HELP_LINK names the page with a reason. Eleven
 * pages shipped with no way to the docs, and two of them had no docs to link.
 *
 * Usage: node tools/scripts/check-dashboard-docs-links.js [repo-root]
 *
 * Mirrored to the public repo, which has no dashboard: there it skips.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const DASHBOARD_SRC = 'apps/dashboard/src'
const AREAS_FILE = 'apps/dashboard/src/components/layout/areas.tsx'
const ROUTER_FILE = 'apps/dashboard/src/main.tsx'
const DOCS = 'apps/docs'
const LINK = /https:\/\/docs\.intutic\.ai(\/[A-Za-z0-9/_.-]*)?(?:#([A-Za-z0-9_-]+))?/g

/**
 * Navigation pages that need no help link of their own, each with the reason.
 * An entry for a page that has a link, or that the navigation no longer
 * lists, fails, so the list cannot outlive its reasons.
 */
export const NO_HELP_LINK = new Map([])

/** The page paths AREAS lists, in order. */
export function areaPaths(areasSrc) {
  const start = areasSrc.indexOf('export const AREAS')
  if (start === -1) return []
  const end = areasSrc.indexOf('\n]\n', start)
  const body = areasSrc.slice(start, end === -1 ? undefined : end)
  return [...body.matchAll(/\{\s*path:\s*'([^']+)'/g)].map((m) => m[1])
}

/** Each route path main.tsx registers, mapped to the `./routes/…` module that renders it. */
export function routeModules(mainSrc) {
  const out = new Map()
  const paths = [...mainSrc.matchAll(/\bpath:\s*'([^']+)'/g)]
  paths.forEach((m, i) => {
    const block = mainSrc.slice(m.index, paths[i + 1]?.index)
    const mod = block.match(/import\(\s*'(\.\/routes\/[^']+)'\s*\)/)
    if (mod) out.set(m[1], mod[1])
  })
  return out
}

/** Navigation pages whose route module has no docs link and no NO_HELP_LINK entry. */
export function helpLinkProblems(root, exempt = NO_HELP_LINK) {
  const areas = join(root, AREAS_FILE)
  const router = join(root, ROUTER_FILE)
  if (!existsSync(areas) || !existsSync(router)) return [`${AREAS_FILE} or ${ROUTER_FILE} is missing; no page was checked for a help link`]
  const pages = areaPaths(readFileSync(areas, 'utf8'))
  if (pages.length === 0) return [`no page paths found in ${AREAS_FILE}'s AREAS; the parsing broke`]
  const modules = routeModules(readFileSync(router, 'utf8'))
  const problems = []
  for (const path of pages) {
    const mod = modules.get(path)
    const file = mod && ['.tsx', '.ts'].map((ext) => join(root, DASHBOARD_SRC, mod.slice(2) + ext)).find(existsSync)
    if (!file) {
      problems.push(`${path}: ${ROUTER_FILE} registers no ./routes/ module for it`)
      continue
    }
    const linked = new RegExp(LINK.source).test(readFileSync(file, 'utf8'))
    if (exempt.has(path)) {
      if (linked) problems.push(`${path}: has a help link now; remove its NO_HELP_LINK entry`)
    } else if (!linked) {
      problems.push(`${path} (${file.slice(root.length + 1)}): no https://docs.intutic.ai/ help link; add one, or a reasoned NO_HELP_LINK entry`)
    }
  }
  for (const path of exempt.keys()) {
    if (!pages.includes(path)) problems.push(`NO_HELP_LINK lists ${path}, which AREAS does not; remove the entry`)
  }
  return problems
}

/** VitePress's default heading slug (@mdit-vue/shared `slugify`). */
export function slugify(text) {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/[\s~`!@#$%^&*()\-_+=[\]{}|\\;:"'“”‘’<>,.?/]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^(\d)/, '_$1')
    .toLowerCase()
}

/**
 * A heading's text without its inline HTML (a `<Badge … />`), which VitePress
 * leaves out of the slug. The result only ever becomes an anchor slug, never
 * markup, so this drops tags rather than sanitising anything.
 */
function withoutTags(text) {
  let out = ''
  let inTag = false
  for (const ch of text) {
    if (ch === '<') inTag = true
    else if (ch === '>' && inTag) inTag = false
    else if (!inTag) out += ch
  }
  return out
}

/** The anchors a Markdown page's headings get: an explicit `{#id}`, else the slug of its text. */
export function headingAnchors(markdown) {
  const anchors = new Set()
  // A repeated heading gets `-1`, `-2`… after its slug, as VitePress numbers them.
  const add = (slug) => {
    let unique = slug
    for (let n = 1; anchors.has(unique); n++) unique = `${slug}-${n}`
    anchors.add(unique)
  }
  let fenced = false
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
    if (fenced) continue
    const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)
    if (!m) continue
    const explicit = /\{#([^}\s]+)\}\s*$/.exec(m[1])
    if (explicit) {
      add(explicit[1])
      continue
    }
    // The rendered text: badges and inline HTML dropped, links and code reduced to their text.
    const text = withoutTags(m[1])
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1')
    add(slugify(text))
  }
  return anchors
}

function sourceFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

export function pageFile(root, path) {
  const clean = (path ?? '/').replace(/\.html$/, '').replace(/\/$/, '/index')
  for (const candidate of [`${clean}.md`, `${clean}/index.md`]) {
    const file = join(root, DOCS, candidate)
    if (existsSync(file)) return file
  }
  return null
}

export function check(root) {
  const src = join(root, DASHBOARD_SRC)
  if (!existsSync(src)) return { skipped: true, links: 0, problems: [] }
  const links = new Map()
  for (const file of sourceFiles(src)) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(LINK)) {
      const key = m[0]
      if (!links.has(key)) links.set(key, { path: m[1], anchor: m[2], where: file.slice(root.length + 1) })
    }
  }
  const problems = []
  for (const [url, { path, anchor, where }] of links) {
    const file = pageFile(root, path)
    if (!file) {
      problems.push(`${url} (${where}): no page at ${DOCS}${path ?? '/'}(.md|/index.md)`)
      continue
    }
    if (anchor && !headingAnchors(readFileSync(file, 'utf8')).has(anchor)) {
      problems.push(`${url} (${where}): ${file.slice(root.length + 1)} has no heading with anchor #${anchor}`)
    }
  }
  return { skipped: false, links: links.size, problems }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '../..'))
  const { skipped, links, problems } = check(root)
  if (!skipped) problems.push(...helpLinkProblems(root))
  if (skipped) {
    console.log(`- no ${DASHBOARD_SRC} here: dashboard docs links skipped`)
  } else if (problems.length) {
    console.error(`✗ ${problems.length} of ${links} dashboard docs link(s) do not resolve:`)
    for (const p of problems) console.error(`  ${p}`)
    process.exit(1)
  } else {
    console.log(
      `✓ all ${links} dashboard docs link(s) open a page${links ? ' (and heading)' : ''} that exists in ${DOCS}, ` +
        'and every navigation page has a help link',
    )
  }
}
