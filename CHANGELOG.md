# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.3.0] - 2026-10-10

Everything that reached `main` since 2.2.0. Self-hosted gateway operators
should upgrade promptly (see Security). Check these behaviour changes before
upgrading: the sync daemon regenerates every hook gate as gate body v18
(`GATE_VERSION` 18) on its next cycle, and the gates refuse with new codes:
`COMMAND_TOO_LARGE` for a command over 256 KiB or arguments over 1 MiB,
`GATE_DEADLINE` when a gate is still deciding a second before its harness's
hook timeout (9 seconds for most harnesses, 4 for Windsurf and Muse Code), and
`POLICY_SNAPSHOT_UNVERIFIED` for every MCP call while the policy snapshot fails
its integrity check, observe-only (`SILENT_LOG`) workspaces included; the gates
also apply the MCP server registry, so under `mcpDefaultPolicy: deny` a
harness's own servers (Claude Code's `mcp__ide__…`) are refused until approved.
In `@intutic/gate` and `intutic_clawde.gate` a `.rules` file with no `#digest`
line now counts as unverified, and a hold rule raises `IntuticGateHold` (a
subclass of `IntuticGateRefusal`, code `HELD`) instead of blocking. The clawde
SDKs raise `ClawdeBlockedError` on every in-band proxy refusal, and with a
`vk_` key they register a session on the first call that carries the working
directory's repository, branch and commit (`autoContext: false` /
`auto_context=False` turns it off). The proxies redact payment card numbers and
IBANs by default, and a workspace's `piiDetectors` setting is the baseline that
local config may only tighten; a proxy that fails closed refuses a request when
it cannot read that setting. `intutic connect` now wraps Gemini CLI's and
Antigravity's MCP servers (an SSE-only remote server written as `url` needs
`"type": "sse"`), reports the machine's AI inventory and the repository each
session works in, writes rule sets only to the file each harness reads (never
`CLAUDE.md`), and sets VS Code's `chat.useHooks` and `chat.hookFilesLocations`
back when they would switch off the GitHub Copilot gate. A custom WASM or Rego
rule that reaches no verdict (its deadline, its fuel, a trap or an unreadable
result) now refuses the call with `GOVERNANCE_UNAVAILABLE` in both proxies,
whatever the fail-open settings say, and Rego rules are on by default; the
shipped Rego examples refuse input cut to fit the 64 KB cap, so the
deny-writes example refuses a `Write` over about 64 KB. Destructive-SQL and action
matching catch more spellings, and `DROP DATABASE` and `DROP SCHEMA` are now
`action:db_write`, so expect more holds and refusals. The workspace settings
API now answers `400` for an unknown key inside `featureFlags`,
`imageProvenance`, `anomaly_enforcement`, `banditKeywords` or `byocStorage`
(they were silently dropped), and for a notification rule `eventType` that is
not one of the published event types. `intutic compliance verify` exits `3`
for a file it cannot read. A workspace that never saved a daily cap is held to
$100 a day, enforced as before, and Settings › Billing, `intutic budget` and
`GET /api/v1/budget` (`daily_budget_is_default`) now say when the cap is that
default; save your own on Settings › Billing › Budget Limits or with
`PUT /api/v1/budget`. The control plane now refuses to start (outside
`NODE_ENV=test`/`development`) when `JWT_SECRET` or `ENCRYPTION_KEY` is missing,
a placeholder or under 32 characters, or when the database password or another
shared secret is a placeholder such as `changeme`; the Compose file no longer
defaults `POSTGRES_PASSWORD` to `changeme_prod` and requires it, `JWT_SECRET`
and `ENCRYPTION_KEY` (a Compose install that kept the old default must change
the Postgres role's password first; see the Compose guide). The provider
settings show Gemini as not yet routable: its requests were never translated
to Gemini's format, and Gemini routing arrives in 2.4.0.

### Security

- **Placeholder secrets are refused at boot.** A deployment that kept a
  template value for `JWT_SECRET` let anyone sign a login token for any user.
  The control plane now refuses to start with placeholder or short secrets
  (`JWT_SECRET`, `ENCRYPTION_KEY`, the database URL passwords,
  `SLACK_ENCRYPTION_KEY`, `SLACK_SIGNING_SECRET`, `STRIPE_WEBHOOK_SECRET`,
  `INTUTIC_ADMIN_TOKEN`), and the Kubernetes manifest check fails any overlay or
  chart that renders a placeholder Secret value. Generate secrets with
  `openssl rand -hex 32`. If yours was ever a placeholder, rotate it. A new
  `JWT_SECRET` signs everyone out. A new `ENCRYPTION_KEY` makes the SSO,
  connector and notification secrets sealed under the old one unreadable unless
  they are re-encrypted first; 2.4.0 adds `ENCRYPTION_KEY_PREVIOUS` and a
  re-encryption command for that.
- **Terraform provider dependencies.** `golang.org/x/crypto`, `golang.org/x/net`
  and `google.golang.org/grpc` are updated past their advisories, and the
  provider is built with Go 1.26.9.
- **Advisory for self-hosted deployments: provider API keys are stored
  unencrypted in Valkey.** A workspace's provider credentials live in Valkey,
  which persists them to disk and replicates them to every region's Valkey.
  Until 2.4.0, which encrypts them at the application layer, keep Valkey
  reachable only from the control plane and proxies (network policy or
  firewall), require a password or ACL and TLS, and keep its data volume on an
  encrypted disk.
- **The workspace PII setting could be switched off by a machine.** A proxy
  whose local config turned DLP off (`dlp.enabled: false`, or both scan
  directions off) skipped the workspace's PII detector setting. The workspace
  baseline now always applies, in both directions; local config can only add
  to it. An unreadable setting is refused as `GOVERNANCE_UNAVAILABLE`.
- **A daily spend cap could silently become $100.** The cap was stored with a
  24-hour expiry and the proxy fell back to $100 when the copy expired. Caps
  no longer expire; a proxy whose copy is missing reads it from the control
  plane and refuses with `BUDGET_UNVERIFIABLE` if it cannot.
- **Editing a notification rule could replace its PagerDuty key with the
  mask.** A key that is left out or sent back masked now keeps the stored key.
- **The SDKs sent repository details before confirming the key.** With the
  workspace taken from `INTUTIC_WORKSPACE_ID` or the daemon config, the
  session carrying the repository, branch and commit was registered without
  first checking the key. Both SDKs now always confirm it with
  `GET /api/v1/auth/me`.
- **A redacted reply could be served unredacted from the response cache.**
  Without streaming, a reply that output DLP had redacted was stored in the
  exact cache before redaction, so the next identical request got the
  credential back. Redacted replies are no longer cached.
- **Provider keys reached the control plane.** On a passthrough proxy the
  request's bearer can be the caller's own provider key, and several
  control-plane calls sent it as it came: `/fix` memory enhancement, the
  tool-call substitution report, the judge, slash commands and the
  `/intutic/attest-sandbox` forward used it as their bearer, and the policy
  check sent its first 12 characters, which traces and logs also recorded as
  the virtual key id. Every control-plane call now takes a typed virtual key
  that only a `vk_` bearer produces (`RequestCredential`), so a provider key
  goes to its provider and nowhere else. Requests made with a provider key are
  answered locally where the control plane used to refuse them (the policy
  check under the configured fail mode, the judge as unavailable) and record no
  key id.
- **Pre-authentication credential overwrite in the proxy.** The session
  credential capture ran before authentication, so an unauthenticated caller
  could replace a workspace's stored Anthropic credential. It now runs after
  authentication. Self-hosted gateway
  operators should upgrade, and run with virtual keys required
  (`INTUTIC_GATEWAY_REQUIRE_VK=true`, or `requireVk` in the gateway config) so
  any other bearer is refused with `401`.
- **WASM rule modules are checked against their SHA-256.** A rule module from
  the control plane is loaded only when its bytes hash to the SHA-256 its
  descriptor names. A mismatch is logged and raised once as an incident, and
  the version of the rule already running stays in force.
- **Gates that never ran.** The Goose, Hermes and OpenHands registrations were
  in shapes those harnesses skip (Hermes ignored `hooks.preToolUse` as an
  unknown event), so their gates never fired. They are now written in the
  schemas each harness loads, with its fail-closed switch where it has one
  (Goose `on_failure: "block"`, Hermes `fail_closed: true`) and a 10 second
  timeout. OpenClaw's gate was an internal hook that never sees a tool call; it
  is now a plugin whose `before_tool_call` hook blocks. Pi's gate and model
  routing were written to files Pi does not read; the gate is now an extension
  in `~/.pi/agent/extensions/` and routing goes to `~/.pi/agent/models.json`.
  Continue's CLI never runs `PreToolUse` hooks, so Continue is reclassified as
  having no gate and is governed by the proxy and its rules file.
- **A slow gate allowed the call.** Most harnesses run a tool call whose hook
  outlives its timeout. Every hook gate now refuses with `GATE_DEADLINE` a
  second before the timeout its own harness applies, at most 9 seconds (a
  watchdog in the bash gates, an interrupting `vm` timeout in the JavaScript
  gates, and a deadline from the start of each call in the in-process
  OpenCode, Pi and OpenClaw gates). `connect` sets a 10 second hook timeout
  wherever a harness has a key for one, now including Cursor and Grok Build;
  Windsurf and Muse Code document none, so their gates assume 5 seconds and
  refuse at 4. One table in `@intutic/shared-types` (`HOOK_GATE_TIMEOUTS`)
  holds every harness's timeout, and a test checks each written hook entry
  against it. The bash gates screen each subject with one `grep` holding every
  rule's pattern before testing rule by rule, so a call at the size limit
  takes about a fifth of the time it did and is not refused on a busy machine.
- **Gate bypasses by spelling.** A destructive SQL statement or a held action
  (`review_before` on `action:db_write` or `action:deploy`) could get past the
  MCP proxy's DLP, the hook gates' `destructive.sql_drop` rule and the hold
  classifiers when its words were separated by something other than a single
  space. Every gate, both SDK gates, the proxy's action classifier and the MCP
  proxy now match a phrase's words whatever separates them, with one shared set
  of test vectors. Matching is literal, so a quoted string that contains the
  phrase still matches the text rules; the proxy's SQL guard, which reads the
  statement, does not.
- **ReDoS.** The JavaScript and Python classifiers, and the bash hold
  classifier, could take seconds to a minute on crafted command text. A linear
  phrase matcher replaces the backtracking regex; gate rules shaped `A.*B` run
  as sequences of steps; the `chmod`/`chown` root rules and the skill-content
  patterns no longer go super-linear; and a static check refuses any new rule a
  backtracking engine could take super-linear time on. Git remote
  normalisation no longer uses backtracking regexes.
- **Protected paths covered every gate.** An agent could rewrite or delete the
  files that load its own gate: Cline's gate (the list still named
  `.cline/hooks`), Codex's `hooks.json` and `config.toml` (where
  `features.hooks = false` turns hooks off), GitHub Copilot's two hook files,
  Hermes' and Goose's `config.yaml`, the Open WebUI filter, Cursor's
  machine-wide `hooks.json`, Antigravity's `~/.gemini/config/hooks.json` and a
  project's `.agents/hooks.json`, OpenClaw's `openclaw.json`, Pi's extension
  directories, and `.intutic/env`, whose workspace id makes every gate drop the
  snapshot's rules when it does not match. All are protected paths now, and
  the settings guard restores every gate script and registration when it is
  deleted or replaced. The guard watched the project's `.gemini/settings.json`
  instead of `~/.gemini/settings.json`, where the Gemini CLI gate is
  registered, and `connect` filtered watched paths by file name before the
  guard saw them, so OpenClaw's config, Muse's managed hooks and every dsh
  profile patch were never restored. Both are fixed.
