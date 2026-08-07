#!/usr/bin/env node
/**
 * Intutic CLI — Entry point
 *
 * AI governance control plane for developer workspaces.
 * Provides harness detection, config sync, and workspace management.
 *
 * LLD #8 — Sync Daemon / CLI
 * HLD §3.14 — Real-Time State Mirroring
 *
 * @module
 */

import { Command } from 'commander'
import { createRequire } from 'node:module'

// Read the version from package.json rather than repeating it here. The literal
// that used to live below said 1.6.0 for three releases running, so
// `intutic --version` reported a version the user did not have — and any check
// of it was worthless, since it printed the same string regardless of what was
// installed. createRequire because this is ESM, where `require` is unavailable
// but JSON imports still need an assertion on older runtimes.
const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

const program = new Command()

program
  .name('intutic')
  .description('Intutic CLI — AI governance control plane for developer workspaces')
  .version(version)

program
  .command('init')
  .description('Initialize workspace — detect harnesses, configure sync')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runInit } = await import('./commands/init.js')
    await runInit(opts)
  })

program
  .command('login')
  .description('Authenticate with the Intutic control plane')
  .option('--api-key <key>', 'Authenticate with an API key (vk_*)')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runLogin } = await import('./commands/login.js')
    await runLogin(opts)
  })

program
  .command('logout')
  .description('Clear stored credentials')
  .action(async () => {
    const { runLogout } = await import('./commands/logout.js')
    await runLogout()
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
  .command('budget')
  .description('Check remaining daily/monthly budget and list active loops')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runBudget } = await import('./commands/budget.js')
    await runBudget(opts)
  })

const sopsCmd = program
  .command('sops')
  .description('Manage local and global SOP rules')

sopsCmd
  .command('push <name>')
  .description('Push a local offline SOP folder to the central workspace')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (name, opts) => {
    const { runSopsPush } = await import('./commands/sops.js')
    await runSopsPush(name, opts)
  })

const policyCmd = program
  .command('policy')
  .description('Manage compliance and safety policies')

policyCmd
  .command('enable <policyId>')
  .description('Enable a compliance policy')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (policyId, opts) => {
    const { runPolicyEnable } = await import('./commands/policy.js')
    await runPolicyEnable(policyId, opts)
  })

policyCmd
  .command('disable <policyId>')
  .description('Disable a compliance policy')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (policyId, opts) => {
    const { runPolicyDisable } = await import('./commands/policy.js')
    await runPolicyDisable(policyId, opts)
  })

policyCmd
  .command('rollback <policyId>')
  .description('Rollback a compliance policy to a specific version')
  .requiredOption('--version <version>', 'Target version (e.g. 2)')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (policyId, opts) => {
    const { runPolicyRollback } = await import('./commands/policy.js')
    await runPolicyRollback(policyId, opts)
  })

policyCmd
  .command('snapshot')
  .description(
    'Compile workspace policy to ~/.intutic/hooks/policy-snapshot.rules — the file every gate reads.\n' +
    '\n' +
    '  Does only that. \'intutic connect\' writes it too, but as one step of\n' +
    '  starting the full sync daemon; this arms the gates without one.'
  )
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runPolicySnapshot } = await import('./commands/policy.js')
    await runPolicySnapshot(opts)
  })

policyCmd
  .command('export')
  .description('Export compliance policies to stdout')
  .option('--all', 'Export all policies')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runPolicyExport } = await import('./commands/policy.js')
    await runPolicyExport(opts)
  })

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
  .option('--src <path>', 'Rule source entry file', 'assembly/index.ts')
  .option('--out <path>', 'Output .wasm path', 'build/rule.wasm')
  .option('--debug', 'Include debug info and source maps')
  .action(async (opts) => {
    const { runPolicyCompile } = await import('./commands/policy.js')
    await runPolicyCompile(opts)
  })

policyCmd
  .command('install')
  .description('Validate and install a compiled WASM rule into the local proxy rules dir')
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

program
  .command('whoami')
  .description('Show current authenticated identity')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runWhoami } = await import('./commands/whoami.js')
    await runWhoami(opts)
  })

program
  .command('start')
  .description('Start the proxy standalone — no account or control plane needed')
  .option('--port <port>', 'Proxy port', '4000')
  .option('--valkey-port <port>', 'Valkey port', '6379')
  .option('--upstream-url <url>', 'Upstream LLM provider base URL')
  .action(async (opts) => {
    const { runStart } = await import('./commands/start.js')
    await runStart(opts)
  })

const envCmd = program
  .command('env')
  .description('Persist or clear the proxy base-URL environment variables')

