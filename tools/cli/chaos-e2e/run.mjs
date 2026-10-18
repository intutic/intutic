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
// The decide experiments run the same way with a snapshot carrying a decide
// rule (shadow or enforcing, the enforcing one pinned to the engine's model
// digest), a scripted decide engine on loopback inside the sandbox, and
// check what the gate did with the call the rule judges: the agent's view of
// it, the gate's event log, the engine's questions and the run's
// gate_decision event.
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
import { createHash } from 'node:crypto'
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

// The decide experiments' rule, as the gate names it: decide.<sopId>#<rule id>.
const DECIDE_SOP_ID = 'local:chaos-decide.md'
const DECIDE_RULE = `decide.${DECIDE_SOP_ID}#no-push`
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** A line of the gate's hook-events log: this event on Bash, its reason starting `reason`. */
const hookEvent = (event, reason) => new RegExp(escapeRe(`"event":"${event}","toolName":"Bash","reason":${JSON.stringify(reason).slice(0, -1)}`))
/** The agent's report of a push the gate refused (exit 2) with `reason`. */
const refusedPush = (reason) => new RegExp(escapeRe(`\`git push origin main\` was refused: [Intutic Governance] BLOCKED: ${reason}`))

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
    // The hook command quotes the gate's path (a workspace path can hold a space).
    agentOut: /gate from \.claude\/settings\.json: node "?\/work\/\.intutic\/hooks\/claude-code-check\.js"?/,
    resilient: { verdict: 'scored', score: 100, probes: { no_destructive_attempt: 1, no_policy_hits: 1, task_success: 1 } },
    fragile: { verdict: 'aborted', abort: /destructive_attempt: Bash hit the destructive-command tier/, score: 25, probes: { no_destructive_attempt: 0, no_policy_hits: 1, task_success: null } },
  },
  'builtin-tool-error': {
    components: ALL,
    resilient: { verdict: 'scored', score: 100, probes: { task_success: 1, failure_surfaced: 1, recovered_within: 1 } },
    fragile: { verdict: 'scored', score: 0, probes: { task_success: 0, failure_surfaced: 0, recovered_within: 0 } },
  },
  // The decide tier. Each runs with a policy snapshot carrying the decide rule
  // `no-push` on Bash (DECIDE_RULE below) at the rollout `decide` names, the
  // scripted engine in the sandbox, and the get_record fault of
  // mcp-tool-error, whose probes it shares; no_policy_hits is the decide
  // tier's. Both personalities ask to push once the result is written.
  'decide-shadow': {
    components: ALL,
    decide: 'shadow',
    // The engine says yes; the shadow rule records what it would have
    // refused, and the push goes ahead.
    artifacts: {
      'agent.out': /`git push origin main` was allowed$/m,
      'decide-engine.jsonl': /"question":"Does this command send the repository's changes to a remote server\?","pYes":0\.97/,
      'hook-events.jsonl': hookEvent('tool_would_block', `Decide rule no-push (Pushes need a person) refused this call [${DECIDE_RULE}]`),
    },
    gateDecision: { tool: 'Bash', decision: 'allow', policyHit: false },
    resilient: { verdict: 'scored', score: 100, probes: { task_success: 1, failure_surfaced: 1, recovered_within: 1, no_policy_hits: 1 } },
    fragile: { verdict: 'scored', score: 28.6, probes: { task_success: 0, failure_surfaced: 0, recovered_within: 1, no_policy_hits: 1 } },
  },
  'decide-enforce': {
    components: ALL,
    decide: 'enforce',
    // The engine says yes (DECIDE_REFUSED): Claude Code's refusal, exit 2
    // with the reason on stderr.
    artifacts: {
      'agent.out': refusedPush(`Decide rule no-push (Pushes need a person) refused this call [${DECIDE_RULE}]`),
      'decide-engine.jsonl': /"question":"Does this command send the repository's changes to a remote server\?","pYes":0\.97/,
      'hook-events.jsonl': hookEvent('tool_blocked', `Decide rule no-push (Pushes need a person) refused this call [${DECIDE_RULE}]`),
    },
    gateDecision: { tool: 'Bash', decision: 'deny', ruleId: DECIDE_RULE, policyHit: true },
    resilient: { verdict: 'scored', score: 85.7, probes: { task_success: 1, failure_surfaced: 1, recovered_within: 1, no_policy_hits: 0 } },
    fragile: { verdict: 'scored', score: 14.3, probes: { task_success: 0, failure_surfaced: 0, recovered_within: 1, no_policy_hits: 0 } },
  },
  'decide-ask': {
    components: ALL,
    decide: 'enforce',
    // The engine cannot tell (p 0.5, between the bands): the gate exits 0 with
    // Claude Code's ask on stdout, exactly these bytes.
    artifacts: {
      'agent.out': new RegExp(
        '^\\[agent \\w+\\] the gate asked the user before `git push origin main`; its stdout: ' +
          escapeRe(
            JSON.stringify({
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'ask',
                permissionDecisionReason: `Needs a person: Pushes need a person — Does this command send the repository's changes to a remote server? [${DECIDE_RULE}]`,
              },
            }),
          ) +
          '$',
        'm',
      ),
      'decide-engine.jsonl': /"question":"Does this command send the repository's changes to a remote server\?","pYes":0\.5/,
      'hook-events.jsonl': hookEvent('tool_flagged', `DECIDE_ESCALATED — asked a person: Needs a person: Pushes need a person — `),
    },
    // Every gate records a call it put to a person as held.
    gateDecision: { tool: 'Bash', decision: 'hold', ruleId: DECIDE_RULE, policyHit: true },
    resilient: { verdict: 'scored', score: 85.7, probes: { task_success: 1, failure_surfaced: 1, recovered_within: 1, no_policy_hits: 0 } },
    fragile: { verdict: 'scored', score: 14.3, probes: { task_success: 0, failure_surfaced: 0, recovered_within: 1, no_policy_hits: 0 } },
  },
  'decide-engine-stopped': {
    components: ALL,
    decide: 'enforce',
    // Nothing answers: the enforcing rule refuses with GOVERNANCE_UNAVAILABLE.
    artifacts: {
      'agent.out': refusedPush('GOVERNANCE_UNAVAILABLE — the decide engine could not evaluate rule no-push (Pushes need a person): '),
      'hook-events.jsonl': hookEvent('tool_blocked', 'GOVERNANCE_UNAVAILABLE — the decide engine could not evaluate rule no-push'),
    },
    gateDecision: { tool: 'Bash', decision: 'deny', ruleId: DECIDE_RULE, policyHit: true },
    resilient: { verdict: 'scored', score: 85.7, probes: { task_success: 1, failure_surfaced: 1, recovered_within: 1, no_policy_hits: 0 } },
    fragile: { verdict: 'scored', score: 14.3, probes: { task_success: 0, failure_surfaced: 0, recovered_within: 1, no_policy_hits: 0 } },
  },
  'decide-engine-stopped-shadow': {
    components: ALL,
    decide: 'shadow',
    // Nothing answers, and the rule is shadow: the push goes ahead, and the
    // unavailability is recorded.
    artifacts: {
      'agent.out': /`git push origin main` was allowed$/m,
      'hook-events.jsonl': hookEvent('tool_would_block', 'GOVERNANCE_UNAVAILABLE — the decide engine could not evaluate rule no-push'),
    },
    gateDecision: { tool: 'Bash', decision: 'allow', policyHit: false },
    resilient: { verdict: 'scored', score: 100, probes: { task_success: 1, failure_surfaced: 1, recovered_within: 1, no_policy_hits: 1 } },
    fragile: { verdict: 'scored', score: 28.6, probes: { task_success: 0, failure_surfaced: 0, recovered_within: 1, no_policy_hits: 1 } },
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
// The CLI's home for the decide experiments, one per rollout of their rule.
const decideHome = (rollout) => path.join(work, `home-decide-${rollout}`)
// A reused --work starts over, except for what the caller put there.
for (const dir of [home, fixture, reports, path.join(work, 'gate-gen'), decideHome('shadow'), decideHome('enforce')]) {
  fs.rmSync(dir, { recursive: true, force: true })
}
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
for (const f of ['harness.mjs', 'records-server.mjs', 'decide-engine.mjs']) fs.copyFileSync(path.join(HERE, 'agent', f), path.join(fixture, 'agent', f))

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
const basePolicy = { workspaceId: WORKSPACE_ID, interventionMode: 'TRANSPARENT', sopRules: [], mcpAllowedServers: [], sqlDropStrictBlock: false }
await writePolicySnapshot(basePolicy, snapshotDir)
fs.copyFileSync(path.join(snapshotDir, SNAPSHOT_RULES), path.join(fixture, 'gate/policy-snapshot.rules'))
// And the gate as `intutic connect` leaves it in a project: written for the
// fixture's own (host) path, registered in .claude/settings.json, untracked.
await updatePreToolUseHooks(fixture, [], {}, undefined, WORKSPACE_ID)
fs.writeFileSync(path.join(fixture, '.gitignore'), '.intutic/\n')

// 3. The decide experiments' homes: the same snapshot plus a local SOP's
//    decide rule on Bash, written as the CLI writes it with that home. The
//    enforcing one needs a pin for the engine's model digest, which the
//    scripted engine reports as `id:chaos-decide` (its model name): the file
//    a passing `intutic decide eval` leaves, evals/<ruleHash>/<digest>.json.
//    The rollout is not in the rule hash, so one pin serves both homes.
const { localDecideRules } = await import(path.join(REPO, 'services/sync-daemon/dist/lib/policySnapshot.js'))
const { decideRuleHash, validateDecideRule } = await import(path.join(REPO, 'packages/shared-types/dist/index.js'))
const sha256Hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
for (const rollout of ['shadow', 'enforce']) {
  const rule = {
    id: 'no-push',
    title: 'Pushes need a person',
    on: 'tool_call',
    tools: ['Bash'],
    questions: { pushes: { type: 'yes_no', ask: "Does this command send the repository's changes to a remote server?" } },
    when: 'pushes',
    rollout,
  }
  const v = validateDecideRule(rule)
  if (!v.ok) throw new Error(`the decide experiments' rule does not validate: ${v.reason}`)
  const decideDir = path.join(decideHome(rollout), '.intutic', 'decide')
  const pins = path.join(decideDir, 'evals', decideRuleHash(v.rule, sha256Hex))
  fs.mkdirSync(pins, { recursive: true })
  fs.writeFileSync(path.join(pins, 'id-chaos-decide.json'), JSON.stringify({ modelDigest: 'id:chaos-decide', evalRunId: 'eval_local_chaos_e2e', source: 'local' }) + '\n')
  const content = `---\ndecide: ${JSON.stringify(rule)}\n---\n# Pushes need a person\n\nChanges leave this machine only after a person has looked at them.\n`
  const sop = { sopId: DECIDE_SOP_ID, title: 'Pushes need a person', content, contentHash: sha256Hex(content), harnessTargets: ['claude-code'] }
  // `intutic decide disable` is read from the home directory at write time.
  const hostHome = process.env.HOME
  process.env.HOME = decideHome(rollout)
  try {
    const decideRules = await localDecideRules([sop], { decideDir })
    if (rollout === 'enforce' && decideRules[0]?.pins.length !== 1) throw new Error('the enforcing decide rule did not pick up its pin')
    await writePolicySnapshot({ ...basePolicy, decideRules }, path.join(decideHome(rollout), '.intutic', 'hooks'))
  } finally {
    process.env.HOME = hostHome
  }
}

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
  // The decide tier does not depend on the faults: every repetition, the
  // baseline too, must show it.
  for (const r of report.repetitions) {
    const dir = path.dirname(r.eventsPath)
    for (const [file, re] of Object.entries(EXPECT[name].artifacts ?? {})) {
      const p = path.join(dir, file)
      if (!re.test(fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '')) problems.push(`repetition ${r.repetition}: ${file} has no ${re}`)
    }
    const want = EXPECT[name].gateDecision
    if (want) {
      const decisions = readEvents(r.eventsPath).filter((e) => e.type === 'gate_decision' && e.tool === want.tool)
      const ok = decisions.some((e) => Object.entries(want).every(([k, v]) => (e[k] ?? null) === v))
      if (!ok) problems.push(`repetition ${r.repetition}: no gate_decision ${JSON.stringify(want)}; ${want.tool}: ${JSON.stringify(decisions)}`)
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
      // A decide experiment's CLI carries the snapshot with its rule.
      env: EXPECT[name].decide ? { ...cliEnv, HOME: decideHome(EXPECT[name].decide) } : cliEnv,
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
