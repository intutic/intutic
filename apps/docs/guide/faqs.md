# Frequently Asked Questions <Badge type="tip" text="Guides" />

This page provides a detailed breakdown of how the open-core and enterprise boundaries, the local Rust proxy, and the control plane interact to handle slash commands, FinOps, policy evaluations, and spend limits.

---

### 1. How do Slash Commands work for Open-Core/Free users?

The slash command pipeline operates differently depending on the deployment mode:
*   **Online/Connected Mode (Free Tier / SaaS):** Outbound slash commands (like `@intutic initialize` or `@intutic start`) are intercepted by the local proxy and forwarded via HTTP to the control-plane API (which is either hosted in the cloud or run locally in a developer sandbox Docker container). The control plane executes `slashCommandService.ts` to perform database/Valkey queries (e.g., fetching Jira tickets) and returns a rendered Markdown card response.
*   **Offline/Standalone Mode (Pure Open-Core):** The local CLI daemon handles core commands locally. For instance, active local SOP folder scanning, compilation, and file writes are executed entirely on your local machine using standard Node.js filesystem APIs and a local **JSON** database, bypassing control plane requirements.

---

### 2. How does the local Rust proxy know about slash commands?

The local Rust proxy acts as a transparent middleman. It doesn't run the slash command logic directly:
1.  When you send a prompt containing a command (like `@intutic start --sops=security`), the local Rust proxy intercepts the request payload.
2.  If the prompt begins with `@intutic` or `/intutic`, the proxy **diverts** the request and posts it to the control-plane API endpoint `/api/v1/slash-command`.
3.  The control-plane processes the command, generates the response markdown (like the locks card), and returns it to the proxy.
4.  The proxy wraps this text inside a standard LLM chat completion structure and streams it back to Cursor or Claude Code. To the editor client, it looks like a normal response from Anthropic or OpenAI.
5.  If the command locks active rules, the control plane immediately broadcasts a WebSocket message (`active_local_sops_update`). The local sync daemon receives this message, writes it locally to `.intutic/session-context.json`, and triggers `applySyncConfig` to rebuild your `CLAUDE.md` or `.cursorrules`.

---

### 3. Who performs FinOps attribution, SOP evaluations, and judging?

It is a hybrid system divided between the **Local Rust Proxy** and the **Remote Control Plane**:

| Capability | Local Rust Proxy / Daemon | control plane / Remote Proxy |
| :--- | :--- | :--- |
| **Local SOPs Evaluation** | **Yes (WASM-based)**. Runs local markdown rules in a WASM sandbox. Violations are logged to a local JSONL trace log and shown in the developer console. | No. Local personal rules are kept strictly private to the developer's computer. |
| **Corporate SOP Evaluations** | No. | **Yes**. Performs semantic similarity and L2/L3 evaluation, records incidents centrally, and raises alerts. |
| **Token & Cost Auditing** | **Yes (Pre-flight estimation)**. Estimates counts pre-flight to prevent runaway token spend. | **Yes (Historical ledger)**. Persists actual token costs centrally for workspace-wide reporting. |

---

### 4. Is Intutic usable in pure Open-Core?

**Yes, absolutely.** The open-core version is fully functional as a developer sandbox:
*   Developers can define personal, local-only guidelines in `.intutic/sops/` subdirectories.
*   The sync daemon compiles and merges these local guidelines directly into `.cursorrules`, `CLAUDE.md`, or `.windsurfrules` in real-time.
*   Outbound prompts and streams are evaluated against these files using the local WASM rules engine. If a rule is violated, warnings are printed directly in the terminal client.
*   This setup protects developer privacy: local rule deviations are kept entirely offline in your workspace, while providing active stream-level interception and rule enforcement. Central database logging, trajectory analysis and config-drift reporting are only enabled when connected to the commercial control plane.

---

### 5. Are these rules limited to Security?

**No, they are not limited to security rules.** 

The local WASM rules engine acts as a general-purpose pattern, regex, and AST scanner. It evaluates *any* rules defined under the `# Rules` or `## Rules` headers in markdown files (such as `.cursorrules`, `CLAUDE.md`, and your `.intutic/sops/` folders). 

