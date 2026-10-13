# Session Safety & Budgets <Badge type="tip" text="Cloud" />

Intutic provides deep, real-time governance for recursive and autonomous agent loops. These loops (e.g. from harnesses like Claude Code, Cursor, Windsurf, or custom script orchestrations) have the potential to run indefinitely, generating high token spend and potential data loss if unconstrained.

## The Challenge: Infinite Execution Loops

The rule most builders miss: **do not loop on confidence — loop on evidence.**
"The agent says it's done" is not a stopping condition. "Tests pass, schema
validates, budget remains, reviewer approves" is.

The difficulty is that the agent is the one reporting its own progress, so a
stopping condition it evaluates itself is one it can talk its way past. Intutic
enforces the condition from outside the agent — at the proxy every request
crosses — so a loop marked `KILLED` is refused on the next request whether or
not the agent agrees it is finished.

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

### 2. Circuit Breaker Enforcement {#circuit-breaker-enforcement}

If a budget is breached, or if an administrator manually terminates a loop run from the dashboard, the loop state is set to `KILLED`.
- Once `KILLED` (or in any other status but `ACTIVE`), the reverse proxy refuses any subsequent model request for that loop run with an HTTP `403 Forbidden` response and error code `LOOP_RUN_TERMINATED`. The run is the one named in the `X-Loop-Run-Id` header or, when a request carries none, the member's active loop run.
- A run held for review (`PENDING_REVIEW`) is refused with `LOOP_RUN_PENDING_REVIEW` until it is approved or rejected.
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
intutic loop exec --name "refactor-auth" --budget 2.50 --sops=1 --auto-judge -- aider --yes
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

A run held for review is approved or rejected (which kills it) with `intutic loop review lr_abc123 --approve` or `--reject`, optionally with `--note`.

## Managing Loops in the Dashboard

**Activity › Session Safety & Budgets** (`/activity/budgets`) in the Intutic dashboard provides an overview of all loop runs:
- **Sessions at a glance**: **Held for review** (runs waiting on a person), **Running**, **Total session cost** across the listed runs, and **Automatic safety guardrail**, which reads Active when the control plane answered and Unverified when it did not.
- **Sessions** and **Session Details**: select a run to see its name, status, cost so far, budget and session ID.
- **Circuit Breaker Controls**: **Mark Completed** or **Force Stop** a running session. A session held for review offers **Approve & Resume** or **Reject & Kill** instead; held runs are also listed under **Findings › Review Queue › Held Changes**.
- **Start New Session** opens a loop run with a session name and a budget in USD.

## Memory Guardrails & State Scanning

To prevent agent loops from being hijacked by prompt injections hidden in memory or state files, the control plane scans state files submitted with their content to config capture (`POST /api/v1/config/capture`, which accepts content only when the workspace has turned on config content upload):
- **Automatic Scans**: Files at `PROGRESS.md`, `STATE.md` or `task.md`, or whose path ends in `state.json`, are checked against unsafe patterns (e.g., `ignore previous instructions`, `bypass guardrails`, `disable safety checks`).
- **Incident Logging**: If an injection attempt is detected, the capture is still accepted, but a HIGH-severity **PROMPT_INJECTION** incident is opened in the governance incident queue.

The sync daemon's own config capture uploads only harness rules files, not these state files, so the scan runs only on a capture another client submits.

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
This endpoint triggers the compliance evaluation engine to analyze the diff against the workspace's `VALIDATED` SOPs, returning findings and safety status dynamically to the running harness. With no `VALIDATED` SOP, or on a plan without LLM judging, nothing is checked: the response is `ok: true`, `score: 0`, `unverified: true`, with a finding saying why.
