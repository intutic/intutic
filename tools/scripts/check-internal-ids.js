#!/usr/bin/env node
/**
 * The open-core repo carries no internal tracker ids, and its published docs
 * no links into the internal docs/ tree.
 *
 * On 2026-10-08 docs.intutic.ai carried 64 tech-debt ids, a design-doc
 * reference and links to the tech-debt tracker under docs/ — a file the public
 * repo does not have, so every one of those links was a 404 and every id
 * pointed a reader at a record they cannot open. Two days later the same
 * sweep over the mirrored source found 925 such lines in 329 files: comments
 * that said "see <id>" where they should have said why.
 *
 * Every scanned file fails on:
 *
 * - a tech-debt id (TD-<n>) or a design-doc reference (LLD <n>, LLD-<n>,
 *   LLD #<n>);
 * - any mention of the tech-debt tracker's file name;
 * - a GitHub link into the repo's top-level docs/ directory.
 *
 * Markdown files also fail on a relative link that resolves into <root>/docs/.
 *
 * What is scanned: packages/, tools/, services/sync-daemon/, apps/docs/, the
 * root README, and in the public checkout also .github/ and every other
 * root-level file (the build and lint config).
 *
 * In the public checkout every file under those roots is public, so all of
 * them are scanned. The enterprise checkout (it has services/control-plane/)
 * keeps files under the same roots that never leave it — enterprise-only
 * packages, deploy scripts — and its own root config and workflows. There a
 * file is scanned only if the public checkout has the same path: pass it with
 * --public <dir>, or keep it as the sibling ../intutic. Without one, the
 * trees synced wholesale (WHOLESALE below) are scanned and the rest is
 * reported as not checked. Root config and .github are never scanned there:
 * each repo has its own copy, and the public run checks the public one.
 *
 * Skipped: dependency, build and cache directories, lockfiles, vitest
 * snapshots, *.generated.* files and binaries.
 *
 * State the limitation itself instead of pointing at the record of it.
 *
 * Usage: node tools/scripts/check-internal-ids.js [repo-root] [--public <public-checkout>]
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join, relative, resolve, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
let publicArg
const positional = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--public') publicArg = argv[++i]
  else positional.push(argv[i])
}

const ROOT = resolve(positional[0] ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..'))
const INTERNAL_DOCS = join(ROOT, 'docs') + sep
const ENTERPRISE = existsSync(join(ROOT, 'services', 'control-plane'))

/** Scanned in both checkouts. */
const SHARED_ROOTS = ['packages', 'tools', 'services/sync-daemon', 'apps/docs', 'README.md']

/**
 * Trees tools/scripts/sync-to-public.sh copies whole (plus those whose file
 * lists match file for file), so every file in them is public. The enterprise
 * run falls back to these when it has no public checkout to compare against.
 */
const WHOLESALE = [
  'packages/anomaly-taxonomy', 'packages/clawde-sdk', 'packages/gate-js', 'packages/id',
  'packages/intutic-clawde', 'packages/logger', 'packages/mcp-proxy', 'packages/proxy',
  'packages/shared-types', 'packages/terraform-provider-intutic', 'packages/theme',
  'packages/vscode-extension', 'packages/wasm-sdk', 'services/sync-daemon', 'tools/cli',
  'tools/gate-tests', 'tools/agentcore-interceptor', 'tools/git-hooks', 'apps/docs', 'README.md',
]

const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'target', '.turbo', '.git', '.venv', 'venv', '__pycache__',
  '.pytest_cache', '.mypy_cache', '.ruff_cache', 'coverage', 'cache', 'cache_temp',
])
const LOCKFILES = new Set([
  'pnpm-lock.yaml', 'Cargo.lock', 'package-lock.json', 'yarn.lock', 'poetry.lock', 'uv.lock', 'go.sum',
])
const SKIP_FILE = /\.snap$|\.generated\.|\.tsbuildinfo$|\.log$|^\.DS_Store$/