This allows you to enforce a wide variety of development standards, including:
*   **Design & Styling Compliance:** (e.g., *“Strictly use CSS custom variables from variables.css; hardcoded hex codes are prohibited in component CSS.”*)
*   **Architecture Boundaries:** (e.g., *“All schemas must live in packages/db. Do not duplicate drizzle structures in other modules.”*)
*   **Coding/Dependency Constraints:** (e.g., *“Do not import third-party libraries globally; use local wrappers under packages/id/.”*)
*   **Deprecations:** (e.g., *“Never call Date.now() directly; use newIso() from the packages/id/ library instead.”*)

---

### 6. How are token counts estimated in Open Core without a historical ledger?

The token cost prediction works via a multi-tiered fallback architecture:

#### Tier 1: Local JSONL Metrics (Developer History)
When running in pure Open-Core mode, the local CLI and Intutic Rust proxy record every token event locally to flat, daily sharded **JSONL trace files** (`~/.intutic/logs/traces-YYYY-MM-DD.jsonl`) on the developer's machine. 
If the developer has run at least 3 queries of the same model and task type, the `@intutic predict` CLI will query the local JSONL trace files to compute average input-to-output ratios, p50 output token counts, and reasoning tokens.

#### Tier 2: Static Token Multipliers (Zero-Data Fallback)
If the local JSONL trace cache is empty (e.g., a brand new workspace or first query), the engine falls back to static, model-specific token ratio multipliers:
*   **Claude models:** Estimated output is `0.8` $\times$ input tokens.
*   **GPT-4 models:** Estimated output is `0.6` $\times$ input tokens.
*   **Reasoning models (o1/o3):** Estimated output is `2.0` $\times$ input tokens.
*   **Gemini models:** Estimated output is `0.7` $\times$ input tokens.

Once the output token count is estimated, the system multiplies both input and estimated output tokens against a built-in model pricing table (e.g. input $0.000003$, output $0.000015$ per token for `claude-4-sonnet`) to generate a pre-flight cost projection with a `low` confidence rating.

---

### 7. Who enforces these rules? Can the agent LLM just ignore them?

**No, they are actively enforced at the protocol level.** 

If the agent LLM attempts to deviate or ignore the instructions (which is common because LLMs suffer from prompt-drift and instruction fatigue), the **Intutic Proxy Layer actively intercepts and blocks/corrects the action.** 

The local Rust proxy acts as an inline firewalled gateway between the developer's agent client (e.g., Claude Code, Cursor) and the LLM providers (Anthropic, OpenAI, Gemini). It enforces rules through three active gates:

1.  **Tool-Call Interception (`UnauthorizedToolDetector`):** If the LLM generates a tool call that an SOP in force lists under `deny_tools`, the proxy **intercepts and blocks** the request *before* the agent harness can execute it, returning a synthetic error message (e.g., `Forbidden tool call: bash — denied by an SOP in force for this node`). It is a denylist rather than an allowlist by design: open core has no way to enumerate every tool a harness might legitimately use, and an allowlist that gets it wrong blocks real work.
2.  **Response scanning:** The proxy scans response bodies with the same DLP pattern set and redacts findings before they reach the client. (Streaming responses are scrubbed mid-stream: every complete SSE line is scanned with the same pattern set and redacted before it reaches the client — or the judge, cache and trace. Input-side DLP remains the boundary that keeps secrets from ever leaving the machine; output-side findings are contained by redaction.) If a rule deviation is detected (e.g., writing a raw hex color code instead of a CSS variable):
    *   It injects a **Steering Advice** warning directly into the stream, forcing the agent to see the correction.
    *   It appends a **Synthesis Card** detailing the violation.
    *   In strict modes, it terminates the stream immediately (`KILL` action), preventing the agent from receiving the invalid code block.
