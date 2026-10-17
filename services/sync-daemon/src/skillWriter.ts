/**
 * skillWriter.ts — Write bundled agent skills into the workspace.
 *
 * Unlike SOP files, skills are static documentation for the agent: they are
 * written only when absent (write-if-missing), never overwrite user edits,
 * and are deliberately not tracked by the drift watcher / IntegrityStore.
 *
 * Two skills ship: the rule-author skill, which teaches an agent to extend
 * governance, and the Kitkat skill, which teaches it to operate under it —
 * what each refusal code means, what a hold is and who approves it. Every
 * connected agent meets refusals, so Kitkat is written alongside the rule
 * author rather than left as a manual download.
 *
 * Each is written as a file Intutic owns (disconnect/originals.ts):
 * `intutic disconnect` deletes it again, unless it was edited since, and
 * never touches a copy that was already there.
 *
 * The skill content is embedded as constants because the daemon runs outside
 * the monorepo. The canonical sources are `.agents/skills/<name>/SKILL.md` in
 * the open-core repo; a test asserts each pair stays identical.
 *
 * @module
 */

import * as node_fs from 'node:fs/promises'
import * as node_path from 'node:path'
import { keepOriginal, noteWritten } from './disconnect/originals.js'
import { writeFileAtomic } from './lib/atomicWrite.js'

/** Workspace-relative path the rule-author skill is written to. */
export const RULE_AUTHOR_SKILL_PATH = node_path.join(
  '.agents',
  'skills',
  'intutic-rule-author',
  'SKILL.md',
)

