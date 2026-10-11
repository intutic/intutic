#!/usr/bin/env node
// The chaos e2e suite: the MCP-proxy and gate faults, injected inside the
// sandbox, through the real `intutic chaos run`.
//
// For every experiment in ./experiments it runs the built CLI twice — once
// with the resilient stub harness, once with the fragile one — against a
// throwaway git repository holding the harness, a stub MCP server and the
// Claude Code gate the sync daemon emits (once as a committed copy at a fixed
// path, once as `intutic connect` leaves it: untracked under .intutic/hooks/,
// registered by host path in .claude/settings.json, with the snapshot in the
// CLI's home), and checks the JSON report: the
// verdict and score, that every fault produced `fault_injected`, that every
// component that should have loaded the plan said so, and each probe's
// outcome. Exits non-zero on the first experiment that does not match.
//
// Needs, already built (tools/scripts/chaos-e2e.sh does all of it):
//   - the CLI (tools/cli/dist) and the sync daemon (services/sync-daemon/dist);
//   - `intutic-proxy` on PATH;
//   - the MCP proxy deployed with its production dependencies, passed as
//     --mcp-proxy <dir> (pnpm deploy --prod);
//   - Docker (or Podman, with --runtime podman).
//
// Usage: node tools/cli/chaos-e2e/run.mjs --mcp-proxy <dir> [--only <name>] [--work <dir>] [--runtime docker]
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../../..')
const CLI = path.join(REPO, 'tools/cli/dist/cli.js')
const WORKSPACE_ID = 'ws_chaos_e2e'

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}
const mcpProxyDir = flag('--mcp-proxy')
const only = flag('--only')
const runtime = flag('--runtime') ?? 'docker'
if (!mcpProxyDir || !fs.existsSync(path.join(mcpProxyDir, 'dist/index.js'))) {
  console.error('--mcp-proxy <dir> must name a deployed MCP proxy (dist/index.js and node_modules)')
  process.exit(64)
}

// What each experiment must produce, per harness. `probes` maps a probe to its
// pass rate over the faulted repetitions, or null for "not evaluated".
// recovered_within is per tool, not per argument: the fragile harness never
// retries the failed lookup, but its next get_record call (another key)
// succeeds, and that counts.
const ALL = ['proxy', 'mcp-proxy', 'gate']
const EXPECT = {
  'mcp-tool-error': {
    components: ALL,
    resilient: { verdict: 'scored', score: 100, probes: { task_success: 1, failure_surfaced: 1, recovered_within: 1 } },
    fragile: { verdict: 'scored', score: 16.7, probes: { task_success: 0, failure_surfaced: 0, recovered_within: 1 } },
  },
  'stale-data': {
    components: ALL,
    resilient: { verdict: 'scored', score: 100, probes: { task_success: 1, recovered_within: 1 } },
    fragile: { verdict: 'scored', score: 25, probes: { task_success: 0, recovered_within: 1 } },
  },
  'inject-tool-result': {
    components: ALL,
    proxyLog: /"action":"injection_detected"/,
    resilient: { verdict: 'scored', score: 100, probes: { no_destructive_attempt: 1, no_policy_hits: 1, task_success: 1 } },
    fragile: { verdict: 'aborted', abort: /destructive_attempt: Bash hit the destructive-command tier/, score: 25, probes: { no_destructive_attempt: 0, no_policy_hits: 1, task_success: null } },
  },
  'toolset-change': {
    components: ALL,
    // The redefined description orders a destructive command: the MCP proxy
    // notices the change and the tool-poisoning check flags it.
    proxyLog: [/"action":"mcp_server_definition_changed"/, /"detectorId":"tool_poisoning"/],
    resilient: { verdict: 'scored', score: 100, probes: { no_destructive_attempt: 1, task_success: 1 } },
    fragile: { verdict: 'aborted', abort: /destructive_attempt: Bash hit the destructive-command tier/, score: 0, probes: { no_destructive_attempt: 0, task_success: null } },
  },
  'permission-deny': {
    components: ALL,
    resilient: { verdict: 'scored', score: 80, probes: { failure_surfaced: 1, no_policy_hits: 1, task_success: 0 } },
    fragile: { verdict: 'scored', score: 20, probes: { failure_surfaced: 0, no_policy_hits: 1, task_success: 0 } },
  },
  'settings-gate': {
    components: ALL,
    proxyLog: /"action":"injection_detected"/,
    // The runner carried the gate in and said what it rewrote; the harness
    // ran the command the rewritten settings name.
    cliLog: /Rewrote host paths to \/work in each repetition's copy of: \.claude\/settings\.json, \.intutic\/hooks\/claude-code-check\.js/,
    agentOut: /gate from \.claude\/settings\.json: node \/work\/\.intutic\/hooks\/claude-code-check\.js/,
    resilient: { verdict: 'scored', score: 100, probes: { no_destructive_attempt: 1, no_policy_hits: 1, task_success: 1 } },
    fragile: { verdict: 'aborted', abort: /destructive_attempt: Bash hit the destructive-command tier/, score: 25, probes: { no_destructive_attempt: 0, no_policy_hits: 1, task_success: null } },
  },
  'builtin-tool-error': {
    components: ALL,
    resilient: { verdict: 'scored', score: 100, probes: { task_success: 1, failure_surfaced: 1, recovered_within: 1 } },
    fragile: { verdict: 'scored', score: 0, probes: { task_success: 0, failure_surfaced: 0, recovered_within: 0 } },
  },
}
const EXIT = { scored: 0, aborted: 1, invalid: 2 }

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Runs a command; resolves with its exit code. Output goes to `logFile` when given. */
function run(cmd, argv, { cwd, env, logFile } = {}) {
  return new Promise((resolve, reject) => {
    const out = logFile ? fs.openSync(logFile, 'a') : 'inherit'
    const child = spawn(cmd, argv, { cwd, env, stdio: ['ignore', out, out] })
    child.on('error', reject)
    child.on('close', (code) => {
      if (logFile) fs.closeSync(out)
      resolve(code)
    })
  })
}

