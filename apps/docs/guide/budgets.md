# Budgets & FinOps <Badge type="tip" text="Cloud" />

Track, allocate, and restrict LLM token costs to prevent runaway agent spend and optimize development budgets.

## Why Budget Controls Matter

Agentic coding workflows can trigger thousands of parallel LLM calls, quickly generating significant API spend. Intutic's **FinOps Budget Gate** protects your organization from unexpected billing spikes by enforcing spend boundaries at every layer.

---

## Setting Up Budget Limits

### Per-Workspace Budgets

Set the workspace's daily and monthly caps and its alert threshold on **Settings › Billing › Budget Limits**, or with `PUT /api/v1/budget`:

```json
{ "daily_budget_usd": 50, "monthly_budget_usd": 1000, "alert_threshold_pct": 80 }
```

### Local Daily Cap

A standalone proxy (one with no control plane) also keeps a daily cap of its own, for all the spend that passes through it. Set it as `maxDailyBudgetUsd` in `~/.intutic/config.json`:

```json
{ "maxDailyBudgetUsd": 25 }
```

It defaults to `$10.00` when unset, and an edit takes effect within 60 seconds without a restart. `INTUTIC_LOCAL_BUDGET_ENFORCE=0` stops the proxy refusing requests over the cap while it keeps counting the spend. There are no environment variables for the cap itself. A proxy connected to a control plane does not apply it: its spend is capped per workspace by the caps above.

### Developer Budget Tiers

Assign developers to budget tiers that match their role and usage needs:

| Tier | Cap Level | Intended For |
|------|-----------|-------------|
| **Junior** | Strict | Junior engineers or experimental features |
| **Senior** | Balanced | Standard operational budget for senior engineers |
| **Staff** | High | Heavy coding sessions or complex projects |
| **Principal** | Generous | Large-scale test pipelines and architectural work |

::: tip
Start with conservative budgets and increase as you understand your team's usage patterns. The FinOps dashboard helps you identify trends.
:::

---

## How Enforcement Works

Each API request flowing through the proxy is checked against budget limits:

1. **Cost estimation** — The proxy calculates the estimated cost using model pricing data and token counting multipliers
2. **Budget check** — The estimated cost is compared against the developer's remaining daily/monthly budget
3. **Decision** — If the request would exceed the budget, it's blocked with a `KILL` enforcement action

### Enforcement Modes & Connectivity

Intutic's budget enforcer operates in two distinct modes depending on connection status:

<!-- ENTERPRISE_ONLY_START -->
#### 1. Connected Mode
*   **Centralized Caps:** Daily and monthly budgets are managed centrally.
*   **Valkey Cache Validation:** The control plane caches billing limits and cumulative workspace usage counters in Valkey. The proxy performs a cache precheck (`check_workspace_hard_block`) — a single Valkey GET — on every incoming request.
*   **Heartbeat Sync:** Actual query costs update Valkey counters and PostgreSQL in real time upon successful completions.
<!-- ENTERPRISE_ONLY_END -->

#### 2. Local Daily Cap (Every Proxy)
*   **Local Budget Definition:** The proxy reads its daily cap (`maxDailyBudgetUsd`, default `$10.00`) from `~/.intutic/config.json`. It is the only cost control in standalone mode; a connected proxy uses the workspace caps instead.
*   **Offline Spend Ledger:** Day-accumulated spend is saved in sharded daily files (`~/.intutic/logs/local-spend-YYYY-MM-DD.jsonl`).
*   **Pre-flight Cost Interception:** Before reaching the LLM provider, a native budget gate plugin estimates query cost based on prompt length and static ratios. If this would exceed the remaining budget, the proxy blocks the request with `HTTP 429 Too Many Requests` (`OVERAGE_HARD_CAP_EXCEEDED` error code).
*   **Offline Telemetry Ingestion:** Successful completion costs are calculated, appended to the daily spend ledger, and queued in sharded files `~/.intutic/logs/traces-YYYY-MM-DD.jsonl` for sync-back.

#### Valkey Failure Behavior (Fail-Open)

When Valkey (the in-memory cache used for budget counters) is unavailable, the budget gate **fails open** — requests are allowed through rather than blocked:

*   **Availability over enforcement:** This is a conscious design decision. During a cache outage, blocking all LLM requests would halt developer productivity across the entire workspace. The budget gate prioritizes availability.
*   **Structured warning logs:** Every request that bypasses the budget check due to Valkey unavailability emits a structured warning log entry, enabling observability dashboards and alerting pipelines to detect prolonged cache outages.
*   **Automatic recovery:** Once Valkey is back online, the budget gate resumes normal enforcement. Spend that occurred during the outage is reconciled via the heartbeat sync process from completion events in PostgreSQL.

::: warning
During a Valkey outage, budget limits are not enforced on the fast path. Monitor your Valkey health and set up alerts for `E_CACHE_UNAVAILABLE` log events to minimize the enforcement gap window.
:::

### Budget Breach Anomalies

When a budget limit is exceeded, Intutic raises one of three anomaly types:

| Anomaly Type | Trigger |
|-------------|---------|
| **Budget Breach** | A developer or workspace has exceeded their allocated daily or monthly budget |
| **Spawn Budget Breach** | A sub-agent fleet has reached its localized budget boundary |
| **Workflow Budget Breach** | A multi-step workflow execution has exceeded its set threshold |

---

## Monitoring Usage

### Dashboard Widgets

The dashboard surfaces budget utilization in real time:

