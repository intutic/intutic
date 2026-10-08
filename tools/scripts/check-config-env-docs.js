#!/usr/bin/env node
/**
 * Fail when the proxy, the CLI or the gate SDK reads an environment variable
 * the configuration reference does not name, or when the reference documents
 * one for them that nothing reads.
 *
 * Both directions have shipped. The budgets guide told readers to set
 * `INTUTIC_BUDGET_DAILY_USD` and `INTUTIC_BUDGET_MONTHLY_USD`, which no code
 * has ever read, while the proxy's real controls (`CONFIG_PATH`,
 * `INTUTIC_EGRESS_MODE`, `WASM_CONTEXT_SNAPSHOT_RATE` and two dozen more)
 * appeared on no page at all. The script this replaces compared the code
 * against a root `keys.md` that no longer exists, from a hardcoded checkout
 * path, and ran nowhere.
 *
 * - Every variable a scanned source reads must appear in
 *   `apps/docs/reference/configuration.md` as `` `NAME` ``, or in INTERNAL
 *   below with the reason it is not for users.
 * - Every variable in a table row under one of the reference's component
 *   headings (DOCUMENTED_SECTIONS) must be read by a scanned source.
 * - An INTERNAL entry that nothing reads any more fails too, so the list
 *   cannot outlive the code it excuses.
 *
 * Every tree scanned here exists in the public checkout as well.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('../..', import.meta.url).pathname
const REFERENCE = 'apps/docs/reference/configuration.md'

const SOURCES = [
  { dir: 'packages/proxy/src', lang: 'rust' },
  { dir: 'tools/cli/src', lang: 'ts' },
  { dir: 'packages/gate-js/src', lang: 'ts' },
]

/**
 * Headings in the reference whose tables document variables of the scanned
 * components; each documented name must be read by one of them.
 */