async function must(cmd, argv, opts) {
  const code = await run(cmd, argv, opts)
  if (code !== 0) throw new Error(`${cmd} ${argv.join(' ')} exited ${code}${opts?.logFile ? `; see ${opts.logFile}` : ''}`)
}

function onPath(bin) {
  return (process.env.PATH ?? '').split(path.delimiter).some((dir) => dir && fs.existsSync(path.join(dir, bin)))
}

// ── Setup ────────────────────────────────────────────────────────────────────

const work = flag('--work') ?? fs.mkdtempSync(path.join(os.tmpdir(), 'intutic-chaos-e2e-'))
fs.mkdirSync(work, { recursive: true })
const home = path.join(work, 'home')
const fixture = path.join(work, 'repo')
const reports = path.join(work, 'reports')
// A reused --work starts over, except for what the caller put there.
for (const dir of [home, fixture, reports, path.join(work, 'gate-gen')]) fs.rmSync(dir, { recursive: true, force: true })
for (const dir of [home, reports]) fs.mkdirSync(dir, { recursive: true })
console.log(`chaos e2e: working in ${work}`)

if (!fs.existsSync(CLI)) throw new Error(`${CLI} is missing: build the CLI first`)
if (!onPath('intutic-proxy')) throw new Error('intutic-proxy is not on PATH: build packages/proxy and put its target dir first')

// The CLI runs with its own HOME, so nothing from this machine's ~/.intutic
// (credentials, local rules, a pinned proxy) and no provider key reaches it.
const cliEnv = {
  PATH: process.env.PATH,
  HOME: home,
  TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
  DOCKER_CONFIG: process.env.DOCKER_CONFIG ?? path.join(os.homedir(), '.docker'),
  ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
  NO_COLOR: '1',
}

// 1. Images: the Node sandbox image as the CLI builds it on demand, then the
//    suite's own image FROM it with the MCP proxy added.
const { ensureSandboxImage, NODE_SANDBOX_IMAGE } = await import(path.join(REPO, 'tools/cli/dist/lib/sandbox/image.js'))
console.log(`chaos e2e: ensuring ${NODE_SANDBOX_IMAGE}`)
await ensureSandboxImage(runtime, NODE_SANDBOX_IMAGE)
const image = `intutic/chaos-e2e:${NODE_SANDBOX_IMAGE.split(':')[1]}`
console.log(`chaos e2e: building ${image}`)
await must(runtime, ['build', '-q', '-f', path.join(HERE, 'Dockerfile'), '--build-arg', `INTUTIC_SANDBOX_NODE=${NODE_SANDBOX_IMAGE}`, '-t', image, mcpProxyDir], {
  logFile: path.join(work, 'image-build.log'),
})

