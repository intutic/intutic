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
import { DEFAULT_SANDBOX_IMAGE } from './lib/sandbox/image.js'

// Read the version from package.json rather than repeating it here. The literal
// that used to live below said 1.6.0 for three releases running, so
// `intutic --version` reported a version the user did not have — and any check
// of it was worthless, since it printed the same string regardless of what was
// installed. createRequire because this is ESM, where `require` is unavailable
// but JSON imports still need an assertion on older runtimes.
const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

const program = new Command()

// Positional options: `--version` and `--help` belong to the program only when
// they come before a subcommand. Without this, commander matches program
// options anywhere on the line, so `intutic policy rollback <id> --version 2`
// printed the CLI version and exited before `policy rollback` ever saw its own
// required `--version`.
program
  .name('intutic')
  .description('Intutic CLI — AI governance control plane for developer workspaces')
  .version(version)
  .enablePositionalOptions()

program
  .command('init')
  .description('Initialize workspace — detect harnesses and record them in ~/.intutic/config.json')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .option('--git-hooks', 'Install the Intutic Git hooks without asking')
  .option('--no-git-hooks', 'Skip the Git hooks without asking (the default when stdin is not a terminal)')
  .action(async (opts) => {
    const { runInit } = await import('./commands/init.js')
    await runInit(opts)
  })

// ── Cohort setup wizard (LLD #70) ────────────────────────────────────────
program
  .command('setup')
  .description('Guided setup: detect harnesses, configure a provider credential, and verify it')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runSetup } = await import('./commands/setup.js')
    await runSetup(opts)
  })

const judgeCmd = program
  .command('judge')
  .description('Configure the LLM-as-judge path')

judgeCmd
  .command('configure')
  .description('Generate local artifacts (litellm_config.yaml, env, Helm values) for an on-prem judge on a self-hosted model — never a remote API call')
  .option('--out <path>', 'Where to write litellm_config.yaml', './litellm_config.yaml')
  .action(async (opts) => {
    const { runJudgeConfigure } = await import('./commands/judge.js')
    await runJudgeConfigure(opts)
  })

program
  .command('login')
  .description('Authenticate with the Intutic control plane')
  .option('--api-key <key>', 'Authenticate with an API key (vk_*)')
  .option('--control-plane-url <url>', 'Control plane to log in to (e.g. a self-hosted one); saved for every later command')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runLogin } = await import('./commands/login.js')
    await runLogin(opts)
  })

program
  .command('disconnect')
  .description('Undo intutic connect: restore every harness config it changed, remove its services, and log out')
  .option('--harness <id>', 'Disconnect one harness only (credentials and services stay)')
  .option('--dry-run', 'Print exactly what would change, and change nothing')
  .option('--keep-login', 'Keep the stored credentials')
  .action(async (opts) => {
    const { runDisconnect } = await import('./commands/disconnect.js')
    await runDisconnect({ harness: opts.harness, dryRun: opts.dryRun, keepLogin: opts.keepLogin })
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

program
  .command('predict-cost')
  .description(
    'Pre-flight cost estimate for a prompt/task before it runs (requires `intutic login`). ' +
    "Estimates output tokens from the workspace's recorded usage and prices them with the same " +
    'rate table as every other cost figure the control plane reports.'
  )
  .requiredOption('--model <model>', 'Model to estimate against (e.g. claude-sonnet-4-5)')
  .option('--tokens <n>', 'Input token count (mutually exclusive with --file)')
  .option('--file <path>', 'File whose contents size the input (mutually exclusive with --tokens)')
  .option('--json', 'Output as JSON instead of a report')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runPredictCost } = await import('./commands/predict-cost.js')
    await runPredictCost(opts)
  })

const sopsCmd = program
  .command('sops')
  .description('Manage local and global SOP rules')

sopsCmd
  .command('push <name>')
  .description('Push a local offline SOP folder to the central workspace')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .option('--org', "Push as an org-wide floor instead of a workspace SOP -- applies to every workspace under the caller's org, in addition to that workspace's own SOPs")
  .action(async (name, opts) => {
    const { runSopsPush } = await import('./commands/sops.js')
    await runSopsPush(name, opts)
  })

sopsCmd
  .command('pull')
  .description('Pull every workspace SOP from the control plane into .intutic/sops/<slug>.md')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .option('--force', 'Overwrite locally-modified files instead of refusing them')
  .action(async (opts) => {
    const { runSopsPull } = await import('./commands/sops.js')
    await runSopsPull(opts)
  })

sopsCmd
  .command('status')
  .description('Show drift between .intutic/sops/*.md and the control plane, read-only')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runSopsStatus } = await import('./commands/sops.js')
    await runSopsStatus(opts)
  })

sopsCmd
  .command('org-list')
  .description("List org-wide SOP floors for the caller's own org")
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runSopsOrgList } = await import('./commands/sops.js')
    await runSopsOrgList(opts)
  })

