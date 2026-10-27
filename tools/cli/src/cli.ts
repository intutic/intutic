#!/usr/bin/env node
/**
 * Intutic CLI — Entry point
 *
 * AI governance control plane for developer workspaces.
 * Provides harness detection, config sync, and workspace management.
 *
 * HLD §3.14 — Real-Time State Mirroring
 *
 * @module
 */

import { Command, Option } from 'commander'
import { createRequire } from 'node:module'
import {
  CLOUD_RELEASED,
  CONTROL_PLANE_PRODUCT_RELEASED,
  HOSTED_CONTROL_PLANE_URL,
} from '@intutic/shared-types'
import { DEFAULT_SANDBOX_IMAGE } from './lib/sandbox/image.js'
import { controlPlaneCommandIn, loadControlPlanePlugin, missingPluginMessage } from './lib/controlPlanePlugin.js'

// Read the version from package.json rather than repeating it here. The literal
// that used to live below said 1.6.0 for three releases running, so
// `intutic --version` reported a version the user did not have — and any check
// of it was worthless, since it printed the same string regardless of what was
// installed. createRequire because this is ESM, where `require` is unavailable
// but JSON imports still need an assertion on older runtimes.
const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

const program = new Command()

// Release flags (packages/shared-types/src/release.ts). An option of an open
// command that only does anything against a control plane is left out of help
// until that product is released. The commands that only work against a control
// plane are not in this package at all: they register from the optional
// @intutic/cli-control-plane plugin, loaded just before the command line is
// parsed (lib/controlPlanePlugin.ts).

/** An option of a visible command that only does anything against a control plane. */
function controlPlaneOption(flags: string, description: string): Option {
  const option = new Option(flags, description)
  return CONTROL_PLANE_PRODUCT_RELEASED ? option : option.hideHelp()
}

// A command that needs a control plane, run with none configured, throws
// NoControlPlaneError (config/paths.ts) from an async action. Say that plainly
// rather than as an unhandled rejection with a stack; anything else still
// crashes as before.
process.on('unhandledRejection', (err) => {
  if (err instanceof Error && err.name === 'NoControlPlaneError') {
    console.error(err.message)
    process.exit(1)
  }
  throw err
})

// Positional options: `--version` and `--help` belong to the program only when
// they come before a subcommand. Without this, commander matches program
// options anywhere on the line, so a subcommand option named `--version` would
// print the CLI version and exit before its command ever saw it.
program
  .name('intutic')
  .description(
    CONTROL_PLANE_PRODUCT_RELEASED
      ? 'Intutic CLI — AI governance control plane for developer workspaces'
      : 'Intutic CLI — open-core AI governance for developer workspaces: a local proxy, gates and policy for coding agents',
  )
  .version(version)
  .enablePositionalOptions()

program
  .command('init')
  .description('Initialize workspace — detect harnesses and record them in ~/.intutic/config.json')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .option('--git-hooks', 'Install the Intutic Git hooks without asking')
  .option('--no-git-hooks', 'Skip the Git hooks without asking (the default when stdin is not a terminal)')
  .option('--gates', 'Install the harness gates (`intutic gates install`) without asking')
  .option('--no-gates', 'Skip the harness gates without asking (the default when stdin is not a terminal)')
  .action(async (opts) => {
    const { runInit } = await import('./commands/init.js')
    await runInit(opts)
  })

// ── Cohort setup wizard ──────────────────────────────────────────────────
program
  .command('setup')
  .description('Guided setup: detect harnesses, configure a provider credential, and verify it')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runSetup } = await import('./commands/setup.js')
    await runSetup(opts)
  })

// ── Decide rules: a self-hosted model answers a rule's questions ──────────
const decideCmd = program.command('decide').description('Decide rules: test and evaluate them, configure the self-hosted engine, and check a call')

