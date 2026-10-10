# Budgets & FinOps <Badge type="tip" text="Cloud" />

Track, allocate, and restrict LLM token costs to prevent runaway agent spend and optimize development budgets.

## Why Budget Controls Matter

Agentic coding workflows can trigger thousands of parallel LLM calls, quickly generating significant API spend. Intutic's **FinOps Budget Gate** protects your organization from unexpected billing spikes by enforcing spend boundaries at every layer.

---

## Setting Up Budget Limits

Spend budgets work at three levels. Every call through the LLM proxy counts against all of the ones that cover it, and each budget is either **hard** or **soft**:

- **Hard:** the proxy refuses a request that the rest of the budget does not cover, before the request leaves, with `429 BUDGET_EXCEEDED`.
- **Soft:** nothing is refused; the budget raises [budget alerts](#budget-alerts) only.

| Budget | Covers | Periods | Default | Plans |
|---|---|---|---|---|
| [Workspace caps](#workspace-caps) | Every call in the workspace | Day and month | Daily cap hard, monthly cap soft | Every plan |
| [Key budgets](#key-budgets) | The calls one virtual key makes | Day and/or month | Hard | Every plan |
| [Member budgets](#member-budgets) | The calls made with the virtual keys one member owns | Day and/or month | Hard | Biz Org, Enterprise, Self-host and the trials <Badge type="warning" text="Biz Org+" /> |

A day is a UTC calendar day and a month a UTC calendar month: every budget starts again from zero at 00:00 UTC, and on the 1st of the month. Virtual keys can also have [rate limits](#key-rate-limits).

### Workspace caps

Set the workspace's daily and monthly caps, the alert threshold, and whether each cap is hard on **Settings › Billing › Budget Limits**, with [`intutic budget set`](/reference/cli#intutic-budget-set), with Terraform's [`intutic_workspace_budget`](/reference/terraform/resources/workspace_budget), or with `PUT /api/v1/budget` (OWNER or ADMIN):

```json
{
  "daily_budget_usd": 50,
  "monthly_budget_usd": 1000,
  "alert_threshold_pct": 80,
  "daily_enforcement": "hard",
  "monthly_enforcement": "hard"
}
```

- **The daily cap is hard** unless you set `daily_enforcement` to `soft`.
- **The monthly cap is soft** unless you set `monthly_enforcement` to `hard`. Then a request the rest of the month's cap does not cover is refused like one over the daily cap.
- A cap of `0` is no cap.
- **Only what you send changes.** A field left out of the `PUT` keeps its value, and `null` returns it to its default. So changing the monthly cap alone does not save a daily cap.
- A workspace that has never saved a daily cap has a **daily cap of $100**, hard like any other, and a monthly cap of $500 that only raises alerts. Settings › Billing and `intutic budget` say when the daily cap is that default, and `GET /api/v1/budget` answers `daily_budget_is_default: true`. Saving your own daily cap replaces the default at once.
- To go back to the default daily cap, send `"daily_budget_usd": null`, run `intutic budget set --daily default`, choose **Use the $100.00 default daily cap** under **Budget Limits**, or leave `daily_budget_usd` out of `intutic_workspace_budget`.

The caps belong to the workspace: every member and every virtual key in it draws on the same amount. A change applies from each key's next request.

### Key budgets

Give one virtual key its own day budget, month budget or both, each hard or soft. Only an OWNER or ADMIN can set them, for any key in the workspace: on **Settings › Billing › Key budgets and rate limits** (**Edit** on the key's row), with [`intutic budget key`](/reference/cli#intutic-budget-key), with the `daily_budget_usd` and `monthly_budget_usd` attributes of Terraform's [`intutic_virtual_key`](/reference/terraform/resources/virtual_key), or with `PATCH /api/v1/keys/:id`:

```json
{
  "budgets": [
    { "period": "day", "limitUsd": 5 },
    { "period": "month", "limitUsd": 100, "enforcement": "soft" }
  ],
  "rateLimit": { "rpm": 60 }
}
```

`budgets` replaces the key's budgets: send `[]` to remove them. `enforcement` is `hard` when you leave it out. A key is created without budgets; any member creates their own keys, and an owner or admin then limits them. Every change is recorded as an `updated` change to the key on the [audit timeline](/guide/audit-timeline).

One key per kind of traffic (CI, a service, a developer's machine) gives each its own budget.

### Member budgets <Badge type="warning" text="Biz Org+" /> {#member-budgets}

A member budget limits what one member spends across all the virtual keys they own: a call belongs to the member who owns the key that made it, as it does in **Cost by Developer**. A service-account key belongs to the member who created it, so its calls count against that member's budgets, as they do in Cost by Developer; give automation its own [key budget](#key-budgets) to limit it separately.

- **The default member budget** applies to every member without a budget of their own for that period.
- **A member's own budget** for a period replaces the default's for that period. A member with only their own month budget still has the default day budget.

Set them on **Settings › Billing › Member budgets**, with [`intutic budget member`](/reference/cli#intutic-budget-member) (`default` for the default), with Terraform's [`intutic_member_budget`](/reference/terraform/resources/member_budget), or with `PUT /api/v1/budget/members/:memberId` and `DELETE /api/v1/budget/members/:memberId` (`default` for the default). OWNER or ADMIN.

Member budgets come with the Biz Org, Enterprise and Self-host plans and the trials. On another plan the routes answer `403` with `Upgrade required — member budgets require a Biz Org plan or higher`. A workspace that moves to a plan without them keeps them stored, but they are neither enforced nor alerted on until it moves back.

### Key rate limits {#key-rate-limits}

A virtual key can have a limit on **requests per minute** (`rpm`) and on **tokens per minute** (`tpm`), set with the key's budgets above. Every plan has them.

- A minute is a UTC calendar minute. The count is kept in Valkey, so every proxy replica on one Valkey shares it.
- **Requests per minute** is exact: the check and the count are one atomic step, so two replicas cannot both take the minute's last request. A refused request is not counted.
- **Tokens per minute** counts the tokens each call actually used, input plus output, as the call completes. A request's tokens are not known before it is sent, so the proxy refuses a request once the minute's tokens have reached the limit: the call that crosses the limit is allowed, and the ones after it in that minute are not.
- Over either limit the proxy answers `429 RATE_LIMITED`, with `Retry-After` set to the seconds left in the minute.
- If Valkey cannot be read, the request is admitted uncounted: a rate limit is a throttle, not a spend control.
- Proxies on different Valkeys (one per region, for example) count separately.

### Plan daily cap

Each plan comes with a daily spend cap of its own, the monitored LLM volume on [Plans & pricing](/guide/plans). It can block too: turn on **Block at the plan's daily cap** under **Budget Limits**, or set both workspace settings `enforcement_mode` to `hard` and `workspace_hard_cap_enabled` to `true` (see [Workspace Settings](/reference/workspace-settings#routing-and-cost)). The control plane then checks the day's spend every five minutes and, once it is over the plan's cap, the proxy refuses every request with `429 OVERAGE_HARD_CAP_EXCEEDED` until midnight UTC.

### Local Daily Cap

A standalone proxy (one with no control plane) also keeps a daily cap of its own, for all the spend that passes through it. Set it as `maxDailyBudgetUsd` in `~/.intutic/config.json`:

```json
{ "maxDailyBudgetUsd": 25 }
```

It defaults to `$10.00` when unset, and an edit takes effect within 60 seconds without a restart. `INTUTIC_LOCAL_BUDGET_ENFORCE=0` stops the proxy refusing requests over the cap while it keeps counting the spend. There are no environment variables for the cap itself. A proxy connected to a control plane does not apply it: its spend is capped by the budgets above.

---

## How Enforcement Works

Before forwarding a request, the proxy:

1. **Estimates its cost** from the model's price, the prompt's length and the request's `max_tokens`.
2. **Checks every hard budget that covers the call** — the workspace's, the key's and its member's — against the spend recorded so far in that budget's day or month. If the estimate plus a 20% margin is more than what is left of any of them, the request is refused with `429 BUDGET_EXCEEDED`. The error names the budget and its window, and `Retry-After` is the seconds until it resets:

   ```json
   {
     "error": {
       "type": "BUDGET_EXCEEDED",
       "message": "This API key's daily spend budget of $5.00 does not cover this request: ...",
       "budget": { "scope": "key", "period": "day", "limitUsd": 5, "spentUsd": 4.98, "resetsAt": "2026-10-10T00:00:00+00:00" }
     }
   }
   ```

3. **Checks the key's rate limits**, and answers `429 RATE_LIMITED` over either.

The spend a budget is checked against is what the control plane records as each call completes, so a request's own cost counts from the request after it. Requests in flight together can each fit what is left and together go past a budget by up to their own cost; the next request is refused. The [clawde SDKs](/reference/clawde-sdk) raise both refusals as `ClawdeBlockedError`, with `retryAfterSeconds` (`retry_after_seconds`) from `Retry-After`.

### Enforcement Modes & Connectivity

#### 1. Connected Mode
*   **Budgets travel with the key.** The control plane puts every hard budget covering a key, and the key's rate limits, on the key's cached entry in Valkey. A change to a budget drops the entries it affects, so it applies from each key's next request.
*   **Spend counters:** the control plane adds each completed call's cost to the workspace's, the key's and the member's counters for the day and the month, and the proxy reads them all in one Valkey round trip per request.

#### 2. Local Daily Cap (Every Proxy)
*   **Local Budget Definition:** The proxy reads its daily cap (`maxDailyBudgetUsd`, default `$10.00`) from `~/.intutic/config.json`. It is the only cost control in standalone mode; a connected proxy uses the budgets above instead.
*   **Offline Spend Ledger:** Day-accumulated spend is saved in sharded daily files (`~/.intutic/logs/local-spend-YYYY-MM-DD.jsonl`).
*   **Pre-flight Cost Interception:** Before reaching the LLM provider, a native budget gate plugin estimates query cost based on prompt length and static ratios. If this would exceed the remaining budget, the proxy blocks the request with `HTTP 429 Too Many Requests` (`OVERAGE_HARD_CAP_EXCEEDED` error code).
*   **Offline Telemetry Ingestion:** Successful completion costs are calculated, appended to the daily spend ledger, and queued in sharded files `~/.intutic/logs/traces-YYYY-MM-DD.jsonl` for sync-back.

#### Valkey Failure Behavior (Fail-Closed)

A connected proxy that cannot read Valkey (the in-memory cache that holds virtual keys and budget counters) cannot verify the caller's key or the spend against a hard budget, so it **refuses** the request rather than admit spend it cannot check:

*   **Retryable refusals:** the proxy answers `503` with `AUTH_UNVERIFIABLE` (the key could not be checked) or `BUDGET_UNVERIFIABLE` (the spend, or the workspace's daily cap, could not be checked: a proxy whose copy of the cap is missing asks the control plane for it and refuses only if it cannot get it; it never falls back to a default cap). The key may well be valid, so clients should retry rather than treat it as an authentication failure.
*   **Automatic recovery:** once Valkey is reachable again, requests are admitted and checked as usual.
*   **Rate limits fail open:** a key's per-minute limits are not checked while Valkey cannot be read.

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
- **Budget Limits** — on **Settings › Billing**: meters for **Spent this month** and **Spent today** against their caps (amber from 75%, red from 90%), the caps, whether each is hard, the alert threshold, and the budget alerts raised so far.
- **Key budgets and rate limits** — on the same tab: each virtual key's spend today and this month against its own budgets, and its rate limit.
- **Member budgets** <Badge type="warning" text="Biz Org+" /> — on the same tab: the default member budget, and each member's spend against the budgets that apply to them.
- **Cost by Virtual Key** — on Overview's **Cost & Token Efficiency** tab: cost per virtual key, today or this month (see below).
- **Cost by Developer** — on the same tab: cost, tokens, calls, active days and models used per member, today or this month. Sort by any column; the top 10 show until you choose **Show all**. A call belongs to the member who owns the virtual key that made it. OWNER, ADMIN and EM see every member, plus an **Unattributed** row for calls with no virtual key. A DEVELOPER or VIEWER sees only their own usage.
- **Cost by Team** — on the same tab, for OWNER, ADMIN and EM: the same figures per [SCIM group](/guide/scim), including members of nested groups. A member in several groups counts in each one, so team totals can add up to more than the workspace total. Without SCIM groups there are no teams, and cost by developer is the finest breakdown. SCIM comes with the Enterprise and Self-host plans.
- **Cost by Branch** — on the same tab: cost per repository and branch, or per HEAD commit, with the same role scoping as **Cost by Developer** (see [Cost per branch and commit](#cost-per-branch-and-commit)).
- **Cost by Pull Request** — on the same tab, next to Cost by Branch: cost, calls and developers per GitHub pull request (see [Cost per pull request](#cost-per-pull-request)).

Cost by Developer, Cost by Team, Cost by Branch and Cost by Pull Request are fleet analytics <Badge type="warning" text="Biz Org+" />: they come with the Biz Org, Enterprise and Self-host plans and the trials. On another plan each card says which plans include it.

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

Every budget, hard or soft, raises two alerts per period:

- **A threshold warning** when spend reaches the workspace's alert threshold (**Alert at (% of cap)** under **Budget Limits**, 80% unless you change it). The one threshold applies to the workspace caps and to every key and member budget.
- **A budget-exceeded alert** when spend reaches 100% of the budget.

Each is raised at most once per budget per day or month. The workspace caps are checked hourly; if one check finds spend already past a cap, it raises only the exceeded alert. Key and member budgets are checked as each call's cost is recorded, so their alerts go out within moments.

Every alert is listed under **Budget alerts** on **Settings › Billing**, naming whose budget it is (the workspace's cap, a key or a member), and can be acknowledged there; `GET /api/v1/budget/alerts` returns them with `scope` and `subjectId`. Each also goes out through any notification rule on **Budget Threshold Reached** (`finops.budget.threshold`) or **Budget Exceeded** (`finops.budget.exceeded`), to that rule's Slack channel, email recipients, webhook or PagerDuty service; the event carries `scope` (`workspace`, `key` or `member`), the key's or member's id, and `enforcement`. See [Notifications](/guide/settings#notifications). With [SIEM export](/guide/siem-export) they stream as the `budget_alerts` source.

## CLI Budget Management

```bash
intutic budget                 # the workspace's spend against its caps, the local cap, and running loops
intutic budget set --monthly 1000 --monthly-enforcement hard
intutic budget keys            # every key's budgets, rate limit and spend
intutic budget key key_abc123 --daily 5 --rpm 60
intutic budget members         # Biz Org and up
intutic budget member default --daily 20
```

See [`intutic budget`](/reference/cli#intutic-budget) and the subcommands after it.

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

From the CLI, `intutic usage branches` and `intutic usage commits` print the same figures (`intutic usage members` and `intutic usage teams` the per-developer and per-team ones); see [the CLI reference](/reference/cli#intutic-usage-branches).

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