const PATTERNS = [
  ['id', /\bTD-\d+\b/, 'an internal tech-debt id'],
  ['id', /\bLLD(?:\s*#\s*|[- ])\d+/, 'an internal design-doc reference'],
  ['tracker', /TECH_DEBT\.md/, 'the internal tech-debt tracker'],
  ['link', /github\.com\/intutic\/[\w.-]+\/(?:blob|tree)\/[^/\s)]+\/docs\//, 'a link into the internal docs/ tree'],
]

/**
 * Pattern kinds a file may carry, and why. Keep this short: each entry is a
 * place the gate does not look.
 */
const ALLOWED = new Map([
  // Validates the tracker itself. Its file name is the script's input; the
  // script skips when the file is absent, as it is in the public repo.
  ['tools/scripts/check-tech-debt-status.js', ['tracker']],
])

function walk(rel, out) {
  const full = join(ROOT, rel)
  if (!existsSync(full)) return out
  if (!statSync(full).isDirectory()) {
    out.push(rel)
    return out
  }
  for (const entry of readdirSync(full)) {
    if (SKIP_DIRS.has(entry)) continue
    walk(rel ? join(rel, entry) : entry, out)
  }
  return out
}

function publicTwin() {
  if (!ENTERPRISE) return null
  const twin = resolve(publicArg ?? join(ROOT, '..', 'intutic'))
  if (!existsSync(twin)) {
    if (publicArg) {
      console.error(`[FAIL] --public ${publicArg}: no such directory`)
      process.exit(2)
    }
    return null
  }
  return realpathSync(twin) === realpathSync(ROOT) ? null : twin
}

const twin = publicTwin()
let candidates = []
let scope
if (!ENTERPRISE) {
  const rootFiles = readdirSync(ROOT).filter((e) => !SKIP_DIRS.has(e) && statSync(join(ROOT, e)).isFile())
  for (const r of [...SHARED_ROOTS, '.github', ...rootFiles]) walk(r, candidates)
  scope = 'the public tree'
} else if (twin) {
  for (const r of SHARED_ROOTS) walk(r, candidates)
  candidates = candidates.filter((rel) => existsSync(join(twin, rel)))
  scope = `files the public checkout at ${relative(process.cwd(), twin) || '.'} also has`
} else {
  for (const r of WHOLESALE) walk(r, candidates)
  scope = 'the wholesale-mirrored trees only (no public checkout: pass --public <dir> to cover tools/scripts and the other shared files too)'
}
candidates = [...new Set(candidates)].filter((rel) => {
  const name = rel.split(sep).pop()
  return !LOCKFILES.has(name) && !SKIP_FILE.test(name)
})

/** Relative markdown link targets on a line that resolve into <root>/docs/. */
function internalDocsLinks(file, line) {
  const hits = []
  for (const m of line.matchAll(/\]\(([^)\s#]+)[^)]*\)/g)) {
    const target = m[1]
    if (/^[a-z][\w+.-]*:/i.test(target) || target.startsWith('/')) continue
    if ((resolve(dirname(file), target) + sep).startsWith(INTERNAL_DOCS)) hits.push(target)
  }
  return hits
}

const failures = []
let scanned = 0
for (const rel of candidates) {
  const file = join(ROOT, rel)
  const buf = readFileSync(file)
  if (buf.subarray(0, 8000).includes(0)) continue // binary
  scanned++
  const allowed = ALLOWED.get(rel.split(sep).join('/')) ?? []
  const markdown = rel.endsWith('.md')
  buf.toString('utf8').split('\n').forEach((line, i) => {
    for (const [kind, pattern, why] of PATTERNS) {
      if (allowed.includes(kind)) continue
      const m = line.match(pattern)
      if (m) failures.push(`${rel}:${i + 1}  "${m[0]}" — ${why}`)
    }
    if (!markdown) return
    for (const target of internalDocsLinks(file, line)) {
      failures.push(`${rel}:${i + 1}  "${target}" — a link into the internal docs/ tree`)
    }
  })
}

if (failures.length) {
  console.error(`[FAIL] ${failures.length} internal reference(s) in files the public repo publishes:\n`)
  for (const f of failures) console.error(`  ${f}`)
  console.error('\nReaders cannot open these. State the limitation, reason or status itself instead.')
  process.exit(1)
}
if (scanned === 0) {
  console.error(`[FAIL] scanned 0 files in ${ROOT} — a pass here would check nothing.`)
  process.exit(1)
}
console.log(`[PASS] ${scanned} file(s) in ${scope}: no internal ids or internal docs/ links.`)