decideCmd
  .command('test <rule>')
  .description('Ask a rule\'s questions about one call and show each answer, the when value and the outcome')
  .requiredOption('--state <file>', 'A JSON file with the call, {"tool","toolInput","cwd"?}; for an on: response rule, the response, {"response"}')
  .option('--json', 'Print the result as JSON')
  .option('--log-state', 'Also write the exact state sent to ~/.intutic/logs/decide-state-<date>.jsonl')
  .option('--workspace <dir>', 'The workspace whose .intutic/sops to read (default: the recorded one, else the current directory)')
  .action(async (rule, opts) => {
    const { runDecideTest } = await import('./commands/decide.js')
    await runDecideTest(rule, opts)
  })

decideCmd
  .command('eval <rule>')
  .description('Measure a rule on labelled calls; under a pre-registration, a pass pins the engine\'s model so the rule may enforce')
  .option('--labels <file>', 'JSONL, one case per line: {"id","label":"refuse"|"allow","tool","toolInput","cwd"?}, or {"id","label","response"} for an on: response rule')
  .option('--preregister <file>', 'Write the pre-registration here when it is absent (reading no label); evaluate against it when present')
  .option('--calibration <id>', 'Pre-register a control-plane candidate calibration\'s band and combiner, and upload the run as its companion (logged in only)')
  .option('--adversarial', 'Add the planted-approval, instruction-in-arguments and paraphrase families (always on under a pre-registration)')
  .option('--json', 'Print the run report as JSON')
  .option('--log-state', 'Also write each exact state sent to ~/.intutic/logs/decide-state-<date>.jsonl')
  .option('--workspace <dir>', 'The workspace whose .intutic/sops to read')
  .action(async (rule, opts) => {
    const { runDecideEval } = await import('./commands/decide.js')
    await runDecideEval(rule, opts)
  })

decideCmd
  .command('calibrate <rule>')
  .description('Fit a combiner over the questions and a band to labelled calls, saved as a candidate for the next pre-registered eval')
  .requiredOption('--labels <file>', 'JSONL labels, as for decide eval')
  .option('--json', 'Print the candidate as JSON')
  .option('--workspace <dir>', 'The workspace whose .intutic/sops to read')
  .action(async (rule, opts) => {
    const { runDecideCalibrate } = await import('./commands/decide.js')
    await runDecideCalibrate(rule, opts)
  })

decideCmd
  .command('models')
  .description('The models the bake-off validated (none for a laptop) — nothing is downloaded')
  .option('--json', 'Print as JSON')
  .action(async (opts) => {
    const { runDecideModels } = await import('./commands/decide.js')
    runDecideModels(opts)
  })

decideCmd
  .command('check')
  .description('Evaluate one call\'s decide rules for a shell or n8n gate: a JSON request on stdin, one JSON line out')
  .option('--stdin', 'Read the request from stdin')
  .action(async (opts) => {
    const { runDecideCheck } = await import('./commands/decide.js')
    await runDecideCheck(opts)
  })

decideCmd
  .command('configure')
  .description('Write ~/.intutic/decide/engine.json: the self-hosted engine\'s URL, adapter and model (the key stays in INTUTIC_DECIDE_API_KEY)')
  .option('--url <url>', 'The engine\'s base URL (default http://127.0.0.1:11434, Ollama)')
  .option('--adapter <adapter>', 'logprobs, systemone or decisions')
  .option('--model <model>', 'The model the engine serves')
  .option('--timeout-ms <ms>', 'Per-call timeout')
  .option('--parallel <n>', 'Most requests in flight at once')
  .option('--structured', 'Send structured_outputs with logprobs requests')
  .option('--no-structured', 'Do not send structured_outputs')
  .option('--json', 'Print the written configuration as JSON')
  .action(async (opts) => {
    const { runDecideConfigure } = await import('./commands/decide.js')
    runDecideConfigure(opts)
  })

decideCmd
  .command('disable')
  .description('Run every decide rule as shadow on this machine (logged, never refusing) until `intutic decide enable`')
  .action(async () => {
    const { runDecideDisable } = await import('./commands/decide.js')
    await runDecideDisable(true)
  })

decideCmd
  .command('enable')
  .description('Undo `intutic decide disable`')
  .action(async () => {
    const { runDecideDisable } = await import('./commands/decide.js')
    await runDecideDisable(false)
  })

