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

const program = new Command()

program
  .name('intutic')
  .description('Intutic CLI — AI governance control plane for developer workspaces')
  .version('1.5.0')

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

program
  .command('whoami')
  .description('Show current authenticated identity')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runWhoami } = await import('./commands/whoami.js')
    await runWhoami(opts)
  })

program
  .command('connect')
  .description('Start sync daemon — bidirectional config sync with control plane')
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
  .requiredOption('--workspace-id <id>', 'Workspace ID (e.g. ws_xxxx)')
  .requiredOption('--api-key <key>', 'Workspace API key (e.g. vk_xxxx)')
  .option('--control-plane-url <url>', 'Control plane URL', 'https://api.intutic.ai')
  .option('--binary-path <path>', 'Path to intutic CLI binary (defaults to current process)')
  .option('--dry-run', 'Print what would be done without writing files')
  .option('--system', 'Install as a system-level service (LaunchDaemon on macOS, systemd system unit on Linux)')
  .action(async (opts) => {
    const { installDaemon } = await import('./commands/install-daemon.js')
    await installDaemon({
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
  .action(async (opts) => {
    const { uninstallDaemon } = await import('./commands/install-daemon.js')
    await uninstallDaemon({ dryRun: opts.dryRun, system: opts.system })
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
  .action(async (opts) => {
    const { uninstallDaemon } = await import('./commands/install-daemon.js')
    await uninstallDaemon({ dryRun: opts.dryRun, system: opts.system })
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
