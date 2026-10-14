#!/usr/bin/env node
/**
 * Prints the Content-Security-Policy source list for the inline scripts in a
 * built docs site: `'sha256-…'` for each distinct one, space-separated.
 *
 * VitePress writes three inline scripts into every page — the dark-mode check,
 * the macOS class toggle, and `window.__VP_HASH_MAP__`, whose content changes
 * with every build. A hash list written by hand would go stale on the next
 * build, so the docs image computes it from the pages it is about to serve and
 * puts it into the CSP (apps/docs/Dockerfile, infra/nginx/docs-security-headers.conf).
 *
 * Fails when the site has none (nothing to allow means the build changed shape)
 * or more than a handful (a per-page inline script is something to move into a
 * file, not to hash page by page).
 *
 * Usage: node scripts/csp-script-hashes.mjs <dist dir>
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const MAX_DISTINCT = 8

const dist = process.argv[2]
if (!dist) {
  console.error('usage: csp-script-hashes.mjs <dist dir>')
  process.exit(2)
}

function htmlFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? htmlFiles(join(dir, e.name)) : e.name.endsWith('.html') ? [join(dir, e.name)] : [],
  )
}

/**
 * The bodies of the inline scripts in one page: every <script> start tag
 * without a src attribute, up to its end tag. A plain scan, not a regex: this
 * reads VitePress's own output, never untrusted markup.
 */
function inlineScripts(html) {
  const out = []
  let at = 0
  for (;;) {
    const open = html.indexOf('<script', at)
    if (open === -1) return out
    const tagEnd = html.indexOf('>', open)
    const close = html.indexOf('</script>', tagEnd)
    if (tagEnd === -1 || close === -1) return out
    if (!html.slice(open, tagEnd).includes(' src=')) out.push(html.slice(tagEnd + 1, close))
    at = close + '</script>'.length
  }
}

const hashes = new Set()
for (const file of htmlFiles(dist)) {
  for (const body of inlineScripts(readFileSync(file, 'utf8'))) {
    if (!body) continue
    hashes.add(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`)
  }
}

if (hashes.size === 0 || hashes.size > MAX_DISTINCT) {
  console.error(`expected 1–${MAX_DISTINCT} distinct inline scripts in ${dist}, found ${hashes.size}`)
  process.exit(1)
}
process.stdout.write([...hashes].sort().join(' '))
