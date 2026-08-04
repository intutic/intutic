#!/usr/bin/env node
/**
 * check-wasm-host-imports.js
 *
 * The proxy registers a set of host functions a WASM rule may import
 * (`packages/proxy/src/wasm/host.rs`). The CLI mirrors that set to validate a
 * rule at `intutic policy install` — the command whose entire job is to refuse
 * a rule that cannot instantiate.
 *
 * The two drifted. The CLI offered `env.seed`, which the proxy has never
 * registered, so any AssemblyScript rule reaching `Math.random()` validated
 * clean, installed, and then failed to link on every request — where the
 * runner's fail-open turned it into a silent allow. An installed rule
 * enforcing nothing, permanently, reported only as a per-request warning.
 *
 * The comment above the CLI's import table asserted the two sets matched. It
 * was false two lines later. That is why this check exists and a comment does
 * not: one place, or they drift.
 *
 * Usage: node tools/scripts/check-wasm-host-imports.js
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const hostRs = join(repoRoot, 'packages', 'proxy', 'src', 'wasm', 'host.rs')
const policyTs = join(repoRoot, 'tools', 'cli', 'src', 'commands', 'policy.ts')

/** Pull a string-array literal out of a source file by declaration name. */
function extractList(file, pattern, label) {
  const src = readFileSync(file, 'utf8')
  const m = src.match(pattern)
  if (!m) {
    console.error(`✖ could not find ${label} in ${file}`)
    console.error('  This check is worthless if it cannot find both lists, so it fails')
    console.error('  rather than reporting a vacuous pass.')
    process.exit(1)
  }
  return [...m[1].matchAll(/"([^"]+)"|'([^']+)'/g)].map((x) => x[1] ?? x[2])
}

const proxy = extractList(
  hostRs,
  /pub const HOST_IMPORTS:\s*&\[&str\]\s*=\s*&\[([\s\S]*?)\]/,
  'HOST_IMPORTS',
)
const cli = extractList(
  policyTs,
  /export const HOST_IMPORT_NAMES\s*=\s*\[([\s\S]*?)\]/,
  'HOST_IMPORT_NAMES',
)

// Also verify the proxy's declaration matches what it actually registers, so
// the const cannot become a comment that lies about its own file.
const hostSrc = readFileSync(hostRs, 'utf8')
const registered = [...hostSrc.matchAll(/linker\.func_wrap\(\s*"env",\s*"([^"]+)"/g)].map((m) => m[1])

const missingFromCli = proxy.filter((n) => !cli.includes(n))
const extraInCli = cli.filter((n) => !proxy.includes(n))
const declaredNotRegistered = proxy.filter((n) => !registered.includes(n))
const registeredNotDeclared = registered.filter((n) => !proxy.includes(n))

let failed = false

if (extraInCli.length > 0) {
  console.error(`✖ the CLI offers host imports the proxy does not register: ${extraInCli.join(', ')}`)
  console.error('  A rule using these passes `intutic policy install` and then fails to link')
  console.error('  in the proxy on every request, where fail-open turns it into a silent allow.')
  failed = true
}
if (missingFromCli.length > 0) {
  console.error(`✖ the proxy registers host imports the CLI does not: ${missingFromCli.join(', ')}`)
  console.error('  Install validation would reject rules the sandbox runs fine.')
  failed = true
}
if (declaredNotRegistered.length > 0) {
  console.error(`✖ HOST_IMPORTS declares ${declaredNotRegistered.join(', ')} but host.rs does not register it`)
  failed = true
}
if (registeredNotDeclared.length > 0) {
  console.error(`✖ host.rs registers ${registeredNotDeclared.join(', ')} but HOST_IMPORTS omits it`)
  failed = true
}

if (failed) {
  console.error(`\n  proxy: ${proxy.join(', ')}\n  cli:   ${cli.join(', ')}`)
  process.exit(1)
}

console.log(`✓ host imports agree across the proxy and the CLI: ${proxy.join(', ')}`)
