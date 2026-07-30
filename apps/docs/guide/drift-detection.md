# Detecting When Agents Go Off-Pattern <Badge type="warning" text="Cloud / Team" />

Catch agents that stop matching their guidelines, start costing far more than
their own history, or fall into a runaway tool loop.

## What This Covers

Three independent mechanisms, each with a different trigger:

| Mechanism | Trigger | Where it runs |
|-----------|---------|---------------|
| **Behavioral drift** | Agents comply with an SOP measurably less than they used to | Hourly control-plane sweep |
| **SOP staleness** | Agents stop matching an SOP at all | Hourly control-plane sweep |
| **Cost baselines** | A run costs far more than its own historical median | Inline, on every classified trace |
| **Sequence anomalies** | Runaway or implausible tool sequences | Rust proxy, sub-millisecond fast path |

::: info What changed on 2026-07-30
This page previously said behavioral drift scoring was **not** part of the
product. That was true at the time: the original embedding-based detector —
vector drift against a rolling centroid, `behavioral_drift_events_v2`,
`sop_drift_centroids` — was removed when the product narrowed to circuit-breaker
scope, and nothing replaced it.

It has since been rebuilt, deliberately without the embeddings. Drift is now a
subtraction between two stored numbers, described below. The centroid and cosine
-distance machinery is gone for good and is not coming back: a drift event you
cannot show the arithmetic for is one a customer cannot dispute.
:::

---

## Behavioral Drift

Drift means one thing here, measured one way: **agents working under an SOP have
become measurably more or less compliant with it than they used to be.** Not that
the SOP's text changed, and not that an embedding moved — a sustained change in
observed behaviour.

Each trace scores its own compliance from what the platform actually did to the
request: a clean pass scores 1.0, a redacted-and-forwarded call 0.6, a blocked
one 0.0, less a penalty for the severity of anything the classifier found. Those
scores roll into a per-SOP rolling average, and drift is the gap between that
average and a stored baseline:

1. **Baseline** — the first observation of an SOP *is* its baseline. The first
   thing you ever measure cannot be a change.
2. **Eligibility** — an SOP needs at least 20 matches in 30 days before it is
   judged at all. A handful of samples cannot establish that behaviour moved.
3. **Detection** — a gap of 0.15 or more raises a drift event recording the
   score, the direction, and both sides of the comparison.
4. **Re-baseline** — the baseline is immediately recaptured, so a given drift is
   reported once rather than every hour forever.
5. **Refinement** — a *degrading* SOP is queued for rewriting, ahead of stale
   ones. An *improving* SOP is recorded and left alone: agents obeying a
   guideline better is evidence the last rewrite worked, not a problem to fix.

Improvement and degradation are both recorded; only degradation is acted on.

---

## SOP Staleness

An SOP that agents have stopped matching is usually one whose scope no longer
describes the work being done. The hourly sweep flags any active SOP whose last
match is older than the staleness window, and enqueues it for review:

1. **Detection** — `last_match_at` is null, or older than the configured window
2. **Enqueue** — a review signal is queued for the workspace
3. **Refinement** — if the dream cycle is enabled (`DREAM_CYCLE_ENABLED=true`),
   the SOP is rewritten against its real usage evidence: days idle, matches in the
   last 30 days, and the average compliance score it achieved when it did match

The refinement prompt is given only measured facts. It is explicitly instructed
not to infer findings the evidence does not state.

---

## Session & SOP Lineage

Every agent session is linked to the specific SOP version that was active when it started. This creates a complete lineage chain:

```
Session → Active SOP Version → Execution Traces → Compliance Scores
```

This lineage allows Intutic to:

- Track which SOP version produced which compliance outcomes
- Compare the effectiveness of different SOP versions
- Compare outcomes before and after an SOP was edited

What this lineage does **not** do is score behavioural drift between versions — no
such comparison ships. It records which version was in force so you can read the
compliance outcomes yourself.

---

## Developer-Specific Baselines <Badge type="tip" text="Enterprise" />

In multi-developer environments, a single global baseline for an SOP can be too broad because developers have distinct usage patterns. Intutic dynamically calculates **Developer-Specific Baselines**:

- **Personalized Reference** — An hourly sweep computes a **median cost** baseline
  for each active (SOP, developer) pair from the trailing 14 days of traces, plus
  a workspace-wide baseline per SOP.
- **Intelligent Fallback** — When evaluating token waste, Intutic compares a trace
  against the developer's own baseline first, then falls back to the SOP-wide
  baseline if the developer has none.
- **Minimum sample size** — A baseline is published only once at least 20 traces
  support it. Below that, a legitimate second run trivially looks like several
  times the first, and the check would fire on noise.

::: tip Why median, not mean
Agent costs are long-tailed. A couple of very expensive runs would drag a mean
upward until nothing ever looked anomalous again.
:::

---

## Real-Time Sequence Anomaly Detection <Badge type="tip" text="Enterprise" />

To intercept anomalous behaviors (such as infinite tool execution loops, abnormal command bursts, or forbidden transition paths) before they generate high costs or damage systems, the Rust Proxy evaluates a **fast-path sequence classifier** (<1ms overhead):

1. **Valkey Queue Tracking** — The proxy maintains a sliding window of the last 20 tool calls executed during a session.
2. **Repetition Filtering** — If a single tool name is repeated consecutively 5 or more times, the proxy terminates the request immediately with a `Verdict::Kill`.
3. **Markov Transition Probabilities** — The proxy evaluates the probability matrix of transitions between consecutive tool invocations (e.g., `view_file` -> `run_command` is highly probable, while `run_command` -> `run_command` is anomalous).
4. **Enforcement Actions** — If the transition probability drops below `0.35`, the request is flagged with an advisory `Verdict::Hijack` (steer) — low
transition plausibility never blocks on its own.

---

## Responding

1. **Review the anomaly** in the dashboard anomaly feed
2. **Examine recent traces** to see what changed
3. **Update the SOP** if agents have outgrown its scope — a stale SOP is a scope
   problem more often than a compliance problem
4. **Expect baselines to re-level on their own**: they are recomputed hourly from a
   trailing window, so a deliberate, sustained change in cost becomes the new
   normal without any manual reset

---

## Related

- [Agent Guidelines (SOPs)](/guide/sops) — Managing the rules agents follow
- [Core Concepts](/guide/concepts) — Anomaly types and compliance scores
- [How It Works](/guide/how-it-works) — Architecture overview