sopsCmd
  .command('org-rm <orgSopId>')
  .description('Remove (soft-delete) an org-wide SOP floor')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (orgSopId, opts) => {
    const { runSopsOrgRm } = await import('./commands/sops.js')
    await runSopsOrgRm(orgSopId, opts)
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
  .option('--src <path>', 'Rule source entry file (default: assembly/index.ts)')
  .option('--out <path>', 'Output .wasm path (default: build/rule.wasm, or build/<candidate>.wasm with --candidate)')
  .option('--debug', 'Include debug info and source maps')
  .option('--candidate <id>', 'Compile a rule candidate from its source of record on the control plane (fetched and hash-verified; not with --src)')
  .option('--upload', 'With --candidate: upload the bundle to the candidate with its source hash and print the gate results')
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

policyCmd
  .command('replay <ruleId>')
  .description(
    "Replay a rule (installed or not) against this workspace's own recent traffic and report " +
    'what it would have done, without touching enforcement.'
  )
  .option('--limit <n>', 'Max sampled contexts to replay against (default 500, capped at 5000)')
  .option('--since <duration>', 'Only contexts at or after this time — relative ("7d", "24h") or ISO 8601')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (ruleId, opts) => {
    const { runPolicyReplay } = await import('./commands/policy.js')
    await runPolicyReplay(ruleId, opts)
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

// Policy Clause Ledger (LLD #71). `intutic policy` is the WASM loop and
// `intutic sops` is files on disk; this namespace is the cited guardrails
// extracted from policy documents and their shadow -> promote lifecycle.
const guardrailsCmd = program
  .command('guardrails')
  .description('Policy documents, cited clauses and the guardrails compiled from them')

const guardrailsSourcesCmd = guardrailsCmd
  .command('sources')
  .description('Policy sources (Notion, Confluence, GitHub, Google Docs) feeding the ledger')

guardrailsSourcesCmd
  .command('list')
  .description('List configured policy sources and their last sync')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runGuardrailsSourcesList } = await import('./commands/guardrails.js')
    await runGuardrailsSourcesList(opts)
  })

guardrailsSourcesCmd
  .command('add <provider>')
  .description('Connect a policy source; the credential is read from --token or --token-file, never echoed')
  .requiredOption('--name <name>', 'Display name for the source')
  .option('--token <token>', 'Provider credential (integration token or API key)')
  .option('--token-file <path>', 'Read the credential from a file (a Google service-account key JSON)')
  .option('--config <json>', 'Provider-specific settings as a JSON object (gdrive: {"folder_id": "…"})')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (provider, opts) => {
    const { runGuardrailsSourcesAdd } = await import('./commands/guardrails.js')
    await runGuardrailsSourcesAdd(provider, opts)
  })

guardrailsSourcesCmd
  .command('sync <connectorId>')
  .description('Pull the source now instead of waiting for the next cron pass')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (connectorId, opts) => {
    const { runGuardrailsSourcesSync } = await import('./commands/guardrails.js')
    await runGuardrailsSourcesSync(connectorId, opts)
  })

const guardrailsDocsCmd = guardrailsCmd
  .command('docs')
  .description('Ingested policy documents and their citable passages')

guardrailsDocsCmd
  .command('list')
  .description('List ingested policy documents')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runGuardrailsDocsList } = await import('./commands/guardrails.js')
    await runGuardrailsDocsList(opts)
  })

guardrailsDocsCmd
  .command('show <docId>')
  .description('Show a document, its passages and the clauses extracted from them')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (docId, opts) => {
    const { runGuardrailsDocsShow } = await import('./commands/guardrails.js')
    await runGuardrailsDocsShow(docId, opts)
  })

guardrailsDocsCmd
  .command('extract <docId>')
  .description('Propose cited guardrails from a document (every proposal is re-validated deterministically)')
  .option('--no-llm', 'Only lift existing SOP front matter; do not call the extraction model')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (docId, opts) => {
    const { runGuardrailsDocsExtract } = await import('./commands/guardrails.js')
    await runGuardrailsDocsExtract(docId, { ...opts, noLlm: opts.llm === false })
  })

guardrailsCmd
  .command('search <token>')
  .description('Which passages and guardrails mention a tool or action token (e.g. Bash, terraform); with --text, which passages use these words')
  .option('--text', 'Full-text search over the words of every live passage instead of an exact token')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (token, opts) => {
    const { runGuardrailsSearch } = await import('./commands/guardrails.js')
    await runGuardrailsSearch(token, opts)
  })

guardrailsCmd
  .command('list')
  .description('List guardrails with their status and shadow evidence')
  .option('--status <status>', 'PROPOSED | SHADOW | ENFORCING | REJECTED | RETIRED')
  .option('--target <target>', 'hook_rule | sop_front_matter | wasm_rule | workspace_setting')
  .option('--provenance <provenance>', 'extracted | authored')
  .option('--doc <docId>', 'Only guardrails cited from this document')
  .option('--limit <n>', 'Max rows (default 50, capped at 200)')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runGuardrailsList } = await import('./commands/guardrails.js')
    await runGuardrailsList(opts)
  })

