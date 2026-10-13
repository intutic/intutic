# Slash Commands <Badge type="tip" text="Cloud" />

Intutic provides an interactive slash command interface that developers can use directly inside their IDE chat windows (such as Cursor or VS Code) or CLI-based agent sessions.

These commands are intercepted pre-flight by the local Intutic proxy gateway and processed instantly—never reaching the upstream model provider.

::: tip Prefixes: `/intutic` vs `@intutic`
The proxy gateway supports two equivalent prefix styles for all slash commands:
* **`/intutic`**: Best for standard IDE chat panels (Cursor, Windsurf) or raw API/curl client integrations.
* **`@intutic`**: Recommended for CLI-based agent environments like **Claude Code** to prevent client-side parsing conflicts (avoiding the need for a hacky leading space).
:::

::: info Typed in the agent's chat, not in your terminal
Slash commands are prompts the proxy answers; they are not the `intutic` CLI. Three share a
name with a CLI command and do something different:

| Slash command (in chat) | CLI command (in a terminal) |
|---|---|
| `/intutic start <task>` binds this session's costs to a ticket | [`intutic start`](/reference/cli#intutic-start) runs the proxy |
| `/intutic status` shows this session's stats | [`intutic status`](/reference/cli#intutic-status) shows local auth, harness and sync state |
| `/intutic budget` shows today's and this month's spend against the caps and budgets covering this session | [`intutic budget`](/reference/cli#intutic-budget) shows the workspace's spend against its caps, the local cap, and running loops |
:::

---

## 🚀 Available Commands

### 1. `/intutic-predict` (or `/intutic predict`) {#intutic-predict}
Provides an instant pre-flight token count and cost projection based on the current prompt content.
* **Mechanism**: Intercepts the request in the proxy gateway, counts input prompt tokens, and queries the workspace's historical baselines in Valkey to retrieve typical output/reasoning token counts and project total USD cost.
* **Output**:
  ```markdown
  ### 🛡️ Intutic Pre-Flight Cost Prediction

  | Metric | Value |
  |---|---|
  | **Model** | `claude-3-5-sonnet` |
  | **Input Tokens** | 24 |
  | **Est. Output Tokens** | 14 |
  | **Est. Reasoning Tokens** | 0 |
  | **Est. Session Cost** | **$0.000264** |
  | **Confidence** | low |

  *Prediction generated pre-flight from historical baseline distribution.*
  ```

### 2. `/intutic recommend`
Suggests prompt adjustments or corrective prompt cards based on recent anomalies logged in the session.
* **Mechanism**: Routes to the control plane, which reads the session's latest trace that carries a corrective prompt card.
* **Output (Anomalous)**:
  ```markdown
  ### 💡 Corrective Prompt Recommendation

  Based on the most recent anomaly detected in this session:

  **Status**: ⚠️ Anomalous Behavior Identified
  **Recommendation**:
  > [!IMPORTANT]
  > Break the loop. The same operation has been repeated multiple times without progress. Try an alternative approach...
  ```
* **Output (Healthy)**: General optimization recommendations (e.g. conciseness, model budgeting, guidelines collapsing).

### 3. `/intutic initialize`
Begins manual session cost attribution by listing the open tickets on the workspace's Jira and Linear connections, and the local SOP folders (`.intutic/sops/<folder>/`) the sync daemon reported, so a session can be scoped to some of them.
* **Mechanism**: Asks each Jira and Linear connection for its open tickets, in parallel, and lists up to 10 per connection, most recently updated first. A tracker that errors or takes longer than 5 seconds is skipped and named ("Couldn't reach Linear (ENG)") while the rest are listed. If the session's git branch names one of the listed tickets (`feature/PROJ-101-…`), that ticket is marked Recommended; this is the same branch parse that tags sessions, with no model call. PagerDuty incidents are not listed, since the command cannot tell which incidents are yours. The options are cached in Valkey for 30 minutes so `/intutic start <n>` can resolve them.
* **Output**:
  ```markdown
  ### 🔑 Initialize Intutic Session cost & governance attribution
  Select a task from your board for cost attribution, or select local SOP directories to active-scope this session:

  **Connected Task Boards (FinOps):**
  - **[1] PROJ-101**: Implement pre-tool safety checks (jira) 🌟 *(Recommended)*
  - **[2] PROJ-105**: Fix Valkey replication lag (jira)

  **Local Rules Directories (Governance):**
  - **[3]** `.intutic/sops/frontend-rules/`
  ```
  The output ends with how to run `/intutic start`, including `--sops` and `--auto-judge`.

### 4. `/intutic start <option_number_or_ticket_key> [--sops=<folders>] [--auto-judge]` (or `-j`)
Binds all sequential LLM request costs and traces in the current session (identified by `x-session-id`) to the selected task key, overriding the default git branch/commit cascade.
* **Local SOP scoping**: `--sops=` takes option numbers or folder names, comma-separated (`--sops=3` or `--sops=frontend-rules`), and limits the session to those local SOP folders; a local SOP folder's option number also works as the first argument. Without it, every folder is active.
* **Auto Judging Option**: Appending `--auto-judge` (or `-j`) judges every later response in this session, as `/intutic judge` does, for 24 hours. `/intutic start` without it turns auto-judging off.
* **Mechanism**: Resolves the selected option index or ticket key against the list `/intutic initialize` cached (a ticket key must be on that list), takes the ticket's metadata (story points, epic, sprint) from it, saves the manual override mapping in Postgres, and caches it in Valkey (24h TTL) for immediate Priority 0 cascade routing.
* **Output**:
  ```markdown
  ### ✅ Session Locked
  All token costs and traces for this session are now attributed to task:

  | FinOps Metric | Value |
  |---|---|
  | **Ticket Key** | `PROJ-101` |
  | **Title** | `Implement pre-tool safety checks` |
  | **Sprint** | `Sprint Board 4` |
  | **Story Points** | `5` |
  | **Provider** | `jira` |

  **Governance Settings:**
  | Scoping Attribute | Value |
  |---|---|
  | **Active Local SOPs** | `All directories active` |
  | **Auto Judging** | `ENABLED (all queries evaluated automatically)` |
  ```

### 5. `/intutic verify <prompt>` (or `/intutic check <prompt>`)
Checks a prompt for tools your workspace's policy refuses, before you send it.
* **Mechanism**: Routes to the control plane, which reads the `deny_tools` front matter of the workspace's VALIDATED, active SOPs (org SOPs included) and of the policy guardrails it runs as ENFORCING, the same set the proxy enforces, and reports each denied tool the prompt names, with the SOP that denies it and any role scope. A guardrail in SHADOW mode and `action:` tokens are not matched. Ordering, call-count and data rules (`requires_before`, `forbid_after`, `max_calls`, `forbid_with`) apply to the calls an agent makes, so the proxy enforces them at call time rather than this command. With no VALIDATED SOPs or enforcing guardrails, it says there is no policy to check against. No model is involved.
* **Output**:
  ```markdown
  ### ⚖️ Policy Check

  **Prompt**: *"Use WebFetch to pull the vendor's pricing page"*
  **Checked against**: 3 enforced SOP(s) and guardrail(s), 4 `deny_tools` rule(s)
  **Verdict**: ⚠️ **Names a denied tool**

  - `WebFetch` is denied by **Outbound data policy**; the proxy refuses a call to it.
  ```

### 6. `/intutic review <prompt>`
Runs a quick heuristic check on a prompt and returns a letter grade with suggestions.
* **Mechanism**: Scores four fixed rules: prompt length, whether it uses action verbs (check, enforce, verify…), and whether it names an SOP, policy or rule. No model is involved, so treat the grade as a nudge, not an assessment of the prompt's quality.

### 7. `/intutic judge <prompt>`
Runs the user prompt upstream to the LLM and evaluates the output response stream in parallel using LLM-as-a-judge compliance checks.
* **Mechanism**: Intercepted pre-flight by the local Rust proxy if arguments are provided, stripping the command prefix and forwarding the prompt upstream while parallel chunk-evaluations run on the response stream. If no arguments are provided, it is handled as a slash command showing usage instructions.
* **Plans**: the judge runs on Self-serve, Biz Org, Enterprise and Self-host, and in the 14-day trials (see the [Tier Matrix](/guide/tier-matrix)). On Free the prefix is still stripped and the response comes back unjudged, with no judge note.

### 8. `/intutic status`
Displays the session's trace count, total cost, average compliance score and session ID.

### 9. `/intutic budget`
Displays today's and this month's spend against every budget covering the session: the workspace's daily and monthly caps and, on plans with member budgets, the session member's own (theirs, or the default member budget). Each row shows spent, limit, share used, and whether the budget refuses requests or only alerts. The spend comes from the counters the proxy's budget gate reads. Per-key budgets are on the dashboard's Billing tab.

### 10. `/intutic sops`
Lists up to 20 of the workspace's SOPs with their lifecycle state and ID.

### 11. `/intutic config auto-judge on|off`
Turns auto-judging on or off for this session, as `/intutic start --auto-judge` does. On lasts 24 hours.

### 12. `/intutic help`
Lists the commands.

---

## 🛠️ Protocol Compatibility

To prevent client-side parser crashes in IDEs that expect strict model schemas, the proxy formats the response to match the exact protocol expected by the client:
* **OpenAI API**: Returns a standard `chat.completion` or `chat.completion.chunk` JSON object.
* **Anthropic Messages API**: Returns a standard `message` JSON structure or a series of SSE events (`message_start` -> `content_block_delta` -> `message_stop`).
* **Gemini API**: Returns canonical Google parts and candidates JSON response objects.

---

## 🔍 Engine & Model Architecture

Under the hood, these calculations and checks are processed by distinct layers of the Intutic architecture:

| Feature | Processing Layer | Backing Engine / Model | Latency Profile |
|---------|------------------|------------------------|-----------------|
| **Token & Cost Projections** | Proxy Gateway | **Deterministic Byte-Pair Encoder (Tiktoken)** + statistical baseline distribution values cached in Valkey (no LLM calls). | In-process |
| **Corrective Prompt Suggestions** | Control Plane | **Corrective Prompt Service** static templates mapping directly to the detected `AnomalyType` (no LLM calls). | In-process |
| **SOP Compliance (LLM-as-a-Judge)** | Control Plane | The **judge** routes (`/api/v1/judge/chunk` and `/api/v1/judge/finalize`), running on **Intutic's cost-optimized open-weight judge** (the `intutic-openweight-judge` alias); judges run only on self-hosted models, never a hosted API. | Asynchronous (does not block client stream). |

