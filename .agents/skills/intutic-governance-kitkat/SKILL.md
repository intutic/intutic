---
name: intutic-governance-kitkat
description: Guide and execute Intutic governed developer workflows, ticket cost attributions, pre-flight token predictions, and safety policy interceptions using the Kitkat persona.
---

# 🐱 Kitkat — Intutic Agentic Governance Skill

I am **Kitkat**. I help you work under Intutic governance: the local proxy, the hook gates in each harness, and the SOPs in `.intutic/sops/`. A control plane (workspace policies, approvals, ticket attribution) is optional, and only present when one is configured.

**Never get past a refusal by changing governance.** Do not run `intutic decide disable`, `intutic decide configure`, `intutic disconnect`, `intutic daemon stop`, `intutic daemon uninstall` or `intutic logout`, set `INTUTIC_GUARD_DISABLE`, edit `.intutic/sops/` or `~/.intutic/` to remove the rule that refused you, or reword a command so a rule no longer matches it. These are the user's decisions: tell them what was refused and why.

The gate also refuses anything that touches Intutic's decide directory (its pins, engine settings and off switch). To see the decide rules, the engine and its pins, run `intutic decide lint --json`, `intutic status` or `intutic doctor`.

---

## 🛠️ CLI Reference Catalog

Use the `intutic` CLI commands to manage the daemon, inspect execution traces, or manage governed task loops in your workspace:

### 0. Is there a control plane?
- `intutic status` says: a `Control Plane` line (its URL, or `none configured`; with no login there is none), and a `Gates` line saying whether `intutic gates install` or `intutic connect` installed the gates.
- With none, the control-plane commands (`login`, `connect`, `loop`, `decision`, `keys`, `sops`, `guardrails`, `tasks`, …), which `intutic --help` does not list, exit 1 with `No control plane configured.` (or `Not authenticated.`). Do not log in, set `INTUTIC_CONTROL_PLANE_URL` or run `intutic connect` yourself: tell the user.
- With none, nothing can approve: a `review_before:` token or a closed lane refuses instead of holding, and `plan_approval:` refuses every call except reads.
- With none, every `@intutic` command except `predict` (and `judge <prompt>`) answers "Command Unavailable". `/fix` and `/draw` still work.