guardrailsCmd
  .command('show <guardrailId>')
  .description('Show a guardrail: cited passage, rendered artifact, validation checks and readiness')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (guardrailId, opts) => {
    const { runGuardrailsShow } = await import('./commands/guardrails.js')
    await runGuardrailsShow(guardrailId, opts)
  })

/** The IR flags `guardrails create` and `guardrails update` share; a file (`--file`) is the alternative. */
function guardrailIrOptions(cmd: Command): Command {
  return cmd
    .option('--file <path>', 'YAML or JSON: a bare IR, or { name, description, ir }')
    .option('--name <name>', 'One-line label (at most 80 characters)')
    .option('--description <text>', 'What the rule is for; shown where an extracted guardrail shows its quote')
    .option('--kind <kind>', 'hook_rule | deny_tools | review_before | requires_before | forbid_after | max_calls | forbid_with | wasm_predicate | allowed_models | egress_allow')
    .option('--title <title>', 'hook_rule, wasm_predicate: the title in the block message')
    .option('--tools <list>', 'hook_rule, deny_tools: comma-separated tool names')
    .option('--tokens <list>', 'review_before: comma-separated tool or action tokens')
    .option('--arg-contains <literal>', 'hook_rule: fire only when the input contains this (repeatable)', (v: string, prev: string[] = []) => [...prev, v])
    .option('--arg-not-contains <literal>', 'hook_rule: fire only when the input does not contain this (repeatable)', (v: string, prev: string[] = []) => [...prev, v])
    .option('--first <token>', 'requires_before, forbid_after: the first token')
    .option('--then <token>', 'requires_before, forbid_after: the second token')
    .option('--token <token>', 'max_calls, forbid_with: the token')
    .option('--limit <n>', 'max_calls: the most calls allowed')
    .option('--taint <taint>', 'forbid_with: secrets() | pii()')
    .option('--roles <list>', 'Comma-separated roles the rule applies to (default: everyone)')
    .option('--models <list>', 'allowed_models: comma-separated model ids')
    .option('--hosts <list>', 'egress_allow: comma-separated hosts, suffixes or IPv4 CIDRs')
    .option('--rationale <text>', 'wasm_predicate: why it re-asks')
    .option('--predicate <json>', 'wasm_predicate: the predicate as JSON')
    .option('--json', 'Output as JSON')
    .option('--dev', 'Use local control plane (http://localhost:3001)')
}

guardrailIrOptions(
  guardrailsCmd.command('create').description('Author a guardrail directly: the same IR and checks as an extracted one, created PROPOSED'),
).action(async (opts) => {
  const { runGuardrailsCreate } = await import('./commands/guardrails.js')
  await runGuardrailsCreate(opts)
})

guardrailIrOptions(
  guardrailsCmd
    .command('update <guardrailId>')
    .description('Edit an authored guardrail: a name or description in place; a changed IR creates the next version, PROPOSED with no evidence')
    .option('--clear-description', 'Remove the description'),
).action(async (guardrailId, opts) => {
  const { runGuardrailsUpdate } = await import('./commands/guardrails.js')
  await runGuardrailsUpdate(guardrailId, opts)
})

guardrailsCmd
  .command('delete <guardrailId>')
  .description('Retire an authored guardrail and undo what it wrote; its history is kept')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (guardrailId, opts) => {
    const { runGuardrailsDelete } = await import('./commands/guardrails.js')
    await runGuardrailsDelete(guardrailId, opts)
  })

guardrailsCmd
  .command('approve-shadow <guardrailId>')
  .description('Ship a proposed guardrail in shadow: it reports, never blocks')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (guardrailId, opts) => {
    const { runGuardrailsApproveShadow } = await import('./commands/guardrails.js')
    await runGuardrailsApproveShadow(guardrailId, opts)
  })

guardrailsCmd
  .command('promote <guardrailId>')
  .description('Promote a shadow guardrail to enforcing once the server says it is ready (an egress allow list is applied from proposed)')
  .option('--acknowledge-no-traffic', 'Promote a rule that no observed traffic exercised, or apply an egress allow list, which has no shadow evidence')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (guardrailId, opts) => {
    const { runGuardrailsPromote } = await import('./commands/guardrails.js')
    await runGuardrailsPromote(guardrailId, opts)
  })

guardrailsCmd
  .command('reject <guardrailId>')
  .description('Reject a guardrail; the reason is recorded on its authority chain')
  .requiredOption('--reason <reason>', 'Why it is rejected')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (guardrailId, opts) => {
    const { runGuardrailsReject } = await import('./commands/guardrails.js')
    await runGuardrailsReject(guardrailId, opts)
  })

guardrailsCmd
  .command('retire <guardrailId>')
  .description('Retire a shadow or enforcing guardrail; it stops being projected')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (guardrailId, opts) => {
    const { runGuardrailsRetire } = await import('./commands/guardrails.js')
    await runGuardrailsRetire(guardrailId, opts)
  })