3.  **Local Configuration File Integrity (`driftWatcher.ts`):** The sync daemon runs `driftWatcher.ts`, a local filesystem watcher using `chokidar` that monitors critical workspace files (like `.cursorrules`, `CLAUDE.md`, or `.intutic/sops`). If the agent attempts to modify or delete these local guidelines, `driftWatcher.ts` immediately restores them, preventing the agent from silently disabling its own rules.
4.  **Active Anomaly Correction (Enterprise Feature):** In remote connected environments, the control plane classifies each trace against the anomaly taxonomy as the agent interacts — `TOKEN_WASTE` measured against the developer's own median-cost baseline, `LOOP_DETECTED`, `SCOPE_VIOLATION`, `UNAUTHORIZED_TOOL`, and `WORKFLOW_GOAL_DRIFT`, raised when a session's plan-match score falls below threshold. When one fires, the `correctivePromptService` maps the anomaly to a steering recommendation (a corrective system prompt) and pushes it to the session's Valkey queue (`gov:notify:${sessionId}`) to be dynamically injected back into the agent's context window. The trigger is anomaly classification against measured thresholds — no embedding centroid is computed.

---

### 8. How do Token Multipliers and Multi-Turn Estimations work?

#### Where do the multipliers come from?
The static multipliers (e.g., `0.8` for Claude, `2.0` for reasoning models like o1/o3) are established from **empirical engineering benchmarks** of standard developer workflows. Claude models typically output long-form code blocks and explanations (high output ratio), whereas o1/o3 models generate substantial volumes of output/thinking tokens relative to their prompt inputs.

#### How can we predict costs for recursive, multi-turn agent sessions?
Agents are stateful, recursive loops where each turn appends the previous history, causing the context window to expand exponentially. To solve this, the **Token Intelligence Engine** uses an **Input Token Bucket Sliding Window** aggregation model:
1.  **Context-Size Bucketing:** Rather than doing linear forecasting, it categorizes input sizes into logarithmic buckets (e.g., `0–5k`, `5k–20k`, `20k–50k`, `50k+` tokens).
2.  **Cumulative Graph Profiling:** When traces are saved to the database (Valkey or local JSONL), the engine groups them by the *total graph session*. It tracks the cumulative output tokens generated across all recursive turns within that input size profile.
3.  **Task-Type Segmentation:** The engine filters historical baselines by task category (e.g. a `refactor` task has a different recursion footprint compared to a `unit-test` or `debug` task).
4.  **Statistical Projection:** When you run `@intutic predict`, the system queries the p50/p95 cumulative output tokens of previous sessions that fell into the same input size bucket and task profile, giving you a highly accurate projection of the **entire multi-turn run** rather than a single prompt turn.

---

### 9. What works and what does not work in pure Standalone Open-Core mode?

If you run Intutic in **pure, standalone Open-Core mode** (100% offline, with zero connection to the control plane or SaaS free tier), here is exactly what works and what does not:

#### What works 100% locally in Standalone Open-Core:
*   **Local Rule Synthesis & Syncing:** The `sync-daemon` scans `.intutic/sops/` and dynamically compiles/merges your local markdown guidelines into `.cursorrules`, `CLAUDE.md`, or `.windsurfrules` as files change.
*   **Local Interception & Policy Enforcement:** The local Rust proxy intercepts LLM prompt/response streams, evaluates them against local rules using the WASM rules engine, blocks prohibited tools, and injects steering warnings directly into the client stream.
*   **Local Cost & Token Ledger:** Local JSON/JSONL logs store session traces and aggregate token metrics, query counts, and daily spend.
*   **Local Cost Predictions:** `@intutic predict` queries your local JSONL history to compute sliding-window averages.
*   **Local Spending Caps (Rust Proxy):** Enforces global daily limits set in `~/.intutic/config.json` natively inside the proxy gateway.

#### What is Gated (Requires control plane / SaaS Tier):
*   **Ticket Board Integrations (Jira / Linear):** `@intutic initialize` cannot log into enterprise APIs to pull issues. Scoping local rules via `--sops` still works, but cost attribution to a Jira key is unavailable.
*   **Central Governance Dashboard:** The web UI for tracking team-wide spending, compute budgets, and developer audits is disabled.
*   **Corporate Policy Distribution:** Centralized policy management and automated distribution of tamper-proof global SOPs to developers requires GKE.
*   **Advanced L2/L3 Judging (LLM-as-a-Judge):** LLM-powered semantic checks and knowledge graph integrations require server compute power.