envCmd
  .command('persist')
  .description(
    'Write ANTHROPIC_BASE_URL / OPENAI_BASE_URL at the OS level so they survive a restart.\n' +
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
  .command('connect')
  .description('Start sync daemon — bidirectional config sync with control plane (requires an account)')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .option('--interval <ms>', 'Poll interval in milliseconds', '30000')
  .option('--workspace-id <id>', 'Workspace ID override')
  .option('--api-key <key>', 'Workspace API key override')
  .option('--control-plane-url <url>', 'Control plane URL override')
  .action(async (opts) => {
    const { runConnect } = await import('./commands/connect.js')
    await runConnect(opts)
  })

program
  .command('sync-context')
  .description('Sync Git context metadata to the local daemon')
  .option('--git', 'Sync Git branch and commit information')
  .option('--branch <name>', 'Current Git branch name')
  .option('--commit <hash>', 'Current Git commit SHA')
  .action(async (opts) => {
    const { runSyncContext } = await import('./commands/syncContext.js')
    await runSyncContext(opts)
  })

program
  .command('exec')
  .description('Execute a command wrapped with Intutic proxy environment variables')
  .argument('[command...]', 'Command and arguments to execute (e.g. -- claude)')
  .action(async (commandAndArgs: string[]) => {
    const { runExec } = await import('./commands/exec.js')
    await runExec(commandAndArgs)
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
  .option('--action <type>', 'Filter by enforcement action (BYPASS|ENHANCE|HIJACK|KILL)')
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

// ── Trace integrity ────────────────────────────────────────────────────────

const integrity = program
  .command('integrity')
  .description(
    'Verify sealed trace roots — list, re-derive, walk the root chain, and walk the config snapshot chain'
  )

integrity
  .command('roots')
  .description('List sealed Merkle roots for the workspace, newest first')
  .option('--loop-run <id>', 'Only roots sealed for this loop run')
  .option('--json', 'Output as JSON instead of table')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runIntegrityRoots } = await import('./commands/integrity.js')
    await runIntegrityRoots(opts)
  })

integrity
  .command('verify <root_id>')
  .description('Re-derive a root from the live traces and check its signature (exit 1 on mismatch)')
  .option('--json', 'Output as JSON instead of a report')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (rootId, opts) => {
    const { runIntegrityVerify } = await import('./commands/integrity.js')
    await runIntegrityVerify(rootId, opts)
  })

integrity
  .command('chain')
  .description('Walk the previous_root chain and report deleted roots (exit 1 on a break)')
  .option('--json', 'Output as JSON instead of a report')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runIntegrityChain } = await import('./commands/integrity.js')
    await runIntegrityChain(opts)
  })

integrity
  .command('config-chain')
  .description(
    'Walk the harness config snapshot chain and re-hash each stored body ' +
    '(exit 1 on a break or a content mismatch)'
  )
  .option('--json', 'Output as JSON instead of a report')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runIntegrityConfigChain } = await import('./commands/integrity.js')
    await runIntegrityConfigChain(opts)
  })

// ── Daemon persistence (WS-5 — Q3 Layer 4) ─────────────────────────────────

const daemon = program
  .command('daemon')
  .description('Manage the Intutic sync-daemon system service (LaunchAgent / systemd)')