guardrailsCmd
  .command('reconfirm <guardrailId>')
  .description('Confirm a guardrail whose cited passage changed upstream still holds')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (guardrailId, opts) => {
    const { runGuardrailsReconfirm } = await import('./commands/guardrails.js')
    await runGuardrailsReconfirm(guardrailId, opts)
  })

guardrailsCmd
  .command('replay <guardrailId>')
  .description('Run a guardrail over captured calls and report how many it would have fired on')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (guardrailId, opts) => {
    const { runGuardrailsReplay } = await import('./commands/guardrails.js')
    await runGuardrailsReplay(guardrailId, opts)
  })

guardrailsCmd
  .command('conflicts')
  .description('List guardrails that contradict each other, with both quotes')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runGuardrailsConflicts } = await import('./commands/guardrails.js')
    await runGuardrailsConflicts(opts)
  })

guardrailsCmd
  .command('impact')
  .description('What a change to a document or passage reaches: passages within five computed edges, the clauses citing them, their guardrails')
  .option('--doc <docId>', 'Start from every live passage of this document')
  .option('--passage <passageId>', 'Start from one passage')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runGuardrailsImpact } = await import('./commands/guardrails.js')
    await runGuardrailsImpact(opts)
  })

guardrailsCmd
  .command('duplicates')
  .description('Overlapping passage pairs (with their Jaccard arithmetic) and the same rule cited from more than one passage')
  .option('--min-jaccard <n>', 'Only pairs at or above this Jaccard (never below the recorded 0.70)')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runGuardrailsDuplicates } = await import('./commands/guardrails.js')
    await runGuardrailsDuplicates(opts)
  })

guardrailsCmd
  .command('pull')
  .description('Write the SHADOW and ENFORCING front-matter guardrails to .intutic/sops/guardrail-<id>.md, for a proxy that reads SOPs from disk')
  .option('--force', 'Overwrite a locally-modified guardrail file instead of refusing it')
  .option('--prune', 'Remove guardrail files that are no longer served (unmodified ones only)')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runGuardrailsPull } = await import('./commands/guardrails.js')
    await runGuardrailsPull(opts)
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
  .option('--port <port>', 'Proxy port (default: the port of $INTUTIC_PROXY_URL, else 4000)')
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

enforceCmd
  .command('report')
  .description(
    'Report locally recorded enforcement state (firewall/CA-trust/system-hooks) to the control plane. ' +
      'No privilege needed — for when apply/remove ran elevated and could not reach stored credentials.',
  )
  .action(async () => {
    const { runEnforce } = await import('./commands/enforce.js')
    await runEnforce('report', {})
  })

// CA-trust rollout, Cursor system hooks, and Jamf/Intune MDM manifest
// generation for a managed fleet. Deliberately named `enterprise install`,
// not the old hyphenated `enterprise-install` — that name collides with
// tools/scripts/intutic-enterprise-install.sh, an unrelated air-gapped
// docker-compose installer. Does not touch the host firewall; see `enforce`.
const enterpriseCmd = program
  .command('enterprise')
  .description('Enterprise fleet rollout: CA trust, Cursor system hooks, MDM manifests')

enterpriseCmd
  .command('install')
  .description('Generate MDM manifests, and (if privileged) install system CA trust + Cursor system hooks')
  .option('--proxy-url <url>', 'Proxy base URL embedded in generated hooks (default: $INTUTIC_PROXY_URL or http://localhost:4000)')
  .option('--generate-mdm-only', 'Only write the MDM manifests; skip CA trust and system hooks (no privilege needed)')
  .option('--mdm-output-dir <dir>', 'Directory to write generated MDM manifests to', './intutic-mdm')
  .option('--skip-ca', 'Skip system-wide CA trust installation')
  .option('--skip-hooks', 'Skip system-level Cursor hooks installation')
  .option('--dev', 'Send the device enforcement report to the local control plane (http://localhost:3001)')
  .option('--cli-binary-path <path>', 'Absolute path to the intutic CLI binary on TARGET machines, embedded in the firewall-deployment manifests (default: /usr/local/bin/intutic — override if your fleet installs elsewhere)')
  .action(async (opts) => {
    const { runEnterpriseInstall } = await import('./commands/enterprise.js')
    await runEnterpriseInstall(opts)
  })

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
  .description('Record the Git branch and commit in .intutic/git-context.json, which a running `intutic connect` reports')
  .option('--git', 'Read the branch and commit from the repository (for any not given below)')
  .option('--branch <name>', 'Current Git branch name')
  .option('--commit <hash>', 'Current Git commit SHA')
  .action(async (opts) => {
    const { runSyncContext } = await import('./commands/syncContext.js')
    await runSyncContext(opts)
  })