---

### 10. How do users set and manage spending caps/budgets?

Developers set and manage spending caps using three distinct interfaces:

#### Setting a Budget for a Specific Session/Task (CLI Wrapper)
If you want to prevent an agent from running away in a recursive loop on a complex task, wrap the agent's start command using the `intutic loop` CLI helper:
```bash
intutic loop exec --name "ISSUE-101" --budget 3.50 -- claude
```
The local proxy tracks the actual token consumption of that specific process and terminates the stream with a `402 Payment Required` block if the session cost hits `$3.50`.

#### Setting a Daily/Global Spend Cap (Local Configuration)
To set a blanket limit to protect your wallet across all sessions and agents running on your machine, configure the daily budget inside your global configuration file (located at `~/.intutic/config.json`):
```json
{
  "max_daily_budget_usd": 10.00
}
```
If the daily aggregated sum of all runs in the local spend ledger exceeds `$10.00`, the proxy blocks all outbound requests until midnight.

::: warning This became true in 2026-08
Streaming responses were not written to the local spend ledger, so for a client that always
streams — Claude Code and Cursor both do — the daily total never moved and this cap could not
fire however much the day cost. Streaming now accrues like any other response.

If that lands badly on a machine that has been over its cap unnoticed, set
`INTUTIC_LOCAL_BUDGET_ENFORCE=0` to keep recording spend while allowing requests through.
The proxy logs a warning on every request it would otherwise have blocked, so the bypass is
never silent. Raising `max_daily_budget_usd` is the better fix; the variable is for the hour
you need to keep working.
:::

#### Checking Budgets in Chat (Slash Command)
While pair-programming inside the agent chat window (like Cursor or Claude Code), check your budget status at any point by prepending the budget command:
```markdown
@intutic budget
```
This returns a real-time markdown card showing the active session cost, active session limit, daily spend log vs. daily cap, and remaining budget percentage.

---

### 11. How are Budgets and Daily Monitored LLM Volume Limits enforced across Connected/SaaS and Standalone/Offline modes?

Intutic enforces financial controls differently based on connection state to ensure zero-latency routing and fail-safe cost management:

#### Connected / SaaS Mode (Active Centralized Enforcement)
*   **Central Workspace Limits:** Daily monitored LLM volume limits and active budget thresholds are managed at the workspace level.
*   **Valkey Fast-Path Interception:** The corporate control plane caches live billing limits and cumulative usage counters in Valkey. On every request, the proxy does a cache precheck (`check_workspace_hard_block`) — a single Valkey GET.
*   **Fail-Closed Protection:** If the cache layer is unreachable, spend cannot be verified, and the budget gate fails closed — the request is rejected with `503 BUDGET_UNVERIFIABLE` rather than admitted on an unverifiable budget. This is deliberately the opposite of the usual rate-limiter convention: a spend cap is a financial control that you explicitly opted into, so the cost of wrongly allowing is unbounded, while the cost of wrongly denying is a retry. Note this applies only to control-plane-managed workspaces; standalone has no central cap to verify and is bounded by the local daily cap instead.
*   **Real-time Ledger Rollups:** Once upstream completions finish, actual token costs are recorded centrally, and cumulative workspace counters are updated to maintain global enforcement.

