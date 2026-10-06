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
 * Every page is published: docs.intutic.ai builds the full site (see
 * apps/docs/Dockerfile and the INTUTIC_REQUIRE_FULL guard in
 * apps/docs/.vitepress/config.ts).
 *
 * Usage: node tools/scripts/check-dashboard-docs-links.js [repo-root]
 *
 * Mirrored to the public repo, which has no dashboard: there it skips.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const DASHBOARD_SRC = 'apps/dashboard/src'
const DOCS = 'apps/docs'
const LINK = /https:\/\/docs\.intutic\.ai(\/[A-Za-z0-9/_.-]*)?(?:#([A-Za-z0-9_-]+))?/g

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
    const text = m[1]
      .replace(/<[^>]+>/g, '')
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
  if (skipped) {
    console.log(`- no ${DASHBOARD_SRC} here: dashboard docs links skipped`)
  } else if (problems.length) {
    console.error(`✗ ${problems.length} of ${links} dashboard docs link(s) do not resolve:`)
    for (const p of problems) console.error(`  ${p}`)
    process.exit(1)
  } else {
    console.log(`✓ all ${links} dashboard docs link(s) open a page${links ? ' (and heading)' : ''} that exists in ${DOCS}`)
  }
}