program
  .command('decisions-log-refresh')
  .description(
    'One-shot refresh of the governed decisions log (.intutic/DECISIONS.md, and the recent ' +
      'entries in each governed harness\'s instructions file) — no-ops if decisionsLogEnabled is off. Invoked by the optional ' +
      'post-merge Git hook `intutic init` installs; safe to run manually.',
  )
  .action(async () => {
    const { refreshDecisionsLog } = await import('./lib/decisionsLogRefresh.js')
    const result = await refreshDecisionsLog(process.cwd())
    if (!result.refreshed && result.reason) {
      const { log } = await import('./lib/logger.js')
      log.dim(`Decisions log not refreshed: ${result.reason}`)
    }
  })

program
  .command('exec')
  .description('Execute a command wrapped with Intutic proxy environment variables')
  .argument('[command...]', 'Command and arguments to execute (e.g. -- claude)')
  // Run the agent inside an isolated sandbox whose ONLY egress is the proxy
  // (LLD #63 §6): cap-drop, no-new-privileges, read-only rootfs, resource caps,
  // and a default-deny egress firewall the agent cannot undo.
  .option('--sandbox [kind]', 'Run the agent in an isolated sandbox (kind: oci | firecracker; default oci)')
  .option('--sandbox-image <image>', 'Sandbox image (must contain the agent + nftables + capsh); the default is built locally on first use', DEFAULT_SANDBOX_IMAGE)
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

// ── Findings (detector_findings adjudication) ───────────────────────────────

const findings = program
  .command('findings')
  .description('Query and adjudicate detector findings — the TP/FP labeling surface')

findings
  .command('list')
  .description('List detector findings for the workspace')
  .option('--unadjudicated', 'Only show findings nobody has ruled on yet (default: all findings)')
  .option('--detector <id>', 'Filter by detector_id (e.g. response_injection:override-instructions)')
  .option('--limit <n>', 'Max rows to return (default: 100, max: 500)')
  .option('--json', 'Output as JSON instead of table')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runFindingsList } = await import('./commands/findings.js')
    await runFindingsList(opts)
  })

findings
  .command('adjudicate <findingId>')
  .description('Record a human ruling (true/false positive) on one finding')
  .option('--true-positive', 'Mark this finding a true positive')
  .option('--false-positive', 'Mark this finding a false positive')
  .option('--note <text>', 'Optional note recorded with the ruling')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (findingId, opts) => {
    const { runFindingsAdjudicate } = await import('./commands/findings.js')
    await runFindingsAdjudicate(findingId, opts)
  })

findings
  .command('stats')
  .description('Per-detector false-positive rate, computed over adjudicated findings only')
  .option('--json', 'Output as JSON instead of table')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runFindingsStats } = await import('./commands/findings.js')
    await runFindingsStats(opts)
  })

findings
  .command('echo-report')
  .description('Response-injection echo measurement report — per-pattern false-positive rate')
  .option('--since <date>', 'ISO date — window start (default: 7 days before --until)')
  .option('--until <date>', 'ISO date — window end (default: now)')
  .option('--json', 'Output as JSON instead of table')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runFindingsEchoReport } = await import('./commands/findings.js')
    await runFindingsEchoReport(opts)
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
  .option('--against <file>', 'Also compare with the copy of this root mirrored to your own bucket (BYOC)')
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

// ── Routing reports ─────────────────────────────────────────────────────────

const routing = program
  .command('routing')
  .description('Read-only reports for the routing subsystem')

routing
  .command('adoption-report')
  .description(
    'Mirror-test adoption report for one candidate model — win/loss/tie, fault-rate delta, ' +
    'cost delta, latency delta. ' +
    'A reported signal for human review, not an automatic gate.'
  )
  .requiredOption('--candidate-model <model>', 'The mirror-tested candidate model to report on')
  .option('--json', 'Output as JSON instead of a report')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runRoutingAdoptionReport } = await import('./commands/routing.js')
    await runRoutingAdoptionReport(opts)
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
    .option('--control-plane-url <url>', 'Control plane the daemon connects to (default: $INTUTIC_CONTROL_PLANE_URL, then the URL saved by `intutic login`, then https://api.intutic.ai)')
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
    // reachability test widened to the status/stop/start verbs (TD-153's
    // shape, one more time).
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
    // reachability test widened to the status/stop/start verbs (TD-153's
    // shape, one more time).
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
    // reachability test widened to the status/stop/start verbs (TD-153's
    // shape, one more time).
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
  .option('--dev', 'Use local control plane (http://localhost:3001)')
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
  .description('Manage self-hosted gateway registrations (Docker / Kubernetes / bare metal)')

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
  .command('get <gateway_id>')
  .description('Show the config values set on a gateway and their version')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (gatewayId, opts) => {
    const { runGatewayConfigGet } = await import('./commands/gateway.js')
    await runGatewayConfigGet(gatewayId, opts)
  })

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