decideCmd
  .command('lint')
  .description('Read every local decide: line: name the ones that do not read, and tools more than 4 rules name')
  .option('--json', 'Print as JSON')
  .option('--workspace <dir>', 'The workspace whose .intutic/sops to read')
  .action(async (opts) => {
    const { runDecideLint } = await import('./commands/decide.js')
    await runDecideLint(opts)
  })

program
  .command('disconnect')
  .description('Undo intutic connect or intutic gates install: restore every harness config they changed, remove the gates and services, and log out')
  .option('--harness <id>', 'Disconnect one harness only (credentials and services stay)')
  .option('--dry-run', 'Print exactly what would change, and change nothing')
  .option('--keep-login', 'Keep the stored credentials')
  .action(async (opts) => {
    const { runDisconnect } = await import('./commands/disconnect.js')
    await runDisconnect({ harness: opts.harness, dryRun: opts.dryRun, keepLogin: opts.keepLogin })
  })

program
  .command('status')
  .description('Show workspace status — auth, harnesses, sync state')
  .action(async () => {
    const { runStatus } = await import('./commands/status.js')
    await runStatus()
  })

program
  .command('doctor')
  .description('Diagnose workspace health — proxy, auth, daemon, configs, logs')
  .action(async () => {
    const { runDoctor } = await import('./commands/doctor.js')
    await runDoctor()
  })

program
  .command('rollback')
  .description('List or restore pre-images captured when a guard flagged a file-writing call')
  .option('--list', 'List captured pre-images (the default with no --id)')
  .option('--id <id>', 'Restore the named pre-image')
  .action(async (opts) => {
    const { runRollback } = await import('./commands/rollback.js')
    await runRollback(opts)
  })

const budgetCmd = program
  .command('budget')
  .description(
    CONTROL_PLANE_PRODUCT_RELEASED
      ? 'Check remaining daily/monthly budget and list active loops; set workspace, key and member budgets'
      : 'Check the local spending cap and what this machine has spent today',
  )
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .option('--watch', 'Continuously print machine-local and workspace spend, one line per tick')
  .option('--interval <seconds>', 'Tick interval in seconds for --watch', String(5))
  .action(async (opts) => {
    if (opts.watch) {
      const { runBudgetWatch } = await import('./commands/budget.js')
      await runBudgetWatch(opts)
      return
    }
    const { runBudget } = await import('./commands/budget.js')
    await runBudget(opts)
  })

const policyCmd = program
  .command('policy')
  .description(CONTROL_PLANE_PRODUCT_RELEASED ? 'WASM rules and the policy snapshot' : 'WASM rules: compile, test and install them locally')

policyCmd
  .command('test')
  .description('Run dry-run WASM policy evaluation locally')
  .requiredOption('--wasm <path>', 'Path to compiled WASM rule binary')
  .requiredOption('--mock <path>', 'Path to mock JSON context file')
  .action(async (opts) => {
    const { runPolicyTest } = await import('./commands/policy.js')
    await runPolicyTest(opts)
  })

policyCmd
  .command('compile')
  .description('Compile an AssemblyScript rule to WASM (wraps asc)')
  .option('--src <path>', 'Rule source entry file (default: assembly/index.ts)')
  .option('--out <path>', `Output .wasm path (default: build/rule.wasm${CONTROL_PLANE_PRODUCT_RELEASED ? ', or build/<candidate>.wasm with --candidate' : ''})`)
  .option('--debug', 'Include debug info and source maps')
  .addOption(controlPlaneOption('--candidate <id>', 'Compile a rule candidate from its source of record on the control plane (fetched and hash-verified; not with --src)'))
  .addOption(controlPlaneOption('--upload', 'With --candidate: upload the bundle to the candidate with its source hash and print the gate results'))
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runPolicyCompile } = await import('./commands/policy.js')
    await runPolicyCompile(opts)
  })

policyCmd
  .command('install')
  .description('Validate and install a compiled WASM rule (native or Rego) into the local proxy rules dir')
  .requiredOption('--wasm <path>', 'Path to compiled WASM rule binary')
  .option('--name <name>', 'Rule name (defaults to the file name)')
  .option('--priority <NN>', 'Evaluation priority — lower runs first', '100')
  .action(async (opts) => {
    const { runPolicyInstall } = await import('./commands/policy.js')
    await runPolicyInstall(opts)
  })

