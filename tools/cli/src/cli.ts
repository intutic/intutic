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
  .command('rollback')
  .description('List or restore pre-images captured when a guard flagged a file-writing call')
  .option('--list', 'List captured pre-images (the default with no --id)')
  .option('--id <id>', 'Restore the named pre-image')
  .action(async (opts) => {
    const { runRollback } = await import('./commands/rollback.js')
    await runRollback(opts)
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

// L2 mandatory egress firewall (LLD #63 §5). Makes the governing proxy
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
    .option('--uid <uid>', 'uid the proxy runs as, exempted from the deny (defaults to current user)')
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
  // Run the agent inside an isolated sandbox whose ONLY egress is the proxy
  // (LLD #63 §6): cap-drop, no-new-privileges, read-only rootfs, resource caps,
  // and a default-deny egress firewall the agent cannot undo.
  .option('--sandbox [kind]', 'Run the agent in an isolated sandbox (kind: oci | firecracker; default oci)')
  .option('--sandbox-image <image>', 'Sandbox image (must contain the agent + nftables + capsh)', 'intutic/sandbox:latest')
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


// ── Decision commands ────────────────────────────────────────────────────
//
// The real front door for a review_before hold. See commands/decision.ts's
// module doc for why `intutic loop review` was never the right command for
// this — it addresses a different id space (Loop Runs, not decisions).
const decisionCmd = program
  .command('decision')
  .description('Approve or reject a decision (e.g. a review_before hold) held for human review')

decisionCmd
  .command('approve <holdId>')
  .description('Approve a held decision; may also unblock the exact retried call, if the workspace opted in')
  .option('--reason <reason>', 'Why, recorded against the decision')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (holdId, opts) => {
    const { runDecisionApprove } = await import('./commands/decision.js')
    await runDecisionApprove(holdId, opts)
  })

decisionCmd
  .command('reject <holdId>')
  .description('Reject a held decision')
  .option('--reason <reason>', 'Why, recorded against the decision')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (holdId, opts) => {
    const { runDecisionReject } = await import('./commands/decision.js')
    await runDecisionReject(holdId, opts)
  })

// ── Gateway commands (LLD #66) ───────────────────────────────────────────
//
// Self-hosted gateway registration/management. Previously reachable only by
// hand-written curl against services/control-plane/src/routes/gateways.ts —
// see commands/gateway.ts's module doc.
const gatewayCmd = program
  .command('gateway')
  .description('Manage self-hosted gateway registrations (Docker / Kubernetes / bare-metal)')

gatewayCmd
  .command('register')
  .description('Register a new self-hosted gateway and print its one-time gwk_ token')
  .requiredOption('--name <name>', 'Display name for this gateway')
  .requiredOption('--target <docker|kubernetes|bare_metal>', 'Deployment target')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runGatewayRegister } = await import('./commands/gateway.js')
    await runGatewayRegister(opts)
  })

gatewayCmd
  .command('list')
  .description("List the org's registered gateways")
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runGatewayList } = await import('./commands/gateway.js')
    await runGatewayList(opts)
  })

gatewayCmd
  .command('status <gateway_id>')
  .description('Live heartbeat-derived status for one gateway')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (gatewayId, opts) => {
    const { runGatewayStatus } = await import('./commands/gateway.js')
    await runGatewayStatus(gatewayId, opts)
  })

gatewayCmd
  .command('rotate <gateway_id>')
  .description('Issue a new gwk_ token; the old one keeps working during the rotation grace period')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (gatewayId, opts) => {
    const { runGatewayRotate } = await import('./commands/gateway.js')
    await runGatewayRotate(gatewayId, opts)
  })

gatewayCmd
  .command('revoke <gateway_id>')
  .description('Revoke a gateway immediately (kills any active rotation grace period too)')
  .option('--reason <text>', 'Recorded in the audit log')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (gatewayId, opts) => {
    const { runGatewayRevoke } = await import('./commands/gateway.js')
    await runGatewayRevoke(gatewayId, opts)
  })

const gatewayConfigCmd = gatewayCmd
  .command('config')
  .description('Manage a gateway\'s remote config (requireVk, requireProvisionedKey)')