// ── DCT Token Attenuation (LLD #19 §2.1, HLD §5.6 Patent Family A) ───────
//
// "CLI mints, dashboard audits": this is the mint/inspect half. See
// commands/attenuate.ts's module doc.
const attenuateCmd = program
  .command('attenuate')
  .description('Attenuate an API key to a narrower child key (capability subset + optional TTL)')
  .option('--parent-key <keyId>', 'Parent API key ID to attenuate')
  .option('--caps <caps>', 'Comma-separated capability subset to grant the child key')
  .option('--ttl <seconds>', 'Child key TTL in whole seconds, 60 to 86400 (default 14400)')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runAttenuate } = await import('./commands/attenuate.js')
    await runAttenuate(opts)
  })

attenuateCmd
  .command('chain <chainId>')
  .description('Resolve the full delegation lineage for an attenuation chain')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (chainId, opts) => {
    const { runAttenuateChain } = await import('./commands/attenuate.js')
    await runAttenuateChain(chainId, opts)
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
  .option('--region <region>', "Gateway cell region (e.g. 'us', 'eu'); server-validated, defaults to the deployment's home region")
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

// ── Operator commands ────────────────────────────────────────────────────
//
// Workspace settings, the MCP server registry, notification rules, SIEM
// destinations and the fleet reports, each over its existing control-plane
// route. Previously dashboard-only. See commands/apiCommand.ts for the shape
// they share.
const settingsCmd = program
  .command('settings')
  .description('Read and change workspace settings (MCP policy, budgets, group policy, config content upload, ...)')

settingsCmd
  .command('get [key]')
  .description('Print every workspace setting, or one')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (key, opts) => {
    const { runSettingsGet } = await import('./commands/settings.js')
    await runSettingsGet(key, opts)
  })

settingsCmd
  .command('set <key> [value]')
  .description('Change one setting; the value is JSON when it parses as JSON, else a string')
  .option('--file <path>', 'Read the value from a JSON file instead')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (key, value, opts) => {
    const { runSettingsSet } = await import('./commands/settings.js')
    await runSettingsSet(key, value, opts)
  })

const mcpCmd = program
  .command('mcp')
  .description('Review the MCP servers the workspace\'s MCP proxies have seen, and decide on them')

mcpCmd
  .command('list')
  .description('Every MCP server seen, its status and tools, and the registry\'s default policy')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runMcpList } = await import('./commands/mcp.js')
    await runMcpList(opts)
  })

for (const [action, desc] of [
  ['approve', 'Approve an MCP server; MCP proxies let it run'],
  ['block', 'Block an MCP server; MCP proxies refuse it'],
  ['reset', 'Return an MCP server to the approval queue'],
] as const) {
  mcpCmd
    .command(`${action} <server_id>`)
    .description(desc)
    .option('--json', 'Output as JSON')
    .option('--dev', 'Use local control plane (http://localhost:3001)')
    .action(async (serverId, opts) => {
      const { runMcpDecide } = await import('./commands/mcp.js')
      await runMcpDecide(action, serverId, opts)
    })
}

for (const [action, enabled, desc] of [
  ['enable-tool', true, 'Switch one tool of an MCP server back on'],
  ['disable-tool', false, 'Switch one tool of an MCP server off; MCP proxies refuse calls to it'],
] as const) {
  mcpCmd
    .command(`${action} <server_id> <tool>`)
    .description(desc)
    .option('--json', 'Output as JSON')
    .option('--dev', 'Use local control plane (http://localhost:3001)')
    .action(async (serverId, tool, opts) => {
      const { runMcpTool } = await import('./commands/mcp.js')
      await runMcpTool(serverId, tool, enabled, opts)
    })
}

const notificationsCmd = program
  .command('notifications')
  .description('Manage notification rules: which events go to Slack, email, a webhook or PagerDuty')

function ruleOptions(cmd: Command): Command {
  return cmd
    .option('--slack-channel <id>', 'Slack channel ID, for the slack channel')
    .option('--email <addresses>', 'Comma-separated recipients (up to 20), for the email channel')
    .option('--webhook-url <url>', 'HTTPS URL, for the webhook channel')
    .option('--pagerduty-key <key>', 'Routing key, for the pagerduty channel')
    .option('--severity <list>', 'Only events of these comma-separated severities')
    .option('--harness <list>', 'Only events from these comma-separated harnesses')
    .option('--user <ids>', 'Only events from these comma-separated user ids')
    .option('--cooldown <minutes>', 'Minimum minutes between two notifications of this rule (1-1440)')
    .option('--json', 'Output as JSON')
    .option('--dev', 'Use local control plane (http://localhost:3001)')
}

notificationsCmd
  .command('list')
  .description('List notification rules')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runNotificationsList } = await import('./commands/notifications.js')
    await runNotificationsList(opts)
  })