policyCmd
  .command('list-local')
  .description('List WASM rules installed in the local proxy rules dir')
  .action(async () => {
    const { runPolicyListLocal } = await import('./commands/policy.js')
    await runPolicyListLocal()
  })

// Rego policies as rules: compiled with OPA and packaged with the metadata
// the proxies read (`intutic rules build`), tested through the same host
// (`intutic rules test`). Installing and uploading are the same as for any rule.
const rulesCmd = program
  .command('rules')
  .description('Build and test Rego policies as Intutic rules')

rulesCmd
  .command('build')
  .description(
    'Compile Rego to a rule with OPA (opa build -t wasm) and package it with its entrypoint and risk tier.\n' +
    '\n' +
    '  Needs the opa binary on the PATH, or INTUTIC_OPA_BIN. Refuses a policy that\n' +
    '  needs a builtin Intutic does not provide, naming it.'
  )
  .requiredOption('--rego <path>', 'Rego file or directory')
  .requiredOption('--entrypoint <package/rule>', 'The rule to evaluate, e.g. intutic/shell/deny')
  .option('--risk-tier <tier>', 'Default risk tier for its decisions: low | medium | high | critical')
  .option('--out <path>', 'Output .wasm path (default: build/<entrypoint>.wasm)')
  .action(async (opts) => {
    const { runRulesBuild } = await import('./commands/rules.js')
    await runRulesBuild(opts)
  })

rulesCmd
  .command('test <module>')
  .description(
    'Evaluate a Rego rule against sample inputs locally, through the same host the proxies use.\n' +
    '\n' +
    '  Each --input file holds one input document, or an array of\n' +
    '  {"name", "input", "expect": "allow|deny|hold|reask"} cases. Exits 1 when a\n' +
    '  case gets a decision other than the one it expects.'
  )
  .requiredOption('--input <file...>', 'JSON file(s) of inputs or cases')
  .action(async (module, opts) => {
    const { runRulesTest } = await import('./commands/rules.js')
    await runRulesTest(module, opts)
  })

program
  .command('start')
  .description('Start the proxy standalone — no account or control plane needed')
  .option('--port <port>', 'Proxy port (default: the port of $INTUTIC_PROXY_URL, else 4000)')
  .option('--valkey-port <port>', 'Valkey port', '6379')
  .option('--upstream-url <url>', 'Upstream LLM provider base URL')
  .option('--no-gates', 'Do not refresh the local gates (`intutic gates install`) or watch .intutic/sops while the proxy runs')
  .action(async (opts) => {
    const { runStart } = await import('./commands/start.js')
    await runStart(opts)
  })

const gatesCmd = program
  .command('gates')
  .description('Harness hook gates and rules files, without a control plane')

gatesCmd
  .command('install')
  .description(
    'Install the tool-call gate and rules file for each recorded harness, from this machine alone: ' +
      'the built-in protections, the local .intutic/sops, and review_before: tokens (refused, as nothing can approve a hold). ' +
      'Also writes the bundled agent skills (Kitkat, rule authoring) where the workspace has none',
  )
  .option('--harness <id>', 'Only this harness (it must be recorded by `intutic init`, or pass --add)')
  .option('--add', 'With --harness: record the harness in ~/.intutic/config.json if it is not')
  .option('--route', "Also point the harnesses' LLM traffic at the local proxy, which must then be running (e.g. `intutic daemon install --proxy`)")
  .option('--dry-run', 'Print what would be written, and write nothing')
  .option('--workspace <path>', 'Workspace to write into (default: the one `intutic init` recorded)')
  .action(async (opts) => {
    // The writers log each file at info, as JSON; the command prints its own
    // list. Warnings (a file left alone because it does not parse) still show.
    process.env.LOG_LEVEL ??= 'warn'
    const { runGatesInstall } = await import('./commands/gates.js')
    await runGatesInstall(opts)
  })

// L2 mandatory egress firewall. Makes the governing proxy
// non-optional: default-deny host egress to everything except the proxy, DNS,
// and declared infra. apply/remove need root; generate/status do not.
const enforceCmd = program
  .command('enforce')
  .description('Manage the mandatory default-deny egress firewall (forces all traffic through the proxy)')