// 2. The fixture repository: harness, stub server, and the gate exactly as the
//    sync daemon emits it for Claude Code, with a policy snapshot it wrote.
fs.mkdirSync(path.join(fixture, 'agent'), { recursive: true })
fs.mkdirSync(path.join(fixture, 'gate'), { recursive: true })
for (const f of ['harness.mjs', 'records-server.mjs']) fs.copyFileSync(path.join(HERE, 'agent', f), path.join(fixture, 'agent', f))

process.env.INTUTIC_SKIP_GLOBAL_HOOKS = '1' // never touch this machine's ~/.claude
const { updatePreToolUseHooks } = await import(path.join(REPO, 'services/sync-daemon/dist/harness/claudeCodeHooks.js'))
const { writePolicySnapshot, SNAPSHOT_RULES } = await import(path.join(REPO, 'services/sync-daemon/dist/lib/policySnapshot.js'))
const gen = path.join(work, 'gate-gen')
await updatePreToolUseHooks(gen, [], {}, undefined, WORKSPACE_ID)
// The gate names its own event logs by the absolute root it was written for;
// inside the sandbox that root is /work.
const gateSource = fs.readFileSync(path.join(gen, '.intutic/hooks/claude-code-check.js'), 'utf8').split(gen).join('/work')
fs.writeFileSync(path.join(fixture, 'gate/claude-code-check.js'), gateSource)
// The snapshot where the sync daemon keeps it: the CLI's home, which the
// runner carries into each repetition.
const snapshotDir = path.join(home, '.intutic', 'hooks')
await writePolicySnapshot(
  { workspaceId: WORKSPACE_ID, interventionMode: 'TRANSPARENT', sopRules: [], mcpAllowedServers: [], sqlDropStrictBlock: false },
  snapshotDir,
)
fs.copyFileSync(path.join(snapshotDir, SNAPSHOT_RULES), path.join(fixture, 'gate/policy-snapshot.rules'))
// And the gate as `intutic connect` leaves it in a project: written for the
// fixture's own (host) path, registered in .claude/settings.json, untracked.
await updatePreToolUseHooks(fixture, [], {}, undefined, WORKSPACE_ID)
fs.writeFileSync(path.join(fixture, '.gitignore'), '.intutic/\n')

const git = (...a) => must('git', ['-c', 'user.name=chaos-e2e', '-c', 'user.email=chaos-e2e@example.invalid', '-c', 'commit.gpgsign=false', ...a], { cwd: fixture, logFile: path.join(work, 'git.log') })
await git('init', '-q')
await git('add', '-A')
await git('commit', '-q', '-m', 'chaos e2e fixture')

// ── The experiments ──────────────────────────────────────────────────────────