gatewayConfigCmd
  .command('set <gateway_id>')
  .description('Update one or both config flags on a gateway')
  .option('--require-vk <true|false>', 'Refuse non-vk_ bearer tokens at this gateway')
  .option('--require-provisioned-key <true|false>', 'Refuse workspaces with no provisioned upstream key')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (gatewayId, opts) => {
    const { runGatewayConfigSet } = await import('./commands/gateway.js')
    await runGatewayConfigSet(gatewayId, opts)
  })

gatewayCmd
  .command('assign')
  .description('Assign (or clear) the gateway this workspace or org defaults to')
  .option('--gateway <gateway_id>', 'Gateway to assign')
  .option('--clear', 'Clear the current assignment instead of setting one')
  .option('--org <org_id>', 'Set the ORG default instead of this workspace\'s own override')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runGatewayAssign } = await import('./commands/gateway.js')
    await runGatewayAssign(opts)
  })

gatewayCmd
  .command('resolve')
  .description('Show which gateway this workspace currently resolves to (own override, org default, or shared)')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runGatewayResolve } = await import('./commands/gateway.js')
    await runGatewayResolve(opts)
  })

// ── Provider credentials (LLD #64 §4, LLD #67) ───────────────────────────
//
// Provision a workspace's own upstream provider keys — the BYO-key wizard's
// API, previously dashboard-only. See commands/credentials.ts's module doc.
const credentialsCmd = program
  .command('credentials')
  .description('Manage this workspace\'s own upstream provider API keys (BYO-key)')

credentialsCmd
  .command('list')
  .description('Provisioning status for every registry provider')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runCredentialsList } = await import('./commands/credentials.js')
    await runCredentialsList(opts)
  })

credentialsCmd
  .command('set <provider>')
  .description('Provision or rotate a provider credential (e.g. --field apiKey=sk-ant-...)')
  .option('--field <key=value>', 'A credential field; repeat for multi-field providers', (v, prev: string[]) => [...prev, v], [] as string[])
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (provider, opts) => {
    const { runCredentialsSet } = await import('./commands/credentials.js')
    await runCredentialsSet(provider, opts)
  })

credentialsCmd
  .command('unset <provider>')
  .description('Remove a provisioned provider credential')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (provider, opts) => {
    const { runCredentialsUnset } = await import('./commands/credentials.js')
    await runCredentialsUnset(provider, opts)
  })

// ── Org signup + team management (LLD #65) ───────────────────────────────
const orgCmd = program
  .command('org')
  .description('Create and manage orgs')

orgCmd
  .command('create')
  .description(
    'Create a real org (paid tier, 30-day trial) with a default team and workspace. ' +
      'Requires `intutic login` first and DNS domain-ownership verification.',
  )
  .option('--org-name <orgName>', 'Organization name (prompted if omitted)')
  .option('--domain <domain>', 'Domain to verify ownership of (prompted if omitted)')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runOrgCreate } = await import('./commands/org.js')
    await runOrgCreate(opts)
  })

const teamCmd = program
  .command('team')
  .description('Manage teams and workspaces under an org')

teamCmd
  .command('list')
  .description("List an org's teams")
  .requiredOption('--org <org_id>', 'Org ID')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runTeamList } = await import('./commands/team.js')
    await runTeamList(opts)
  })

teamCmd
  .command('create')
  .description('Create a new team under an org')
  .requiredOption('--org <org_id>', 'Org ID')
  .requiredOption('--name <name>', 'Team name')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runTeamCreate } = await import('./commands/team.js')
    await runTeamCreate(opts)
  })

teamCmd
  .command('workspaces <team_id>')
  .description('List the workspaces under a team')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (teamId, opts) => {
    const { runTeamWorkspaces } = await import('./commands/team.js')
    await runTeamWorkspaces(teamId, opts)
  })

teamCmd
  .command('create-workspace <team_id>')
  .description('Create a new workspace under a team; you become its OWNER')
  .requiredOption('--name <name>', 'Workspace name')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (teamId, opts) => {
    const { runTeamCreateWorkspace } = await import('./commands/team.js')
    await runTeamCreateWorkspace(teamId, opts)
  })

program.parse()
