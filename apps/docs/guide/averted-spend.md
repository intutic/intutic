# Runaway-Spend Counterfactual <Badge type="warning" text="Cloud / Team" />

When a proxy detector [kills](/guide/loops#circuit-breaker-enforcement) a runaway agent loop,
the dashboard shows an **averted spend** figure alongside your normal cost-savings numbers — for
example, "$412.60 in runaway spend averted". This page explains exactly what that number is,
where it comes from, and — just as important — what it is not.

---

## It is a model, not a measurement

The averted-spend figure is a **projection of what the killed session would have cost had the
KILL not fired**, extrapolated from the session's own measured burn rate. It is not, and cannot
be, an observed cost — the whole point of the KILL is that the spend it prevents never happens,
so there is nothing left to measure directly.

Treat it the same way you'd treat any other financial projection: directionally useful for
understanding the value of enforcement, not a number to reconcile against an invoice.

## How it's computed

The figure comes from `computeAvertedSpend` in the control plane
(`services/control-plane/src/services/runawayCounterfactualService.ts`), which runs in two steps:

1. **Measure the burn rate.** Sum `actual_cost_usd` over every execution trace on the killed
   session that precedes the kill timestamp, and divide by the elapsed time from the earliest of
   those traces up to the kill. This gives a `$/min` burn rate for the session's actual,
   already-incurred activity — the killed trace itself is excluded (its cost is zeroed at the
   source by the proxy's KILL handling anyway).
2. **Extrapolate forward.** Multiply that measured `$/min` rate by a fixed extrapolation window —
   currently **60 minutes** — to produce the averted-spend dollar figure.

```
avertedUsd = usdPerMin × 60
```

If a session has **zero traces preceding the kill**, there is nothing to measure a rate from, and
the service returns no figure at all rather than a fabricated `$0`. A missing averted-spend
callout on a killed session means "not enough data to estimate," not "nothing was averted."

## What it deliberately does not do

- **It never replays or re-executes anything.** This is pure arithmetic over already-recorded
  trace costs — not a simulation, fork, or replay of the session's actual trajectory. A session
  that would have hit a rate limit, failed auth, or naturally terminated on its own is not
  modeled; the extrapolation assumes the measured rate simply continues.
- **It does not cover advisory interventions.** Only enforced `KILL` actions produce an
  averted-spend figure. A `TRAJECTORY_ALERT`/advisory intervention doesn't actually stop
  anything, so there is no counterfactual to compute for it.
- **The extrapolation window is fixed, not configurable per workspace.** 60 minutes is a named
  constant applied uniformly, so a persisted figure always means the same thing regardless of
  when it was computed — a per-workspace override would silently change what an
  already-displayed number represents.

## Where it shows up

The dashboard's **Cost Savings** card (`apps/dashboard/src/components/dashboard/CostSavingsCard.tsx`)
renders the averted-spend figure as its own callout row, tagged **extrapolated**, and deliberately
never merges it into the measured routing-savings percentage shown above it. Those are two
different populations of numbers:

| | What it measures | Basis |
|---|---|---|
| **Savings %** / **You saved $X** | Actual routing/caching cost reduction on completed requests | Measured |
| **Runaway spend averted** | Projected cost of a killed session's burn rate continuing for 60 more minutes | Extrapolated |

The callout only renders when the figure is a positive number — a session with no averted spend
(or none computed) shows nothing rather than a `$0` row.

## Related

- [Session Safety & Budgets](/guide/loops) — how loops are registered, budgeted, and killed
- [Budgets & FinOps](/guide/budgets) — measured spend, budget alerts, and enforcement modes
