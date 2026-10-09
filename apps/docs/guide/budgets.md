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

What each cap does:

- **The daily cap is enforced.** Before forwarding a request, the proxy estimates its cost and refuses it with `429 BUDGET_EXCEEDED` when the estimate plus a 20% margin is more than what is left of the day's cap. The cap belongs to the workspace: every member and every virtual key in it draws on the same amount.
- **The monthly cap raises alerts.** Reaching its alert threshold or the cap itself raises the [budget alerts](#budget-alerts) below; requests are not refused.

There are no per-developer or per-virtual-key budgets. To see who spends what, use **Cost by Developer** and **Cost by Virtual Key** (see [Dashboard Widgets](#dashboard-widgets)) or `intutic usage members`.

::: tip
Start with a conservative daily cap and raise it as you learn your team's usage. Cost by Developer shows where the spend goes.
:::

### Local Daily Cap

A standalone proxy (one with no control plane) also keeps a daily cap of its own, for all the spend that passes through it. Set it as `maxDailyBudgetUsd` in `~/.intutic/config.json`:

```json
{ "maxDailyBudgetUsd": 25 }
```

It defaults to `$10.00` when unset, and an edit takes effect within 60 seconds without a restart. `INTUTIC_LOCAL_BUDGET_ENFORCE=0` stops the proxy refusing requests over the cap while it keeps counting the spend. There are no environment variables for the cap itself. A proxy connected to a control plane does not apply it: its spend is capped per workspace by the caps above.

---

## How Enforcement Works

Each API request flowing through the proxy is checked against budget limits:

1. **Cost estimation** — The proxy estimates the cost from the model's price, the prompt's length and the request's `max_tokens`
2. **Budget check** — The estimate plus a 20% margin is compared with what is left of the workspace's daily cap, or of the machine's local daily cap on a standalone proxy
3. **Decision** — If the request would exceed it, it is blocked with a `KILL` enforcement action and a `429`

### Enforcement Modes & Connectivity

Intutic's budget enforcer operates in two distinct modes depending on connection status:

<!-- ENTERPRISE_ONLY_START -->
#### 1. Connected Mode
*   **Centralized Caps:** The daily cap is set centrally and enforced on every request; the monthly cap raises alerts only.
*   **Valkey Cache Validation:** The control plane writes the workspace's daily cap and its running daily spend to Valkey, and the proxy reads both with the virtual key on every request.
*   **Heartbeat Sync:** Actual query costs update Valkey counters and PostgreSQL in real time upon successful completions.
<!-- ENTERPRISE_ONLY_END -->

#### 2. Local Daily Cap (Every Proxy)
*   **Local Budget Definition:** The proxy reads its daily cap (`maxDailyBudgetUsd`, default `$10.00`) from `~/.intutic/config.json`. It is the only cost control in standalone mode; a connected proxy uses the workspace caps instead.
*   **Offline Spend Ledger:** Day-accumulated spend is saved in sharded daily files (`~/.intutic/logs/local-spend-YYYY-MM-DD.jsonl`).
*   **Pre-flight Cost Interception:** Before reaching the LLM provider, a native budget gate plugin estimates query cost based on prompt length and static ratios. If this would exceed the remaining budget, the proxy blocks the request with `HTTP 429 Too Many Requests` (`OVERAGE_HARD_CAP_EXCEEDED` error code).
*   **Offline Telemetry Ingestion:** Successful completion costs are calculated, appended to the daily spend ledger, and queued in sharded files `~/.intutic/logs/traces-YYYY-MM-DD.jsonl` for sync-back.

#### Valkey Failure Behavior (Fail-Closed)

A connected proxy that cannot read Valkey (the in-memory cache that holds virtual keys and budget counters) cannot verify the caller's key or the workspace's spend, so it **refuses** the request rather than admit spend it cannot check:

*   **Retryable refusals:** the proxy answers `503` with `AUTH_UNVERIFIABLE` (the key could not be checked) or `BUDGET_UNVERIFIABLE` (the spend could not be checked). The key may well be valid, so clients should retry rather than treat it as an authentication failure.
*   **Automatic recovery:** once Valkey is reachable again, requests are admitted and checked as usual.

::: warning
A Valkey outage stops a connected workspace's model traffic. Monitor Valkey's health and alert on the proxy's `AUTH_UNVERIFIABLE` and `BUDGET_UNVERIFIABLE` refusals. A standalone proxy is unaffected: its local cap is kept in files.
:::

### Budget Breach Anomalies

When a budget limit is exceeded, Intutic raises one of three anomaly types:

| Anomaly Type | Trigger |
|-------------|---------|
| **Budget Breach** | The workspace, or a standalone machine, has used up its daily budget |
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
- **Per-Pull-Request Breakdown:** Cost grouped by GitHub pull request (`/api/v1/usage/pull-requests`). See [Cost per pull request](#cost-per-pull-request).
- **Event-Level Detail:** The individual billed calls behind those totals (`/api/v1/usage/events`).

The per-developer, per-team, per-branch, per-commit and per-pull-request breakdowns are fleet analytics, on Biz Org and above: on another plan they answer `403` with `Upgrade required — fleet analytics requires a Biz Org plan or higher`, from the first request after a downgrade. The other reports are on every plan.

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
- **The clawde SDKs** report their own: with a virtual key, `ClawdeClient` registers a session carrying the repository, branch and commit of the directory it runs in, through a gateway or in CI too. See [Git context and cost attribution](/reference/clawde-sdk#_1a-git-context-and-cost-attribution).
- **Pull requests:** a branch with a GitHub pull request is also reported per pull request. See [Cost per pull request](#cost-per-pull-request).

### Cost per pull request <Badge type="warning" text="Biz Org+" /> {#cost-per-pull-request}

A pull request's cost is the calls made on its head branch, in its repository, from the end of the previous pull request on that branch (or the branch's first call) until it was merged or closed. The dashboard shows it as **Cost by Pull Request** on Overview's **Cost & Token Efficiency** tab, next to Cost by Branch: each pull request links to GitHub, with its state, author, cost, calls and developers. The CLI is `intutic usage pull-requests`, and the API is `GET /api/v1/usage/pull-requests`.

- **Several pull requests from one branch** split it: each one takes the calls since the previous one ended. Calls after the last one was merged or closed stay in cost by branch only. When two pull requests from one branch are open at once (to different base branches), a call goes to the newer one opened before it.
- **A reopened pull request** takes back the calls made while it was closed.
- **Force-pushes change nothing:** attribution is by branch and time, not by commit.
- **Forks:** a pull request from a fork is not mapped. Its branch lives in the fork, and calls made in a fork carry the fork's remote, so they stay in cost by branch.
- **Scope:** the same as cost by branch. OWNER, ADMIN and EM see every call; anyone else sees their own.

Intutic learns which pull requests a branch has in one of two ways. You need one of them:

1. **A GitHub source's token.** If the workspace has a GitHub source (Policy Guardrails › Sources), the control plane uses its token to ask GitHub for the pull requests of each branch that had a call in the last 35 days, on the host the source serves: `github.com`, or your GitHub Enterprise Server when `GITHUB_BASE_URL` is set. It sends only the repository and branch names, never call content, and the token never leaves the control plane. It asks every 15 minutes, and OWNER, ADMIN and EM can ask now with **Look up on GitHub now** on the card or `intutic usage pull-requests --refresh`. Each request is conditional on the previous answer's ETag, so a branch with no news does not count against GitHub's rate limit, and lookups pause when fewer than 100 requests remain in the token's hour, leaving the rest for the policy sync. A fine-grained token needs **Pull requests: Read** on the repositories; a classic token with the `repo` scope already has it. When GitHub refuses, the card names the repositories.
2. **The pull-request webhook**, which needs no token and works with GitHub Enterprise Server. An owner or admin creates it under **Settings › Integrations › GitHub Pull Request Webhook** (or `intutic github webhook rotate-secret`), then adds a webhook on the GitHub repository or organization: the payload URL, content type `application/json`, the secret, and the **Pull requests** event only. Intutic checks every delivery's `X-Hub-Signature-256` against the secret and refuses one that does not match. A delivery is processed once, and an event older than what Intutic already holds for that pull request changes nothing, so a redelivered or late event cannot reopen a merged pull request. Replacing the secret keeps the URL; deliveries signed with the old secret are refused from then on.

GitLab merge requests are not mapped yet; calls on GitLab branches are in cost by branch.

### Resolving Budget Breaches
Budget breach anomalies (see [Budget Breach Anomalies](#budget-breach-anomalies)) are incidents: security and FinOps administrators review them on **Findings › Incidents**. When resolving a breach, administrators can record:
- **Resolution Status:** `RESOLVED` status marking once action has been taken (e.g., plan tier upgraded, limits adjusted).
- **Audit Trails:** Record `resolvedBy` and `resolutionNote` to maintain SOC 2 compliance logs for financial audit records.

---

## Related

- [Settings & Configuration](/guide/settings) — Configure workspace budgets
- [Core Concepts](/guide/concepts) — Anomaly types and enforcement actions
- [Activity Logs (Traces)](/guide/traces) — Token utility classification