ruleOptions(
  notificationsCmd
    .command('create')
    .description('Create a notification rule; a webhook rule prints its signing secret once')
    .requiredOption('--event <type>', 'Event type, e.g. incident.created or mcp.server.candidate')
    .requiredOption('--channel <channel>', 'slack, email, webhook or pagerduty')
    .option('--disabled', 'Create the rule switched off'),
).action(async (opts) => {
  const { runNotificationsCreate } = await import('./commands/notifications.js')
  await runNotificationsCreate(opts)
})

ruleOptions(
  notificationsCmd
    .command('update <rule_id>')
    .description('Change a notification rule; only the fields given change')
    .option('--event <type>', 'Event type')
    .option('--channel <channel>', 'slack, email, webhook or pagerduty')
    .option('--enable', 'Switch the rule on')
    .option('--disable', 'Switch the rule off'),
).action(async (ruleId, opts) => {
  const { runNotificationsUpdate } = await import('./commands/notifications.js')
  await runNotificationsUpdate(ruleId, opts)
})

notificationsCmd
  .command('delete <rule_id>')
  .description('Delete a notification rule')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (ruleId, opts) => {
    const { runNotificationsDelete } = await import('./commands/notifications.js')
    await runNotificationsDelete(ruleId, opts)
  })

notificationsCmd
  .command('rotate-secret <rule_id>')
  .description('Replace a webhook rule\'s signing secret and print the new one once')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (ruleId, opts) => {
    const { runNotificationsRotateSecret } = await import('./commands/notifications.js')
    await runNotificationsRotateSecret(ruleId, opts)
  })

const siemCmd = program
  .command('siem')
  .description('Manage SIEM export destinations and the event sources each receives')

function destinationOptions(cmd: Command): Command {
  return cmd
    .option('--sources <list>', 'Comma-separated event sources this destination receives (see `intutic siem sources`)')
    .option('--default-sources', 'Receive the default set: every source except the opt-in ones')
    .option('--batch-size <n>', 'Events per delivery batch')
    .option('--flush-interval-ms <ms>', 'Longest wait before a partial batch is sent')
    .option('--json', 'Output as JSON')
    .option('--dev', 'Use local control plane (http://localhost:3001)')
}

siemCmd
  .command('list')
  .description('List SIEM destinations (credentials masked)')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runSiemList } = await import('./commands/siem.js')
    await runSiemList(opts)
  })

siemCmd
  .command('show <destination_id>')
  .description('Show one SIEM destination (credentials masked)')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (destinationId, opts) => {
    const { runSiemShow } = await import('./commands/siem.js')
    await runSiemShow(destinationId, opts)
  })

siemCmd
  .command('sources')
  .description('List the event sources a destination can receive, and which are opt-in')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runSiemSources } = await import('./commands/siem.js')
    await runSiemSources(opts)
  })

destinationOptions(
  siemCmd
    .command('create')
    .description('Create a SIEM destination; a webhook destination prints its signing secret once')
    .requiredOption('--name <name>', 'Display name')
    .requiredOption('--type <adapter>', 'syslog_cef, webhook_https, splunk_hec, datadog_logs, gcs or s3')
    .requiredOption('--config <path>', 'JSON file with the adapter settings and credentials'),
).action(async (opts) => {
  const { runSiemCreate } = await import('./commands/siem.js')
  await runSiemCreate(opts)
})

destinationOptions(
  siemCmd
    .command('update <destination_id>')
    .description('Change a SIEM destination; only the fields given change')
    .option('--name <name>', 'Display name')
    .option('--config <path>', 'JSON file with the new adapter settings; a secret left out or left masked keeps its stored value')
    .option('--enable', 'Turn a deactivated destination back on'),
).action(async (destinationId, opts) => {
  const { runSiemUpdate } = await import('./commands/siem.js')
  await runSiemUpdate(destinationId, opts)
})

siemCmd
  .command('delete <destination_id>')
  .description('Deactivate a SIEM destination; it stops receiving events and stays listed')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (destinationId, opts) => {
    const { runSiemDelete } = await import('./commands/siem.js')
    await runSiemDelete(destinationId, opts)
  })

siemCmd
  .command('rotate-secret <destination_id>')
  .description('Replace a webhook destination\'s signing secret and print the new one once')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (destinationId, opts) => {
    const { runSiemRotateSecret } = await import('./commands/siem.js')
    await runSiemRotateSecret(destinationId, opts)
  })

const complianceCmd = program
  .command('compliance')
  .description('Compliance framework reports and the evidence archive')

complianceCmd
  .command('coverage <framework_id>')
  .description('Coverage of eu_ai_act, iso_42001, nist_ai_rmf or mitre_atlas from the latest probe results')
  .option('--format <format>', 'Download the report: json, md, csv or pdf')
  .option('--out <path>', 'Write the report to this file instead of stdout')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (frameworkId, opts) => {
    const { runComplianceCoverage } = await import('./commands/compliance.js')
    await runComplianceCoverage(frameworkId, opts)
  })