for (const [action, desc] of [
  ['apply', 'Apply the default-deny egress firewall (root). All egress except the proxy, DNS and --allow infra is dropped.'],
  ['remove', 'Remove the Intutic egress firewall (root).'],
  ['status', 'Report whether the egress firewall is currently applied.'],
  ['generate', 'Print the platform ruleset without applying it (no privilege).'],
] as const) {
  enforceCmd
    .command(action)
    .description(desc)
    .option('--port <port>', "The proxy's listener port to permit", '4000')
    .option('--uid <uid>', 'uid the proxy runs as, exempted from the deny (defaults to you: the invoking user under sudo)')
    .option('--allow <cidrs>', 'Comma-separated extra destination CIDRs to permit (control plane, registries, …)')
    .option('--no-dns', 'Also deny outbound DNS (only if a local resolver serves the host)')
    .option('--platform <os>', 'Target ruleset platform: linux | macos | windows (defaults to current OS)')
    .action(async (opts) => {
      const { runEnforce } = await import('./commands/enforce.js')
      await runEnforce(action, opts)
    })
}

const envCmd = program
  .command('env')
  .description('Persist or clear the proxy base-URL environment variables')

envCmd
  .command('persist')
  .description(
    'Write ANTHROPIC_BASE_URL / OPENAI_BASE_URL at the OS level so new shells and apps pick them up.\n' +
    '  macOS: launchctl setenv    Linux: ~/.bashrc    Windows: setx\n' +
    '\n' +
    '  Opt-in on purpose: on macOS this reaches every GUI app you launch afterwards.\n' +
    '  For a single command instead, use \'intutic exec\'.'
  )
  .option('--proxy-url <url>', 'Proxy base URL to point the variables at', 'http://localhost:4000')
  .action(async (opts) => {
    const { runEnvPersist } = await import('./commands/env.js')
    await runEnvPersist({ proxyUrl: opts.proxyUrl })
  })

envCmd
  .command('clear')
  .description('Remove the variables written by \'intutic env persist\'')
  .action(async () => {
    const { runEnvClear } = await import('./commands/env.js')
    await runEnvClear()
  })

program
  .command('exec')
  .description('Execute a command wrapped with Intutic proxy environment variables')
  .argument('[command...]', 'Command and arguments to execute (e.g. -- claude)')
  // Run the agent inside an isolated sandbox whose ONLY egress is the proxy:
  // cap-drop, no-new-privileges, read-only rootfs, resource caps,
  // and a default-deny egress firewall the agent cannot undo.
  .option('--sandbox [kind]', 'Run the agent in an isolated sandbox (kind: oci | firecracker; default oci)')
  .option('--sandbox-image <image>', 'Sandbox image (must contain the agent + nftables + capsh); the default, and its <default>-node variant with Node.js for agents such as Claude Code, are built locally on first use', DEFAULT_SANDBOX_IMAGE)
  .option('--sandbox-memory <size>', 'Sandbox memory cap (e.g. 2g)', '2g')
  .option('--sandbox-cpus <n>', 'Sandbox CPU cap', '2')
  .option('--sandbox-pids <n>', 'Sandbox max process count', '512')
  .option('--sandbox-allow <cidrs>', 'Comma-separated extra destination CIDRs the sandbox may reach')
  .action(async (commandAndArgs: string[], opts) => {
    const { runExec } = await import('./commands/exec.js')
    if (opts.sandbox) {
      await runExec(commandAndArgs, {
        kind: typeof opts.sandbox === 'string' ? opts.sandbox : 'oci',
        image: opts.sandboxImage,
        memory: opts.sandboxMemory,
        cpus: opts.sandboxCpus,
        pidsLimit: Number.parseInt(opts.sandboxPids, 10),
        allow: opts.sandboxAllow
          ? String(opts.sandboxAllow).split(',').map((s) => s.trim()).filter(Boolean)
          : [],
      })
    } else {
      await runExec(commandAndArgs)
    }
  })

