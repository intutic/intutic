#!/usr/bin/env node
// Every manifest a release bumps carries the same version as the CLI
// (tools/cli/package.json): the workspace package.json files, the Python SDK,
// the proxy crate and its two Cargo.lock entries, and the Helm charts'
// version and appVersion where the charts exist. A chart left behind installs
// old images from a checkout (the image tag defaults to appVersion), and five
// releases once shipped with the charts still at 2.2.0.
//
// Runs in both repos: files one checkout does not have are skipped.
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const read = (p) => readFileSync(join(root, p), 'utf8')

// Versioned on their own, not with the product.
const INDEPENDENT = new Set([
  'tools/gate-tests/package.json',
  'services/trueforge-bridge/package.json',
  'tools/agentcore-interceptor/package.json',
])

const want = JSON.parse(read('tools/cli/package.json')).version
const found = []

const manifests = execFileSync('git', ['ls-files', '*package.json'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter((p) => p && /^(packages|apps|services|tools)\/[^/]+\/package\.json$/.test(p) && !INDEPENDENT.has(p))
for (const p of manifests) {
  const v = JSON.parse(read(p)).version
  if (v !== undefined) found.push([p, v])
}

const pyproject = 'packages/intutic-clawde/pyproject.toml'
if (existsSync(join(root, pyproject))) found.push([pyproject, read(pyproject).match(/^version = "([^"]+)"/m)?.[1]])

const crate = 'packages/proxy/Cargo.toml'
if (existsSync(join(root, crate))) found.push([crate, read(crate).match(/^version = "([^"]+)"/m)?.[1]])

for (const lock of ['Cargo.lock', 'packages/proxy/Cargo.lock']) {
  if (!existsSync(join(root, lock))) continue
  found.push([`${lock} (intutic-proxy)`, read(lock).match(/name = "intutic-proxy"\nversion = "([^"]+)"/)?.[1]])
}

const helm = join(root, 'tools/helm')
if (existsSync(helm)) {
  for (const chart of readdirSync(helm)) {
    const p = `tools/helm/${chart}/Chart.yaml`
    if (!existsSync(join(root, p))) continue
    const text = read(p)
    found.push([`${p} version`, text.match(/^version:\s*"?([^"\s]+)"?/m)?.[1]])
    found.push([`${p} appVersion`, text.match(/^appVersion:\s*"?([^"\s]+)"?/m)?.[1]])
  }
}

const wrong = found.filter(([, v]) => v !== want)
if (wrong.length > 0) {
  console.error(`[FAIL] release versions: ${wrong.length} of ${found.length} manifest(s) are not at ${want} (tools/cli/package.json):`)
  for (const [p, v] of wrong) console.error(`  ${p}: ${v ?? '(no version found)'}`)
  console.error('\nA release bumps all of them together.')
  process.exit(1)
}
console.log(`[PASS] release versions: ${found.length} manifest(s) at ${want}.`)