complianceCmd
  .command('collect')
  .description('Run a fresh evidence collection and seal it into an archive (OWNER, ADMIN)')
  .option('--from <date>', 'Start of the evidence period, ISO 8601 (default: 90 days before --to)')
  .option('--to <date>', 'End of the evidence period, ISO 8601 (default: now)')
  .option('--out <path>', 'Also write the archive to this file')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runComplianceCollect } = await import('./commands/compliance.js')
    await runComplianceCollect(opts)
  })

complianceCmd
  .command('download <run_id>')
  .description('Download a stored evidence archive (OWNER, ADMIN)')
  .option('--out <path>', 'Write the archive to this file instead of stdout')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (runId, opts) => {
    const { runComplianceDownload } = await import('./commands/compliance.js')
    await runComplianceDownload(runId, opts)
  })

complianceCmd
  .command('verify <file>')
  .description('Check an evidence archive\'s hashes and signature offline')
  .option('--jwks <path>', 'The published signing keys, saved from /.well-known/intutic-trace-signing.json (default: fetch them)')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (file, opts) => {
    const { runComplianceVerify } = await import('./commands/compliance.js')
    await runComplianceVerify(file, opts)
  })

const usageCmd = program
  .command('usage')
  .description('LLM usage across the fleet, by member, team, branch, commit or pull request')

for (const [view, handler, desc] of [
  ['members', 'runUsageMembers', 'Usage per member'],
  ['teams', 'runUsageTeams', 'Usage per team (SCIM group)'],
  ['branches', 'runUsageBranches', 'Usage per repository and branch'],
  ['commits', 'runUsageCommits', 'Usage per HEAD commit'],
] as const) {
  usageCmd
    .command(view)
    .description(desc)
    .option('--period <period>', 'daily (today) or monthly (this month)', 'monthly')
    .option('--json', 'Output as JSON')
    .option('--dev', 'Use local control plane (http://localhost:3001)')
    .action(async (opts) => {
      const usage = await import('./commands/usage.js')
      await usage[handler](opts)
    })
}

usageCmd
  .command('pull-requests')
  .description('Usage per GitHub pull request')
  .option('--period <period>', 'daily (today) or monthly (this month)', 'monthly')
  .option('--refresh', 'Look the branches up on GitHub first (OWNER, ADMIN, EM)')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runUsagePullRequests } = await import('./commands/usage.js')
    await runUsagePullRequests(opts)
  })

const githubWebhookCmd = program
  .command('github')
  .description('GitHub integration for cost per pull request')
  .command('webhook')
  .description('The pull-request webhook: payload URL and signing secret')

githubWebhookCmd
  .command('show')
  .description('Show the payload URL and when the secret was made')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runGithubWebhookShow } = await import('./commands/github.js')
    await runGithubWebhookShow(opts)
  })

githubWebhookCmd
  .command('rotate-secret')
  .description('Make the webhook, or replace its secret (printed once)')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runGithubWebhookRotateSecret } = await import('./commands/github.js')
    await runGithubWebhookRotateSecret(opts)
  })

const inventoryCmd = program
  .command('inventory')
  .description('AI harnesses, MCP servers and skills on connected developer machines, governed or not')

inventoryCmd
  .command('summary')
  .description('Counts of machines, harnesses, MCP servers and skills, and how many are ungoverned')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runInventorySummary } = await import('./commands/inventory.js')
    await runInventorySummary(opts)
  })

for (const [view, handler, desc] of [
  ['harnesses', 'runInventoryHarnesses', 'Harnesses by machine, with gate state and status'],
  ['mcp-servers', 'runInventoryMcpServers', 'MCP servers by machine, wrapped by the MCP proxy or not'],
] as const) {
  inventoryCmd
    .command(view)
    .description(desc)
    .option('--status <status>', 'Only rows with this status')
    .option('--harness <harness>', 'Only rows for this harness')
    .option('--device <device_id>', 'Only rows from this machine')
    .option('--search <text>', 'Only rows whose name or hostname contains this text')
    .option('--csv', 'Download as CSV, the same file the dashboard exports')
    .option('--out <path>', 'With --csv: write to this file instead of stdout')
    .option('--json', 'Output as JSON')
    .option('--dev', 'Use local control plane (http://localhost:3001)')
    .action(async (opts) => {
      const inventory = await import('./commands/inventory.js')
      await inventory[handler](opts)
    })
}

inventoryCmd
  .command('skills')
  .description('Skill bundles by machine, with their content scan result')
  .option('--device <device_id>', 'Only rows from this machine')
  .option('--search <text>', 'Only rows whose name or hostname contains this text')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runInventorySkills } = await import('./commands/inventory.js')
    await runInventorySkills(opts)
  })

program
  .command('gate-liveness')
  .description('Whether each installed harness\'s gate is reporting, and any open silent-gate alert')
  .option('--json', 'Output as JSON')
  .option('--dev', 'Use local control plane (http://localhost:3001)')
  .action(async (opts) => {
    const { runGateLiveness } = await import('./commands/gateLiveness.js')
    await runGateLiveness(opts)
  })

program.parse()