- **GitHub Copilot's gate could be switched off from VS Code settings.** Every
  gate now refuses an agent edit that sets `chat.useHooks` or
  `chat.hookFilesLocations`, and a shell command that names either key. While
  the Copilot gate is installed, the sync daemon sets either value back when
  it would switch the gate off, leaves the rest of the settings file
  (comments included) as it was, and reports a `config_tamper` incident. VS
  Code's `ChatHooks` policy remains the administrator's hard lock.
- **A tampered policy snapshot refuses every MCP call.** A snapshot whose
  digest is broken or missing, or that names another workspace, used to keep
  the registry's refusals; but a deleted record looks like one never set, and
  an edit to the blocked list or default policy still widened it. Every gate
  and both SDK gates now refuse every MCP call on such a snapshot with
  `POLICY_SNAPSHOT_UNVERIFIED`. The sync daemon keeps the last snapshot it
  wrote in `~/.intutic/hooks/verified/`, puts it back as soon as the live one
  differs (an edit, a deletion or an older copy), and reports the tamper; the
  MCP daemon seeds its policy at startup from that verified copy
  (`~/.intutic/hooks/verified/policy-snapshot.json`) instead of the live file.
- **The MCP server allowlist sat outside the digest.** `mcpAllowedServers` was
  a `#mcpservers` header, so adding a server by hand widened the allowlist and
  left the snapshot valid. It is now an `@mcp_allowlist` record inside the
  digest.
- **Gates were skipped and holds let calls run.** `intutic connect` installed
  no gate for a harness that no rule set targeted; every configured harness
  now gets its gate. The sandbox gate script `@intutic/gate/harness` writes
  refused a block but ran a call a hold rule matched; it now refuses it.
  `@intutic/gate` and `intutic_clawde.gate` never fired a
  `review_before: action:…` hold and never recorded an SOP approval hold; both
  now hold as the hook gates do.
- **WASM limits.** The proxy checked a rule's time limit only after the guest
  returned, so the limit never fired and only the fuel budget stopped a slow
  rule. Fuel is now the limit a rule is held to, the same on any machine:
  1,000,000 instructions for a native rule and 100,000,000 for a Rego rule in
  the proxy (300,000,000 in the MCP proxy, whose meter counts differently),
  each at least four times what the largest shipped policy spends on the
  largest input. A wall-clock deadline (wasmtime epoch interruption in the
  proxy) stops what fuel cannot see, set well above the time a loaded machine
  needs to spend the whole budget: 1 s native and 2 s Rego in the proxy, 1 s
  and 10 s in the MCP proxy. A busy machine no longer turns into refusals of
  correct calls.
- **A custom rule that reaches no verdict refuses the call.** A WASM or Rego
  rule that hit its deadline or fuel budget, trapped, or returned something
  other than a verdict was allowed, so input crafted to slow a rule down got
  past it. Both proxies now refuse with `GOVERNANCE_UNAVAILABLE`, naming the
  rule and the cause, whatever `fail_closed`, `mcpProxyFailBehavior` or
  `INTUTIC_MCP_FAIL_OPEN` say: those settings cover control-plane outages,
  which an agent cannot cause. In the MCP proxy a rule quarantined after three
  runaways in a row refuses every call until the next rescan, where it used to
  be skipped. The shipped Rego examples refuse input marked `truncated`, and
  `intutic rules build` warns about a policy that reads `input.args` without
  checking `input.truncated`. `read_referenced_file` returns a new code, `-7`,
  for a path the call names but the host did not read (past 8 manifests or
  64 KiB of command), so a rule can refuse it rather than read it as absent.
- **Rule load failures are reported.** A rule pushed from the dashboard that
  failed to load was dropped without a word, and a module that failed to
  compile stopped every later sync. The previous version now stays in force
  and one incident is raised per version, saying so when no version loaded.

### Added

- **Refusal codes everywhere.** One shared list names every refusal per
  surface. The proxy names each in-band refusal (`TOOL_DENIED`, `SSO_GROUP`,
  `SQL_GUARD`, `RESPONSE_UNPARSEABLE`, `OUTPUT_DLP`, `COST_GATE_EXCEEDED`) in
  `x-intutic-refusal` and `x-intutic-refusal-rule` headers, or a
  `: intutic-refusal {…}` comment line on a stream. The MCP proxy puts
  `error.data.code` and `error.data.ruleId` on every refusal (a budget refusal
  adds its budget, limit, use and `resetAt`). Cline, Grok Build and
  Antigravity gate decisions carry `code` and `ruleId`.
- **Holds in the SDK gates.** `@intutic/gate` and `intutic_clawde.gate` hold a
  call through the decisions API, as the MCP proxy does: an exact approved
  bypass lets the identical call through, otherwise the hold is recorded and
  `IntuticGateHold` names its `holdId`. Every hold message, in every gate and
  the MCP proxy, says who can approve (owner, admin or EM) and that the retry
  passes only with the workspace's review-hold bypass on. The proxy's `403
  policy_held` (a Rego or WASM hold) is classified as a hold in both clawde
  SDKs.
- **MCP server registry in the hook and SDK gates.** The policy snapshot
  carries the registry inside its digest, and every hook gate and both SDK
  gates refuse a blocked or held server, an unapproved one under
  `mcpDefaultPolicy: deny`, and a disabled tool, with the MCP proxy's codes and
  rule ids. A server refused as unapproved joins the approval queue.
- **MCP call budgets and tool-change risk scoring.** Budgets per server, tool,
  member, or member on a server, per hour or day, counted in the Valkey the MCP
  proxies share (`INTUTIC_VALKEY_URL`); a used-up budget refuses with
  `BUDGET_EXCEEDED` and its reset time. A change to a server's tool set gets a
  deterministic risk score, and a high-risk change holds the server for
  re-approval (`SERVER_HELD`). The `intutic` MCP server gains
  `intutic_hold_status`, `intutic_mcp_registry_status` and
  `intutic_mcp_budget_remaining`.
- **Checksum-validated PII detectors** in the proxy and the MCP proxy, from one
  shared definition: `pii.card` (known card prefix and length, Luhn),
  `pii.iban` (registry country and length, mod-97) and `pii.ssn` (rejects
  numbers never issued) redact by default; `pii.email` and `pii.phone` are off.
  Set each to `off`, `redact` or `block` with `dlp.detectors` (proxy) or
  `INTUTIC_MCP_DLP_DETECTORS` (MCP proxy), or centrally with the workspace's
  `piiDetectors` setting.
- **Rego policies as rules.** OPA-compiled Rego modules run in the proxy and
  the MCP proxy wherever WASM rules run (`INTUTIC_DISABLE_REGO_RULES=1` turns
  them off), with a fixed set of host builtins checked against `opa eval`.
  A policy can allow, deny, hold or reask. `intutic rules build --rego` and
  `intutic rules test` build and test them; `intutic policy install` validates
  them.
- **Google Antigravity** is governed: a `PreToolUse` gate in
  `~/.gemini/config/hooks.json`, rule sets in `GEMINI.md`, and its
  `mcp_config.json` servers behind the MCP proxy. Gemini CLI's
  `mcpServers` are wrapped too, and Gemini CLI reports as `gemini-cli`.
  Antigravity and Gemini CLI gates have Jamf and Intune manifests.
- **AI inventory.** `intutic connect` reports each machine's harnesses (with
  gate kind, whether the gate file is present and when it last reported), MCP
  servers (wrapped or not, endpoint sanitised), skill bundles (name, source,
  hash) and the local proxy's guard-probe result, on the first poll and every
  five minutes after. Only names, home-relative paths, hashes and timestamps
  leave the machine.
- **Cost per branch, commit and pull request.** The sync daemon reports each
  session's repository (the `origin` remote, credentials, port and query
  removed) and reports again when the branch or `HEAD` moves. The clawde SDKs
  register a session with the same context (see Changed).
- **Event ids.** Every gate, reporter and SDK stamps each event with a random
  `eventId`, so a resent event is filed once.
- **Kitkat governance skill** covers every refusal code and hold and what an
  agent should do with each, and `intutic connect` installs it in
  `.agents/skills/` when missing.
- **CLI:** `settings get|set`; `mcp list|approve|block|reset|enable-tool|disable-tool`;
  `notifications list|create|update|delete|rotate-secret`;
  `siem list|show|sources|create|update|delete|rotate-secret`;
  `compliance coverage` (json, md, csv or pdf) and `compliance
  collect|download|verify` (`verify` checks an evidence archive's hashes and
  Ed25519 signature offline and exits `2` for an unsigned one);
  `usage members|teams|branches|commits|pull-requests`; `github webhook
  show|rotate-secret`; `inventory summary|harnesses|mcp-servers|skills`;
  `gate-liveness`; `gateway config get`; and `guardrails create|update|delete`
  for guardrails written directly in the Guardrail IR. A `403` prints the roles
  the server requires.
- **clawde SDKs:** `getWorkspaceSettings` / `updateWorkspaceSettings` and
  `getGatewayConfig` (`get_workspace_settings`, `update_workspace_settings`,
  `get_gateway_config`) on the control-plane client; `GatewayStatus` carries
  the applied and desired config versions; `ClawdeBlockedError` carries
  `ruleId` (`rule_id`); `streamRefusal` (`stream_refusal`) reads a stream's
  refusal marker.
- **Terraform provider 0.1.0**, released alongside this version
  (`terraform-provider-v0.1.0`), manages a workspace as code: `intutic_sop`,
  `intutic_policy`, `intutic_guardrail`, `intutic_workspace_settings`,
  `intutic_virtual_key`, `intutic_gateway`, `intutic_notification_rule`,
  `intutic_mcp_server_decision`, `intutic_siem_destination` and
  `intutic_wasm_rule` (uploads a WASM or Rego module and checks its stored
  SHA-256), with the `intutic_workspace` and `intutic_members` data sources.
  Every resource supports import; notification rules and SIEM destinations
  rotate their signing secret in place with `secret_rotation_triggers`.
  The source is in `packages/terraform-provider-intutic`.
