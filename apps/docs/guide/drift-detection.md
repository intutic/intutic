# Drift Detection <Badge type="warning" text="Cloud / Team" />

Monitor agent behavior over time and detect when agents deviate from expected patterns.

## What Is Drift?

Drift occurs when an AI agent's behavior changes over time — even without any configuration changes. This can happen due to model updates, prompt variations, or evolving usage patterns. Intutic monitors for drift so you can catch problems before they impact productivity or compliance.

---

## How Drift Detection Works

The drift detection system runs periodically (every 5 minutes by default) and compares current agent behavior against established baselines.

### Compliance Score Drift

The primary drift detection method:

1. **Window Average** — Calculates the average compliance score across recent traces over a rolling 7-day window
2. **Baseline Comparison** — Compares against the stored baseline compliance score for each active SOP
3. **Divergence Check** — If the deviation exceeds the threshold (default 15%), a drift event is logged

### Drift Direction

| Direction | Meaning |
|-----------|---------|
| **Positive Drift** | Compliance scores are *increasing* — agents are becoming more compliant than the baseline |
| **Negative Drift** | Compliance scores are *decreasing* — agents are deviating from expected behavior |

::: warning
Negative drift typically requires attention. It may indicate that agents are finding ways around governance rules, or that SOPs need updating to match current usage patterns.
:::

---

## Session & SOP Lineage

Every agent session is linked to the specific SOP version that was active when it started. This creates a complete lineage chain:

```
Session → Active SOP Version → Execution Traces → Compliance Scores
```

This lineage allows Intutic to:

- Track which SOP version produced which compliance outcomes
- Compare the effectiveness of different SOP versions
- Identify when an SOP change caused a drift in agent behavior

---

## Drift Events

When drift is detected, a `behavioral_drift_event` is created containing:

| Field | Description |
|-------|-------------|
| **SOP** | The SOP where drift was detected |
| **Direction** | Positive or negative drift |
| **Deviation** | The percentage deviation from baseline |
| **Window** | The time window analyzed |
| **Traces** | The number of traces in the analysis window |

Drift events appear in the dashboard's anomaly feed and can trigger alerts or escalation workflows.

---

## Advanced: Vector Drift Detection

For more subtle behavioral changes, Intutic supports vector-based drift detection using trace profile embeddings:

1. The system collects recent traces (models used, compliance scores, enforcement actions, token costs)
2. These are embedded into vector representations
3. Cosine distance is calculated against the baseline centroid
4. If the distance exceeds the threshold (default 0.15), a vector drift event is logged

::: info
Vector drift detection captures behavioral changes that aren't visible in simple compliance score averages — such as shifts in model selection patterns or cost profiles.
:::

---

---

## Developer-Specific Baselines <Badge type="tip" text="Enterprise" />

In multi-developer environments, a single global baseline for an SOP can be too broad because developers have distinct usage patterns. Intutic dynamically calculates **Developer-Specific Baselines**:

- **Personalized Reference** — The `driftDetectorCron` calculates individual compliance scores and median token spend baselines for each active developer (User-SOP pair).
- **Intelligent Fallback** — When evaluating token waste and behavior anomalies, Intutic compares execution traces against the developer's historical baseline first. If no developer-specific baseline exists, the system automatically falls back to the workspace-wide SOP baseline.

---

## Real-Time Sequence Anomaly Detection <Badge type="tip" text="Enterprise" />

To intercept anomalous behaviors (such as infinite tool execution loops, abnormal command bursts, or forbidden transition paths) before they generate high costs or damage systems, the Rust Proxy evaluates a **fast-path sequence classifier** (<1ms overhead):

1. **Valkey Queue Tracking** — The proxy maintains a sliding window of the last 20 tool calls executed during a session.
2. **Repetition Filtering** — If a single tool name is repeated consecutively 5 or more times, the proxy terminates the request immediately with a `Verdict::Kill`.
3. **Markov Transition Probabilities** — The proxy evaluates the probability matrix of transitions between consecutive tool invocations (e.g., `view_file` -> `run_command` is highly probable, while `run_command` -> `run_command` is anomalous).
4. **Enforcement Actions** — If the transition probability drops below `0.35`, the request is flagged with a `Verdict::Hijack` or blocked with a `Verdict::Kill`.

---

## Responding to Drift

When drift is detected:

1. **Review the drift event** in the dashboard anomaly feed
2. **Examine recent traces** to understand what changed
3. **Update SOPs** if the drift indicates rules need refinement
4. **Reset baselines** if the drift represents a desired behavioral change

---

## Related

- [Agent Guidelines (SOPs)](/guide/sops) — Managing the rules agents follow
- [Core Concepts](/guide/concepts) — Anomaly types and compliance scores
- [How It Works](/guide/how-it-works) — Architecture overview