#### Standalone / Offline Mode (Local Fallback Enforcer)
*   **Local Budget Definition:** The local proxy reads the configured daily budget cap (`maxDailyBudgetUsd`) directly from `~/.intutic/config.json` (falling back to a default of `$10.00`).
*   **Offline Spend Ledger:** The proxy maintains an offline daily spend ledger in sharded append-only daily files (`~/.intutic/logs/local-spend-YYYY-MM-DD.jsonl`) that tracks day-accumulated costs. If the cache is unreachable, the system fails closed locally.
*   **Pre-flight Cost Interception:** Before any request is sent to the LLM provider, a native budget gate plugin estimates the request cost (using prompt length and static multipliers). If the estimated cost exceeds the remaining daily budget (`maxDailyBudgetUsd - spent`), the proxy intercepts the request and blocks it immediately with `HTTP 429 Too Many Requests` and `OVERAGE_HARD_CAP_EXCEEDED` error response.
*   **Atomic Rollback/Writeback:** After the LLM request successfully completes, the actual token usage costs are calculated, atomically appended to the daily spend ledger (`local-spend-YYYY-MM-DD.jsonl`), and stored in the daily local offline trace log.

---

### 12. How does the Offline Spends and Traces Sync Pipeline work?

When developers pair-program in Standalone / Offline mode, all LLM trajectories, token counts, and cost details are queued locally to prevent data loss. The sync-back pipeline reconciles these logs as follows:

1.  **Local Append Logging:** The local proxy writes every successful LLM completion as a structured JSON line to sharded, daily offline trace files `~/.intutic/logs/traces-YYYY-MM-DD.jsonl`.
2.  **Sync Daemon Reconnect:** When the developer logs in (`intutic login`) and starts the sync daemon (`intutic connect`), the daemon scans `~/.intutic/logs` for trace files on startup and on every subsequent polling iteration.
3.  **Batch Reconstruction & Upload:** The daemon renames active trace files to `traces-YYYY-MM-DD.jsonl.syncing` to prevent concurrency conflicts, groups the offline traces into batches of 100 and uploads them securely via `POST /api/v1/traces/sync-back` to the control plane.
4.  **Database Ingestion & Validation:** The control plane validates the API token, resolves trace parameters (e.g., mapping orphaned session IDs to synthetic sessions if context was missing), persists them in the control plane’s datastore using the `recordUsageEvent` service, and updates Valkey billing states.
5.  **Log Cleanup:** Upon receiving a successful `200 OK` response from the control plane for all batches in a file, the sync daemon deletes the local `.syncing` file, preventing double-processing.

---

### 13. How does the Offline SOPs Sync and Promotion Pipeline work?

Intutic supports local-first development by letting developers test custom prompts, styles, or constraints offline before scaling them workspace-wide:

*   **Local SOP Discovery:** Developers define rule directories locally under `.intutic/sops/<rule-group-name>/` containing markdown rules.
*   **State Mirroring & Metadata Sync:** When connected, the sync daemon reports the list of active local rule names in the WebSocket `context_report` message. The control plane caches these metadata entries in Valkey so they can be referenced/targeted by other developer clients in `@intutic start`.
*   **Rule Promotion (Push to Central SOP Registry):** If a local rule proves effective and needs to be distributed to the entire workspace, the developer runs:
    ```bash
    intutic sops push <rule-group-name>
    ```
    This packages the rule group's markdown files, posts them to `/api/v1/sops`, and writes them to the central the control plane’s datastore `sops` table.
*   **Workspace-wide Distribution:** During subsequent sync cycles, the sync daemons of all other developers in the workspace automatically fetch the newly promoted rule, write it to their local `.intutic/sops/` folders, and update their respective adapter configs (like `.cursorrules` or `CLAUDE.md`).

---

### 14. How does an AI agent self-correct using the Auto-Judge feedback inside a loop?

The self-correction mechanism works through two distinct loops at the proxy layer: the **In-Context History Loop** (for standard chat interfaces) and the **Harness/State Loop** (for autonomous wrapped CLI agents):

#### Flow A: In-Context History Steering (Cursor, Claude Code, etc.)
1.  **Active Interception:** When the agent outputs code that violates a rule, the proxy intercepts the stream on paragraph boundaries and posts the accumulated text to the control plane judge (`/api/v1/judge/finalize`).
2.  **Synthesis Card Injection:** The proxy appends the generated `--- Intutic LLM-as-a-Judge final Security Synthesis ---` warning card directly into the final response text chunk.
3.  **Context Retention:** Because the IDE or CLI client saves the complete response (including the warning block) in the conversation history, the agent sees the critique on its next turn.
4.  **Auto-Refinement:** On the subsequent turn, the LLM reads the previous warning instruction and dynamically refines its output to fix the violation.

