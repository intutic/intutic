#!/usr/bin/env node
/**
 * Every path a published npm package's package.json points a consumer at
 * must be in the tarball `npm pack` builds for it: `main`, `types`/`typings`,
 * every `bin`, every `exports` target and every `typesVersions` target.
 *
 * `@intutic/gate` shipped `typesVersions` pointing at `src/*.ts` while its
 * `files` packs only `dist/`, so a consumer resolving with
 * `moduleResolution: node` got no types for any subpath. Nothing noticed,
 * because inside this workspace `src/` is always there.
 *
 * Published packages: packages/* without `"private": true`, plus tools/cli and
 * services/sync-daemon. The tarball listing is npm's own (`npm pack
 * --dry-run --json`), so build first (`pnpm turbo build`): an unbuilt `dist/`
 * is reported as missing, with a hint.
 *
 * Usage: node tools/scripts/check-package-entrypoints.js
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function publishedPackageDirs() {
  const dirs = fs
    .readdirSync(path.join(ROOT, 'packages'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join('packages', d.name))
  dirs.push('tools/cli', 'services/sync-daemon')
  return dirs.filter((dir) => {
    const manifest = path.join(ROOT, dir, 'package.json')
    return fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, 'utf8')).private !== true
  })
}

/** Every path string the manifest hands a consumer, with the field that names it. */
function referencedPaths(pkg) {
  const refs = []
  const add = (field, value) => {
    if (typeof value === 'string') refs.push({ field, target: value })
  }
  add('main', pkg.main)
  add('types', pkg.types)
  add('typings', pkg.typings)
  if (typeof pkg.bin === 'string') add('bin', pkg.bin)
  else for (const [name, target] of Object.entries(pkg.bin ?? {})) add(`bin.${name}`, target)

  const walk = (field, node) => {
    if (typeof node === 'string') add(field, node)
    else if (Array.isArray(node)) node.forEach((n, i) => walk(`${field}[${i}]`, n))
    else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walk(`${field}["${k}"]`, v)
  }
  walk('exports', pkg.exports)
  for (const [range, map] of Object.entries(pkg.typesVersions ?? {})) {
    for (const [subpath, targets] of Object.entries(map ?? {})) walk(`typesVersions["${range}"]["${subpath}"]`, targets)
  }
  return refs
}

function normalise(p) {
  return p.replace(/^\.\//, '')
}

/** A path, or a pattern with `*` (exports/typesVersions wildcards), against the tarball listing. */
function inTarball(target, files) {
  const t = normalise(target)
  if (!t.includes('*')) return files.has(t)
  const re = new RegExp('^' + t.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.+') + '$')
  return [...files].some((f) => re.test(f))
}

function tarballFiles(dir) {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: path.join(ROOT, dir),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const [report] = JSON.parse(out)
  return new Set(report.files.map((f) => f.path))
}

const failures = []
let checked = 0
const dirs = publishedPackageDirs()
for (const dir of dirs) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, dir, 'package.json'), 'utf8'))
  const files = tarballFiles(dir)
  for (const { field, target } of referencedPaths(pkg)) {
    checked++
    if (inTarball(target, files)) continue
    const onDisk = !target.includes('*') && fs.existsSync(path.join(ROOT, dir, target))
    failures.push(
      `${dir}/package.json ${field} -> ${target}: not in the npm tarball` +
        (onDisk ? ' (it exists on disk, so `files` does not ship it)' : ' (not on disk either: build first, or the path is wrong)'),
    )
  }
}

if (failures.length > 0) {
  console.error(`check-package-entrypoints: ${failures.length} of ${checked} referenced paths are not packed:`)
  for (const f of failures) console.error(`  ${f}`)
  process.exit(1)
}
console.log(`check-package-entrypoints: ${checked} referenced paths across ${dirs.length} published packages are all in their tarballs`)
