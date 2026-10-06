#!/usr/bin/env node
/**
 * Every link between docs pages must open a page, and a heading, that exist.
 *
 * The docs build sets `ignoreDeadLinks: true` (an open-source build leaves the
 * paid-tier pages out, so links to them are dead there by design), and
 * VitePress never checks `#anchors` anyway. So on 2026-10-06 the full site had
 * 17 links to headings that had been renamed or removed, and nothing said so.
 *
 * This reads every Markdown page under apps/docs (the source, so the result
 * does not depend on the build mode) and checks each internal link:
 * `[text](/guide/x#y)`, `[text](./x.md#y)`, `[text](#y)`, `<a href="/x">` and
 * `https://docs.intutic.ai/…`. The page must exist (`<path>.md` or
 * `<path>/index.md`) and the anchor must be a heading of it (VitePress's slug,
 * or an explicit `{#id}`), or an `id="…"` in the page's HTML. Links inside
 * fenced code are not links. Files under `public/` are served as they are and
 * are only checked to exist.
 *
 * Usage: node tools/scripts/check-docs-links.js [repo-root]
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, dirname, relative, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { headingAnchors, pageFile } from './check-dashboard-docs-links.js'

const DOCS = 'apps/docs'
const SKIP = new Set(['node_modules', '.vitepress', 'public'])
const MD_LINK = /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g
const HREF = /href="([^"]+)"/g

function pages(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...pages(full))
    else if (entry.endsWith('.md')) out.push(full)
  }
  return out
}

/** The page's text outside fenced code blocks. */
function prose(markdown) {
  let fenced = false
  return markdown
    .split('\n')
    .filter((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced
        return false
      }
      return !fenced
    })
    .join('\n')
    .replace(/`[^`\n]*`/g, '')
}

/** Every anchor a page offers: its headings, and any id="…" in its HTML. */
function anchorsOf(file, cache) {
  if (!cache.has(file)) {
    const text = readFileSync(file, 'utf8')
    const ids = [...text.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1])
    cache.set(file, new Set([...headingAnchors(text), ...ids]))
  }
  return cache.get(file)
}

export function check(root) {
  const docs = join(root, DOCS)
  if (!existsSync(docs)) return { links: 0, problems: [] }
  const cache = new Map()
  const problems = []
  let links = 0
  for (const file of pages(docs)) {
    const here = '/' + relative(docs, file).split('\\').join('/')
    const text = prose(readFileSync(file, 'utf8'))
    const targets = [...text.matchAll(MD_LINK), ...text.matchAll(HREF)].map((m) => m[1])
    for (const raw of targets) {
      let target = raw.replace(/^https:\/\/docs\.intutic\.ai(?=\/|#|$)/, '')
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) continue
      const [pathPart, anchor] = target.split('#')
      let path = pathPart.split('?')[0]
      links++
      if (path === '') path = here
      else if (!path.startsWith('/')) path = posix.join(posix.dirname(here), path)
      if (!existsSync(join(docs, 'public', path))) path = path.replace(/\.md$/, '').replace(/\.html$/, '')
      // A file under public/ is served as it is, whatever its extension (downloads/SKILL.md).
      if (existsSync(join(docs, 'public', pathPart.startsWith('/') ? pathPart : path))) continue
      if (/\.[a-z0-9]+$/i.test(path)) {
        problems.push(`${here}: ${raw} — no file ${DOCS}/public${path}`)
        continue
      }
      const page = pageFile(root, path.replace(/\.md$/, ''))
      if (!page) {
        problems.push(`${here}: ${raw} — no page ${DOCS}${path}(.md|/index.md)`)
        continue
      }
      if (anchor && !anchorsOf(page, cache).has(decodeURIComponent(anchor))) {
        problems.push(`${here}: ${raw} — ${relative(root, page)} has no heading #${anchor}`)
      }
    }
  }
  return { links, problems }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '../..'))
  const { links, problems } = check(root)
  if (problems.length) {
    console.error(`✗ ${problems.length} of ${links} docs link(s) do not resolve:`)
    for (const p of problems) console.error(`  ${p}`)
    process.exit(1)
  }
  console.log(`✓ all ${links} links between docs pages open a page (and heading) that exists`)
}
