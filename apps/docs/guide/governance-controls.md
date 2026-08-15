---
title: Governance Controls Checklist
description: A control-by-control mapping of what Intutic actually enforces today, stated honestly rather than rounded up.
---

# Governance Controls Checklist <Badge type="tip" text="Open-Core" />

Enterprise security teams evaluating an "agent governance" product increasingly
arrive with a specific checklist in hand — six controls that separate a
governed agent fleet from a liability: agent-issued identity, an immutable
audit trail, task-scoped permissions, a hard stop with clean rollback, live
behavioural drift monitoring, and sweeps for unauthorized agents already in
the stack.

This page maps each one to what Intutic actually ships — not a marketing
gloss. Where coverage is partial, it says so, and says why.

| Control | Coverage | What backs it |
|---|---|---|
| **Identity issued to the agent itself** | Partial | Graph identity (`node_id`/`agent_role`/`graph_id`) is explicitly **not** verified — see the warning in [Graph Guardrails → Node identity](/guide/graph-guardrails#node-identity). An ephemeral, employee-scoped agent credential exists as a real, distinct credential type in the Cloud/Enterprise tier — see below. |
| **An immutable audit trail behind every decision** | Strong | An append-only `notification_log` (database-trigger enforced, `UPDATE`/`DELETE` refused), trace Merkle roots with a tamper-evidence chain, and refused requests are traced too — not just the ones that succeeded. See [How It Works](/guide/how-it-works). |
| **Permissions scoped to the task, not the role on paper** | Strong | `deny_tools` blocks a tool outright; `scope_paths` bounds *where* a task may touch; `plan_steps` bounds *what* it consists of — genuinely task-scoped, not just role-scoped. See [SOP Front Matter](/reference/sop-front-matter). |
| **A hard stop, and clean rollback, when an agent exceeds its authority** | Strong | `KILL` refuses the request outright; `loop kill` and `review_before` holds stop a run from proceeding. Separately, `intutic rollback` reverts a flagged-but-allowed tool call's file changes from a local pre-image cache — opt-in, and scoped to the `warn` enforcement tier today (a `KILL`ed call never executes, so there's nothing to revert; a `require`-tier violation is refused before it runs). See [`intutic rollback`](/reference/cli#intutic-rollback). |
| **Live monitoring for behavioural drift before it compounds** | Strong | Trajectory analysis, behavioral drift events, and anomaly promotion (a repeated finding escalates from "recorded" to "acted on" — see [Graph Guardrails](/guide/graph-guardrails)) all run continuously, not as a point-in-time audit. |
| **Continuous sweeps for unauthorized agents already inside your stack** | Partial-to-strong | Active network probes raise a `CRITICAL` incident the moment an agent's traffic reaches a provider directly, bypassing the proxy. Harness config drift detection catches manual edits to governance files. The gap: this needs to be *enabled* — `intutic enforce` and the network probe are both opt-in, not the default. |

<!-- ENTERPRISE_ONLY_START -->
::: tip Cloud / Enterprise — agent-scoped credentials
On-behalf-of ephemeral tokens are a distinct credential type an agent
receives for a bounded task and time window — not the developer's own
shared key. See [Policies & Enforcement](/guide/policies) for the full
mechanism. Enterprise device visibility also reports whether host-level
enforcement (`intutic enforce`) is actually active on a given machine, not
just configured to be — strengthening the "sweeps for unauthorized agents"
row above.
:::
<!-- ENTERPRISE_ONLY_END -->

## What "Strong" and "Partial" mean here

"Strong" means the control is enforced today, with a real mechanism behind
it, not a policy document. "Partial" means real coverage exists but doesn't
close the whole gap the control describes — usually because the missing
half would require verifying something (a client-supplied identity claim)
that is structurally unverifiable without a stronger primitive underneath it,
or because the control is opt-in rather than a default.

## Related

| Page | What it covers |
|---|---|
| [Graph Guardrails](/guide/graph-guardrails) | The deterministic detector taxonomy and SOP enforcement |
| [Security](/security) | Full threat model, data flow, and encryption |
| [Policies & Enforcement](/guide/policies) | Network egress control and sandboxed execution |
| [Sandboxed Execution](/guide/sandboxed-execution) | What `intutic exec --sandbox` isolates, and what platforms it does and doesn't cover |
