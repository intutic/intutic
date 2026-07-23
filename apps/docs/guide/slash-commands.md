# Slash Commands <Badge type="warning" text="Cloud / Team" />

Intutic provides an interactive slash command interface that developers can use directly inside their IDE chat windows (such as Cursor or VS Code) or CLI-based agent sessions.

These commands are intercepted pre-flight by the local Intutic proxy gateway and processed instantly—never reaching the upstream model provider.

::: tip Prefixes: `/intutic` vs `@intutic`
The proxy gateway supports two equivalent prefix styles for all slash commands:
* **`/intutic`**: Best for standard IDE chat panels (Cursor, Windsurf) or raw API/curl client integrations.
* **`@intutic`**: Recommended for CLI-based agent environments like **Claude Code** to prevent client-side parsing conflicts (avoiding the need for a hacky leading space).
:::

---

## 🚀 Available Commands

### 1. `/intutic-predict` (or `/intutic predict`)
Provides an instant pre-flight token count and cost projection based on the current prompt content.
* **Mechanism**: Intercepts the request in the proxy gateway, counts input prompt tokens, and queries GKE Valkey historical baselines to retrieve typical output/reasoning token counts and project total USD cost.
* **Output**:
  ```markdown
  ### 🛡️ Intutic Pre-Flight Cost Prediction

  | Metric | Value |
  |---|---|
  | **Model** | `claude-3-5-sonnet` |
  | **Input Tokens** | 24 |
  | **Est. Output Tokens** | 14 |
  | **Est. Session Cost** | **$0.000264** |
  | **Confidence** | low |
  ```

### 2. `/intutic recommend`
Suggests prompt adjustments or corrective prompt cards based on recent anomalies logged in the session.
* **Mechanism**: Routes to the control plane, which queries the database for the latest anomalous traces.
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
Begins manual session cost attribution by listing the top open or in-progress tasks from the connected integrations (Jira, Linear, GitHub).
* **Mechanism**: Queries external task managers registered for the workspace, runs a lightweight LLM-as-a-judge check matching current repository context (active branch name or files) to recommend the most relevant task, caches options in Valkey, and displays a numbered list of tasks.
* **Output**:
  ```markdown
  ### 🔑 Initialize Intutic Session cost attribution
  Select a task from your board to attribute all LLM token costs for this session:

  - **[1] PROJ-101: Implement pre-tool safety checks** 🌟 *(Recommended)*
  - **[2] PROJ-105: Fix Valkey replication lag**
  - **[3] PROJ-108: Clean up old settingsGuard tests**

  *To start attribution, run `/intutic start <option_number_or_ticket_key> [--auto-judge]` (or `-j`).*
  ```

### 4. `/intutic start <option_number_or_ticket_key> [--auto-judge]` (or `-j`)
Binds all sequential LLM request costs and traces in the current session (identified by `x-session-id`) to the selected task key, overriding the default git branch/commit cascade.
* **Auto Judging Option**: Appending `--auto-judge` (or `-j`) locks automated compliance checks on for all future turns in this session without prefixing prompts with `/intutic verify`.
* **Mechanism**: Resolves the selected option index or explicit ticket key, fetches task metadata (story points, epic, sprint) using the connector adapter, saves the manual override mapping in Postgres, and caches it in Valkey (24h TTL) for immediate Priority 0 cascade routing.
* **Output**:
  ```markdown
  ### ✅ Session Attribution Locked
  All token costs and traces for this session are now attributed to:

  | Metric | Value |
  |---|---|
  | **Ticket Key** | `PROJ-101` |
  | **Title** | `Implement pre-tool safety checks` |
  | **Sprint** | `Sprint Board 4` |
  | **Story Points** | `5` |
  | **Provider** | `jira` |
  | **Auto Judging** | `ENABLED (all queries evaluated automatically)` |
  ```

### 5. `/intutic verify <prompt>` (or `/intutic check <prompt>`)
Runs manual pre-flight compliance checks on a prompt against active workspace SOPs and architectural boundaries.
* **Mechanism**: Routes to the control plane, checks the prompt text against pattern matches and guidelines, and returns immediate pass/fail verdicts and violations list.
* **Output**:
  ```markdown
  ### ⚖️ E2E Compliance Verification

  **Target Query**: *"Retrieve users using db helper"*
  **Verdict**: ✅ **COMPLIANT**

  No active SOP violations identified.
  ```

### 6. `/intutic review <prompt>`
Runs a deep heuristic prompt quality evaluation to grade its clarity, specificity, and actionability.
* **Mechanism**: Scores the prompt's quality using a heuristic model and suggests optimizations for improvement.

### 7. `/intutic judge <prompt>`
Runs the user prompt upstream to the LLM and evaluates the output response stream in parallel using LLM-as-a-judge compliance checks.
* **Mechanism**: Intercepted pre-flight by the local Rust proxy if arguments are provided, stripping the command prefix and forwarding the prompt upstream while parallel chunk-evaluations run on the response stream. If no arguments are provided, it is handled as a slash command showing usage instructions.

### 8. `/intutic status`
Displays the active session stats, trace count, average compliance score, and total spent budget.

### 9. `/intutic budget`
Displays daily monitored LLM volume limits and current workspace progress.

### 10. `/intutic help`
Lists all available commands and subcommands.

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
| **Token & Cost Projections** | Proxy Gateway | **Deterministic Byte-Pair Encoder (Tiktoken)** + statistical baseline distribution values cached in Valkey (no LLM calls). | < 5ms |
| **Corrective Prompt Suggestions** | Control Plane | **Corrective Prompt Service** static templates mapping directly to the detected `AnomalyType` (no LLM calls). | < 10ms |
| **SOP Compliance (LLM-as-a-Judge)** | Control Plane | **LLM Probe Service** running Tier 3 async evaluations using **`claude-3-5-haiku`** (or `gpt-4o-mini` fallbacks). | Asynchronous (does not block client stream). |