- `@intutic/shared-types`: the phrase and sequence matchers, gate limits
  (`COMMAND_SIZE_LIMIT`, `ARGUMENTS_SIZE_LIMIT`, `HOOK_GATE_TIMEOUTS` and
  `gateDeadlineMs()`), the MCP
  registry and allowlist records and evaluators, MCP budgets and tool-risk
  scoring, PII detector settings and precedence (`effectivePiiActions`),
  `HARNESS_RULES_FILES`, `normalizeGitRemote`, the device inventory, usage and
  authored-guardrail types, and notification events for decision reviews, MCP
  server decisions, refused sign-ins, SCIM changes, secret rotations and
  evidence downloads.
- Docs: Rego policies, AI inventory, Terraform and Google Antigravity pages;
  MITRE ATLAS mapping; which role may make each change; where each harness's
  rule sets go; hook timeouts per harness; SIEM sources for MCP registry
  decisions, SCIM changes, decision reviews, secret rotations and evidence
  exports, with an OCSF-shaped `actor`.

### Changed

- **Workspace PII settings win over local config.** A workspace's
  `piiDetectors` is the baseline in both proxies; `dlp.detectors` and
  `INTUTIC_MCP_DLP_DETECTORS` may make a detector stricter but never looser,
  and detectors the workspace leaves out keep the local action. If the proxy
  cannot read the setting it follows its fail mode (fail closed, the default,
  refuses; in the LLM proxy, a global break-glass scans with local config). The MCP proxy keeps
  the setting it last loaded through an outage, and refuses with
  `GOVERNANCE_UNAVAILABLE` under fail-closed when the stored value cannot be
  read. `pii.ssn` replaces the old SSN pattern.
- **clawde SDKs register a session.** With a `vk_` key, and no session id from
  the environment, `ClawdeClient` registers a session carrying the working
  directory's repository, branch and commit on its first call (after the
  control plane accepts the key) and sends it as `x-session-id`. A provider
  key never triggers it. `autoContext: false` (`auto_context=False`) sends
  nothing. Both SDKs raise `ClawdeBlockedError` on every in-band proxy
  refusal, where they used to return verdict `allow`.
- **Rule sets go only to the file each harness reads**, named per harness in
  `HARNESS_RULES_FILES`: a marked section of a shared `AGENTS.md` for every
  reader (Codex now gets rules), `.claude/rules/`, `.cursor/rules/`,
  `.windsurf/rules/`, `.continue/rules/`, a section of `.goosehints`, a section
  of `GEMINI.md` (read only in a trusted folder), an OpenHands microagent and
  OpenClaw's agent-workspace `AGENTS.md`. Your own text in shared files is
  kept. Files earlier versions overwrote whole (`CLAUDE.md`, `.cursorrules`,
  `.windsurfrules`, `.roorules`, `AGENTS.md`) are given back on the first sync.
- **The decisions log** follows the same map. Claude Code's goes to
  `.claude/rules/intutic-decisions.md`, and `CLAUDE.md` is never created or
  written; the section earlier versions put there comes out on the next sync.
- **Gate body v18.** Every gate is regenerated each sync cycle. Beyond the
  refusals under Security, a long option between a command's words
  (`git --no-pager push`) counts as the command, Gemini CLI's
  `run_shell_command` is a shell tool for holds, and SSO group rules match an
  MCP tool by its own name (`run_query`) as well as its harness name
  (`mcp__<server>__run_query`) at every gate.
- **WASM rules:** a rule is held to its fuel budget, with a wall-clock
  deadline as a backstop (see Security); a rule that runs out of either
  refuses the call, where a slow rule used to finish and its verdict applied.
  Rego input is capped at 64 KB.
- **Hermes** asks you to approve the shell hook the first time it sees it.
  **Cline** shows a refusal from `errorMessage`.
- `intutic disconnect` reports the disconnect before it removes the
  credentials, and removes everything the new gates, rules sections, skills
  and MCP wraps add, plus what earlier versions wrote for Continue, OpenClaw
  and Pi.
- The sync daemon's event drain no longer deletes events a gate appends while
  a batch is in flight; a batch left behind by a crash is sent again.
- `@intutic/gate` and `intutic_clawde.gate` export `GATE_REFUSAL_CODES`
  (`GateRefusalCode`), checked against the shared list.
- `@intutic/gate` exports `GATE_DEADLINE_MS` (9000): its sandbox hook gate
  refuses with `GATE_DEADLINE` a second inside the 10 second timeout of the
  hook it writes.

- **Gemini is shown as not yet routable.** The provider registry and the
  settings guide called Gemini live, but the proxy forwarded Gemini requests
  without translating them to Gemini's format, so none succeeded. Gemini keys
  can still be saved, in the same field, and are used once Gemini routing
  arrives in 2.4.0.

### Removed

- **Continue's gate registration.** `cn` never ran it; `intutic disconnect
  --harness continue` removes it.
- **Claude Desktop and Roo Code hook writers**: neither product read what they
  wrote. Both are classified as having no gate of their own.
- **n8n's workflow-settings rules update**, which n8n's schema always refused.
  n8n reads no instructions file.
- **`SOP_RULE_APPROVAL`** from the SDK gates' refusal codes: an SOP approval
  rule is a hold (`HELD`). `GateClient.hold_for_review` in `intutic-clawde` is
  replaced by the hold flow.
- From `@intutic/shared-types`: `PRIVILEGED_SOURCE_PROVIDERS`; owners and
  admins manage every connector provider.

### Fixed

- `intutic inventory devices` and `intutic inventory disconnects` give the CLI
  the dashboard's machine and disconnect views; `guardrails` commands print the
  roles a refused call needs; `guardrails sources sync` prints its real counts.
- Gate Health no longer reports harnesses that have no gate (Continue, Claude
  Desktop, Roo Code, aider) or that delegate to another harness as silent.
- `intutic rules build`, `rules test`, `policy test` and `policy install` meter
  rules with the proxies' instruction budgets, so a rule that would run out in
  a proxy fails locally too.
- A custom rule refused at load names why (`missing`, `hash_mismatch`,
  `compile_error`, `unsupported_import`, `load_error`), with one incident per
  rule version and reason.
- The dashboard shows `TAMPER` gate decisions and the file that was restored.
- Terraform: removing a credential from `intutic_siem_destination`
  `secret_config` clears it, and `event_type` on `intutic_notification_rule`
  is validated against the published event types.
- The Python SDK no longer lets a malformed control-plane reply during session
  registration break a call, registers once across threads, and types
  `get_gateway_status`.
- **MCP proxy policy cache with Valkey down.** Every cache miss waited out a
  read and then a write through the Valkey client's retries, seconds per miss
  and growing with the outage, and a Valkey that accepted the connection but
  never answered held the call forever. Valkey is asked only when it is ready,
  and the write-through no longer blocks the call.
- **The response cache answered an agent's next turn with its last one.**
  The exact cache keyed only on the plain text of user and system messages, so
  a request carrying a tool result hashed like the turn before it and got that
  turn's reply back, sending a coding agent round in a loop; every posture
  preset turns this cache on. The exact key now covers the whole request:
  model, every message including tool calls and results, tools and sampling
  parameters. The semantic cache answers only a plain-text question with no
  tools, with everything but the question matched exactly. A streaming request
  served from cache now gets a valid event stream, a Responses API hit gets the
  `output[]` shape, and replies that call a tool or were cut off are no longer
  cached. Requests with `n` above 1, and Responses API requests that do not
  set `"store": false`, skip the cache. Entries keyed the old way are not
  served and expire within 24 hours. Nothing is written to the cache while
  both cache flags are off.
- Rule sets never reached Gemini CLI, Antigravity or OpenHands: neither
  Gemini product reads `customInstructions` in `.gemini/settings.json`, and
  OpenHands never read an `[intutic]` table in `config.toml`. `connect`
  removes the stale key and table.
- Aider's `read:` entry is an absolute path, so Aider finds the rules from any
  subdirectory.
- The settings guard sent OpenCode plugin tampering to the Goose writer.
- The MCP proxy failed on a registry from an older MCP daemon that lacked
  held servers.
- The smolagents step callback logged a held step as neither blocked nor
  allowed.
- `intutic-clawde`'s snapshot reader normalised commands differently from the
  shipped gates, so a command starting with `DROP TABLE` did not match.
- Docs: compliance evidence exports are signed only when a signing key is
  configured; OpenClaw's proxy routing is set by hand; gate counts and
  comparison pages checked against the code.

## [2.2.0] - 2026-10-08

Everything that reached `main` since 2.1.0. Check these behaviour changes
before upgrading: a mistyped `INTUTIC_EGRESS_MODE` now stops the proxy at
startup; a proxy that fails closed refuses a virtual-key request when it cannot
read the key's SSO group policy; the clawde SDKs raise `ClawdeBlockedError` on
the cost gate's `200` refusal; `intutic predict-cost --task-type` is an error;
and `intutic connect` records each harness rules file's hash and size in the
config history, write-protects rules files under the Write-protect setting on
macOS, and writes Windsurf's proxy settings to the file Windsurf reads. Hold
redaction now redacts a private key with no footer to the end of the text.
`INTUTIC_PROMPT_QUALITY_GATE`, `INTUTIC_PROXY_IP` and `INTUTIC_PROXY_PORT` are
gone (see Removed).

### Added

- **MCP server registry in the MCP governance proxy**: the proxy reads the
  workspace's registry decisions with the policy it already polls. It refuses
  a blocked server and a tool an operator disabled (and hides that tool from
  `tools/list`), and, when the workspace's `mcpDefaultPolicy` is `deny`, every
  server not yet approved. It reports the server it fronts and its tool names,
  so a new server lands in the approval queue (`mcp.server.candidate`). The
  first call waits for the first policy fetch; a registry that never loads
  follows the fail setting (open skips the registry checks, closed refuses).
- **Approval holds in the MCP proxy**: a `require_approval` rule holds the call
  through the decisions API, as the hook gates' hold tier does, instead of
  refusing it. The agent gets a held error naming the hold id and the
  `intutic decision approve` command; once approved, with the workspace's
  review-hold bypass on, the identical retry passes. An unreachable control
  plane keeps the call held.
- **Per-call identity**: every MCP proxy event and hold carries the API key's
  prefix, the OS user, the harness session and the server the proxy fronts.
- **SSO-group tool clearance in every gate**: a workspace's `sso_group_policy`
  (high-risk tools, the identity-provider groups that clear them, and tools
  only an on-behalf-of token may call) is enforced by the MCP proxy, the
  generated hook gates (the policy snapshot carries the member's groups in an
  `@sso_groups` record), `@intutic/gate` and `intutic_clawde.gate` (refusal
  code `SSO_GROUP`), and the proxy's response gate, which reads the policy and
  the key's member groups from `GET /api/v1/auth/key-context` (cached 30
  seconds per key, refetched when the workspace config version moves) and
  records a finding naming the rule. A member whose groups are unknown,
  including after the control plane refuses the key, is refused high-risk
  tools. While SCIM provisioning is on, SCIM groups decide membership.
  `@intutic/shared-types` exports the one evaluator and schema
  (`evaluateSsoGroupClearance`, `SsoGroupPolicySchema`, `parseSsoGroupPolicy`,
  `ssoGroupRuleId`, `encodeSsoGroupRecord`, `decodeSsoGroupRecord`), and a
  shared vectors file holds every implementation to the same answers.
- **`intutic disconnect`** restores every file `intutic connect` changed:
  owned files restored or deleted, Intutic's hook entries and MCP wraps
  removed, overwritten proxy settings put back. A full run also removes the
  background services, the CA connect trusted in the login keychain, the
  Valkey container, the gate caches and the stored credentials. `--dry-run`
  prints the plan, `--harness <id>` takes out one harness, `--keep-login`
  keeps the login. Files written by earlier versions are recognised.
- **Claude Code project MCP servers are governed**: each server in a
  repository's `.mcp.json` gets a wrapped copy at local scope in
  `~/.claude.json`, which Claude Code prefers, so the committed file is never
  rewritten. Only servers Claude Code itself would start are copied: approvals
  in the project's `.claude/settings.json` and `settings.local.json` count only
  once the folder's trust dialog was accepted, and a disable anywhere wins. A
  remote server whose URL or headers use `${VAR}` is not copied and shows as
  ungoverned, with the reason, in the MCP server registry.
- **Config history**: `intutic connect` records each harness rules file
  (`HARNESS_FILES`, listed in the CLI reference) every fifth poll: its path,
  the SHA-256 of its redacted text, and its size, never the text. The new
  `configBodyUpload` workspace setting (off by default) uploads the text too,
  with credential-shaped strings redacted on the machine first.
  `intutic integrity config-chain` says how many snapshots carry no content.
- **Live gateway config**: a registered self-hosted gateway pulls its config
  whenever the heartbeat's desired version differs from the one it runs, and
  applies `requireVk` and `requireProvisionedKey` without a restart; the first
  heartbeat goes out at startup. `intutic gateway status` shows the applied
  config version against the desired one. Bare metal is a deployment target
  again (`intutic gateway register --target bare_metal`): the release's proxy
  binary, checked against `checksums.json`, under a systemd unit.
- **Workspace MCP detection settings**: `mcpInjectionAction`, `mcpAnomalyMode`
  and `mcpAnomalyOverrides` (keys checked against the new
  `MCP_ANOMALY_DETECTOR_IDS`) reach the MCP proxy with its policy and win over
  `INTUTIC_MCP_INJECTION_ACTION`, `INTUTIC_MCP_ANOMALY_MODE` and
  `INTUTIC_MCP_ANOMALY_OVERRIDES`; unset, the local variables stay in force.
- `@intutic/shared-types`: the `governance.gate.silent`,
  `governance.gate.recovered`, `governance.integrity.failed` and
  `mcp.server.candidate` notification events; `NotificationRule.signingSecret`,
  a webhook rule's generated signing secret, returned once; `mcpDefaultPolicy`,
  `sso_group_policy` and `configBodyUpload` on `WorkspaceSettings`.
- Docs: a framework mapping guide (EU AI Act, ISO/IEC 42001, NIST AI RMF);
  SIEM sources, gate-silent and integrity alerts, and the one signature scheme
  notification and SIEM webhooks share, with its replay window; every sign-in
  method, and refused sign-ins, in the audit trail; the MCP registry, approval
  holds, caller identity and every MCP proxy flag and variable; SCIM groups as
  stored resources; how to set an SSO group policy.

### Changed

- **`INTUTIC_EGRESS_MODE`** must be `off`, `monitor` or `enforce` (case and
  surrounding space ignored). Anything else is an error naming the valid
  values, and the proxy does not start; it used to mean `off`, so a typo in
  `enforce` turned egress control off. An empty value still defers to
  `intutic_settings.egress.mode`.
- **The proxy reads a virtual key's SSO group policy on each request** (cached
  30 seconds) when it has a control plane. If the read fails, a proxy whose
  policy check fails closed refuses the request with `403 policy_denied`; one
  that fails open proceeds without group rules.
- **clawde SDKs** (`@intutic/clawde`, `intutic-clawde`): the proxy's
  cost-prediction gate answers a non-streaming request with a `200` whose
  assistant turn explains the estimate, and now names the refusal in an
  `x-intutic-refusal: COST_GATE_EXCEEDED` header. `chat()` fires `kill` and
  raises `ClawdeBlockedError` (status `200`, the explanation as its message)
  instead of returning the turn as the model's answer with verdict `allow`.
- **`intutic connect` runs the sync work the docs describe**, which lived in a
  second sync loop nothing started: SkillOpt config edits are applied and
  acknowledged, MCP servers are wrapped every cycle, `skill_flagged` events,
  the decisions log and the bundled rule-author skill are produced, and
  Markdown rules files keep their `sop://` pointer comments. The hand-edit
  setting is honoured: Write-protect sets the macOS immutable flag
  (`chflags uchg`) on the rules files between cycles, and Record only leaves a
  hand edit in place (gate hook files are still restored).