const DOCUMENTED_SECTIONS = [/^### Proxy\b/, /^### CLI\b/, /^### Gate SDK\b/]

/** Read by a scanned source but deliberately absent from the reference. */
const INTERNAL = new Map([
  ['HOME', 'the operating system: where ~/.intutic lives'],
  ['USERPROFILE', 'the operating system: the Windows home directory'],
  ['APPDATA', 'the operating system: the Windows data directory'],
  ['PATH', 'the operating system: where the CLI finds harness binaries'],
  ['SUDO_USER', 'the operating system: the invoking user under sudo'],
  ['KUBERNETES_SERVICE_HOST', 'set by Kubernetes inside a pod'],
  ['KUBERNETES_SERVICE_PORT', 'set by Kubernetes inside a pod'],
  ['CODEX_HOME', "Codex's own variable, honoured where Codex keeps its config"],
  ['OPENCODE_CONFIG_DIR', "OpenCode's own variable, honoured where OpenCode keeps its config"],
  ['XIRP_HOME', "Xirp's own variable, honoured where Xirp keeps its config"],
  ['ANTHROPIC_CUSTOM_HEADERS', "Claude Code's own variable; `intutic exec` appends identity headers to it"],
  ['INTUTIC_PROMPT_QUALITY_GATE', 'turns on a prompt check whose control-plane endpoint no longer exists'],
  ['INTUTIC_PROXY_IP', 'read only by the firewall-rule generator, which no command calls'],
])

/** `// …` and `/* … *\/` comments, and Rust test modules: code that is not run. */
function stripComments(src, lang) {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'\\])\/\/.*$/gm, '$1')
  if (lang === 'rust') {
    const tests = out.search(/#\[cfg\(test\)\]\s*mod\b/)
    if (tests !== -1) out = out.slice(0, tests)
  }
  return out
}

/** Names of the environment variables `src` reads. */
export function readsIn(src, lang) {
  const code = stripComments(src, lang)
  const names = new Set()
  if (lang === 'rust') {
    for (const m of code.matchAll(/env::var(?:_os)?\(\s*"([A-Z][A-Z0-9_]+)"\s*\)/g)) names.add(m[1])
    // tracing-subscriber's EnvFilter reads RUST_LOG.
    if (/EnvFilter::(?:try_)?from_default_env/.test(code)) names.add('RUST_LOG')
    // A name kept in a const (`const SOPS_DIR_ENV: &str = "INTUTIC_SOPS_DIR"`).
    for (const m of code.matchAll(/const\s+[A-Z0-9_]*ENV\s*:\s*&str\s*=\s*"([A-Z][A-Z0-9_]+)"/g)) names.add(m[1])
    // Names read through a variable (`["A", "B"].iter().filter_map(|k| env::var(k))`).
    for (const m of code.matchAll(/env::var(?:_os)?\(\s*&?[a-z_]+\s*\)/g)) {
      for (const lit of code.slice(Math.max(0, m.index - 300), m.index).matchAll(/"([A-Z][A-Z0-9]*_[A-Z0-9_]+)"/g)) names.add(lit[1])
    }
    // Names read through a lookup closure handed to a function
    // (`resolve_upstream_base(p, |name| std::env::var(name).ok())`): every
    // env-shaped literal in that function's body.
    for (const m of code.matchAll(/\b([a-z_][a-z0-9_]*)\([^()]*\|\s*[a-z_]+\s*\|\s*(?:std::)?env::var\(/g)) {
      const start = code.search(new RegExp(`\\bfn\\s+${m[1]}\\b`))
      if (start === -1) continue
      const end = code.indexOf('\n}\n', start)
      for (const lit of code.slice(start, end === -1 ? undefined : end).matchAll(/"([A-Z][A-Z0-9]*_[A-Z0-9_]+)"/g)) names.add(lit[1])
    }
  } else {
    // `process.env.X`, `process.env['X']` and an `env` parameter defaulting to
    // it, read rather than assigned. `\b` after the name stops a backtrack to
    // a shorter name when the full one is an assignment.
    for (const m of code.matchAll(/\b(?:process\.)?env(?:\.([A-Z][A-Z0-9_]+)\b|\[\s*['"]([A-Z][A-Z0-9_]+)['"]\s*\])(?!\s*(?:\?\?|\|\|)?=(?!=))/g)) {
      names.add(m[1] ?? m[2])
    }
  }
  return names
}

function* files(dir, ext) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__' || name === 'tests') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* files(p, ext)
    else if (name.endsWith(ext) && !/\.test\.tsx?$/.test(name)) yield p
  }
}

/** Every variable named in backticks in `doc`, and those in table rows under DOCUMENTED_SECTIONS. */
export function documentedIn(doc) {
  const mentioned = new Set([...doc.matchAll(/`([A-Z][A-Z0-9_]{2,})`/g)].map((m) => m[1]))
  const tabled = new Map()
  let inSection = false
  doc.split('\n').forEach((line, i) => {
    if (/^#{1,3} /.test(line)) inSection = DOCUMENTED_SECTIONS.some((re) => re.test(line))
    const row = inSection && line.match(/^\|\s*`([A-Z][A-Z0-9_]{2,})`/)
    if (row) tabled.set(row[1], i + 1)
  })
  return { mentioned, tabled }
}

function main() {
  const reads = new Map()
  let scanned = 0
  for (const { dir, lang } of SOURCES) {
    const abs = join(ROOT, dir)
    if (!existsSync(abs)) {
      console.error(`[FAIL] ${dir} is missing; the gate would pass without looking at it`)
      process.exit(1)
    }
    for (const file of files(abs, lang === 'rust' ? '.rs' : '.ts')) {
      scanned++
      for (const name of readsIn(readFileSync(file, 'utf8'), lang)) {
        if (!reads.has(name)) reads.set(name, relative(ROOT, file))
      }
    }
  }

  const { mentioned, tabled } = documentedIn(readFileSync(join(ROOT, REFERENCE), 'utf8'))
  const failures = []
  for (const [name, file] of [...reads].sort()) {
    if (!mentioned.has(name) && !INTERNAL.has(name)) failures.push(`${name} (read in ${file}) is not in ${REFERENCE}`)
  }
  for (const [name, line] of tabled) {
    if (!reads.has(name)) failures.push(`${REFERENCE}:${line} documents ${name}, which nothing in ${SOURCES.map((s) => s.dir).join(', ')} reads`)
  }
  for (const name of INTERNAL.keys()) {
    if (!reads.has(name)) failures.push(`INTERNAL lists ${name}, which nothing reads any more; remove the entry`)
  }

  if (failures.length) {
    console.error(`[FAIL] ${failures.length} environment variable(s) out of step with the configuration reference:\n`)
    for (const f of failures) console.error(`  ${f}`)
    process.exit(1)
  }
  console.log(`[PASS] ${reads.size} environment variables read across ${scanned} files are documented in ${REFERENCE} or listed as internal.`)
}

if (process.argv[1] === new URL(import.meta.url).pathname) main()