// Agent fault injection: run an agent with a known fault injected, in the
// sandbox only, and score what it did.
const chaos = program
  .command('chaos')
  .description('Run an agent with a known fault injected, in the sandbox, and score what it did')

chaos
  .command('validate')
  .description('Check a chaos experiment file')
  .argument('<file>', 'Experiment file (YAML)')
  .action(async (file: string) => {
    const { runChaosValidate } = await import('./commands/chaos.js')
    await runChaosValidate(file)
  })

chaos
  .command('list')
  .description('List the fault catalog: each fault, the component that injects it and its safety class')
  .action(async () => {
    const { runChaosList } = await import('./commands/chaos.js')
    runChaosList()
  })

chaos
  .command('run')
  .description('Run an experiment: baseline then faulted repetitions, each in a sandbox behind its own proxy')
  .argument('<file>', 'Experiment file (YAML)')
  .option('--sandbox-image <image>', 'Sandbox image (must contain the agent; extend intutic/sandbox:<version>-node for Node agents); overrides the experiment\'s sandbox_image')
  .option('--out <report.json>', 'Where to write the JSON report (default: under the OS temp dir)')
  .option('--keep', 'Keep each repetition\'s git worktree instead of removing it')
  .action(async (file: string, opts: { sandboxImage?: string; out?: string; keep?: boolean }) => {
    const { runChaosRun } = await import('./commands/chaos.js')
    await runChaosRun(file, opts)
  })


const traces = program
  .command('traces')
  .alias('trace')
  .description('Query execution traces — list, filter, and inspect')

traces
  .command('list')
  .description('List execution traces for the workspace')
  .option('--limit <n>', 'Number of traces to show (default: 20, max: 100)')
  .option('--since <duration>', 'Time window, e.g. "24h", "7d", "30m" (default: "24h")')
  .option('--action <type>', 'Filter by enforcement action (BYPASS|ENHANCE|HIJACK|KILL) — connected mode only')
  .option('--verdict <type>', 'Filter by verdict (allowed|killed|upstream_error|reasked|hijacked) — local mode only')
  .option('--model <name>', 'Filter by model name')
  .option('--json', 'Output as JSON instead of table')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runTracesList } = await import('./commands/traces.js')
    await runTracesList(opts)
  })

traces
  .command('inspect <trace_id>')
  .description('Show full detail of a single trace')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (traceId, opts) => {
    const { runTracesInspect } = await import('./commands/traces.js')
    await runTracesInspect(traceId, opts)
  })

// ── Daemon persistence (WS-5 — Q3 Layer 4) ─────────────────────────────────

const daemon = program
  .command('daemon')
  .description('Manage the Intutic sync-daemon, MCP daemon and standalone proxy system services (LaunchAgent / systemd)')

