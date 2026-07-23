# Gödel Guardrails Scoring <Badge type="warning" text="Cloud / Team" />

::: warning Commercial / Team Tier Feature
Automated Gödel scoring and LLMProbe quality evaluation require an active **Intutic Control Plane** (local dev stack or Cloud SaaS / Team tier).
:::

Automated quality scoring for Standard Operating Procedures (SOPs) using a 13-category rubric that gates SOP lifecycle transitions.

## What Is the Gödel Score?

The **Gödel score** is a quality metric on a **0–26 scale** that evaluates whether an SOP is comprehensive, consistent, and safe enough to be enforced by the governance engine. Named after Kurt Gödel's work on formal system completeness, it ensures that SOPs meet a minimum quality bar before they can influence agent behavior.

Every SOP submitted to the control plane is scored against 13 rubric categories, each worth **0–2 points**. The total score determines which lifecycle gate the SOP passes through.

---

## Threshold Gates

The Gödel score controls automatic SOP lifecycle transitions:

| Score Range | Gate Result | Effect |
|-------------|-------------|--------|
| **< 12** | `BLOCKED` | SOP cannot proceed — it is rejected and must be revised |
| **12–14** | `PENDING_REVIEW` | SOP requires manual review by an Admin or EM before advancing |
| **≥ 15** | `GENERATED` | SOP auto-advances to the next lifecycle state |

::: tip
These thresholds can be tuned via environment variables to match your organization's risk tolerance. See [Configuration](#configuration) below.
:::

### Lifecycle Integration

The Gödel score integrates into the SOP lifecycle at the **DRAFT → PENDING_REVIEW / GENERATED** transition:

```
DRAFT → [Gödel Scoring] → BLOCKED (score < 12)
                         → PENDING_REVIEW (12 ≤ score < 15)
                         → GENERATED (score ≥ 15)
```

SOPs that score `BLOCKED` remain in `DRAFT` state and surface a quality report showing which rubric categories scored low.

---

## The 13-Category Rubric

Each category is scored from **0** (not addressed) to **2** (fully addressed):

| # | Category | What It Evaluates |
|---|----------|-------------------|
| 1 | **Completeness** | Does the SOP cover all necessary steps and edge cases? |
| 2 | **Consistency** | Are instructions internally consistent and non-contradictory? |
| 3 | **Testability** | Can compliance with the SOP be objectively verified? |
| 4 | **Side-Effect Coverage** | Are potential side effects of agent actions documented? |
| 5 | **Error Handling** | Does the SOP specify what to do when things go wrong? |
| 6 | **Security** | Are security implications addressed (secrets, permissions, data exposure)? |
| 7 | **Scope Clarity** | Is it clear when this SOP applies and when it does not? |
| 8 | **Version Compatibility** | Does the SOP account for different tool/API versions? |
| 9 | **Performance Impact** | Are resource usage and performance considerations documented? |
| 10 | **Observability** | Does the SOP include logging, metrics, or alerting guidance? |
| 11 | **Maintainability** | Is the SOP structured for easy updates as requirements evolve? |
| 12 | **Documentation** | Is the SOP itself well-documented with examples and rationale? |
| 13 | **Adversarial Resilience** | Does the SOP resist prompt injection or manipulation attempts? |

### Scoring Example

A well-written SOP covering code review requirements might score:

```
Completeness:            2/2
Consistency:             2/2
Testability:             2/2
Side-Effect Coverage:    1/2  (missing rollback steps)
Error Handling:          2/2
Security:                2/2
Scope Clarity:           2/2
Version Compatibility:   1/2  (no version-specific notes)
Performance Impact:      2/2
Observability:           2/2
Maintainability:         2/2
Documentation:           1/2  (examples could be richer)
Adversarial Resilience:  1/2  (no injection guard clauses)
─────────────────────────────
Total:                  22/26 → GENERATED ✅
```

---

## Configuration

Tune the gate thresholds with environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `GODEL_SCORE_THRESHOLD_GENERATED` | `22` | Minimum score for automatic advancement to `GENERATED` |
| `GODEL_SCORE_THRESHOLD_BLOCKED` | `12` | Scores below this are `BLOCKED` |

::: warning
Lowering `GODEL_SCORE_THRESHOLD_GENERATED` reduces the quality bar for auto-approved SOPs. Only adjust this if you have a robust manual review process for `PENDING_REVIEW` SOPs.
:::

Scores between `GODEL_SCORE_THRESHOLD_BLOCKED` and `GODEL_SCORE_THRESHOLD_GENERATED` land in `PENDING_REVIEW`, requiring manual approval from an Admin or EM.

---

## Current Implementation

::: info Phase 1 — Static Scoring
The current implementation (Phase 1) returns a **static score of 22** for all SOPs, placing them directly in the `GENERATED` gate. This ensures forward compatibility while the full LLM-based scoring engine is developed in Phase 2.

Phase 2 will integrate real 13-category LLM-based scoring via the Gödel Guardrails evaluator service, where each SOP's markdown content is evaluated against the rubric by an LLM judge.
:::

---

## Related

- [Standard Operating Procedures](/concepts/sops) — SOP lifecycle and structure
- [CLI Reference](/reference/cli) — SOP rules and local CLI configuration
- [Custom Filters (WASM)](/external/wasm-rules) — Policy rules engine