#### Flow B: Scripted/CLI Loop Steering (`intutic loop exec` & Autonomous Agents)
1.  **Refusal & Block:** If the agent tries to perform a prohibited file write or command execution, the proxy blocks the action and returns a protocol error.
2.  **Autonomic Retry:** The agent loop reads the refusal response, updates its loop state, and automatically issues a revised prompt/command to resolve the issue before finalizing the run.

#### Flow C: Parallel Corrective Agents (Claude Dynamic Workflows)
In multi-agent systems where execution and checking are divided across parallel nodes:
*   The worker agent generates code which the proxy intercepts to append the violation card.
*   The parallel verification/checker agent parses this warning block, rejects the worker draft, and routes structured corrective feedback directly back to the worker in-flight.
*   The worker corrects the code and re-submits a compliant draft within the same workflow iteration.

---

### 15. Can Intutic correct an agent mid-session, or only block it?

**It can steer as well as block.** When the control plane classifies a trace as
anomalous, `correctivePromptService` queues a corrective instruction on
`gov:notify:{sessionId}`, and the proxy's response post-processor drains that queue and
merges the note into the response the agent reads. The agent adjusts on its next turn
without a session restart.

That path is real and inline. Two things it does **not** do, which earlier versions of
this page claimed:

*   **It does not detect hallucinations.** There is no engine that checks whether a file
    path or library the agent invented actually exists. What ships is output probing —
    a background LLM probe scores completions against the active guideline and records
    a verdict — which finds *policy* violations, not fabricated facts.
*   **It does not re-pin rules into the system prompt.** The corrective note is a
    message appended to a response, not a rewrite of the agent's system prompt, and it
    comes from the proxy rather than the sync daemon.

#### What happens as a session gets long
*   **The Issue:** In long sessions the model's attention is diluted and it drifts from
    the guidelines it was given.
*   **What actually ships:** the proxy's `ContextGrowthDetector` flags a session whose
    context has ballooned, as an advisory signal rather than a block, and the corrective
    note described above can be delivered inline. There is **no** automatic re-pinning
    of rules into the system prompt — if a session has drifted far enough to matter, it
    still needs restarting.

---

### 16. How are the local Rust proxy and CLI binaries packaged and hosted?

To keep the global developer installation lightweight, the local Rust proxy binary is **not** bundled inside the `@intutic/cli` npm package. Instead:
*   **Pipeline Compilation:** When a version tag (e.g. `v1.6.0`) is pushed, the Github Actions publish workflow (`.github/workflows/publish.yml`) compiles the Rust proxy code (`packages/proxy`) for five target combinations: `aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`, and `x86_64-pc-windows-msvc` — that is, macOS arm64/x64, Linux x64/arm64, and Windows x64.
*   **GitHub Release Hosting:** The `github-release` job collects every compiled artifact together with the `npm pack` tarballs and attaches them to a GitHub Release for the tag (`gh release create <tag> release-assets/*`); the standalone `pkg`-built CLI executables ride along in the same release. In parallel, `packages/proxy` is published to npm as `@intutic/proxy` — the npm package ships the `bin/proxy.js` launcher only, not a compiled binary, so the tarball stays small on every platform.
*   **Dynamic Download:** `intutic connect` only fetches a binary in non-dev mode, and only after it fails to find one at `packages/proxy/target/release/intutic-proxy`, then `target/debug/intutic-proxy`, then the global cache `~/.intutic/bin/`. It then detects the local OS/architecture and downloads the matching asset from the GitHub Release for the pinned CLI version — `https://github.com/intutic/intutic/releases/download/v<version>/<asset-name>` (e.g. `intutic-proxy-darwin-arm64`) — marks it executable, and saves it in `~/.intutic/bin/` to run as a local managed process. Because the URL is derived from the release tag, the download can never drift from the published assets. If the download fails, the CLI falls back to `cargo run`.

