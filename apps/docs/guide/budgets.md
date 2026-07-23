# Budgets & FinOps <Badge type="warning" text="Cloud / Team" />

Track, allocate, and restrict LLM token costs to prevent runaway agent spend and optimize development budgets.

## Why Budget Controls Matter

Agentic coding workflows can trigger thousands of parallel LLM calls, quickly generating significant API spend. Intutic's **FinOps Budget Gate** protects your organization from unexpected billing spikes by enforcing spend boundaries at every layer.

---

## Setting Up Budget Limits

### Per-Workspace Budgets

Configure spending limits from the dashboard (**Settings &rarr; Billing**) or via environment variables:

| Variable | Description |
|----------|-------------|
| `INTUTIC_BUDGET_DAILY_USD` | Maximum daily spend in USD. Requests are blocked once reached |
| `INTUTIC_BUDGET_MONTHLY_USD` | Maximum monthly spend in USD |

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
#### 1. Active GKE/SaaS Enforcement (Connected Mode)
*   **Centralized Caps:** Daily and monthly budgets are managed centrally.
*   **Valkey Cache Validation:** The GKE control plane caches billing limits and cumulative workspace usage counters in Valkey. The proxy performs a fast-path cache precheck (`check_workspace_hard_block`) in under `<1ms` p99 latency for every incoming request.
*   **Heartbeat Sync:** Actual query costs update Valkey counters and PostgreSQL in real time upon successful completions.
<!-- ENTERPRISE_ONLY_END -->

#### 2. Local Fallback Enforcer (Standalone / Offline Mode)
*   **Local Budget Definition:** The local proxy loads your daily budget cap (`maxDailyBudgetUsd`) directly from your local config (`~/.intutic/config.json`).
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

- **Spend vs. Budget** — Visual gauge showing `spentUsd` against `totalBudgetUsd`
- **Daily trend** — Spending pattern over the current billing period
- **Per-model breakdown** — Which LLM models are consuming the most budget
- **Per-developer breakdown** — Individual spending by team member

### Token Utility Classification

Every trace is classified as either:

| Classification | Meaning |
|---------------|---------|
| **Useful** | The agent's output was productive and valuable |
| **Wasted** | The agent looped, hallucinated, or produced unusable output |

This classification feeds into the FinOps ledger and helps optimize model routing decisions over time.

---

## Budget Alerts

Intutic monitors usage trends and generates alerts:

- **Threshold warnings** — Alerts when spending approaches budget limits (e.g., 80%, 90%)
- **Breach notifications** — Immediate alerts when a budget is exceeded
- **Trend anomalies** — Alerts for unusual spending spikes
- **Forecast overruns (GA Upgrades)** — Projected spend overruns warning that the 30-day forecasted spend is projected to exceed the monthly budget. Dispatched immediately to corporate Slack channels.

All budget events are logged to the `budget_alerts` table and appear as governance incidents in the dashboard.

---

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

## CFO FinOps Ledger & Chargebacks (Enterprise)

For large-scale enterprise environments, Intutic includes a dedicated **CFO FinOps Dashboard** mapping agent costs directly to financial business structures:

- **General Ledger (GL) Mapping:** Automatically maps API usage costs to corporate cost centers (such as department codes, project IDs, or client billing codes).
- **Chargeback Re-invoicing:** Computes aggregated chargeback reports at the end of every period, matching plan tiers (e.g. `ent_sub`), consumption metrics, and customized overage rates.
- **Async Report Exports:** Generate and download detailed corporate financial PDF and CSV reports compiled through background worker jobs.

### Resolving Budget Alerts
Security and FinOps administrators can review all active budget breaches on the **Incidents Page**. When resolving a breach, administrators can record:
- **Resolution Status:** `RESOLVED` status marking once action has been taken (e.g., plan tier upgraded, limits adjusted).
- **Audit Trails:** Record `resolvedBy` and `resolutionNote` to maintain SOC 2 compliance logs for financial audit records.

---

## Related

- [Settings & Configuration](/guide/settings) — Configure workspace budgets
- [Core Concepts](/guide/concepts) — Budget tiers and anomaly types
- [Activity Logs (Traces)](/guide/traces) — Token utility classification