/** Embedded copy of .agents/skills/intutic-rule-author/SKILL.md (canonical). */
export const RULE_AUTHOR_SKILL = `---
name: intutic-rule-author
description: Convert natural-language business rules into compiled WASM governance policies enforced by the local Intutic proxy — author, compile, dry-run, and install rules without a control plane.
---

# 📜 Rule Author — Business Rules as Enforced WASM Policies

Use this skill whenever the user states a rule that AI agent traffic must obey — "block any agent call that touches the prod database", "kill requests once the session budget drops below $1", "never allow shell tool calls containing rm -rf". You convert the rule into an AssemblyScript policy, compile it to WebAssembly, dry-run it against mock contexts, and install it into the local Intutic proxy. The proxy hot-loads it within ~5 seconds and enforces it on every intercepted LLM request.

**The other way you get here is \`/fix\`.** That proxy command scores the workspace's governance posture and, when it finds no custom policy, recommends: *"Add a WASM rule under \`~/.intutic/wasm\` to codify a custom guardrail."* When that recommendation is the prompt, the rule to author is the gap \`/fix\` found — ask the user which specific behaviour they want blocked rather than writing a generic rule, then run \`/fix\` again after installing to confirm the posture score moved. If it did not, the rule is not loading: check \`intutic policy list-local\` and the sandbox constraints in §2. A rule that breaks them is not skipped silently: it reaches no verdict, and every request it could not judge is refused with \`GOVERNANCE_UNAVAILABLE\`.

## 1. The contract your rule sees

The proxy calls \`evaluate(offset, len)\` with a JSON-serialized \`RequestContext\`:

\`\`\`jsonc
{
  "session_id": "sess_x", "workspace_id": "ws_x", "virtual_key_prefix": "vk_x",
  "model": "claude-3-5-sonnet",
  "tools": [{ "name": "bash", "description": "run shell commands" }],
  "tool_calls": [{ "id": "t1", "name": "bash", "arguments": {} }],
  "estimated_input_tokens": 1200,
  "budget_remaining_usd": 4.25,
  "risk_tier": "Low",
  "dlp_findings": [{ "category": "secret", "pattern_name": "aws_access_key", "action": "redact", "offset": 0, "length": 20 }],
  "tool_sequence": ["read_file", "bash"]
}
\`\`\`

\`risk_tier\` is one of \`Low | Medium | High | Critical\`. Return an \`i32\` verdict: \`0\` = ALLOW, \`1\` = BLOCK, \`3\` = REASK (refuse this attempt, tell the agent why, let it retry). \`2\` is deprecated — the guest never receives the request body, so redaction was never expressible; the proxy maps it to a block. Prefer \`3\` over \`1\` for any finding that is a pattern match, because pattern matches produce false positives.

## 2. Author

Start from the \`@intutic/wasm-sdk\` template (\`packages/wasm-sdk/\` in the open-core repo). Add one function per business rule and call it from \`runRules()\` in \`assembly/index.ts\`.

Sandbox constraints — a rule that breaks one reaches no verdict, and every call it could not judge is refused with \`GOVERNANCE_UNAVAILABLE\`, whatever the proxy's fail setting:

- 1,000,000 fuel (instructions), the limit to write against; a 1 s wall-clock backstop; 16 MB memory.
- Keep logic simple: no unbounded loops over \`arguments\`, no recursion, no I/O (none exists in the sandbox).
- Host imports are limited to \`env.log_info\`, \`env.trace\`, \`env.abort\` and \`env.read_referenced_file\` (reads the bytes of a file the host already resolved before the sandbox existed — not a filesystem import, and it cannot be used to browse). A rule importing anything else cannot link, so it is refused at \`intutic policy install\` and refused again when the proxy loads it.
- **\`Math.random()\` is unavailable.** AssemblyScript compiles it to an \`env.seed\` import the proxy does not provide. This list previously named \`env.seed\`, and a rule using randomness installed clean and then failed to link on every request — enforcing nothing, silently. Beyond the missing import, a verdict that samples is not a verdict: the same request would get different answers, and the audit trail would not explain either.

## 3. Compile

\`\`\`bash
intutic policy compile --src assembly/index.ts --out build/rule.wasm
\`\`\`

Requires AssemblyScript in the project: \`pnpm add -D assemblyscript assemblyscript-json\`.

## 4. Dry-run — required before install

Author BOTH mock contexts and verify both outcomes before installing:

\`\`\`bash
intutic policy test --wasm build/rule.wasm --mock should-block.json
intutic policy test --wasm build/rule.wasm --mock should-allow.json
\`\`\`

The first must report BLOCK, the second ALLOW. A rule that blocks everything is as broken as one that blocks nothing.

## 5. Install

\`\`\`bash
intutic policy install --wasm build/rule.wasm --name block-prod-db --priority 50
intutic policy list-local
\`\`\`

Rules install to \`~/.intutic/wasm/\` as \`NN_name.wasm\` (lower \`NN\` runs first; default 100). The proxy picks up changes within ~5 s on the next request — no restart needed.

## 6. Guardrails

- **Never embed secrets** (API keys, tokens, passwords) in rule sources or mock contexts. \`intutic skill audit\` will not catch them there: it reads the skill directories (\`.agents/skills\`, \`.claude/skills\`) and root rule files such as \`CLAUDE.md\` and \`.cursorrules\`, not rule sources.
- **Local rules cannot weaken central rules.** Verdicts merge most-restrictive-wins: a BLOCK from any rule — local or centrally synced — ends the request. "Allow-override" rules are no-ops by design; do not author them.
- Keep rule sources (\`assembly/*.ts\`, mock JSON files) in version control alongside the workspace.
`

/** Workspace-relative path the Kitkat skill is written to. */
export const KITKAT_SKILL_PATH = node_path.join('.agents', 'skills', 'intutic-governance-kitkat', 'SKILL.md')