---

### 17. How does the upgrade path work from Open Core (Offline) to Free Tier SaaS to Paid SaaS?

No changes to the CLI or local proxy binaries are required to upgrade tiers. The progression operates dynamically through config updates and billing webhooks:

1.  **Open Core / Standalone (Local Mode):** The proxy and CLI run entirely locally. Budget limits are evaluated against `maxDailyBudgetUsd` in `~/.intutic/config.json` and saved to sharded local spend log files (`~/.intutic/logs/local-spend-YYYY-MM-DD.jsonl`).
2.  **Free Tier SaaS (Connected Mode):** The user registers on the web dashboard to receive a Workspace ID and API Key, and runs:
    ```bash
    npx @intutic/cli connect --workspace-id <wk_id> --api-key <api_key>
    ```
    *(Or `intutic connect` if the CLI is installed globally).*
    The Sync Daemon immediately uploads buffered local traces (`traces-YYYY-MM-DD.jsonl`) to `/api/v1/traces/sync-back` and syncs workspace-wide rules. Onboarding users use **Direct Provisioning** — admins create accounts directly by entering a display name and role, and the dashboard UI generates a secure random temporary password (`tempPassword`) that the admin copies and shares manually (avoiding email server delivery failures).
3.  **Paid SaaS (Pro / Team / Enterprise):** The administrator sets limits and tier access from the central dashboard. During the next Sync Daemon handshake, the updated tier limits and capabilities (like workspace-wide SOP Registry or semantic caching) are dynamically unlocked.

---

### 18. How does the Real-Time Governance & Resilience Loop (Optimizations) work?

Intutic's active resilience and loop steering are supported by three newly optimized components:

#### Real-Time Event-Driven Micro-Aggregation
*   **The Problem:** Traditional aggregation pipelines run on static 6-hour cron intervals, introducing massive latency before suggesting rule repairs.
*   **The Optimization:** On-demand workspace micro-aggregations are triggered instantly by `anomaly.detected` events, reducing recommendation generation latency to **under 30 seconds**.

#### Bespoke LLM Config Edit Synthesis & Conflict Auditing
*   **The Optimization:** Suggestion config edits are dynamically generated using cheap evaluator prompts targeted specifically to the trace anomaly context, bypassing static boilerplate templates.
*   **Safety Guards:** Suggested config patches are audited against the workspace's active `VALIDATED` security policies to block forbidden operations (e.g. enabling `child_process`) and parsed to verify JSON, YAML, and Markdown format safety before saving.

#### Post-Completion Analysis
*   **LLM Probe Verdicts**: Completed traces are probed against the active workspace SOP; each probe records a verdict and structured violations, which is what drives the compliance score on the trace.
*   **Cost Baselines**: An hourly sweep computes a median-cost baseline per (SOP, developer) from the trailing 14 days, published only once at least 20 traces support it. `TOKEN_WASTE` is raised against that baseline, so a run is compared to its own history rather than a global threshold.

#### Sync-Daemon Overwrite Recovery
*   **The Optimization:** If a base SOP version update rewrites `.cursorrules`, the control plane sync payload returns all active, approved suggestions. The local sync-daemon automatically re-overlays these active suggestions on top of the newly written baseline rules, preventing applied edits from being wiped out.

---

### 19. How does Intutic prevent the same agent mistakes from repeating?

Instead of acting as a simple reactive alert or blocking tool, Intutic implements a **Closed-Loop Policy Optimization & Remediation** system:

1. **Telemetry & Incident Logging:** When developers run agent harnesses, all stream violations, blocked tool calls and config-drift incidents are logged in real-time.
2. **Background Pattern Analysis (Sleep Cycle):** A background analytical service periodically processes these incident logs to cluster them by category and evaluate their severity and frequency.
3. **Auto-Proposed Rule Tightening:** When a recurring mistake pattern crosses safety thresholds, the platform automatically drafts a tightened rule amendment targeted at preventing that specific mistake.
4. **Approval & Real-Time Sync:** Once approved (either manually by an administrator or automatically for high-confidence safety policies), the new rule is written to the central SOP registry. The local sync-daemon then instantly pushes these rule updates directly into the active `.cursorrules`, `CLAUDE.md`, or harness config files in the developer's workspace.
5. **Proactive Prevention:** On the next prompt turn, the agent model ingests the updated rules in its context window and is steered away from making the same mistake, permanently closing the compliance loop.