- **Budget used** — on Overview, above every tab: spend against the workspace budget, as a percentage and in dollars.
- **Budget Limits** — on **Settings › Billing**: meters for **Spent this month** and **Spent today** against their caps (amber from 75%, red from 90%), the caps and alert threshold themselves, and the budget alerts raised so far.
- **Cost by Virtual Key** — on Overview's **Cost & Token Efficiency** tab: cost per virtual key, today or this month (see below).
- **Cost by Developer** — on the same tab: cost, tokens, calls, active days and models used per member, today or this month. Sort by any column; the top 10 show until you choose **Show all**. A call belongs to the member who owns the virtual key that made it. OWNER, ADMIN and EM see every member, plus an **Unattributed** row for calls with no virtual key. A DEVELOPER or VIEWER sees only their own usage.
- **Cost by Team** — on the same tab, for OWNER, ADMIN and EM: the same figures per [SCIM group](/guide/scim), including members of nested groups. A member in several groups counts in each one, so team totals can add up to more than the workspace total. Without SCIM groups there are no teams, and cost by developer is the finest breakdown. SCIM comes with the Enterprise and Self-host plans.
- **Cost by Branch** — on the same tab: cost per repository and branch, or per HEAD commit, with the same role scoping as **Cost by Developer** (see [Cost per branch and commit](#cost-per-branch-and-commit)).

Cost by Developer, Cost by Team and Cost by Branch are fleet analytics <Badge type="warning" text="Biz Org+" />: they come with the Biz Org, Enterprise and Self-host plans and the trials. On another plan each card says which plans include it.

The dashboard has no daily spend trend or per-model spend view. **Token Efficiency by Model** on the same tab shows tokens per model, not cost.

### Token Utility Classification

Every trace is classified as either:

| Classification | Meaning |
|---------------|---------|
| **Useful** | The agent's output was productive and valuable |
| **Wasted** | The agent looped, hallucinated, or produced unusable output |

This classification feeds into the FinOps ledger and helps optimize model routing decisions over time.

---

## Budget Alerts

An hourly check compares each workspace's spend with its daily and monthly caps, and raises:

- **A threshold warning** when spend reaches the alert threshold (**Alert at (% of cap)** under **Budget Limits**, 80% unless you change it).
- **A cap-exceeded alert** when spend reaches 100% of the cap.

Each is raised at most once per budget period: once for the day's spend and once for the month's. If one check finds spend already past the cap, it raises only the cap-exceeded alert. The periods follow the workspace's spend counters, which start with the first spend after the previous period ends and run 24 hours (daily) or 30 days (monthly).

Every alert is listed under **Budget alerts** on **Settings › Billing**, where it can be acknowledged. It also goes out through any notification rule on **Budget Threshold Reached** (`finops.budget.threshold`) or **Budget Exceeded** (`finops.budget.exceeded`), to that rule's Slack channel, email recipients, webhook or PagerDuty service. See [Notifications](/guide/settings#notifications). Without such a rule, alerts appear only on the Billing page.

## CLI Budget Management

You can inspect your remaining budget limits and active task loops directly from your terminal:

```bash
intutic budget
```

This returns a clear breakdown containing:
* **Cloud Budget Status**: Remaining daily/monthly spend and limits from the control plane.
* **Local Spending Cap**: Your global daily limit configured in `~/.intutic/config.json`.
* **Active Task Loops**: Running loops, names, accumulated costs, and localized budget limits.

---

## Usage Reporting

Intutic keeps an append-only cost ledger — `execution_traces` forbids UPDATE and DELETE at the database level — and exposes it for reporting:

- **Workspace Summary:** Actual cost, raw cost before routing, routing savings, input and output token totals, and call count for a daily, weekly or monthly window (`/api/v1/usage/summary`).
- **Per-Model Breakdown:** Cost and tokens grouped by requested model (`/api/v1/usage/models`).
- **Per-Virtual-Key Breakdown:** Cost and tokens grouped by which virtual key authenticated the call (`/api/v1/usage/virtual-keys`).
- **Per-Developer Breakdown:** Cost, tokens, calls, models and active days per member (`/api/v1/usage/members`). DEVELOPER and VIEWER callers get their own row only.
- **Per-Team Breakdown:** The same totals per SCIM group (`/api/v1/usage/teams`, OWNER, ADMIN and EM).
- **Per-Branch and Per-Commit Breakdown:** Cost grouped by repository and branch (`/api/v1/usage/branches`) or by HEAD commit (`/api/v1/usage/commits`).
- **Event-Level Detail:** The individual billed calls behind those totals (`/api/v1/usage/events`).

The per-developer, per-team, per-branch and per-commit breakdowns are fleet analytics, on Biz Org and above: on another plan they answer `403` with `Upgrade required — fleet analytics requires a Biz Org plan or higher`, from the first request after a downgrade. The other reports are on every plan.

::: info Chargebacks and GL mapping are not part of the product
Cost-center GL mapping, period-end chargeback re-invoicing and the async PDF/CSV report workers were removed when the product narrowed to circuit-breaker scope, and their tables were dropped. The endpoints above are what ships.
:::

### Splitting cost by traffic class (desktop vs. app, staging vs. prod, …)

There is no dedicated "traffic class" concept — the interim answer is one
virtual key per class. Mint a separate key under **Settings › Security › Virtual API Keys** for
each class (e.g. `desktop`, `ci`, `prod`), point that traffic at its own key,
and `/api/v1/usage/virtual-keys` reports each key's cost separately from that
point on. The same split is on the dashboard as the **Cost by Virtual Key**
card on Overview's **Cost & Token Efficiency** tab, for today or the
current month. Traces from before a key existed, and any trace with no
virtual-key auth context (a standalone/offline trace synced back, for
instance), report under a `null` key — shown as **unattributed** on the card —
rather than being folded into whichever key happens to be first.

### Cost per branch and commit <Badge type="warning" text="Biz Org+" /> {#cost-per-branch-and-commit}

The sync daemon (`intutic connect`) reports the repository, Git branch and HEAD commit of the directory it runs in. It checks them on every poll (every 30 seconds by default) and reports them again when they change. When the control plane records a trace, it copies the session's current repository, branch and commit onto that trace. A call therefore stays with the commit it was made at, even after the session moves on.

- **Repository** is the `origin` remote reduced to host and path, such as `github.com/acme/widgets`. Any user name, password or token in the remote is removed before the daemon sends it, and removed again when the control plane receives it. No file contents are sent.
- **Commit** is the commit that was checked out when the call was made. A commit's cost is therefore the work that led to the next commit, not the work that produced this one.
- **Scope:** the figures cover calls that go through a machine's local proxy while `intutic connect` is running. Every agent on that machine is attributed to the repository the daemon runs in, even when the agent works in a different directory. Calls through a shared gateway, calls made while the daemon is not reporting, and calls from a directory with no Git repository are shown as **No git context**.
- **Pull requests:** branches are not mapped to pull requests. That needs a GitHub integration, which Intutic does not have.

### Resolving Budget Breaches
Budget breach anomalies (see [Budget Breach Anomalies](#budget-breach-anomalies)) are incidents: security and FinOps administrators review them on **Findings › Incidents**. When resolving a breach, administrators can record:
- **Resolution Status:** `RESOLVED` status marking once action has been taken (e.g., plan tier upgraded, limits adjusted).
- **Audit Trails:** Record `resolvedBy` and `resolutionNote` to maintain SOC 2 compliance logs for financial audit records.

---

## Related

- [Settings & Configuration](/guide/settings) — Configure workspace budgets
- [Core Concepts](/guide/concepts) — Budget tiers and anomaly types
- [Activity Logs (Traces)](/guide/traces) — Token utility classification