// `install` and `uninstall` are also reachable as the top-level shortcuts
// `intutic install-daemon` / `intutic uninstall-daemon`. A commander alias only
// renames a command within its own parent, so each verb is defined once here
// and registered in both places. The shortcuts used to be separate copies, and
// they drifted: `install-daemon` had no --mcp, --proxy or proxy options and
// demanded a workspace and key even for the standalone proxy, while the docs
// called it a shortcut for `daemon install`.
function defineDaemonInstall(cmd: Command): Command {
  return cmd
    .description(
      'Install sync-daemon as a system service (auto-starts on login, restarts on any exit).\n' +
      '  macOS: ~/Library/LaunchAgents/ai.intutic.sync-daemon.plist (KeepAlive: true)\n' +
      '  Linux: ~/.config/systemd/user/intutic-sync-daemon.service (Restart=always)\n' +
      '\n' +
      '  --proxy installs the standalone intutic-proxy binary instead (no workspace or key needed):\n' +
      '  macOS: ~/Library/LaunchAgents/ai.intutic.proxy.plist\n' +
      '  Linux: ~/.config/systemd/user/intutic-proxy.service\n' +
      '\n' +
      '  The service restarts whenever its process exits, so killing the process does not stop it.\n' +
      '  Use \'intutic daemon stop\' or \'intutic daemon uninstall\'.'
    )
    .option('--workspace-id <id>', 'Workspace ID (e.g. wk_xxxx) — required unless --proxy')
    .option('--api-key <key>', 'Workspace API key (e.g. vk_xxxx) — required unless --proxy')
    .addOption(controlPlaneOption('--control-plane-url <url>', `Control plane the daemon connects to (default: $INTUTIC_CONTROL_PLANE_URL, then a workspace set up with \`intutic init --dev\`, then the URL saved by \`intutic login\`${CLOUD_RELEASED ? `, then ${HOSTED_CONTROL_PLANE_URL}` : ''})`))
    .option('--binary-path <path>', 'Path to intutic CLI binary (defaults to current process); with --proxy, absolute path to intutic-proxy')
    .option('--dry-run', 'Print what would be done without writing files')
    .option('--system', 'Install as a system-level service (LaunchDaemon on macOS, systemd system unit on Linux)')
    .option('--mcp', 'Install the MCP proxy daemon instead of the sync-daemon')
    .option('--proxy', 'Install the standalone intutic-proxy binary as a service')
    .option('--port <port>', 'With --proxy: proxy listen port (default: the port of $INTUTIC_PROXY_URL, else 4000)')
    .option('--valkey-url <url>', 'With --proxy: Valkey URL to attach to; omit to run standalone (INTUTIC_STANDALONE=1)')
    .option('--upstream-url <url>', 'With --proxy: upstream LLM provider base URL')
    .action(async (opts, cmd) => {
      if (opts.proxy) {
        // The standalone proxy has no control plane, so no workspace or key.
        // Its unit carries the same environment `intutic start` sets, fixed at
        // install time rather than probed at launch.
        const { installProxyService } = await import('./commands/install-daemon.js')
        await installProxyService({
          port:        opts.port,
          valkeyUrl:   opts.valkeyUrl,
          upstreamUrl: opts.upstreamUrl,
          binaryPath:  opts.binaryPath,
          dryRun:      opts.dryRun,
          system:      opts.system,
        })
        return
      }
      // Required for the two daemons; commander's `requiredOption` cannot express
      // "unless --proxy", so the check lives here with the same wording.
      if (!opts.workspaceId) cmd.error("error: required option '--workspace-id <id>' not specified")
      if (!opts.apiKey) cmd.error("error: required option '--api-key <key>' not specified")
      // `installMcpDaemon` and `buildMcpPlist` were written, tested and exported,
      // and then nothing called them: every route into install-daemon.ts landed
      // on `installDaemon`, so the MCP proxy daemon could not be installed by any
      // command the CLI offered. This flag is that missing route.
      const { installDaemon, installMcpDaemon } = await import('./commands/install-daemon.js')
      const install = opts.mcp ? installMcpDaemon : installDaemon
      await install({
        workspaceId:     opts.workspaceId,
        apiKey:          opts.apiKey,
        controlPlaneUrl: opts.controlPlaneUrl,
        binaryPath:      opts.binaryPath,
        dryRun:          opts.dryRun,
        system:          opts.system,
      })
    })
}

function defineDaemonUninstall(cmd: Command): Command {
  return cmd
    .description('Remove the sync-daemon system service and stop it permanently.')
    .option('--dry-run', 'Print what would be done without writing files')
    .option('--system', 'Uninstall the system-level service')
    .option('--mcp', 'Uninstall the MCP proxy daemon instead of the sync-daemon')
    .option('--proxy', 'Uninstall the standalone intutic-proxy service instead of the sync-daemon')
    .action(async (opts) => {
      const { uninstallDaemon, uninstallMcpDaemon, uninstallProxyService } = await import('./commands/install-daemon.js')
      const uninstall = opts.proxy ? uninstallProxyService : opts.mcp ? uninstallMcpDaemon : uninstallDaemon
      await uninstall({ dryRun: opts.dryRun, system: opts.system })
    })
}

defineDaemonInstall(daemon.command('install'))
defineDaemonUninstall(daemon.command('uninstall'))

defineDaemonInstall(program.command('install-daemon'))
  .summary("Shortcut for 'intutic daemon install'")
defineDaemonUninstall(program.command('uninstall-daemon'))
  .summary("Shortcut for 'intutic daemon uninstall'")

