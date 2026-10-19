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
- **Correction that runs out pauses the run, when you ask for it.** A detector that re-asks the agent refuses on the third attempt. With `on_reask_exhausted: pause` in an applicable SOP (the default is `block`), a loop run is held for review on that third attempt instead (`LOOP_RUN_PENDING_REVIEW`), and an approved run gets three fresh attempts. Without a loop run nothing changes.
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

### Verify, Complete or Kill a Loop Run
```bash
intutic loop verify lr_abc123 --base main
intutic loop complete lr_abc123
intutic loop kill lr_abc123
```

`loop verify` diffs the working tree against `--base` (by default the commit the run started on), checks it against the local SOPs selected for the run, and only then asks the control plane; see [Verification Gate](#verification-gate).

A run held for review is approved or rejected (which kills it) with `intutic loop review lr_abc123 --approve` or `--reject`, optionally with `--note`.

## Managing Loops in the Dashboard

**Activity › Session Safety & Budgets** (`/activity/budgets`) in the Intutic dashboard provides an overview of all loop runs:
- **Sessions at a glance**: **Held for review** (runs waiting on a person), **Running**, **Total session cost** across the listed runs, and **Automatic safety guardrail**, which reads Active when the control plane answered and Unverified when it did not.
- **Sessions** and **Session Details**: select a run to see its name, status, cost so far, budget and session ID.
- **Circuit Breaker Controls**: **Mark Completed** or **Force Stop** a running session. A session held for review offers **Approve & Resume** or **Reject & Kill** instead; held runs are also listed under **Findings › Review Queue › Held Changes**.
- **Start New Session** opens a loop run with a session name and a budget in USD.

## Verification Gate (Loop Verifier API) {#verification-gate}

`intutic loop verify <id>` (or `POST /api/v1/loops/:loopRunId/verify` with `{ diff, taskDescription, files? }`) checks a run's work in two stages.

1. **Deterministic checks first,** against the enforced SOPs that declare no `roles:` (a loop run has no agent role):
   - **Scope.** Every path the diff, `files` and the run's recorded file changes touched must be inside the SOPs' `scope_paths`. One path outside fails the check, whatever `scope_paths_mode` says: a verify is a boundary check.
   - **Plan.** The run's tool calls, as the gateway traced them, against the SOPs' `plan_steps`. Up to 40% of the steps may be off the plan under `plan_steps_mode: advise`, none under `enforce`. A run with no gateway traces (hook gates only) has nothing to check here.
2. **The judge,** only when both pass: it grades the diff against the workspace's `VALIDATED` SOPs, as before. On a plan without LLM judging, or with no `VALIDATED` SOP, the judge is unavailable.

```json
{
  "ok": false,
  "score": 0,
  "stage": "deterministic",
  "findings": ["1 changed path is outside scope_paths (src): infra/main.tf"],
  "checks": [
    { "id": "scope_paths", "status": "fail", "findings": ["…"], "scope": { "paths": ["infra/main.tf"] } },
    { "id": "plan_steps", "status": "pass", "findings": [] }
  ],
  "verificationId": "lv_…"
}
```

`stage: "deterministic"` means a scope or plan check failed and the judge was not asked. `unverified: true` appears only when no check could run (no scope, no plan, no judge); the response then says why in `findings`.

### Completing only verified runs {#require-verified-completion}

With **Require a passing verify before a run completes** on (**Settings › Security › Loop Runs & Reversibility Lanes**, the setting `loop_review.requireVerifiedCompletion`, off by default), a run is marked completed only when its latest verify passed and nothing ran after it:

| Refusal (409) | Why |
| --- | --- |
| `E_LOOP_NOT_VERIFIED` | The run was never verified, or its latest verify failed. The findings come with it. |
| `E_LOOP_UNVERIFIABLE` | The latest verify could check nothing; the refusal names what was missing. |
| `E_LOOP_VERIFY_STALE` | The agent did more traced work after the latest verify. Verify again. |

If the check itself cannot run, the completion is refused with `503 GOVERNANCE_UNAVAILABLE` rather than let through. Recording a failed run (`outcome: FAILED`) is never refused. A run that used only hook gates has no traces, so a passing verify cannot go stale there.

`intutic loop exec` verifies before completing when the setting is on, and leaves the run active if the verify does not pass. In the dashboard, **Mark Completed** shows the refusal and its findings in the session's details.

The setting is off by default because a run completed by `intutic loop exec` was never verified before, and turning it on leaves such runs active until they are.
