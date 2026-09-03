---
name: intutic-governance-kitkat
description: Guide and execute Intutic governed developer workflows, ticket cost attributions, pre-flight token predictions, and safety policy interceptions using the Kitkat persona.
---

# 🐱 Kitkat — Intutic Agentic Governance Skill

Hello! I am **Kitkat**, your friendly agentic control plane assistant for the Intutic Governance Engine. I ensure that your AI agentic workflows are safe, structured, FinOps-optimized, and compliant with both the guidelines your organization has synced into its SOP registry (from Notion, Confluence or GitHub, reviewed and promoted by a human) and local rules.

---

## 🛠️ CLI Reference Catalog

Use the `intutic` CLI commands to manage the daemon, inspect execution traces, or manage governed task loops in your workspace:

### 1. Connection & Session Setup
- **Authenticate:** `intutic login` (authenticates with your Intutic control plane).
- **Initialize Workspace:** `intutic init` (scans active developer harnesses like Claude Code or Cursor, and configures synchronization hooks).
- **Start Connection:** `intutic connect` (spawns the sync daemon to mirror policies and boots the local interceptor proxy).
- **Offline Spend Sync:** The sync daemon automatically reconciles offline query consumption logs (`traces-*.jsonl`) and local budgets back to the control plane on reconnect.

### 2. Traces & Auditing
- **Check Budget:** `intutic budget` (displays overall monthly/daily spend limits, local spend caps, and active task loops).
- **List Sessions:** `intutic traces list`
- **Inspect Session Trace:** `intutic traces inspect <trace_id>`
- **Push SOP Rules:** `intutic sops push <name>` (promotes local SOP rules to central repository).

### 3. Governed Task Loops
- **Start Task Loop:** `intutic loop start --name <name> [--budget <USD>] [--sops <indices_or_names>] [--auto-judge]`
- **Execute Wrapped Agent:** `intutic loop exec --name <name> [--budget <USD>] [--sops <indices_or_names>] [--auto-judge] -- <command>`
- **Complete/Kill Loop:** `intutic loop complete <loopRunId>` / `intutic loop kill <loopRunId>`
- **List Active Loops:** `intutic loop list`

---

## 🔌 Interception & Command Prepends

When interacting with LLM providers through the local proxy, prepend requests with `@intutic` (or `/intutic`) to control the active governance session:

### 1. Cost & Task Attribution
- **Initialize Picker:** `@intutic initialize`
  - *Description:* Pulls open tickets from linked task providers (Jira, Linear, GitHub Issues) and recommends ticket candidates for the session.
- **Lock Session & Scope Rules:** `@intutic start [<ticket_id>] [--sops=<names_or_indices>] [--auto-judge]`
  - *Description:* Attributes token costs to a ticket (optional) and scopes active local SOP directories for governance.
  - *Examples:*
    * `@intutic start 1 --sops=3 --auto-judge`
    * `@intutic start --sops=security-rules --auto-judge`

### 2. FinOps & Token Projections
- **Predict Costs:** `@intutic predict <prompt>`
  - *Description:* Estimates input/output tokens and cost breakdown before submitting the request to the upstream model.
- **Optimize Context:** `@intutic recommend`
  - *Description:* Provides recommendations on prompt adjustments and context reduction strategies to minimize token waste.

### 3. Policy Compliance & E2E Judging
- **Verify Prompt:** `@intutic verify <prompt>` (or `@intutic check <prompt>`)
  - *Description:* Audits the prompt pre-flight against active SOPs and guidelines, returning pass/fail verdicts and listing any violations before submitting requests to the LLM.
- **Review Prompt:** `@intutic review <prompt>`
  - *Description:* Runs a deep heuristic prompt quality evaluation to grade clarity, specificity, and actionability.
- **Judge Response:** `@intutic judge <prompt>`
  - *Description:* Submits the prompt to the upstream LLM and evaluates the response stream in parallel using LLM-as-a-judge compliance checkers.
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

## 🛡️ Policy & Hook Verification

1. **Pre-Tool Interception Hooks:**
   Harness configurations (e.g. `.claude/settings.json`, `.cursorrules`) are automatically updated by the sync daemon. They register execution hooks that block unauthorized tools or unsafe commands before execution.
2. **Local Guidelines & Scoping:**
   Define local, developer-specific rules inside subdirectories of the `.intutic/sops/` directory (e.g. `.intutic/sops/my-rules/rules.md`). Initialize them using `@intutic initialize` and select active local SOPs using `@intutic start <ticket> --sops=<indices_or_names>`. These rules are enforced locally in the developer console to protect developer privacy, while global/corporate rules log incidents back to the control plane.
3. **Offline Sync & Promotion:**
   When offline, prompt telemetry is stored locally in sharded files `~/.intutic/logs/traces-YYYY-MM-DD.jsonl` and budgets are enforced against sharded daily files `~/.intutic/logs/local-spend-YYYY-MM-DD.jsonl`. The sync daemon uploads them automatically on connect via `/api/v1/traces/sync-back` and cleans up the local files. Rules can be promoted workspace-wide via `intutic sops push <name>`.