daemon
  .command('status')
  .description('Show sync-daemon system service status (or the standalone proxy service with --proxy).')
  .option('--proxy', 'Show the standalone intutic-proxy service instead of the sync-daemon')
  .option('--mcp', 'Show the MCP proxy daemon instead of the sync-daemon')
  .action(async (opts) => {
    // `mcpDaemonStatus` was exported and never called by any command until the
    // reachability test widened to the status/stop/start verbs (the same
    // exported-but-unreachable shape, one more time).
    const { daemonStatus, proxyServiceStatus, mcpDaemonStatus } = await import('./commands/install-daemon.js')
    await (opts.proxy ? proxyServiceStatus() : opts.mcp ? mcpDaemonStatus() : daemonStatus())
  })

daemon
  .command('stop')
  .description('Stop and unload the sync-daemon system service (or the standalone proxy service with --proxy).')
  .option('--proxy', 'Stop the standalone intutic-proxy service instead of the sync-daemon')
  .option('--mcp', 'Stop the MCP proxy daemon instead of the sync-daemon')
  .action(async (opts) => {
    // `mcpDaemonStop` was exported and never called by any command until the
    // reachability test widened to the status/stop/start verbs (the same
    // exported-but-unreachable shape, one more time).
    const { daemonStop, proxyServiceStop, mcpDaemonStop } = await import('./commands/install-daemon.js')
    await (opts.proxy ? proxyServiceStop() : opts.mcp ? mcpDaemonStop() : daemonStop())
  })

daemon
  .command('start')
  .description('Start and load the sync-daemon system service (or the standalone proxy service with --proxy).')
  .option('--proxy', 'Start the standalone intutic-proxy service instead of the sync-daemon')
  .option('--mcp', 'Start the MCP proxy daemon instead of the sync-daemon')
  .action(async (opts) => {
    // `mcpDaemonStart` was exported and never called by any command until the
    // reachability test widened to the status/stop/start verbs (the same
    // exported-but-unreachable shape, one more time).
    const { daemonStart, proxyServiceStart, mcpDaemonStart } = await import('./commands/install-daemon.js')
    await (opts.proxy ? proxyServiceStart() : opts.mcp ? mcpDaemonStart() : daemonStart())
  })

// ── Skill commands ─────────────────────────────────────────────────────────
const skillCmd = program
  .command('skill')
  .description('Manage and audit agent skills and instructions')

skillCmd
  .command('list')
  .description('Discover and list local workspace rule/skill files')
  .action(async () => {
    const { runSkillList } = await import('./commands/skill.js')
    await runSkillList()
  })

skillCmd
  .command('audit')
  .description('Audit local rules/skills for security leakage or unsafe command patterns')
  .option('--sarif', 'Output findings as a SARIF 2.1.0 document (for GitHub Code Scanning / CI interop) instead of the human-readable report')
  .option(
    '--engine <engine>',
    "Scanning engine: 'native' (default, always runs) or 'cisco' to also run the opt-in Cisco " +
      "skill-scanner integration (requires the 'skill-scanner' binary on PATH — pipx install cisco-ai-skill-scanner)",
    'native',
  )
  .option('--exit-zero', 'Exit 0 even when there are findings (by default findings exit 1)')
  .action(async (opts) => {
    const { runSkillAudit } = await import('./commands/skill.js')
    await runSkillAudit({ sarif: opts.sarif, engine: opts.engine, exitZero: opts.exitZero })
  })

skillCmd
  .command('scan-staged')
  .description('Warn-only content scan of staged skill-surface additions (.agents/skills, .claude/skills) — used by the pre-commit hook, never blocks the commit')
  .action(async () => {
    const { runSkillScanStaged } = await import('./commands/skill.js')
    await runSkillScanStaged()
  })

// The control-plane commands (login, connect, guardrails, ...) come from the
// optional plugin. Without it a command the plugin would have provided says so,
// rather than commander's "unknown command"; everything else is unaffected.
if (!(await loadControlPlanePlugin(program, version))) {
  const missing = controlPlaneCommandIn(process.argv.slice(2))
  if (missing) {
    console.error(missingPluginMessage(missing))
    process.exit(1)
  }
}

program.parse()
