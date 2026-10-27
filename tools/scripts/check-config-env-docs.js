#!/usr/bin/env node
/**
 * Fail when a shipped component (the proxy, the CLI, the gate SDK, the sync
 * daemon, the MCP proxy and daemon, the clawde SDKs, the AgentCore
 * interceptor, the TrueForge bridge) reads an environment variable the
 * configuration reference does not name, or when the reference documents one
 * for them that nothing reads.
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
 * Every tree scanned here exists in the public checkout as well, except the
 * ones marked `optional`: those are skipped where absent, and so is their
 * section's "must be read" direction. The control plane is not scanned yet.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('../..', import.meta.url).pathname
const REFERENCE = 'apps/docs/reference/configuration.md'

/**
 * `section` is the reference heading whose tables document the source's
 * variables; each name tabled there must be read by some scanned source.
 */
const SOURCES = [
  { dir: 'packages/proxy/src', lang: 'rust', section: /^### Proxy\b/ },
  { dir: 'tools/cli/src', lang: 'ts', section: /^### CLI\b/ },
  // The commands that need a control plane (private); see PLUGIN_ONLY.
  { dir: 'tools/cli-control-plane/src', lang: 'ts', section: /^### CLI\b/, optional: true },
  { dir: 'packages/gate-js/src', lang: 'ts', section: /^### Gate SDK\b/ },
  { dir: 'services/sync-daemon/src', lang: 'ts', section: /^### Sync daemon\b/ },
  { dir: 'packages/mcp-proxy/src', lang: 'ts', section: /^### MCP proxy\b/ },
  { dir: 'packages/clawde-sdk/src', lang: 'ts', section: /^### Clawde SDK\b/ },
  { dir: 'packages/intutic-clawde/intutic_clawde', lang: 'python', section: /^### Clawde SDK\b/ },
  { dir: 'tools/agentcore-interceptor/src', lang: 'ts', section: /^### AgentCore interceptor\b/ },
  { dir: 'services/trueforge-bridge/src', lang: 'ts', section: /^### TrueForge bridge\b/, optional: true },
]

/**
 * Where `env[SOME_ENV]` finds the name SOME_ENV holds, besides the scanned
 * sources themselves: constants shared across packages.
 */
const CONSTANT_SOURCES = ['packages/shared-types/src']

const EXT = { rust: '.rs', ts: '.ts', python: '.py' }

/**
 * Variables only the control-plane plugin (tools/cli-control-plane, which the
 * private checkout has and this one does not) reads. Without the plugin tree
 * nothing reads them, so neither a table row for one nor an INTERNAL entry for
 * one can be checked there; with it, both are checked like any other.
 */
const PLUGIN_ONLY = new Set([
  'INTUTIC_LOOP_BASE_COMMIT', // intutic loop verify
  'SUDO_USER', // intutic enterprise install, through the elevation helper
])

/** Read by a scanned source but deliberately absent from the reference. */
const INTERNAL = new Map([
  ['HOME', 'the operating system: where ~/.intutic lives'],
  ['USERPROFILE', 'the operating system: the Windows home directory'],
  ['APPDATA', 'the operating system: the Windows data directory'],
  ['PATH', 'the operating system: where the CLI finds harness binaries'],
  ['SUDO_USER', 'the operating system: the invoking user under sudo'],
  ['SUDO_UID', "the operating system: the invoking user's uid under sudo"],
  ['KUBERNETES_SERVICE_HOST', 'set by Kubernetes inside a pod'],
  ['KUBERNETES_SERVICE_PORT', 'set by Kubernetes inside a pod'],
  ['CODEX_HOME', "Codex's own variable, honoured where Codex keeps its config"],
  ['OPENCODE_CONFIG_DIR', "OpenCode's own variable, honoured where OpenCode keeps its config"],
  ['XIRP_HOME', "Xirp's own variable, honoured where Xirp keeps its config"],
  ['ANTHROPIC_CUSTOM_HEADERS', "Claude Code's own variable; `intutic exec` appends identity headers to it"],
  ['XDG_CONFIG_HOME', 'the operating system: where Linux harnesses keep their config'],
  ['OPENCODE_CONFIG', "OpenCode's own variable: the config file OpenCode loads, which the daemon wires"],
  ['OPENCODE_CONFIG_CONTENT', "OpenCode's own variable: inline config the daemon reports it cannot govern"],
  ['OPENCLAW_WORKSPACE_DIR', "OpenClaw's own variable, honoured where OpenClaw keeps its workspace"],
  ['DSH_HOME', "dsh's own variable, honoured where dsh keeps its config"],
  ['VITEST', 'set by the test runner; the daemon then leaves ~/.claude alone'],
  ['GITHUB_RUN_ID', "GitHub Actions' own variable: the clawde SDKs report it as the CI pipeline"],
  ['GITHUB_HEAD_REF', "GitHub Actions' own variable: the clawde SDKs' branch on a detached checkout"],
  ['BUILDKITE_BUILD_ID', "Buildkite's own variable: the clawde SDKs report it as the CI pipeline"],
  ['CIRCLE_BUILD_NUM', "CircleCI's own variable: the clawde SDKs report it as the CI pipeline"],
  ['INTUTIC_HOST', 'a key of ~/.intutic/env/runtime.env, which the sync daemon writes and the Open WebUI filter reads; never read from the environment'],
  ['INTUTIC_REMOTE_HEADERS', 'written by the sync daemon into a wrapped remote MCP server entry and read by the MCP proxy it starts; documented with the MCP proxy settings'],
  ['INTUTIC_REVIEW_REQUESTS', 'test-only: points the generated hook gates\' hold records at a scratch file'],
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

/** `NAME = 'VALUE'` string constants in `src` whose value is env-shaped. */
export function envConstantsIn(src) {
  const out = new Map()
  for (const m of src.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*(?::\s*string\s*)?=\s*['"]([A-Z][A-Z0-9_]+)['"]/g)) out.set(m[1], m[2])
  return out
}

/**
 * Names of the environment variables `src` reads. `constants` resolves
 * `env[SOME_ENV]` to the name the constant holds (see envConstantsIn).
 */
export function readsIn(src, lang, constants = new Map()) {
  if (lang === 'python') return pythonReadsIn(src)
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
    // `env[SOME_ENV]` through a constant, here or imported.
    const local = new Map([...constants, ...envConstantsIn(code)])
    for (const m of code.matchAll(/\b(?:process\.)?env\[\s*([A-Z][A-Z0-9_]*)\s*\](?!\s*(?:\?\?|\|\|)?=(?!=))/g)) {
      if (local.has(m[1])) names.add(local.get(m[1]))
    }
    // A helper handed the environment and a name (`required(env, 'TRUEFORGE_BASE_URL')`).
    for (const m of code.matchAll(/\b[a-zA-Z_]\w*\(\s*(?:process\.)?env\s*,\s*['"]([A-Z][A-Z0-9_]+)['"]/g)) names.add(m[1])
  }
  return names
}

/** `os.environ.get("X")`, `os.environ["X"]` (read, not assigned) and `os.getenv("X")`. */
function pythonReadsIn(src) {
  const code = src.replace(/(^|\s)#.*$/gm, '$1')
  const names = new Set()
  for (const m of code.matchAll(/\bos\.(?:environ\.get|getenv)\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g)) names.add(m[1])
  for (const m of code.matchAll(/\bos\.environ\[\s*['"]([A-Z][A-Z0-9_]+)['"]\s*\](?!\s*=(?!=))/g)) names.add(m[1])
  return names
}

function* files(dir, ext) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__' || name === 'tests' || name === '__pycache__') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* files(p, ext)
    else if (name.endsWith(ext) && !/\.test\.tsx?$/.test(name) && !/^test_.*\.py$/.test(name)) yield p
  }
}

/** Every variable named in backticks in `doc`, and those in table rows under `sections`. */
export function documentedIn(doc, sections = SOURCES.map((s) => s.section)) {
  const mentioned = new Set([...doc.matchAll(/`([A-Z][A-Z0-9_]{2,})`/g)].map((m) => m[1]))
  const tabled = new Map()
  let inSection = false
  doc.split('\n').forEach((line, i) => {
    if (/^#{1,3} /.test(line)) inSection = sections.some((re) => re.test(line))
    const row = inSection && line.match(/^\|\s*`([A-Z][A-Z0-9_]{2,})`/)
    if (row) tabled.set(row[1], i + 1)
  })
  return { mentioned, tabled }
}

function main() {
  const present = []
  for (const source of SOURCES) {
    if (existsSync(join(ROOT, source.dir))) present.push(source)
    else if (source.optional) console.log(`[skip] ${source.dir} is not in this tree`)
    else {
      console.error(`[FAIL] ${source.dir} is missing; the gate would pass without looking at it`)
      process.exit(1)
    }
  }

  const constants = new Map()
  for (const dir of [...CONSTANT_SOURCES, ...present.filter((s) => s.lang === 'ts').map((s) => s.dir)]) {
    if (!existsSync(join(ROOT, dir))) continue
    for (const file of files(join(ROOT, dir), '.ts')) {
      for (const [k, v] of envConstantsIn(readFileSync(file, 'utf8'))) constants.set(k, v)
    }
  }

  const reads = new Map()
  let scanned = 0
  for (const { dir, lang } of present) {
    for (const file of files(join(ROOT, dir), EXT[lang])) {
      scanned++
      for (const name of readsIn(readFileSync(file, 'utf8'), lang, constants)) {
        if (!reads.has(name)) reads.set(name, relative(ROOT, file))
      }
    }
  }

  const { mentioned, tabled } = documentedIn(
    readFileSync(join(ROOT, REFERENCE), 'utf8'),
    present.map((s) => s.section),
  )
  const pluginAbsent = !present.some((source) => source.dir === 'tools/cli-control-plane/src')
  const unreadOk = (name) => pluginAbsent && PLUGIN_ONLY.has(name)
  const failures = []
  for (const [name, file] of [...reads].sort()) {
    if (!mentioned.has(name) && !INTERNAL.has(name)) failures.push(`${name} (read in ${file}) is not in ${REFERENCE}`)
  }
  for (const [name, line] of tabled) {
    if (!reads.has(name) && !unreadOk(name)) failures.push(`${REFERENCE}:${line} documents ${name}, which nothing in ${present.map((s) => s.dir).join(', ')} reads`)
  }
  for (const name of INTERNAL.keys()) {
    if (!reads.has(name) && !unreadOk(name)) failures.push(`INTERNAL lists ${name}, which nothing reads any more; remove the entry`)
  }

  if (failures.length) {
    console.error(`[FAIL] ${failures.length} environment variable(s) out of step with the configuration reference:\n`)
    for (const f of failures) console.error(`  ${f}`)
    process.exit(1)
  }
  console.log(`[PASS] ${reads.size} environment variables read across ${scanned} files are documented in ${REFERENCE} or listed as internal.`)
}

if (process.argv[1] === new URL(import.meta.url).pathname) main()
