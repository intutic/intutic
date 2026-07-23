# Session Safety & Budgets <Badge type="warning" text="Cloud / Team" />

Intutic provides deep, real-time governance for recursive and autonomous agent loops. These loops (e.g. from harnesses like Claude Code, Cursor, Windsurf, or custom script orchestrations) have the potential to run indefinitely, generating high token spend and potential data loss if unconstrained.

## The Challenge: Infinite Execution Loops

Autonomous agents typically execute within a feedback loop:
1. Observe current state.
2. Formulate a plan.
3. Call tools / edit files.
4. Verify the results.
5. Loop back to step 1 if the task is incomplete.

If the agent gets stuck in a logic loop, or if verification fails repeatedly, it can consume thousands of dollars in tokens in a matter of minutes.

## How Intutic Protects Your Compute Budget

Intutic addresses this challenge using a lightweight, multi-layered circuit breaker system:

### 1. Registration and Budgets

Every autonomous agent session can be registered as a **Loop Run** under a workspace. This registers the loop run state inside both the PostgreSQL ledger and a high-performance Valkey cache.
- **Budget Limits**: You can configure a maximum token budget (in USD) for the loop run.
- **Circuit Breaker**: As token costs accumulate, the proxy increments the spend and evaluates if the budget has been exceeded.

### 2. Circuit Breaker Enforcement

If a budget is breached, or if an administrator manually terminates a loop run from the dashboard, the loop state is set to `KILLED`.
- Once `KILLED`, the reverse proxy intercepts any subsequent model requests matching the loop run header with an HTTP `403 Forbidden` response and error code `LOOP_RUN_TERMINATED`.
- This immediately stops the running agent CLI or IDE extension, preventing any further waste.

## Using the CLI to Manage Loops

You can register, list, and control loops directly from your terminal using the `intutic` CLI:

### Start a Loop Run
```bash
intutic loop start --name "deploy-fix" --budget 5.00 --sops=security-rules --auto-judge
```
This registers a new Loop Run ID, configures the loop on the control plane (persisting budget limits, active local sops, and auto-judging settings), writes active sops to `.intutic/session-context.json` locally, and saves the run context inside `~/.intutic/env/loop.env`.

### Execute a Wrapped Command
You can automatically wrap any agent tool command under a safety loop boundary. Active local SOPs and auto-judging options are fully supported:
```bash
intutic loop exec --name "refactor-auth" --budget 2.50 --sops=1 --auto-judge -- Aider --yes
```

### List Active Loop Runs
```bash
intutic loop list
```

### Complete or Kill a Loop Run
```bash
intutic loop complete lr_abc123
intutic loop kill lr_abc123
```

## Managing Loops in the Dashboard

The **Session Safety & Budgets** page in the Intutic dashboard provides a graphical overview of all loop runs:
- **Metrics Overview**: View total spend, active loops, and average cost.
- **Circuit Breaker Controls**: Real-time buttons to **Complete** or **Kill** loop runs.
- **Telemetry Links**: Drill down into the specific activity logs and trace steps associated with each loop run.

## Memory Guardrails & State Scanning

To prevent agent loops from being hijacked by prompt injections hidden in memory or state files, Intutic actively scans uploaded state files during config capture:
- **Automatic Scans**: Any files named `PROGRESS.md`, `STATE.md`, `task.md`, or matching `*.json` state schemas are parsed against unsafe patterns (e.g., `ignore previous instructions`, `bypass safety checks`).
- **Incident Logging**: If an injection attempt is detected, the daemon accepts the capture without crashing, but flags it immediately as a **PROMPT_INJECTION** anomaly in the governance incident queue.

## Verification Gate (Loop Verifier API)

Agent loops can actively check code diffs and progress against workspace SOPs before executing final operations:
- **Endpoint**: `POST /api/v1/loops/:loopRunId/verify`
- **Request Payload**:
  ```json
  {
    "diff": "git diff content",
    "taskDescription": "Deploy auth fixes"
  }
  ```
- **Response Verdict**:
  ```json
  {
    "ok": false,
    "score": 0.2,
    "findings": ["SOP violation: Destructive command detected in diff."]
  }
  ```
This endpoint triggers the compliance evaluation engine to analyze the diff against active SOP instructions, returning findings and safety status dynamically to the running harness.