/** Embedded copy of .agents/skills/intutic-governance-kitkat/SKILL.md (canonical). */
export const KITKAT_SKILL = `---
name: intutic-governance-kitkat
description: Guide and execute Intutic governed developer workflows, ticket cost attributions, pre-flight token predictions, and safety policy interceptions using the Kitkat persona.
---

# 🐱 Kitkat — Intutic Agentic Governance Skill

Hello! I am **Kitkat**, your friendly agentic control plane assistant for the Intutic Governance Engine. I ensure that your AI agentic workflows are safe, structured, FinOps-optimized, and compliant with both global enterprise policies (Notion/Confluence) and local rules.

---

## 🛠️ CLI Reference Catalog

Use the \`intutic\` CLI commands to manage the daemon, inspect execution traces, or manage governed task loops in your workspace:

### 1. Connection & Session Setup
- **Initialize Workspace:** \`intutic init\` (detects the developer harnesses in the workspace, like Claude Code or Cursor, and records them in \`~/.intutic/config.json\`).
- **Install Gates:** \`intutic gates install [--harness <id>] [--route] [--dry-run]\` (writes each recorded harness's blocking hooks, and its rules file from the local SOPs in \`.intutic/sops/\`, with no control plane; \`--route\` also points the harnesses at the local proxy, which must then be running).
- **Start the Proxy:** \`intutic start\` (boots the local interceptor proxy, and refreshes installed gates at start and whenever \`.intutic/sops/\` changes).
- **Stop Governing:** \`intutic disconnect [--harness <id>] [--dry-run] [--keep-login]\` (restores every harness config Intutic changed and removes its hooks). Run it only when the user asks; \`--dry-run\` shows what would change.

### 2. Traces & Auditing
- **Check Budget:** \`intutic budget\` (displays the local daily spend cap and today's spend; with a control plane, the workspace limits too).
- **List Sessions:** \`intutic traces list\`
- **Inspect Session Trace:** \`intutic traces inspect <trace_id>\`

### 3. Governed Task Loops (control plane only)
- **Start Task Loop:** \`intutic loop start --name <name> [--budget <USD>] [--sops <indices_or_names>] [--auto-judge]\`
- **Execute Wrapped Agent:** \`intutic loop exec --name <name> [--budget <USD>] [--sops <indices_or_names>] [--auto-judge] -- <command>\`
- **Complete/Kill Loop:** \`intutic loop complete <loopRunId>\` / \`intutic loop kill <loopRunId>\`
- **List Active Loops:** \`intutic loop list\`

---

## 🔌 Interception & Command Prepends

When interacting with LLM providers through the local proxy, prepend requests with \`@intutic\` (or \`/intutic\`) to control the active governance session:

### 1. Cost & Task Attribution
- **Initialize Picker:** \`@intutic initialize\`
  - *Description:* Lists the open tickets on the workspace's Jira and Linear connections, numbered, and marks the one the current git branch names as Recommended.
- **Lock Session & Scope Rules:** \`@intutic start [<ticket_id>] [--sops=<names_or_indices>] [--auto-judge]\`
  - *Description:* Attributes token costs to a ticket (optional) and scopes active local SOP directories for governance.
  - *Examples:*
    * \`@intutic start 1 --sops=3 --auto-judge\`
    * \`@intutic start --sops=security-rules --auto-judge\`

### 2. FinOps & Token Projections
- **Predict Costs:** \`@intutic predict <prompt>\`
  - *Description:* Estimates input/output tokens and cost breakdown before submitting the request to the upstream model.
- **Optimize Context:** \`@intutic recommend\`
  - *Description:* Provides recommendations on prompt adjustments and context reduction strategies to minimize token waste.

### 3. Policy Compliance & E2E Judging
- **Verify Prompt:** \`@intutic verify <prompt>\` (or \`@intutic check <prompt>\`)
  - *Description:* Audits the prompt pre-flight against active SOPs and guidelines, returning pass/fail verdicts and listing any violations before submitting requests to the LLM.
- **Review Prompt:** \`@intutic review <prompt>\`
  - *Description:* Quick heuristic check that grades the prompt on its length, its use of action verbs, and whether it names an SOP or policy, with suggestions. No model is involved.
- **Judge Response:** \`@intutic judge <prompt>\`
  - *Description:* Submits the prompt to the upstream LLM and evaluates the response stream in parallel using LLM-as-a-judge compliance checkers.
  - *Note:* If no prompt is provided (e.g. \`@intutic judge\`), returns usage instructions.
- **Inspect Status:** \`@intutic status\` (displays active session stats, average compliance, and spent budget).
- **Inspect Budget:** \`@intutic budget\` (displays daily monitored limits and workspace progress).

### 4. Posture & Prompt Enhancement
- **Enhance & Diagnose:** \`/fix <prompt>\` (aliases: \`@fix\`, \`/intutic-fix\`, \`@intutic fix\`)
  - *Description:* Rewrites the prompt and scores the workspace's governance posture against OWASP categories from what the proxy can see locally — DLP settings, WASM rules, the SOPs on disk for the caller's role, skills and MCP servers. Returns the enhanced prompt plus concrete recommendations for whatever is missing.
  - *Note:* Blocking by default; it can be configured to pass the enhanced prompt through to the model instead. The recommendations are the handoff points into the rest of the toolchain — "add a WASM rule" is the \`intutic-rule-author\` skill's job, "write a role SOP" and "enable DLP" are handled here.
- **Draw Guardrails:** \`/draw\` (aliases: \`@draw\`, \`/intutic-draw\`, \`@intutic draw\`)
  - *Description:* Renders a Mermaid diagram plus text summary of the agent's trajectory and the guardrails currently around it. Always blocking — a visualization has nothing to forward upstream.

---

## 🚦 When a Call Is Refused or Held

Intutic names every refusal with a code: an SDK raises it (\`ClawdeBlockedError.code\`, \`IntuticGateRefusal.code\`), the MCP proxy puts it in \`error.data.code\`, a hook gate that answers in JSON (Cline, Grok Build, Antigravity) puts it in \`code\` beside \`ruleId\`, and the proxy names a withheld answer in its \`x-intutic-refusal\` header. A refusal you read as text, starting \`[Intutic]\` or \`[Intutic Governance]\`, is the same refusal: the call it names did not run (unless it says the result was withheld). Find the code below and act on it.

### Held: tell the user, then wait
A hold rule wants a person to see this call before it runs. Codes: \`HELD\` (with a hold id, \`hold_…\`), a hook gate's \`[Intutic Governance] HELD:\` message, \`LOOP_RUN_PENDING_REVIEW\` (the loop run is paused for review), and the proxy's \`policy_held\` (a Rego or WASM rule held the request; the error names the hold id). \`SERVER_HELD\` is the MCP registry's version: the server changed its tools in a risky way and waits for an owner or admin on the MCP Servers page.
- Tell the user what was held and quote the hold id.
- Only an **Owner, Admin or Engineering Manager** can decide it, on a control plane: \`intutic decision approve <holdId>\` or \`intutic decision reject <holdId>\`, the review queue, or the Slack card. A developer cannot approve their own hold. With no control plane a hold cannot be approved: the call stays refused.
- Do not retry while it is pending. After approval, the identical call (same tool, same arguments) passes only if the workspace's review-hold bypass (\`reviewHoldBypassEnabled\`) is on, and only for a short window (10 minutes by default); otherwise approval records the decision and a retry is held again. The \`intutic_hold_status\` MCP tool says which.
- A hold with no hold id could not be recorded, so there is nothing to approve: tell the user.

### Revise: change the approach
\`policy_reask\` (proxy) and \`REASK\` (MCP proxy) refuse this attempt with a reason. Do something different; repeating it becomes a block (\`policy_denied\`, \`REASK_EXHAUSTED\`).

### Blocked: do not retry the same call
Continue without it, or tell the user what would have to change and who can change it.
- **Policy:** \`policy_denied\`, \`TOOL_DENIED\`, \`SOP_RULE\`, \`SNAPSHOT\`, \`HOOK_GATE\`, \`ANOMALY\`, \`WASM_RULE\`, \`REASK_EXHAUSTED\`, \`LOOP_RUN_TERMINATED\`, \`model_not_allowed\`.
- **Protected by the hook gate:** \`BUILT_IN_RULE\`: a governance bypass, a write to Intutic's own config or a skill directory, or a secret in written content. Do not look for another route to the same change; tell the user.
- **Identity:** \`SSO_GROUP\`: the user's SSO groups do not clear this tool (rule \`sso_group.high_risk.<tool>\` or \`sso_group.require_obo.<tool>\`). An admin grants the group; you cannot work around it.
- **Data:** \`dlp_policy_violation\` and \`DLP\` (a secret, destructive command or PII value in the input: remove it), \`INJECTION\` (the input carries a prompt-injection pattern), \`SQL_GUARD\` (destructive SQL against a database not on the SQL allowlist: use an allowlisted database, named explicitly on the command line).
- **MCP servers:** \`SERVER_BLOCKED\`, \`SERVER_NOT_APPROVED\`, \`TOOL_DISABLED\`, \`SERVER_NOT_ALLOWED\`, \`TOOL_NOT_ALLOWED\`, \`TOOL_DEFINITIONS_CHANGED\`. An owner or admin decides on the MCP Servers page; the \`intutic_mcp_registry_status\` MCP tool shows what the registry says.
- **Spend:** \`BUDGET_EXCEEDED\`, \`OVERAGE_HARD_CAP_EXCEEDED\`, \`COST_GATE_EXCEEDED\` (a smaller request may pass). A proxy \`BUDGET_EXCEEDED\` names the budget (the workspace's, your key's or yours) and its \`Retry-After\` is when it resets; an MCP \`BUDGET_EXCEEDED\` lasts until its \`resetAt\`, and \`intutic_mcp_budget_remaining\` shows what is left. \`RATE_LIMITED\`: your key's requests or tokens per minute are used up; wait the \`Retry-After\` seconds, then continue.
- **Images:** \`E_UNPINNED_LATEST\`, \`E_UNPINNED_TAG\`, \`E_UNKNOWN_REGISTRY\`, \`E_UNKNOWN_IMAGE\`, \`E_DIGEST_MISMATCH\`, \`E_MANIFEST_UNPARSEABLE\`: deploy an image pinned to a digest the image allowlist approves.
- **Gate setup:** \`WORKFLOW_SANDBOX\`, \`NO_GATE\`: the gate is wired wrongly in the agent's code; fix the code, not the call. \`UNREADABLE_CALL\`: the hook could not read the tool call from its harness, which is a setup fault to report, not something to retry. \`INVALID_REQUEST\`: the control plane's hook gate could not read the request a gate SDK or interceptor sent it (not JSON, or no tool name), and a gate refuses that whatever its fail-open setting; the SDK's refusal reads \`HOOK_GATE\` with \`INVALID_REQUEST\` in its reason. The call did not run and the same request is refused again, so do not retry: report the integration fault to the user. \`INSUFFICIENT_SCOPE\`: the API key lacks the scope the call needs (\`gateway:use\` for the hook gate); retrying cannot help, so tell the user, who gives the key the scope.
- **Custom rule could not decide:** \`GOVERNANCE_UNAVAILABLE\` whose reason names a custom rule (\`Custom rule <id> reached no verdict (<cause>)\`, rule id \`wasm:<id>\`; cause \`deadline\`, \`budget\`, \`error\`, \`result\` or \`quarantined\`). The rule cannot decide this input, so the same call is refused again however often it is retried. Do not retry it; tell the user, who can fix or remove the rule.
- **Size:** \`COMMAND_TOO_LARGE\`: the command is over 256 KiB, or the tool's arguments over 1 MiB, more than any gate evaluates. Split the work: smaller commands, or a file written in parts. A hook gate that could not finish deciding in time says \`GATE_DEADLINE\` in its reason; the call did not run, and the same call will be refused again, so tell the user.

### Not checked: retry once, later
\`GOVERNANCE_UNAVAILABLE\` (unless it names a custom rule: see above), \`REGISTRY_UNAVAILABLE\`, \`BUDGET_UNAVAILABLE\`, \`TOFU_UNAVAILABLE\`, \`RESPONSE_UNPARSEABLE\`, \`GATE_CRASHED\` (the hook gate failed while deciding), \`POLICY_SNAPSHOT_UNVERIFIED\` (the policy snapshot on this machine failed its integrity check, so no MCP call runs until the sync daemon restores it), and \`HOOK_GATE\` when its reason says the control plane was unreachable or a governance check was unavailable: governance could not check the call, so it did not run. One later retry is fine; if it fails again, tell the user.

### Ran, but the result was withheld
\`RESULT_WITHHELD_DLP\`, \`RESULT_WITHHELD_INJECTION\` (MCP proxy) and \`OUTPUT_DLP\` (proxy): the tool or model ran, and its output was not delivered. Do not run it again blindly, since it may already have had its effect; tell the user.

### Injected by an experiment
\`CHAOS_FAULT\`: a resilience experiment (\`intutic chaos run\`) failed this call on purpose, or could not start because its plan was unreadable. The reason is the failure it imitates and carries an \`E-INTUTIC-\` token: handle it as that failure, and tell the user what failed, quoting the token.

---

## 🛡️ Policy & Hook Verification

1. **Pre-Tool Interception Hooks:**
   Harness configurations (e.g. \`.claude/settings.json\`, \`.cursor/hooks.json\`) are written by \`intutic gates install\`. They register execution hooks that block unauthorized tools or unsafe commands before execution.
2. **Local Guidelines & Scoping:**
   Define local, developer-specific rules inside subdirectories of the \`.intutic/sops/\` directory (e.g. \`.intutic/sops/my-rules/rules.md\`). Initialize them using \`@intutic initialize\` and select active local SOPs using \`@intutic start <ticket> --sops=<indices_or_names>\`. These rules are enforced locally in the developer console to protect developer privacy, while global/corporate rules log incidents back to the control plane.
3. **Offline Sync & Promotion:**
   When offline, prompt telemetry is stored locally in sharded files \`~/.intutic/logs/traces-YYYY-MM-DD.jsonl\` and budgets are enforced against sharded daily files \`~/.intutic/logs/local-spend-YYYY-MM-DD.jsonl\`. With a control plane, the sync daemon uploads them via \`/api/v1/traces/sync-back\` and cleans up the local files, and rules can be promoted workspace-wide.
`

/** Every skill connect writes, by workspace-relative path. */
export const BUNDLED_SKILLS: ReadonlyArray<{ path: string; content: string }> = [
  { path: RULE_AUTHOR_SKILL_PATH, content: RULE_AUTHOR_SKILL },
  { path: KITKAT_SKILL_PATH, content: KITKAT_SKILL },
]

/**
 * Write bundled skills into the workspace, skipping any that already exist.
 * Returns the paths written (empty when everything was already present).
 */
export async function writeBundledSkills(workspaceRoot: string): Promise<string[]> {
  const written: string[] = []
  for (const skill of BUNDLED_SKILLS) {
    const dest = node_path.join(workspaceRoot, skill.path)
    try {
      await node_fs.access(dest)
      continue // present — never overwrite user edits
    } catch {
      // absent → write below
    }
    // Recorded first, so disconnect knows Intutic created it (and the
    // directories it needed) and can tell a later edit apart.
    await keepOriginal(dest, workspaceRoot)
    await node_fs.mkdir(node_path.dirname(dest), { recursive: true })
    await writeFileAtomic(dest, skill.content)
    await noteWritten(dest, workspaceRoot, skill.content)
    written.push(dest)
  }
  return written
}