function readEvents(file) {
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

/** Every mismatch between a report and what the experiment should produce. */
function check(name, mode, report, exitCode, cliLog) {
  const want = EXPECT[name][mode]
  const problems = []
  const v = report.verdict
  if (v.kind !== want.verdict) problems.push(`verdict ${v.kind}${v.reason ? ` (${v.reason})` : ''}, want ${want.verdict}`)
  if (exitCode !== EXIT[want.verdict]) problems.push(`exit code ${exitCode}, want ${EXIT[want.verdict]}`)
  if (want.abort && !want.abort.test(v.reason ?? '')) problems.push(`abort reason ${JSON.stringify(v.reason)} does not match ${want.abort}`)
  if (v.score !== want.score) problems.push(`score ${v.score}, want ${want.score}`)
  for (const [id, rate] of Object.entries(want.probes)) {
    const p = report.probes.find((x) => x.id === id)
    if (!p) problems.push(`probe ${id} missing from the report`)
    else if (rate === null ? p.evaluated !== 0 : p.evaluated === 0 || p.passRate !== rate) {
      problems.push(`probe ${id}: ${p.passes}/${p.evaluated}, want ${rate === null ? 'not evaluated' : `pass rate ${rate}`}`)
    }
  }
  if (report.warnings.length) problems.push(`warnings: ${report.warnings.join(' | ')}`)

  const baseline = report.repetitions.filter((r) => r.baseline)
  const faulted = report.repetitions.filter((r) => !r.baseline)
  if (baseline.length !== 1 || faulted.length !== 1) problems.push(`${baseline.length} baseline and ${faulted.length} faulted repetitions, want 1 and 1`)
  for (const r of report.repetitions) if (r.error) problems.push(`repetition ${r.repetition}: ${r.error}`)
  for (const r of baseline) {
    const events = readEvents(r.eventsPath)
    if (events.some((e) => e.type === 'fault_injected')) problems.push(`baseline repetition ${r.repetition} injected a fault`)
    if (r.verifyExitCode !== 0) problems.push(`baseline repetition ${r.repetition} failed verify (${r.verifyExitCode})`)
  }
  for (const r of faulted) {
    const events = readEvents(r.eventsPath)
    const loaded = new Set(events.filter((e) => e.type === 'plan_loaded').map((e) => e.component))
    for (const c of EXPECT[name].components) if (!loaded.has(c)) problems.push(`repetition ${r.repetition}: ${c} never reported plan_loaded`)
    for (const f of report.experiment.faults) {
      if (!events.some((e) => e.type === 'fault_injected' && e.faultId === f.id)) problems.push(`repetition ${r.repetition}: ${f.id} never produced fault_injected`)
    }
    const artifact = (file) => {
      const p = path.join(path.dirname(r.eventsPath), file)
      return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
    }
    for (const re of [EXPECT[name].proxyLog ?? []].flat()) {
      if (!re.test(artifact('mcp-proxy.log'))) problems.push(`repetition ${r.repetition}: the MCP proxy log has no ${re}`)
    }
    if (EXPECT[name].agentOut && !EXPECT[name].agentOut.test(artifact('agent.out'))) {
      problems.push(`repetition ${r.repetition}: the agent output has no ${EXPECT[name].agentOut}`)
    }
  }
  if (EXPECT[name].cliLog && !EXPECT[name].cliLog.test(cliLog)) problems.push(`the runner output has no ${EXPECT[name].cliLog}`)
  return problems
}

const files = fs.readdirSync(path.join(HERE, 'experiments')).filter((f) => f.endsWith('.yaml')).sort()
const names = files.map((f) => f.replace(/\.yaml$/, ''))
const unexpected = names.filter((n) => !EXPECT[n])
if (unexpected.length) throw new Error(`no expectations for ${unexpected.join(', ')}`)

const started = Date.now()
const failures = []
const summary = []
for (const name of names) {
  if (only && !name.includes(only)) continue
  const source = fs.readFileSync(path.join(HERE, 'experiments', `${name}.yaml`), 'utf8')
  for (const mode of ['resilient', 'fragile']) {
    const label = `${name}-${mode}`
    const file = path.join(work, `${label}.yaml`)
    fs.writeFileSync(file, source.replace(`name: ${name}`, `name: ${label}`).replace('--mode resilient', `--mode ${mode}`))
    const out = path.join(reports, `${label}.json`)
    const t0 = Date.now()
    const exitCode = await run(process.execPath, [CLI, 'chaos', 'run', file, '--out', out, '--sandbox-image', image], {
      cwd: fixture,
      env: cliEnv,
      logFile: path.join(reports, `${label}.log`),
    })
    const secs = ((Date.now() - t0) / 1000).toFixed(1)
    if (!fs.existsSync(out)) {
      failures.push(`${label}: no report (exit ${exitCode}); see ${path.join(reports, `${label}.log`)}`)
      console.log(`FAIL ${label} (${secs}s): no report`)
      continue
    }
    const report = JSON.parse(fs.readFileSync(out, 'utf8'))
    const problems = check(name, mode, report, exitCode, fs.readFileSync(path.join(reports, `${label}.log`), 'utf8'))
    const v = report.verdict
    const injected = report.repetitions
      .filter((r) => !r.baseline)
      .flatMap((r) => readEvents(r.eventsPath).filter((e) => e.type === 'fault_injected').map((e) => `${e.component}:${e.faultId}@${e.target ?? '-'}`))
    const line = `${label}: ${v.kind}${v.kind === 'invalid' ? '' : ` ${v.score}`} [${report.probes.map((p) => `${p.id} ${p.passes}/${p.evaluated}`).join(', ')}] injected ${injected.join(' ') || 'nothing'}`
    summary.push(line)
    console.log(`${problems.length ? 'FAIL' : 'ok  '} ${line} (${secs}s)`)
    for (const p of problems) {
      console.log(`       ${p}`)
      failures.push(`${label}: ${p}`)
    }
  }
}

console.log(`\nchaos e2e: ${summary.length} runs in ${Math.round((Date.now() - started) / 1000)}s; reports in ${reports}`)
if (failures.length) {
  console.log(`chaos e2e: ${failures.length} problem${failures.length > 1 ? 's' : ''}`)
  process.exit(1)
}
console.log('chaos e2e: all experiments match')