- **Windsurf**: `http.proxy`, `http.proxyStrictSSL` and `codeium.proxy` are
  merged into Windsurf's user `settings.json`
  (`~/Library/Application Support/Windsurf/User/` on macOS,
  `$XDG_CONFIG_HOME/Windsurf/User/` or `~/.config/Windsurf/User/` on Linux,
  `%APPDATA%\Windsurf\User\` on Windows) instead of
  `~/.codeium/windsurf/settings.json`, which Windsurf does not read.
  `intutic disconnect` cleans both.
- MCP proxy: the workspace's `mcpProxyFailBehavior` (the dashboard's "When
  Intutic is unreachable" setting) now reaches the proxy and wins over
  `INTUTIC_MCP_FAIL_OPEN`, which applies until a policy has loaded or when the
  workspace never chose; `INTUTIC_MCP_FAIL_OPEN` is read from the environment
  before `runtime.env`. The standalone `intutic` MCP server reports the package
  version instead of `0.1.0`. The MCP daemon finds Claude Code's servers in
  `~/.claude.json` and each project's `.mcp.json`, not `~/.claude/mcp.json`.
- `intutic gateway config set` says the change applies on the next heartbeat
  (every 30 seconds by default, `INTUTIC_GATEWAY_HEARTBEAT_INTERVAL_SECS`).
- `intutic attenuate`: a child key expires after `--ttl` or when the first key
  it descends from expires, whichever is sooner, and the printed expiry is that
  time. A parent that descends from an expired key is refused.
- `@intutic/shared-types`: `CapturedConfigFile.content` is optional and
  `sizeBytes` required; `ConfigDiff.currentContent` can be `null`, and
  `contentUploaded` says whether both snapshots carry content.

### Deprecated

- **Policy checks authenticated by key prefix alone.** From 2.1.0 the proxy
  sends its whole virtual key (`Authorization: Bearer vk_…`) with
  `POST /api/v1/policy/check`; older proxies send only the key prefix. The
  control plane still answers a prefix-only check whose prefix names a live key
  of the workspace, and now logs each one (`policy_check_prefix_only`, with the
  workspace, prefix and outcome) and counts it in the
  `policy_check_prefix_only` metric. Prefix-only checks will be refused in a
  later release, once that count stays at zero: upgrade proxies to 2.1.0 or
  later before then. A refused check blocks every request on a proxy that
  fails closed.

### Removed

- **`intutic predict-cost --task-type`.** Token baselines are recorded per
  model and input size only, so the task type selected nothing. Passing the
  option is now an error; drop it from scripts. `TokenBaseline.taskType` is
  removed from `@intutic/shared-types`.
- **`INTUTIC_PROMPT_QUALITY_GATE`** and the prompt quality gate it switched
  on, with the `--force` bypass that only skipped it. The gate posted every
  request to a scoring endpoint the control plane no longer has and failed
  open. `/intutic` slash commands are unchanged.
- **`INTUTIC_PROXY_IP` and `INTUTIC_PROXY_PORT`**, read only by the proxy's
  transparent-redirect firewall generators, which nothing called and which are
  deleted. `intutic enforce` and `intutic-proxy enforce` are unchanged.
- From `@intutic/sync-daemon`: `startSyncLoop` (with `SyncLoopOptions` and
  `SyncResult`), `writeConfigFiles` (`WriteResult`), `computeFileHashes`,
  `hashFile`, `loadIntegrity` and `saveIntegrity`. `intutic connect` is the
  sync loop. Git worktree propagation, which only that loop had, went with it.
- From `@intutic/shared-types`: the `budget.exceeded` and
  `finops.budget.overrun` notification events, which nothing sent (budget
  alerts are `finops.budget.threshold` and `finops.budget.exceeded`); the
  `TOOL_SUBSTITUTION` and `PARAMETER_DRIFT` deviation types and the
  `PENDING_APPROVAL` to `EXECUTING` plan transition, none of which the gates
  can observe; and `ChannelConfig.webhookSecret`, since every webhook's signing
  secret is now generated by the server.

### Fixed

- OpenHands: any workspace with a `config.toml` (every Hugo site, for one) was
  detected as OpenHands; detection now needs `.openhands/` or a table only
  OpenHands uses. A second edit replaced the first `base_url` anywhere in
  `config.toml` (an `[llm.draft_editor]` table's, say) with the bare proxy URL
  and created `~/.openhands/config.toml` on every machine; the user-level file
  now gets only `[llm] base_url`, and only when it exists.
- Goose: `provider.host` and `hooks.pre_tool_use` were set by replacing the
  first `host:` and `pre_tool_use:` lines in `config.yaml`, which could belong
  to an extension; they are now set by key, and a file that is not a mapping is
  left alone.
- The settings guard blanked Goose's and OpenHands' provider URL when it re-ran
  their writers; it now gets the synced proxy URL.
- `intutic env clear` on Linux added a newline to `~/.bashrc` per variable
  instead of restoring it, and left `/etc/environment` alone when `env
  persist` had run as root. It now removes exactly the lines persist wrote,
  from both, and a failed read no longer replaces `~/.bashrc` with the two
  exports.
- The control plane dropped every injection, anomaly and redaction event the
  MCP proxy reported. They are filed as detector findings, each with a
  structured finding from the proxy, and announced as `anomaly.finding`.
- The `@intutic/mcp-governance-proxy` README described `intutic-mcp-daemon` as
  a standalone MCP server; it is the policy and telemetry daemon, and the
  standalone server is `intutic-mcp-proxy` with no server to wrap.
- Docs: SOP titles are up to 256 characters and versions up to 16; budget
  alerts fire at the workspace's alert threshold and at the cap, once per
  period.

### Security

- **Hook redactor ReDoS.** 2.1.0's hold redactor, which runs in the generated
  hook gates before any length cap, matched private keys with a lazy
  `BEGIN…END` pattern that rescanned to the end of the text from every header
  without a footer: quadratic, so 520 KB of headers took over two seconds. Keys
  are now found in linear time, and a header with no footer is redacted to the
  end of the text.
- An MCP daemon restart disarmed daemon-mode MCP proxies: until its first fetch
  the daemon answered from the sync daemon's snapshot, which carries only the
  rules, and a proxy took that answer whole, resetting its tool and server
  allowlists, description overrides, DLP and injection patterns to
  unrestricted. A proxy that has loaded a full policy now takes only the rules
  from a snapshot answer.
- The MCP proxy ignored the workspace's `mcpProxyFailBehavior`, so a workspace
  set to fail closed failed open wherever `INTUTIC_MCP_FAIL_OPEN` was unset.
- Windsurf's Cascade traffic never went through the proxy: its proxy settings
  were written to a file Windsurf does not read.
- clawde SDKs: with `failOpen` (`fail_open`) set, the circuit breaker
  swallowed its own budget verdict along with connection errors, so a wrapped
  call ran exactly when the budget was gone. It now fails open only when the
  check could not be made.

## [2.1.0] - 2026-10-08

Everything that reached `main` since 2.0.0. Check three behaviour changes
before upgrading: `intutic skill audit` exits 1 on findings, the CLI no longer
reads `PORT`, and the clawde SDKs raise `ClawdeBlockedError` on a proxy
refusal instead of retrying it. Judges run only on self-hosted models, which
removes `judgeModelChoices` and `managedJudgeModel` (see Removed).

### Added

- **Destructive-SQL guard** on the proxy's response gate: destructive SQL run
  through `psql`, `mysql`, `sqlite3` or `dropdb` against a target that is not
  allowlisted is withheld. Off unless an SOP declares `sql_guard` (and
  `sql_allow_dsns`) in its front matter.
- **DeepSeek route**: `deepseek-chat`, `deepseek-reasoner` and `deepseek-flash`
  go to DeepSeek's own API on both the OpenAI and the Anthropic wire
  (`DEEPSEEK_UPSTREAM_URL` overrides it); other `deepseek-*` names keep going
  to the OpenAI-compatible upstream. `DEEPSEEK_API_MODEL_IDS` in
  `@intutic/shared-types`.
- **Typed stage for the self-hosted gateway's local judge**: with
  `INTUTIC_GATEWAY_LOCAL_JUDGE_TYPED_LO` and `_HI` set, two one-token yes/no
  questions score the response first. Below the band it is compliant with no
  free-text call, above it a violation (the free-text judge runs once for the
  reasoning), and inside it the free-text verdict stands.
  `LITELLM_LOCAL_TYPED_JUDGE_MODEL` picks the model; there is no default band.
- **Skill protection**: nine content patterns that hit none of 350 public
  `SKILL.md` files block writes into a skills directory (`skill_content.*` in
  the policy snapshot); the daemon reports each bundled skill script's sha256
  (`SkillScriptsFacet`; hashes only, never content).
- **Guardrails on workspace settings**: `allowed_models` and `egress_allow`
  guardrail kinds on a `workspace_setting` target, rendered by
  `@intutic/shared-types` and shown and promoted by `intutic guardrails`.
- **Harnesses**: Microsoft Agent Framework (`intutic-clawde[agent-framework]`,
  `IntuticFunctionMiddleware`), the 43rd governed harness; Strands `BidiAgent`
  and multi-agent `Graph`/`Swarm` (`install_multiagent()`, requires
  `strands-agents>=1.57.2`); OpenCode MCP servers wrapped through the MCP
  governance proxy, so the per-server allowlist applies; the AgentCore
  interceptor's `composeRequestInterceptor()`, with `checkToolCall` and
  `readConfig` exported.
- **`@intutic/gate`**: `intuticApprovalStep()` runs the gate from a Workflow
  DevKit `"use step"` function; `intuticAuditHooks()` audits eve's
  `input.resolved`; harness approvals work on `@ai-sdk/harness` 1.0.101+, and
  the sandbox bootstrap registers the hook for each session.
- **WASM rules**: `setReason()` in the AssemblyScript rule SDK sets the message
  a block returns, through the `reason_ptr()`/`reason_len()` exports both
  proxies already read.
- **CLI**: `intutic login --control-plane-url` saves the control plane, and
  every command resolves it the same way (flag, then
  `INTUTIC_CONTROL_PLANE_URL`/`INTUTIC_DEV`, then the saved URL); `intutic
  integrity verify <root> --against <file>` compares your own copy with what
  the control plane serves; `init --git-hooks`/`--no-git-hooks`.
- `@intutic/shared-types`: `anthropicBaseUrl()`, `openaiBaseUrl()` and
  `proxyHost()`; the `judge.review.queued` notification event; the
  `E_PLAN_CHANGE_UNSUPPORTED`, `E_PLAN_FROM_ORG` and `E_CHECKOUT_UNAVAILABLE`
  error codes.

### Changed

- **`intutic skill audit` exits 1 when it has findings**, once the report, the
  SARIF document and the upload are done. `--exit-zero` keeps the old
  behaviour.
- **One local proxy port**: `start`, `connect`, `daemon install --proxy`,
  `budget`, `doctor` and `exec` all take it from `INTUTIC_PROXY_URL` (default
  4000), and `--port` overrides it. The shell's `PORT` is no longer read.
- **clawde SDKs** (`@intutic/clawde`, `intutic-clawde`): a proxy refusal
  (`403 policy_denied`, `409 policy_reask`, `429 OVERAGE_HARD_CAP_EXCEEDED`, …)
  fires the matching event and raises `ClawdeBlockedError` (verdict `kill`,
  `reask` or `hold`); only transport failures and 5xx are retried. Anthropic
  requests go to `/v1/messages`. The circuit breaker gains `requireBudget`;
  `maxCostUsd` (now only switches the budget check on), `sensitivityTier`
  (ignored), `budgetRemainingUsd`/`budgetPctUsed` (never set) and the
  `hijack`/`enhance`/`bypass` verdicts are deprecated.
- `intutic exec` runs without a login: it sets the base-URL variables and
  leaves your provider keys alone. `exec --sandbox` builds
  `intutic/sandbox:<CLI version>` from the Dockerfile the npm package now
  ships; the old `intutic/sandbox:latest` default was never published.
- `connect` uses the control plane saved by `intutic login` when no flag is
  given.
- Workflow DevKit: call the gate from a `"use step"` function.
  `@intutic/gate/workflow` no longer loads Node, and the old form inside the
  workflow sandbox refuses with `WORKFLOW_SANDBOX`, naming the fix.
- **Cline**: rules move to `.clinerules/intutic-governance.md` and the gate to
  `.clinerules/hooks/PreToolUse`. A flat `.clinerules` an earlier version
  wrote is converted; one you wrote is left alone. Cline's base URL is set in
  its own settings panel.
- Harness configs are merged, never replaced: Claude Code, Cursor (Cursor's
  `hooks.json` schema, plus `preToolUse` for writes and deletes), Windsurf
  (the real proxy port), OpenHands `config.toml`, Aider and Hermes YAML, and
  Pi's per-provider base URLs. Continue routes only OpenAI and Anthropic
  models. MCP auto-wrap reads Claude Code's servers from `~/.claude.json` and
  uses the proxy installed next to the CLI.
- dsh 0.2: the egress override goes on the `llm-deepseek` row of each
  profile's `cordis.patch.yml`. Until the plugin is installed dsh runs
  ungoverned and warns; the docs had called this fail-closed.
- `intutic judge configure` offers only self-hosted models, refuses a hosted
  custom reference, writes `api_base` for Ollama models, and gives Helm users
  the `--set-file litellm.config` flag; `intutic setup` no longer asks for a
  judge model.
- `intutic integrity verify` reports a root whose traces the three-year
  retention deleted (exit 0, signature still checked) instead of failing it.
- `execute_command` (Cline, Roo Code) counts as a shell tool in `@intutic/gate`
  and `intutic-clawde`, as it does in the proxy.
- The MCP governance proxy refuses WASM modules that import their memory or
  use instructions its metering cannot charge.
- The offline pricing bundle is re-pinned to LiteLLM upstream (2026-09-28,
  2026-10-07, 2026-10-08), and from now on nightly.
- The docs site and theme use Geist and Geist Mono (SIL OFL), self-hosted,
  with no Google Fonts requests.

### Removed

- `judgeModelChoices` from `@intutic/shared-types`, replaced by
  `selfHostedJudgeModelChoices()` (judge-capable Ollama models, Ollama Cloud
  excluded), `isHostedModelRef()` and `SELF_HOSTED_MODEL_PROVIDER_IDS`.
- `managedJudgeModel` from `WorkspaceSettings`; `PUT
  /api/v1/workspace/settings` rejects it with `400`.
- `BillingUsageSummary` from `@intutic/shared-types`; the endpoint it
  described is gone.
- `mergeSettingsYaml` from `@intutic/sync-daemon/harness/dshHooks`: dsh 0.2
  has no `settings.yaml`.
- The `x-intutic-judge-loop-guard` header (see Security).
- Proxy config keys that were parsed and never read: `general_settings`,
  `harness_overrides`, `litellm_params.api_key` and `litellm_params.api_base`.
  A LiteLLM config that still carries them loads.
- The VS Code `settings.json` injection for Cline and Roo Code, which neither
  extension reads (see Security).
- The clawde SDKs' `X-Intutic-Context`, `X-Intutic-Cost-Limit` and
  `X-Intutic-Sensitivity` request headers and their verdict and budget
  response-header parsing; the proxy never sent or read any of them.

### Fixed

- `UPSTREAM_URL`, which `intutic start --upstream-url` and the installed
  service set, was never read by the proxy. It is now the default upstream for
  every provider unless the provider's own `*_UPSTREAM_URL` is set.
- The proxy refused (403) every virtual key for a workspace whose id does not
  start with `ws_`, and invented a workspace for about 40 % of attenuated child
  keys.
- When the response gate refused a tool call on an OpenAI Chat or Responses
  stream, the text before it was lost; it now reaches the client, scrubbed,
  ahead of the refusal.
- The proxy's session-credential capture filed any non-virtual-key token as
  the workspace's Anthropic key, so an OpenAI or DeepSeek key overwrote it.
  Only `sk-ant-` tokens are captured now.
- CLI: `policy rollback <id> --version N` printed the CLI version;
  `install-daemon`/`uninstall-daemon` lacked the `daemon install` options;
  `doctor` asked a route that does not exist and probed Valkey through the
  proxy; `enforce --allow` accepted entries that are not IPs or CIDRs; `skill
  scan-staged` scanned the workspace `init` last recorded; `sync-context --git`
  ignored Git; `loop review` exited 0 when the review failed; `attenuate`
  accepted a `--ttl` the server refuses; `init` waited on a prompt without a
  terminal.
- `intutic-clawde` treats a judge verdict held for review (`REVIEW`) as not
  clean.
- `@intutic/gate`: `withIntuticProxy` accepts `apiKey` for `createOpenAI`; eve's
  `cancelled` outcome is handled; the harness bootstrap merge is idempotent.
- dsh profiles were pinned to `@intutic/gate ^0.1.0`, which no published
  version satisfies; `^2.0.0` is added only when the profile has no entry.
- The proxy container image installs `wget` for its health check.

### Security

- The proxy authenticates its budget and plan-limit check (`POST
  /api/v1/policy/check`) with the request's virtual key as the bearer. It sent
  only the key's 12-character prefix, which is not a secret, so the control
  plane could not tell the proxy from anyone asking about a workspace ID. A
  provider credential is never sent.
- The machine-wide daily cap (`maxDailyBudgetUsd`, $10 by default) applies only
  to a standalone proxy. On a proxy with a control plane, every workspace's
  spend accrued to one day file, so the day's combined traffic could refuse
  every request for every workspace until midnight. With `CONTROL_PLANE_URL`
  set, the control plane's per-workspace daily limit is the cap.
- A virtual key with no resolvable provider key now gets `402
  no_upstream_credential` instead of being forwarded to the provider.
- Any client could set `x-intutic-judge-loop-guard` to skip judging for its own
  traffic; the header is gone.
- `intutic connect` could wipe VS Code's user and workspace `settings.json`:
  the Cline/Roo Code injection replaced a file it failed to parse with only its
  own keys.
- `intutic connect` replaced `~/.codex/config.toml` (or `$CODEX_HOME`'s) with
  its own; it now merges `openai_base_url` into your file.
- Hook installation gaps: `connect` never installed the gate for Codex, GitHub
  Copilot, Continue, Antigravity, Open WebUI or n8n; Cline's gate sat where
  Cline does not look, Antigravity's under the wrong key, and Cursor's
  `hooks.json` was not in Cursor's schema; a Claude Code sync dropped the
  user's own `PreToolUse` hooks.
- The MCP governance proxy enforces the Rust proxy's WASM limits: 16 MB of
  memory (growth past it fails) and 1,000,000 instructions per call
  (exhaustion fails open for that call and counts toward disabling the rule).
  Memory used to be checked only after the call.
- Dependency updates for open advisories: `@modelcontextprotocol/sdk`, `vue`,
  `undici`, `shell-quote` and seven more on npm; `pyjwt`, `oauthlib`,
  `multidict`, `langgraph-sdk` and `urllib3` (floor `>=2.8.0`) for
  `intutic-clawde`; `rustls` 0.23.45 for the proxy.

### Documentation

- New reference pages: the Tool Gate SDK (`@intutic/gate` and
  `intutic_clawde.gate`), every environment variable the proxy, CLI and gate
  SDK read, every CLI command and option, and the regenerated API route
  catalog.
- The clawde SDK, WASM rule (`evaluate(offset, len)`, `risk_tier` values such
  as `High`), budgets (`maxDailyBudgetUsd`), workflow and Strands pages match
  the code; the competitor comparisons are rewritten against current code and
  public docs; native hook gates are in 19 of the 43 harnesses.

### Internal

- New gates: docs links and anchors, every environment variable documented
  both ways, no internal ids in published pages, the WASM pages' host-guest
  contract. CI runs the Rust job and each CodeQL language only when their
  inputs change, and groups Dependabot updates per ecosystem.

## [2.0.0] - 2026-09-27

A milestone release: no public API, wire format or configuration value that
worked on 1.10.x stops working.

### Changed

- **`TURBOVEC_URL` is a base URL.** Both semantic-cache routes now hang off it
  (`<base>/vectors/query`, `<base>/vectors/insert`), matching the TurboVec
  service. A legacy value naming one of those endpoints is still accepted: the
  proxy strips the route back to the base.
- The offline pricing bundle is re-pinned to current LiteLLM upstream twice
  (2026-09-26, 2026-09-27), picking up moved Azure `gpt-4o-mini` and OpenRouter
  DeepSeek rates.

### Added

- **BYO-key for paid workspaces only**: `INTUTIC_GATEWAY_REQUIRE_PROVISIONED_KEY=paid`
  refuses (`402 byok_required`) only the workspaces the control plane marks
  `byokRequired` on the key; trials and exempt workspaces keep the gateway's own
  provider key. `true` still means every workspace, and unset/`false` is unchanged.
  `AuthContext.byokRequired` in `@intutic/shared-types`.

### Fixed

- npm publishing passes tarballs by an explicit `./` path (npm 11 read a bare
  `dir/file.tgz` as a GitHub shorthand).

### Internal

- The proxy is `rustfmt`-formatted and clippy-clean under `-D warnings`; CI now
  gates both, on a pinned Rust 1.98.0 toolchain.

## [1.10.1] - 2026-09-24

The first tagged release since 1.10.0: everything that reached `main` between
2026-07-29 and 2026-09-24, including the entries previously listed under
Unreleased.

### Added

- **Graph guardrails and anomaly detection on the proxy**: graph-aware node
  identity and a detector registry; graph-wide budget and orphan detection;
  broadcast findings to sibling nodes; trajectory recorded on every trace;
  broadcast safety valves, fan-out and schema-drift detectors; tool-description
  poisoning detection; a landmark cycle detector (period-3 cycles and
  `action:`-interleaved spins); a REASK rung between HIJACK and KILL; any detector
  can hold a run (`Disposition::Ask`); NOTIFY out-of-band; shadow mode (evaluate
  everything, enforce nothing, record it all); temporal policy primitives
  (time-windowed call rate, `tool_sequence` fold); a code-as-action detector;
  ordering rules declarable with the defaults as the floor; the first measured
  false-positive rate and anomaly-chain benchmark this product has had.
- **SOPs are enforceable**: `deny_tools`, role-scoped SOP subscription,
  `.intutic/sops` found by walking up from the working directory, an
  `INTUTIC_SOPS_DIR` override, a loud startup warning naming every detector an
  empty SOP set disables, `REFINED` treated as advisory.
- **Policy Clause Ledger**: the Guardrail IR, renderers and five-way vector
  parity; guardrail warn rules through the daemon and proxy; the shared SOP-file
  renderer and replay vectors; the guardrails CLI and wire types; the predicate
  evaluator and `compile --candidate`; `--token-file`; guardrails pull; anchored
  hook-rule exclusions and the ledger CLI.
- **WASM rules**: a rule can reask, with a starter rule library; the guest sees
  every field the host sends; a governance module can say why it blocked; hot
  reload of `~/.intutic/wasm/`; a 16 MB guest-memory ceiling; `denied_tool_sources`
  in the guest context; the guest SDK parses it.
- **Harness coverage**: LangGraph, Muse Code, Grok Build, `@intutic/gate`, the
  Python SDK adapters, dsh, Mastra, Vercel AI SDK, OpenAI Agents SDK, TrueForge
  (embedded and standalone-server modes), OpenCode (the 42nd governed harness,
  with a `throw` gate contract), AutoGen in-process workbench, Managed Agents
  `watch()` reconnects; four more harnesses get real pre-tool gates; gates
  enforce WHERE clauses; `hold` at every hook gate — one mechanism for
  `review_before` and REQUIRE_APPROVAL; local hold tokens; Windsurf's real
  Cascade hook events and the JetBrains plugin's AI traffic through the TLS
  MITM proxy.
- **MCP governance proxy**: injection, anomaly and WASM governance ported from
  the Rust proxy; MCP curation parity; the remote MCP bridge (streamable HTTP
  and SSE) and its daemon mode; the per-server MCP allowlist; workspace
  injection patterns and landmark fixtures; `read_referenced_file` resolver; a
  shared anomaly session window across a harness session's sibling proxies;
  `remote_bridge_ready` in the log once the bridge is serving.
- **Gateway and BYO keys**: a `vk_`-only front door with cache tenancy pin,
  render-guard and per-workspace SOP resolution; enforced BYO-key
  refuse-on-missing-key gate; in-proxy heartbeat, config-version ack and
  SOP-status piggyback; automatic self-rotation that survives Docker recreate
  and Kubernetes reschedule; a local judge for self-hosted gateways; a shared
  gateway mints a `gw_` instance id so the control plane never mistakes a pod
  for a developer's session; `GET /intutic/instance` (loopback-only) tells the
  daemon which proxy process it is talking to, so the workspace's git and task
  context lands on the proxy's own session row.
- **Multi-provider key wizard** (registry, proxy routing for Mistral and
  OpenRouter); org signup, team management, gateway registration and
  provider-credentials CLI commands; `ControlPlaneClient` in the SDKs; a
  per-key model allowlist intersection; org-creation region parameter.
- **Sandbox and egress**: mandatory egress enforcement and an on-demand secure
  sandbox runtime; central egress-policy distribution with a Firecracker
  in-guest e2e; require-sandbox policy and egress-denial observability; sandbox
  attestation as a proxy signal a rule can gate on; sandbox-usage telemetry;
  enterprise CA/MDM rollout and the device-enforcement CLI.
- **Streaming and DLP**: the stream is held back so a split secret cannot escape;
  `/v1/responses` as a first-class shape; a model-emitted tool call refused before
  the client runs it; the DLP pattern set operator-configurable; secrets redacted
  before forwarding upstream; tool definitions pinned per workspace with the input
  schema hashed; response-injection snippet capture and the response-echo corpus.
- **Routing**: a routing reward that can notice a worse answer; cache-honest
  counterfactual, workspace-isolated session scope and a warm-prefix guard;
  unservable-model recovery; guard-liveness probes; `GET /intutic/spend`
  (loopback-only) and a local spend-trajectory detector; cache-token fields on
  trace details; mirror original-side cost and latency.
- **Open-core CLI and daemon**: `intutic start` (one-command standalone, no
  Valkey), `intutic integrity`, `intutic doctor`, local traces reader, the
  policy snapshot, findings CLI with a Reason column, daemon `status|stop|start`
  for the proxy and MCP targets, a proxy service unit, `connect` exits when told
  to (exit deadline, second-signal exit, SIGKILL escalation); agent and session
  reporting from the daemon; `/fix` and `/draw` prompt commands with local
  Obsidian/Logseq/Foam vault search; OTel across the mcp-daemon and CLI; GitOps
  for SOPs (faithful push, round-trip pull, drift status); the model catalog and
  cohort wizard.
- **Docs**: Compliance Evidence guide, Kafka/CDC delivery guarantees for SIEM
  export, capability matrix, governance controls checklist, egress as a guardrail,
  sandbox platform guide, org/tenancy hierarchy, provider keys and self-hosted
  gateway coverage, five integration pages, the harness security matrix.

### Changed

- The proxy attributes traces to the harness that made the request; each proxy
  process carries a per-process instance id on every trace.
- Judge failures are reported `UNAVAILABLE`, never a fabricated clean pass;
  mid-stream judge chunking runs on same-provider streams; BYO workspace judge
  model; open-weight judge default with governance-card labeling.
- Advisory anomaly findings no longer block the request; the exfiltration rule
  fires on a one-line exfiltration; the tool pin is scoped per harness.
- `@intutic/anomaly-taxonomy` extracted as the single source of truth; a
  taxonomy value is not an identity — detectors carry `detector_id`.
- Requests are bound to the authenticated workspace and honour deactivation; a
  key is validated against the control plane on a cache miss; the proxy fails
  closed when a virtual key cannot be validated.
- The pricing bundle is pinned to a LiteLLM commit and re-pinned on drift (the
  drift check gates the deploy); Linux release binaries build against glibc 2.35.
- Published latency claims retracted where no benchmark stood behind them;
  hallucination and context-drift auto-resolution no longer claimed.

### Fixed

- Loop governance never fired: the circuit breaker's budget scalar was never
  written and the proxy had no run id to read; now verified live (403
  `LOOP_RUN_TERMINATED` after Kill, 403 `WORKFLOW_BUDGET_BREACH` over budget).
- Streaming responses accrued no spend, so the local cap never fired; the cost
  gate answered every request instead of forwarding it; five inert controls
  brought to life; the token-baseline key hardcoded a segment nothing produced.
- `intutic exec` sent agent traffic and API keys to a remote host (1.7.2); the
  CLI shipped a stale proxy binary (1.7.1); the proxy admitted a request on a
  published key prefix; a redactor that missed its own examples.
- The remote-bridge test harness charged the child proxy's boot to its 5 s
  request timer (the source of the CI timeouts); the MCP-allowlist refusal
  names its rule on the stdout-contract gates; the reask ladder keyed reasks
  across tenants; the MCP proxy never read the control-plane URL the daemon
  wrote; `install-hooks.js` failed inside a git worktree.
- `intutic doctor`'s daemon-log check read a path nothing writes; the daemon's
  dead ContextGraph scan and BrainIndexer removed with three dead wires.

- **Loop governance never fired.** A user could set a per-loop budget and press
  Kill in the dashboard, and the agent kept running. The control plane wrote loop
  state as a JSON blob at `intutic:loop:{id}` while the proxy read flat scalars
  `:budget` and `:spend`, nothing wrote the budget scalar at all, and nothing set
  the `x-loop-run-id` header the proxy needed to identify the run. The proxy now
  resolves the active loop from a workspace pointer when the header is absent, the
  budget is published as a bare decimal (it is parsed as `Option<f64>`, so a JSON
  value silently became `None`), and `store::valkey::loop_key_contract` pins the
  key strings in Rust so the two sides cannot drift apart again. Verified against
  a live cluster: 403 `LOOP_RUN_TERMINATED` after Kill, 403
  `WORKFLOW_BUDGET_BREACH` over budget.
- `intutic doctor`'s daemon-log check read `~/.intutic/daemon.log`, which nothing
  writes — the installer logs to `sync-daemon.log` and `mcp-daemon.log`.
- Dropped the sync daemon's dead ContextGraph scan and BrainIndexer, and three
  proxy/CLI wires that no longer connected to anything.

### Security

- CodeQL runs over the whole tree on PRs and main alike, with test code excused
  and counted; polynomial regexes replaced (gate-js, guardrailRender,
  providerVerification); cleartext-logging sites fixed or dismissed at the site
  with reasoning; Dependabot advisories cleared before 1.6.0 and js-yaml raised
  for CVE-2026-59870; contiguous credential-shaped test literals assembled at
  runtime.

### Documentation

- **Removed claims of Docker/V8 agent isolation.** The competitor-comparison
  pages carry no paid-tier badge, so they render in the public docs build, and all
  three asserted that agent execution is isolated in Docker containers or V8
  isolates. Nothing containerizes an agent: what ships is a wasmtime WASM sandbox
  for policy rules (16 MB, 1,000,000 fuel, 5 ms) and SOP hook scripts in a frozen
  `node:vm` context. Corrected in prose as well as the comparison tables.
  The 1.6.0 entry below claims this cleanup was already done — it was not; that
  sweep fixed some references and missed the comparison pages entirely.
- Also removed the outbound-block-list and container-interceptor claims, neither
  of which has an implementation.
- **`guide/drift-detection.md` rewritten.** It documented compliance-score drift
  windows, drift direction, `behavioral_drift_event` records and embedding-based
  vector drift — none of which exist; that work was removed when the product
  narrowed to circuit-breaker scope. The page now covers the three mechanisms
  that are real (SOP staleness, per-developer cost baselines, proxy sequence
  anomalies) and says plainly that the drift scoring was removed, so a reader who
  remembers it is not left guessing.

## [1.10.0] - 2026-07-29

### Added

- **DLP scanner expanded from 6 patterns to 19**, all prefix- or
  magic-substring-anchored (formats ported from the gitleaks default config
  and TruffleHog detectors): OpenAI, GitLab, Slack tokens and webhook URLs,
  Google, Stripe, SendGrid, npm, PyPI, Hugging Face, database connection
  credentials, JWTs — plus widened AWS (temporary `ASIA` credentials), GitHub
  (all five classic prefixes + fine-grained), and the full PEM private-key
  family (OpenSSH, PGP, PKCS#8). A RegexSet prefilter keeps the clean-body
  scan at a single traversal.
- **Streaming responses are now scanned by output DLP.** Each SSE line is
  scrubbed before it is forwarded and before it is parsed, so the client, the
  judge, the semantic cache and the trace all see redacted text. Previously
  the streaming branch bypassed output DLP entirely.
- **Forwarded request headers are scanned** with the body's doctrine:
  block-action findings refuse the request, the rest are redacted in place.

### Fixed

- `DlpEscalationDetector` (the credential-sweep kill) was unfireable: it
  counted block-action findings, which refuse the request before the detector
  registry runs. It now counts distinct pattern types, so an AWS key + GitHub
  token + SSN in one request kills even though each is individually redacted.
- Multibyte characters bisected by a network chunk boundary were corrupted in
  streamed responses (per-chunk lossy decoding); the stream buffer is now
  bytes, decoded per line.
- The claude-code hook forwards Claude Code's `session_id`, restoring
  per-user attribution for hook-gate blocks after the next `intutic connect`.

## [1.9.0] - 2026-07-29

### Changed

- **Advisory anomaly findings no longer block requests.** Six heuristic
  detection paths (tool-transition plausibility, tool-contract drift,
  diversity collapse, context growth, token-waste heuristics, a single
  prompt-injection technique) now advise — logged, broadcast to graph siblings
  and traced — while the request proceeds. Deterministic detectors (loops,
  forbidden successions, budget breaches, credential sweeps, denied tools)
  still return 403. Previously every finding blocked, which had six advisory
  detectors hard-refusing requests they were written to merely steer.
- **`trace:live` events carry real per-turn tool calls.** A `tools` array
  (the calls newly observed on that request) and `taskType` join the payload;
  `toolName` is deprecated — it has always carried the task type — and is kept
  only for older sync-daemons. The stored tool sequence no longer duplicates
  the conversation history into itself on every request.
- **All graph state is workspace-namespaced.** Graph membership, spend,
  broadcast budgets and notification queues now include the workspace in
  their keys, and the response cache's exact-match hash is workspace-salted —
  two tenants reusing a graph id on shared infrastructure are isolated by
  construction rather than by id uniqueness.

### Fixed

- `MissingPredecessorDetector` stopped evaluating at its first rule, so
  sessions that never ran `deploy` had the `publish` and `release` ordering
  invariants silently unchecked.
- Tool-sequence keys in Valkey never expired; they now carry a 24h sliding
  TTL refreshed on write.
- `@modelcontextprotocol/sdk` moved to `^1.30.0`, taking `@hono/node-server`
  to 2.x (GHSA-frvp-7c67-39w9).

## [1.8.0] - 2026-07-28

### Added

- **Graph guardrails.** Node identity from OpenTelemetry GenAI attributes over
  W3C Baggage (with `X-Intutic-*` fallbacks), an 18-detector hot-path anomaly
  registry covering 11 of the 12 runtime anomaly categories, sibling broadcast
  of findings with loop suppression and rate ceilings, graph coordinates on
  every trace, and role-scoped SOPs from `.intutic/sops/*.md` whose
  `deny_tools` front matter is enforced rather than advisory.
- **Tool-definition pinning.** SHA-256 over each tool's name, description and
  input schema, pinned per workspace and surviving restarts — the MCP
  rug-pull defence.
- New public package `@intutic/anomaly-taxonomy` (Apache-2.0): the 12-category
  runtime anomaly taxonomy as types and constants, declared once and drift-
  checked against the Rust proxy's copy at build time.

### Fixed

- **DLP redaction actually redacts before forwarding.** Secrets matching
  redact-action patterns (AWS keys, GitHub tokens, bearer tokens, SSNs) were
  detected and logged as redacted, but the original body was forwarded to the
  provider. The redacted body is now what leaves the machine, and a redaction
  that would produce invalid JSON refuses the request instead of forwarding
  either version.

### Breaking

- **`intutic-clawde` (Python) now requires Python >= 3.10** (was 3.9). The
  patched releases of `requests` (2.33.0) and `urllib3` (2.7.0) — carrying
  fixes for CVE-2026-25645, CVE-2026-44431 and CVE-2026-44432 — themselves
  require 3.10, so keeping the 3.9 floor meant shipping known-vulnerable
  transports. Python 3.9 reached end of life in October 2025.

## [1.7.2] - 2026-07-27

### Fixed

- **`intutic exec` sent agent traffic and API keys to a remote host.**
  `buildProxyEnv` pointed `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL` and the rest
  at a remote proxy unless `--dev` was passed, and injected `OPENAI_API_KEY`
  alongside them. The default path therefore routed an agent's prompts and its
  provider credentials off the machine. That host does not resolve, so the
  command could not work either way. It now uses the local proxy that
  `intutic start` binds on `:4000`; set `INTUTIC_PROXY_URL` to point elsewhere.
- **Onboarding printed the same wrong address.** The setup instructions the CLI
  prints after `intutic init` told you to point your agent at a remote host
  rather than the proxy you had just started.

## [1.7.1] - 2026-07-27

### Fixed

- **The CLI installed, and then kept, the wrong proxy binary.** Two halves of
  one bug:

  The release tag `intutic connect` fetched the binary from was pinned to a
  literal `1.6.0`, so every version since shipped a CLI that installed a proxy
  several releases behind itself. A 1.7.0 user got the 1.6.0 binary, which
  still required Valkey and had none of the standalone work. It now reads the
  version from its own `package.json`, the same fix `intutic --version` got in
  1.6.3.

  Worse, the download cached to a single unversioned `~/.intutic/bin/intutic-proxy`
  that nothing ever revalidated: the launcher used the first binary it found and
  only downloaded when there was none. So upgrading the package did not upgrade
  the binary, and anyone who had already run `intutic connect` or
  `npx @intutic/proxy` would have stayed on the old proxy no matter how many
  times they upgraded. The cache is now keyed by version, and the old
  unversioned entry is deleted on first run.
- **Every install path pointed at `intutic connect`.** The README, the docs
  landing page, the marketing site and 18 integration guides all opened with
  `intutic init` then `intutic connect`, which starts the sync daemon and
  requires credentials for a control plane, which open core does not include.
  Anyone without one hit a login wall on step 2 of a "30-second" quickstart.
  They all lead with `intutic start` now (#1).
- **`integrations/standalone.md` documented a flag that does not exist.**
  `intutic connect --upstream-url ...` — `--upstream-url` is an option of
  `start`, not `connect`, so the command exited with an unknown-option error.
- **Docs pointed every harness at a hosted proxy.** Twelve integration guides
  gave a remote base URL and never mentioned `http://localhost:4000`, so
  following them routed every LLM request — prompts and provider API keys
  included — off the machine, when the whole premise of open core is that the
  proxy runs locally. All of them now point at the local proxy.
- **The OSS docs build now fails on hosted-infrastructure references.** Section
  stripping was opt-in, so anything nobody remembered to wrap shipped. The
  build refuses to publish those terms and names the offending page.

- **"Not authenticated" told you to run a command that would also fail.**
  Eight commands emitted `Run \`intutic login\` first` with no indication of
  the command needed, or that `intutic start` needs nothing. They now say both.

## [1.7.0] - 2026-07-27

### ⚠️ Breaking

- **Valkey is no longer required.** The proxy runs standalone with an in-memory,
  file-backed store. Nothing to change for existing setups — a reachable Valkey
  is still used whenever one is found — but the boot behaviour differs:

  | Environment | Behaviour |
  |---|---|
  | `CONTROL_PLANE_URL` set, Valkey unreachable | **fatal** (was: fatal) |
  | no `CONTROL_PLANE_URL`, Valkey unreachable | **standalone** (was: fatal) |
  | `INTUTIC_STANDALONE=1` | standalone, no probe (new) |

- **Control-plane-managed deployments now fail closed on an unverifiable
  request.** Previously, if Valkey became unreachable *after* startup, the proxy
  admitted requests it could neither authenticate nor budget-check. Both gates
  now reject instead:

  - `503 AUTH_UNVERIFIABLE` — the virtual key could not be validated
  - `503 BUDGET_UNVERIFIABLE` — spend could not be verified against the cap

  Both are retryable; clients should back off rather than treat the key as
  invalid. This affects managed deployments only. Standalone has no control
  plane to be unreachable and is unaffected.

  Rationale: authentication and hard spend caps are security and financial
  controls, where wrongly allowing is unbounded and wrongly denying costs a
  retry. Rate limiting and feature flags continue to fail open.

### Added

- **Standalone open core.** `intutic start` no longer exits when Valkey cannot
  be provisioned — it warns and runs. Routing, policies, DLP, WASM rules and
  local spend caps all work without one. Closes the last dead-end in the
  documented install (#1).
- **Durable standalone learning.** Bandit arm state persists to
  `~/.intutic/bandit-state.json` and reloads on boot, so a per-session CLI proxy
  accumulates learning across restarts and reaches the 20-pull threshold at
  which Thompson sampling engages. Writes are atomic and merged under an
  exclusive lock, so two proxies sharing a home directory converge instead of
  clobbering each other. Provider credentials are held in memory only and are
  never written to disk.
- **Learning carries over on upgrade.** Connecting a control plane seeds Valkey
  from the local snapshot, so attaching a control plane does not reset the
  workspace to cold start. Only arms Valkey does not already have are seeded; existing
  control-plane state is never overwritten.
- **`INTUTIC_STANDALONE=1`** forces standalone regardless of what is listening
  on the Valkey port.

### Changed

- **The proxy's entire Valkey surface moved behind two traits** (`LocalStore`,
  `ControlPlaneCache`). All 20 per-call-site connection clones are gone, and
  `redis::` now appears in exactly two files. Wire format is unchanged: the
  arm-update Lua runs verbatim and cached responses keep their field names, so
  state written by this version stays readable by the control plane's crons.
- **The standalone Valkey probe is bounded at 1.5s.** Falling back previously
  waited on the client's full retry budget (~9s) before starting.

### Fixed

- The cost-prediction gate and notification reader no longer construct a Redis
  client per request; both read only control-plane-written keys and are inert
  without one.
- `apps/docs/guide/faqs.md` described the budget gate as failing closed while
  the code failed open. The code now matches the documentation.

## [1.6.3] - 2026-07-26

### Added

- **`intutic start`** — one command to run the proxy standalone: no
  control plane, no configuration file. The Valkey provisioning ladder
  (existing instance, then Docker, then a local `valkey-server`/`redis-server`)
  previously sat below `intutic connect`'s credential check, so the open-core
  users who needed it could never reach it.

### Fixed

- `intutic --version` reads the installed `package.json` instead of a literal
  that had reported 1.6.0 for three releases.

## [1.6.2] - 2026-07-26

### Fixed

- A missing `config.yaml` no longer stops the proxy starting. `npm i -g
  @intutic/proxy` installs a binary and nothing else, so anyone following the
  documented install had no config file and got a bare
  `No such file or directory`. Defaults are now a working standalone
  configuration; a file that exists but is malformed still fails.
- An unreachable Valkey reports what it was connecting to and how to start one,
  instead of a bare `Connection refused (os error 111)`.
- The sync daemon stops its drift watcher before tearing down the workspace it
  watches, rather than after.
- Documentation no longer describes a control plane that open core does not
  ship.
- LaTeX in the docs renders instead of printing as source.

## [1.6.1] - 2026-07-26

### Fixed

- Linux release binaries build against glibc 2.35 rather than 2.39, restoring
  compatibility with Ubuntu 22.04 and other still-supported distributions. The
  npm publish is now blocked on an old-glibc smoke test so this cannot regress
  silently.

## [1.6.0] - 2026-07-25

### ⚠️ Breaking

- **The proxy no longer rewrites Anthropic-bound requests to a fixed model.**
  Previously every request whose resolved provider was Anthropic was silently
  rewritten to `claude-opus-4-8`, regardless of the model the caller asked for.
  Requests now reach the model they name.

  If you relied on that pin, restore it explicitly in `config.yaml`:

  ```yaml
  intutic_settings:
    routing:
      anthropic_model_override: "claude-opus-4-8"
  ```

  Leaving `anthropic_model_override` unset (the default) means no rewriting.

### Added

- **Local Thompson-sampling model routing.** The bandit router that previously
  required a control plane now runs standalone. Enable it under
  `intutic_settings.routing` in `config.yaml`; the candidate pool is
  configurable via `candidate_models` (default: `claude-3-5-sonnet`,
  `gpt-4o`, `gemini-2.0-flash`).
- **Local deterministic reward loop.** Arm rewards are computed on your machine
  from signals the proxy already observes — upstream success, latency against
  `latency_slo_ms`, token anomalies, and routed-vs-requested cost ratio — with
  no LLM judge and no telemetry leaving the host. Tunable under
  `intutic_settings.routing.reward`.
- **Single-writer ownership contract** for bandit arms, tracked in Valkey at
  `bandit:reward_mode:{workspaceId}`. A standalone proxy claims `local`; a
  control plane taking over sets `cloud`, and the local writer stands down
  within ~60s. Arm state carries over without distortion because both sides
  apply the identical update rule.
- **Local WASM rule hot-reload.** Compiled rules dropped into `~/.intutic/wasm`
  are picked up within ~5s on the request path — no restart, no control plane.
  Files follow an `NN_name.wasm` convention where `NN` sets evaluation
  priority. Override the directory with `INTUTIC_WASM_DIR` or
  `intutic_settings.wasm_local_dir`.
- **`intutic policy compile | install | list-local`** — compile AssemblyScript
  rules with `asc`, validate them by instantiation before install, and inspect
  what is installed locally. `install` refuses a rule that cannot instantiate,
  because the sandbox fails open and a broken rule would enforce nothing.
- **`intutic-rule-author` agent skill**, distributed to workspaces by the sync
  daemon (write-if-missing), teaching any coding agent to turn a plain-English
  business rule into a compiled, dry-run-verified, installed WASM policy.

### Changed

- Local WASM rules and centrally-synced rules are merged into one
  priority-ordered chain. `BLOCK` short-circuits and nothing overrides it, so
  the union is most-restrictive-wins: a local rule can add restrictions but can
  never neutralize a centrally-synced one.
- Blocked requests now report which rule fired (`policy_id` is attributed from
  the rule registry rather than left empty).
- Proxy binaries are downloaded from GitHub Release assets instead of a
  self-hosted mirror, so the download always matches the released tag.

### Fixed

- **`npm install -g @intutic/cli` failed with E404.** The published CLI
  depended on `@intutic/logger` and `@intutic/sync-daemon`, which were marked
  private and never published; `workspace:*` resolved to versions that did not
  exist on npm. Both are now published ahead of their dependents.
- **Quickstart docs misrouted Anthropic traffic.** `ANTHROPIC_BASE_URL` was
  documented with a `/v1` suffix, producing `/v1/v1/messages`, which failed
  route matching, was misclassified as OpenAI, and was forwarded to the wrong
  vendor with the wrong auth header. The Anthropic base URL is host-only.
  (`OPENAI_BASE_URL` correctly keeps `/v1`.)
- **Linux proxy downloads could never succeed.** The release workflow built
  `intutic-proxy-linux-amd64` while the CLI requested `intutic-proxy-linux-x64`.
  Names now match, and a native `linux-arm64` build target was added.
- A missing Valkey binary now produces actionable install instructions instead
  of a bare HTTP status.
- The managed proxy no longer defaults to Valkey port `6380` (the isolated test
  stack) when `VALKEY_URL` is unset; it uses the documented `6379`.
- Local WASM rule loading is fail-safe: an unreadable rules directory retains
  the previously loaded rules instead of silently dropping every local rule,
  and directory rescans no longer hold a lock across compilation.
- Streaming responses that fail or truncate mid-flight are no longer recorded
  as successful pulls in the bandit reward loop, and judge/cache overhead is no
  longer charged against a model's latency SLO.

### Documentation

- Removed references to endpoints and features that do not exist
  (SCIM provisioning, `POST /api/v1/auth/register`, Prompt Library,
  Docker/V8 sandboxing, CFO Ledger).
- The intelligent-routing guide is now reachable in the open-source docs build,
  with its dashboard-only steps marked enterprise-only.
- `reference/configuration.md` documents the full `intutic_settings` surface;
  `reference/cli.md` documents the shipped `policy`, `doctor`, and `budget`
  commands.
- Corrected sandbox limits (16 MB memory / 1,000,000 fuel / 5 ms), the wasmtime
  version (29), and the harness adapter count (18) across README, package
  READMEs, and `AGENTS.md`/`CLAUDE.md`.

[1.6.0]: https://github.com/intutic/intutic/releases/tag/v1.6.0