---

### 20. How does Intutic integrate with different AI harnesses (e.g. Cursor vs. Gemini Antigravity)?

Intutic automatically detects which harnesses are active in your workspace and applies rules using two primary integration paths:

1. **Context-Steered Harnesses (Markdown Rules):**
   For tools that read rules from the project workspace (like **Cursor** `.cursorrules`, **Claude Code** `CLAUDE.md`, **Windsurf** `.windsurfrules`, and **Cline / Roo Code** `.clinerules`), the sync-daemon compiles and updates these markdown files in real-time. The agent ingests these rules directly in its context window to steer output generation.
   
2. **Runtime Interceptors (Hook Scripts & Plugins):**
   For terminal-based or executing daemons (like **Gemini Antigravity**, **Goose**, **OpenHands**, and **Open WebUI**), Intutic installs pre-tool check scripts and filters directly into their runtime settings. For example:
   * **Gemini Antigravity:** Registers a `hooks.preTool` bash check in `~/.gemini/settings.json` to audit and block tools pre-flight.
   * **Open WebUI:** Injects a Python filter at `.open-webui/intutic-governance-filter.py`.
   * **Goose:** Registers a custom plugin under `.agents/plugins/intutic-governance/`.

---

### 21. How do `/intutic verify` (prompt check) and `/intutic judge` (response evaluator) differ?

Although both protect the same compliance boundaries, their engines and execution environments are tailored for different latency and evaluation stages:
- **`/intutic verify <prompt>` (or `/intutic check`)**:
  - **Type**: Pre-flight prompt linter.
  - **Latency**: Very low — it runs client-side or in the control plane with no model call and no upstream network hop.
  - **Mechanism**: Runs client-side or control plane regex pattern matchers on the prompt input. It checks for compliance violations *before* any request is forwarded to the LLM, protecting you from sending forbidden commands or queries upstream.
- **`/intutic judge <prompt>`**:
  - **Type**: Parallel E2E response evaluator (LLM-as-a-judge).
  - **Latency**: Sub-second (hidden behind stream chunking).
  - **Mechanism**: Forwards the prompt to the upstream LLM and streams the response back to your terminal or IDE in real-time. In parallel, the local proxy chunks and sends segments of the generated output stream to the control plane, running deep LLM-as-a-judge audits. The final synthesis card is injected at the end of the stream.
  - **Usage**: Type `/intutic judge <prompt>` to run a query with output checking, or run `/intutic start --auto-judge` to enable automatic judging for all subsequent queries in a session. Running `/intutic judge` without arguments returns usage instructions.

---

### 22. Can I write custom, fine-grained validation logic in AssemblyScript?

Yes, absolutely. For complex governance checks that go beyond regular expressions, you can build custom sandboxed filters:
- **AssemblyScript SDK:** Developers use the `@intutic/wasm-sdk` package to author rules in AssemblyScript. The SDK provides helper classes to read and evaluate the `intutic.context` (representing LLM prompts, tool calls, and DLP findings). Context parameters are handed over as raw binary guest buffers (`Uint8Array`) rather than guest string pointers to ensure maximum memory safety and prevent Wasmtime GC pointer corruption.
- **Isolated WASM Sandbox:** The compiled `.wasm` binary runs inside the proxy's isolated, fuel-limited WebAssembly engine. Rules run under a strict wasmtime fuel and execution-timeout ceiling and cannot access the filesystem or make network calls.
- **CLI Verification:** You can run local dry-runs to test rules using the CLI tool:
  ```bash
  intutic policy test --wasm /path/to/rule.wasm --mock /path/to/context.json
  ```
  Once verified, rules can be uploaded and hot-reloaded dynamically into the live proxy without restart.