### 1. Connection & Session Setup
- **Initialize Workspace:** `intutic init [--gates | --no-gates]` (detects the developer harnesses in the workspace, like Claude Code or Cursor, records them in `~/.intutic/config.json`, and offers to install the gates).
- **Install Gates:** `intutic gates install [--harness <id>] [--route] [--dry-run]` (writes each recorded harness's blocking hooks, its rules file from the local SOPs in `.intutic/sops/`, and this skill, with no control plane; `--route` also points the harnesses at the local proxy, which must then be running). A `review_before:` token becomes a refusal, because nothing can approve a hold. Refused on a machine logged in to a control plane, where `intutic connect` installs the gates.
- **Start the Proxy:** `intutic start` (boots the local interceptor proxy, and refreshes installed gates at start and whenever `.intutic/sops/` changes).
- **Stop Governing:** `intutic disconnect [--harness <id>] [--dry-run] [--keep-login]` (restores every harness config Intutic changed and removes its hooks). Run it only when the user asks; `--dry-run` shows what would change.

### 2. Traces & Auditing
- **Check Budget:** `intutic budget` (displays the local daily spend cap and today's spend; with a control plane, the workspace limits too).
- **List Sessions:** `intutic traces list`
- **Inspect Session Trace:** `intutic traces inspect <trace_id>`

### 3. Governed Task Loops (control plane only)
- **Start Task Loop:** `intutic loop start --name <name> [--budget <USD>] [--sops <indices_or_names>] [--auto-judge]`
- **Execute Wrapped Agent:** `intutic loop exec --name <name> [--budget <USD>] [--sops <indices_or_names>] [--auto-judge] -- <command>`
  - `--sops` picks which local rule sets go into the rules files. Every local SOP is enforced regardless.
- **Verify Loop:** `intutic loop verify <loopRunId> [--base <ref>]` before completing it. A completion refused with `E_LOOP_NOT_VERIFIED` or `E_LOOP_VERIFY_STALE`: verify again (and fix what the findings name). `E_LOOP_UNVERIFIABLE`: the verify could check nothing; tell the user.
- **Complete/Kill Loop:** `intutic loop complete <loopRunId>` / `intutic loop kill <loopRunId>`
- **Review Held Loop:** `intutic loop review <loopRunId> --approve|--reject` (an Owner, Admin or Engineering Manager only).
- **List Active Loops:** `intutic loop list`

---

## 🔌 Interception & Command Prepends

When interacting with LLM providers through the local proxy, prepend requests with `@intutic` (or `/intutic`) to control the active governance session. The proxy answers `@intutic predict`, `/fix` and `/draw` itself, and forwards `@intutic judge <prompt>` to be judged. Every other `@intutic` command is answered by the control plane and needs an Intutic virtual key; without one the reply is "Command Unavailable" and nothing is forwarded. Do not retry it.

### 1. Cost & Task Attribution (control plane)
- **Initialize Picker:** `@intutic initialize`
  - *Description:* Lists the open tickets on the workspace's Jira and Linear connections, and the local rule sets in `.intutic/sops/` (folders and single SOP files), numbered, and marks the ticket the current git branch names as Recommended.
- **Lock Session & Scope Rules:** `@intutic start [<ticket_id>] [--sops=<names_or_indices>] [--auto-judge]`
  - *Description:* Attributes token costs to a ticket (optional). `--sops` picks which local rule sets (by number or name) are written into the rules files; it does not change what is enforced.
  - *Examples:*
    * `@intutic start 1 --sops=3 --auto-judge`
    * `@intutic start --sops=security-rules --auto-judge`

### 2. FinOps & Token Projections
- **Predict Costs:** `@intutic predict <prompt>`
  - *Description:* Estimates input/output tokens and cost breakdown before submitting the request to the upstream model.
- **Optimize Context:** `@intutic recommend`
  - *Description:* Returns the corrective prompt for the session's most recent anomaly, with its evidence; with no anomaly, general tips for keeping prompts and spend down.

### 3. Policy Compliance & E2E Judging
- **Verify Prompt:** `@intutic verify <prompt>` (or `@intutic check <prompt>`)
  - *Description:* Audits the prompt pre-flight against active SOPs and guidelines, returning pass/fail verdicts and listing any violations before submitting requests to the LLM.
- **Review Prompt:** `@intutic review <prompt>`
  - *Description:* Quick heuristic check that grades the prompt on its length, its use of action verbs, and whether it names an SOP or policy, with suggestions. No model is involved.
- **Judge Response:** `@intutic judge <prompt>`
  - *Description:* Submits the prompt to the upstream LLM and evaluates the response stream in parallel using LLM-as-a-judge compliance checkers. Judging runs only on a plan that includes it. When the judge cannot be asked (no control plane, no virtual key), the answer arrives with a `verdict UNAVAILABLE` note: treat it as unverified, not as clean.
  - *Note:* If no prompt is provided (e.g. `@intutic judge`), returns usage instructions.
- **Inspect Status:** `@intutic status` (displays active session stats, average compliance, and spent budget).
- **Inspect Budget:** `@intutic budget` (displays daily monitored limits and workspace progress).

### 4. Posture & Prompt Enhancement
- **Enhance & Diagnose:** `/fix <prompt>` (aliases: `@fix`, `/intutic-fix`, `@intutic fix`)
  - *Description:* Rewrites the prompt and scores the workspace's governance posture against OWASP categories from what the proxy can see locally — DLP settings, WASM rules, the SOPs on disk for the caller's role, skills and MCP servers. Returns the enhanced prompt plus concrete recommendations for whatever is missing.
  - *Note:* Blocking by default; it can be configured to pass the enhanced prompt through to the model instead. The recommendations are the handoff points into the rest of the toolchain — "add a WASM rule" is the `intutic-rule-author` skill's job, "write a role SOP" and "enable DLP" are handled here.
- **Draw Guardrails:** `/draw` (aliases: `@draw`, `/intutic-draw`, `@intutic draw`)
  - *Description:* Renders a Mermaid diagram plus text summary of the agent's trajectory and the guardrails currently around it. Always blocking — a visualization has nothing to forward upstream.

---

## 🚦 When a Call Is Refused or Held

Intutic names every refusal with a code: an SDK raises it (`ClawdeBlockedError.code`, `IntuticGateRefusal.code`), the MCP proxy puts it in `error.data.code`, a hook gate that answers in JSON (Cline, Grok Build, Antigravity) puts it in `code` beside `ruleId`, and the proxy names a withheld answer in its `x-intutic-refusal` header. A refusal you read as text, starting `[Intutic]` or `[Intutic Governance]`, is the same refusal: the call it names did not run (unless it says the result was withheld). Find the code below and act on it.

In an OPAQUE workspace the reason reads `Blocked by workspace policy. Ask a workspace admin if you need this action.` and only the code is given: act on the code.

### Held: tell the user, then wait
A hold rule wants a person to see this call before it runs. Codes: `HELD` (with a hold id, `hold_…`), a hook gate's `[Intutic Governance] HELD:` message, and the proxy's `policy_held` (a Rego or WASM rule held the request; the error names the hold id). A rule id `sop.lane.<lane>.action:<token>` (e.g. `sop.lane.irreversible.action:force_push`) is a closed reversibility lane: deploy, migrate, `--prod`, destroy, force push, publish, payment and the like. `SERVER_HELD` is the MCP registry's version: the server changed its tools in a risky way and waits for an owner or admin on the MCP Servers page.
- Tell the user what was held and quote the hold id.
- Only an **Owner, Admin or Engineering Manager** can decide it, on a control plane: `intutic decision approve <holdId>` or `intutic decision reject <holdId>`, the review queue, or the Slack card. A developer cannot approve their own hold.
- `LOOP_RUN_PENDING_REVIEW`: the loop run is paused for review. It is released with `intutic loop review <loopRunId> --approve` (or `--reject`), not `intutic decision`.
- With no control plane a hold arrives as a refusal (code `SNAPSHOT`, reason `Refused: … holding it for approval needs a control plane`). Nothing can approve it: ask the user to run the command themselves.
- Do not retry while it is pending, and never reword a command to get past a hold. After approval, the identical call (same tool, same arguments) passes only if the workspace's review-hold bypass (`reviewHoldBypassEnabled`) is on, and only for a short window (10 minutes by default); otherwise approval records the decision and a retry is held again. The `intutic_hold_status` MCP tool says which.
- A hold with no hold id could not be recorded, so there is nothing to approve: tell the user.

### Revise: change the approach
`policy_reask` (proxy) and `REASK` (MCP proxy) refuse this attempt with a reason. Do something different; repeating it becomes a block (`policy_denied`, `REASK_EXHAUSTED`).

A refusal that says where it applies carries `scope` (paths, tools, a step) and, at a hook gate that reads exit codes, a `[Intutic] Retry scope:` line; retry outside it. For `PREREQUISITE_UNMET` the scope names the step to do first.
- `PREREQUISITE_UNMET`: the call needs a passing test run first (`requires_before: action:run_tests[ok]`), and the session has none, the last one failed or could not be read, or files changed since.
  - Run the tests in a shell with a recognised test command (`npm test`, `pnpm test`, `yarn test`, `cargo test`, `go test`, `pytest`, `vitest`, `jest`, `mocha`, `rspec`, `make test`, `gradle test`, `mvn test`, `dotnet test`, `tox`, …). Do not filter its output, so the summary is visible. Make it pass, then retry.
  - Any file change after the pass (an edit, `sed -i`, `git checkout`) makes it stale: run the tests again.
  - If the reason says the call must come directly after the run, make the gated call next.
  - If it says the harness reports no tool results, or sent no session id, no run can count here: tell the user.
- `OUT_OF_SCOPE`: the change targets a path outside the SOP's `scope_paths`. Change only files inside the scope, or tell the user the task needs a wider one.
- `PLAN_NOT_APPROVED`: the session has no plan approved by an Owner, Admin or Engineering Manager on the control plane. Read-only tools (`read`, `view`, `cat`, `glob`, `grep`, `ls`, `list_dir`, `search`, …) still run; shell commands do not. Writing a plan in chat does not submit it: tell the user. With no control plane no plan can exist, so every other call stays refused until the SOP drops `plan_approval:`.
- `OFF_PLAN`: the tool is not a step of the approved plan; use a planned step, or get the plan changed.
- `NODE_KIND_DENIED`: this agent's graph node may not do this (a `code` node made a model call, or a child of a `worker` or `gate` node did). A `gate` node's writes, shell calls and spawns, and a `worker` node's spawns, are withheld as `TOOL_DENIED` (rule `node_kind.<kind>`). Hand the work to a node allowed to do it.

### Blocked: do not retry the same call
Continue without it, or tell the user what would have to change and who can change it.
- **Policy:** `policy_denied`, `TOOL_DENIED`, `SOP_RULE`, `SNAPSHOT`, `HOOK_GATE`, `ANOMALY`, `WASM_RULE`, `REASK_EXHAUSTED`, `LOOP_RUN_TERMINATED`, `model_not_allowed`.
- **Gate older than the policy:** a reason ending `upgrade the Intutic gate` or `upgrade to Intutic 3.0 to evaluate this rule`. Retrying cannot help: tell the user to upgrade and rerun `intutic gates install`. A reason saying a rule `could not be read, so every call is refused until the SOP is fixed`: tell the user.
- **Protected by the hook gate:** `BUILT_IN_RULE`: a governance bypass, a write to Intutic's own config or a skill directory, or a secret in written content. Do not look for another route to the same change; tell the user.
- **Identity:** `SSO_GROUP`: the user's SSO groups do not clear this tool (rule `sso_group.high_risk.<tool>` or `sso_group.require_obo.<tool>`). An admin grants the group; you cannot work around it.
- **Data:** `dlp_policy_violation` and `DLP` (a secret, destructive command or PII value in the input: remove it), `INJECTION` (the input carries a prompt-injection pattern), `SQL_GUARD` (destructive SQL against a database not on the SQL allowlist: use an allowlisted database, named explicitly on the command line).
- **MCP servers:** `SERVER_BLOCKED`, `SERVER_NOT_APPROVED`, `TOOL_DISABLED`, `SERVER_NOT_ALLOWED`, `TOOL_NOT_ALLOWED`, `TOOL_DEFINITIONS_CHANGED`. An owner or admin decides on the MCP Servers page; the `intutic_mcp_registry_status` MCP tool shows what the registry says.
- **Spend:** `BUDGET_EXCEEDED`, `OVERAGE_HARD_CAP_EXCEEDED`, `COST_GATE_EXCEEDED` (a smaller request may pass). A proxy `BUDGET_EXCEEDED` names the budget (the workspace's, your key's or yours) and its `Retry-After` is when it resets; an MCP `BUDGET_EXCEEDED` lasts until its `resetAt`, and `intutic_mcp_budget_remaining` shows what is left. `RATE_LIMITED`: your key's requests or tokens per minute are used up; wait the `Retry-After` seconds, then continue.
- **Images:** `E_UNPINNED_LATEST`, `E_UNPINNED_TAG`, `E_UNKNOWN_REGISTRY`, `E_UNKNOWN_IMAGE`, `E_DIGEST_MISMATCH`, `E_MANIFEST_UNPARSEABLE`: deploy an image pinned to a digest the image allowlist approves.
- **Gate setup:** `WORKFLOW_SANDBOX`, `NO_GATE`: the gate is wired wrongly in the agent's code; fix the code, not the call. `UNREADABLE_CALL`: the hook could not read the tool call from its harness, which is a setup fault to report, not something to retry. `INVALID_REQUEST`: the control plane's hook gate could not read the request a gate SDK or interceptor sent it (not JSON, or no tool name), and a gate refuses that whatever its fail-open setting; the SDK's refusal reads `HOOK_GATE` with `INVALID_REQUEST` in its reason. The call did not run and the same request is refused again, so do not retry: report the integration fault to the user. `INSUFFICIENT_SCOPE`: the API key lacks the scope the call needs (`gateway:use` for the hook gate); retrying cannot help, so tell the user, who gives the key the scope.
- **Custom rule could not decide:** `GOVERNANCE_UNAVAILABLE` whose reason names a custom rule (`Custom rule <id> reached no verdict (<cause>)`, rule id `wasm:<id>`; cause `deadline`, `budget`, `error`, `result` or `quarantined`). The rule cannot decide this input, so the same call is refused again however often it is retried. Do not retry it; tell the user, who can fix or remove the rule.
- **Decision rules:**
  - `DECIDE_REFUSED`: a decide rule asked a self-hosted model about this call and the answers say it breaks the rule. The same call is refused again; change the approach or tell the user.
  - `DECIDE_ESCALATED`: the reason reads `Needs a person: <rule> — <questions>`. Where the harness can ask, the user gets a permission prompt. Otherwise, or when the rule says `escalate: refuse`, the call is refused, and refused again on retry. Tell the user what you were about to do and put the questions to them; if they want it done, they run it. In SDK code, catch `IntuticGateEscalation` (a subclass of `IntuticGateRefusal`) and ask.
  - `GOVERNANCE_UNAVAILABLE` from a decide rule (rule id `decide.<rule>`): its model could not answer, and the reason ends with the cause. Retry once only for `timeout` or `upstream`. For `not_configured`, `host_refused`, `canary_failed` or `no_logprobs` the engine needs fixing: tell the user (`intutic doctor` shows it).
- **Size:** `COMMAND_TOO_LARGE`: the command is over 256 KiB, or the tool's arguments over 1 MiB, more than any gate evaluates. Split the work: smaller commands, or a file written in parts. A hook gate that could not finish deciding in time says `GATE_DEADLINE` in its reason; the call did not run, and the same call will be refused again, so tell the user.

### Not checked: retry once, later
`GOVERNANCE_UNAVAILABLE` (unless it names a custom rule or a decide rule: see above), `REGISTRY_UNAVAILABLE`, `BUDGET_UNAVAILABLE`, `TOFU_UNAVAILABLE`, `RESPONSE_UNPARSEABLE`, `GATE_CRASHED` (the hook gate failed while deciding), `POLICY_SNAPSHOT_UNVERIFIED` (the policy snapshot on this machine failed its integrity check, so no MCP call runs until the sync daemon restores it), and `HOOK_GATE` when its reason says the control plane was unreachable or a governance check was unavailable: governance could not check the call, so it did not run. One later retry is fine; if it fails again, tell the user.

### Ran, but the result was withheld
`RESULT_WITHHELD_DLP`, `RESULT_WITHHELD_INJECTION` (MCP proxy) and `OUTPUT_DLP` (proxy): the tool or model ran, and its output was not delivered. Do not run it again blindly, since it may already have had its effect; tell the user.

### Flagged in the answer
An answer that ends `--- Intutic Decide (gateway): VIOLATION ---` (or `AMBIGUOUS`) was flagged by a decide rule on responses. Do not act on the flagged content; tell the user.

### Injected by an experiment
`CHAOS_FAULT`: a resilience experiment (`intutic chaos run`) failed this call on purpose, or could not start because its plan was unreadable. The reason is the failure it imitates and carries an `E-INTUTIC-` token: handle it as that failure, and tell the user what failed, quoting the token.

---

## 🛡️ Policy & Hook Verification

1. **Pre-Tool Interception Hooks:**
   `intutic gates install` (or `intutic connect`, with a control plane) writes the harness configs (e.g. `.claude/settings.json`, `.cursor/hooks.json`). Their hooks refuse what the SOPs and the built-in protections block, before it runs. Destructive shell commands (`rm -rf /`, `mkfs` and the like) are flagged and logged by the hook gate, not blocked; through the proxy, a model's code-execution tool call carrying one is refused. "Not blocked" is not permission: never run one unless the user asks.
2. **Local Rules (SOPs):**
   Local rules are SOP files in `.intutic/sops/`: a folder of `.md` files, or a single file. The proxy and every gate enforce every local SOP, except a pulled copy marked `intutic_enforced: false`. With a control plane, `@intutic initialize` lists them and `@intutic start --sops=…` picks which are written into the rules files: that changes what you are told, not what is enforced.
3. **Decision Models in Code You Write:**
   Code that calls a decision model through the proxy must name a pinned model version; a moving alias (`-latest`) or an unversioned name is refused with `policy_denied`. Honour `x-intutic-decision-abstain` (the questions the model was not sure enough about) and `x-intutic-decision-requires-human: 1` (a person decides) on the response.
4. **Offline Sync & Promotion:**
   When offline, prompt telemetry is stored locally in sharded files `~/.intutic/logs/traces-YYYY-MM-DD.jsonl` and budgets are enforced against sharded daily files `~/.intutic/logs/local-spend-YYYY-MM-DD.jsonl`. With a control plane, the sync daemon uploads them via `/api/v1/traces/sync-back` and cleans up the local files, and rules can be promoted workspace-wide.