daemon
  .command('install')
  .alias('install-daemon')  // top-level alias for discoverability
  .description(
    'Install sync-daemon as a system service (auto-starts on login, restarts on any exit).\n' +
    '  macOS: ~/Library/LaunchAgents/ai.intutic.sync-daemon.plist (KeepAlive: true)\n' +
    '  Linux: ~/.config/systemd/user/intutic-sync-daemon.service (Restart=always)\n' +
    '\n' +
    '  NOTE: To stop the daemon you MUST use \'intutic daemon uninstall\' or \'launchctl unload\'.\n' +
    '  \'intutic disconnect\' alone will NOT stop a daemon-installed service. (TD-154)'
  )
  .requiredOption('--workspace-id <id>', 'Workspace ID (e.g. wk_xxxx)')
  .requiredOption('--api-key <key>', 'Workspace API key (e.g. vk_xxxx)')
  .option('--control-plane-url <url>', 'Control plane URL', 'https://api.intutic.ai')
  .option('--binary-path <path>', 'Path to intutic CLI binary (defaults to current process)')
  .option('--dry-run', 'Print what would be done without writing files')
  .option('--system', 'Install as a system-level service (LaunchDaemon on macOS, systemd system unit on Linux)')
  .option('--mcp', 'Install the MCP proxy daemon instead of the sync-daemon')
  .action(async (opts) => {
    // `installMcpDaemon` and `buildMcpPlist` were written, tested and exported,
    // and then nothing called them: every route into install-daemon.ts landed
    // on `installDaemon`, so the MCP proxy daemon could not be installed by any
    // command the CLI offered (TD-153). This flag is that missing route.
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

daemon
  .command('uninstall')
  .alias('uninstall-daemon')
  .description('Remove the sync-daemon system service and stop it permanently.')
  .option('--dry-run', 'Print what would be done without writing files')
  .option('--system', 'Uninstall the system-level service')
  .option('--mcp', 'Uninstall the MCP proxy daemon instead of the sync-daemon')
  .action(async (opts) => {
    const { uninstallDaemon, uninstallMcpDaemon } = await import('./commands/install-daemon.js')
    const uninstall = opts.mcp ? uninstallMcpDaemon : uninstallDaemon
    await uninstall({ dryRun: opts.dryRun, system: opts.system })
  })

daemon
  .command('status')
  .description('Show sync-daemon system service status.')
  .action(async () => {
    const { daemonStatus } = await import('./commands/install-daemon.js')
    await daemonStatus()
  })

daemon
  .command('stop')
  .description('Stop and unload the sync-daemon system service.')
  .action(async () => {
    const { daemonStop } = await import('./commands/install-daemon.js')
    await daemonStop()
  })

daemon
  .command('start')
  .description('Start and load the sync-daemon system service.')
  .action(async () => {
    const { daemonStart } = await import('./commands/install-daemon.js')
    await daemonStart()
  })

// Top-level shortcuts (for discoverability)
program
  .command('install-daemon', { hidden: false })
  .description('Shortcut for \'intutic daemon install\' — install sync-daemon as system service')
  .requiredOption('--workspace-id <id>', 'Workspace ID')
  .requiredOption('--api-key <key>', 'Workspace API key')
  .option('--control-plane-url <url>', 'Control plane URL', 'https://api.intutic.ai')
  .option('--binary-path <path>', 'Path to intutic CLI binary')
  .option('--dry-run', 'Print what would be done without writing files')
  .option('--system', 'Install as a system-level service')
  .action(async (opts) => {
    const { installDaemon } = await import('./commands/install-daemon.js')
    await installDaemon({
      workspaceId: opts.workspaceId,
      apiKey: opts.apiKey,
      controlPlaneUrl: opts.controlPlaneUrl,
      binaryPath: opts.binaryPath,
      dryRun: opts.dryRun,
      system: opts.system,
    })
  })

program
  .command('uninstall-daemon', { hidden: false })
  .description('Shortcut for \'intutic daemon uninstall\'')
  .option('--dry-run', 'Print what would be done without writing files')
  .option('--system', 'Uninstall the system-level service')
  .option('--mcp', 'Uninstall the MCP proxy daemon instead of the sync-daemon')
  .action(async (opts) => {
    const { uninstallDaemon, uninstallMcpDaemon } = await import('./commands/install-daemon.js')
    const uninstall = opts.mcp ? uninstallMcpDaemon : uninstallDaemon
    await uninstall({ dryRun: opts.dryRun, system: opts.system })
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
  .action(async () => {
    const { runSkillAudit } = await import('./commands/skill.js')
    await runSkillAudit()
  })

// ── Loop commands ──────────────────────────────────────────────────────────
const loopCmd = program
  .command('loop')
  .description('Manage and execute recursive agent loops with budget limits')

loopCmd
  .command('start')
  .description('Register and start an active loop execution session')
  .requiredOption('--name <name>', 'Name of the loop execution')
  .option('--budget <limit>', 'Maximum token spend budget in USD (e.g. 5.00)')
  .option('--sops <sops>', 'Comma-separated local SOP folder names or option indices')
  .option('--auto-judge', 'Enable automatic E2E judging for the loop')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runLoopStart } = await import('./commands/skill.js')
    await runLoopStart(opts)
  })

loopCmd
  .command('complete <loopRunId>')
  .description('Mark a running loop as successfully completed')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (loopRunId, opts) => {
    const { runLoopComplete } = await import('./commands/skill.js')
    await runLoopComplete(loopRunId, opts)
  })

loopCmd
  .command('kill <loopRunId>')
  .description('Kill an active loop and prevent subsequent API requests')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (loopRunId, opts) => {
    const { runLoopKill } = await import('./commands/skill.js')
    await runLoopKill(loopRunId, opts)
  })

loopCmd
  .command('review <loopRunId>')
  .description('Approve or reject a loop run held for human review')
  .option('--approve', 'Release the hold; the run resumes')
  .option('--reject', 'Refuse the hold; the run is killed')
  .option('--note <note>', 'Why, recorded against the run')
  .option('--dev', 'Target the local control plane')
  .action(async (loopRunId, opts) => {
    const { runLoopReview } = await import('./commands/skill.js')
    await runLoopReview(loopRunId, opts)
  })

loopCmd
  .command('list')
  .description('List loop runs and cost accounting details for the workspace')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runLoopList } = await import('./commands/skill.js')
    await runLoopList(opts)
  })

loopCmd
  .command('exec')
  .description('Execute an agent command wrapped with loop budget boundaries')
  .option('--name <name>', 'Name of the loop execution')
  .option('--budget <limit>', 'Maximum token spend budget in USD (e.g. 5.00)')
  .option('--sops <sops>', 'Comma-separated local SOP folder names or option indices')
  .option('--auto-judge', 'Enable automatic E2E judging for the loop')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .argument('<command...>', 'Agent execution command (e.g. -- claude-code)')
  .action(async (commandAndArgs: string[], opts) => {
    const { runLoopExec } = await import('./commands/skill.js')
    await runLoopExec(commandAndArgs, opts)
  })


program.parse()
