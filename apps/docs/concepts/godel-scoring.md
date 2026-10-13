# Gödel Guardrails Scoring <Badge type="tip" text="Cloud" />

::: warning Control plane required
Automated Gödel scoring and LLMProbe quality evaluation require an active **Intutic Control Plane** (local dev stack or Intutic Cloud).
:::

Automated quality scoring for Standard Operating Procedures (SOPs) using a 13-category rubric that gates SOP lifecycle transitions.

## What Is the Gödel Score?

The **Gödel score** is a quality metric on a **0–26 scale** that evaluates whether an SOP is comprehensive, consistent, and safe enough to be enforced by the governance engine. Named after Kurt Gödel's work on formal system completeness, it ensures that SOPs meet a minimum quality bar before they can influence agent behavior.

An SOP is scored against 13 rubric categories, each worth **0–2 points**, when it is promoted from `PENDING_REVIEW` to `GENERATED`, when the SOP refinement cycle rewrites it, and whenever a lead runs the probe by hand. The total score determines the gate result.

---

## Threshold Gates

The Gödel score gates the `PENDING_REVIEW → GENERATED` transition. With the default thresholds (12 and 15):

| Score Range | Gate Result | Effect |
|-------------|-------------|--------|
| **< 12** | `BLOCKED` | The transition is refused; the SOP must be revised |
| **12–14** | `PENDING_REVIEW` | The transition is refused; the SOP stays in review |
| **≥ 15** | `GENERATED` | The transition goes through |

::: tip
These thresholds can be tuned via environment variables to match your organization's risk tolerance. See [Configuration](#configuration) below.
:::

### Lifecycle Integration

The Gödel score integrates into the SOP lifecycle at the **PENDING_REVIEW → GENERATED** transition (`POST /api/v1/sops/:sopId/transition`, owners and admins):

```
PENDING_REVIEW → [Gödel Scoring] → refused, BLOCKED (score < 12)
                                 → refused, PENDING_REVIEW (12 ≤ score < 15)
                                 → GENERATED (score ≥ 15)
```

A refused transition leaves the SOP in `PENDING_REVIEW` and names the score, the threshold and the gate result. Every score, passing or not, is recorded, and the latest one is shown with its per-category scores and rationales under **Gödel probe** on the SOP's Governance tab, where an owner, admin or EM can also re-run it (`POST /api/v1/sops/:sopId/godel-probe`).

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
| `GODEL_SCORE_THRESHOLD_GENERATED` | `15` | Minimum score for the `PENDING_REVIEW → GENERATED` transition |
| `GODEL_SCORE_THRESHOLD_BLOCKED` | `12` | Scores below this are `BLOCKED` |

::: warning
Lowering `GODEL_SCORE_THRESHOLD_GENERATED` reduces the quality bar for auto-approved SOPs. Only adjust this if you have a robust manual review process for `PENDING_REVIEW` SOPs.
:::

Scores between `GODEL_SCORE_THRESHOLD_BLOCKED` and `GODEL_SCORE_THRESHOLD_GENERATED` get the gate result `PENDING_REVIEW`. Any score below `GODEL_SCORE_THRESHOLD_GENERATED` refuses the transition; there is no manual override.

---

## Current Implementation

Each SOP's markdown is scored against the rubric by the platform's self-hosted judge model, which returns a score and a rationale per category. When the judge is the same model as the platform's default routing model (no separate `INTUTIC_TRUSTED_MONITOR_MODEL` is set), every rationale is prefixed `[self-graded]`.

When the judge cannot be reached (for example an air-gapped install with no model service), scoring falls back to an offline rubric that scores the same 13 categories on the document's observable structure: section headings, numbered steps, and language about verification, side effects, failures, credentials, scope, versions, cost, logging and prohibitions. Its rationales are prefixed `[offline]`, and the same thresholds apply.

---

## Related

- [Standard Operating Procedures](/concepts/sops) — SOP lifecycle and structure
- [CLI Reference](/reference/cli) — SOP rules and local CLI configuration
- [Custom Filters (WASM)](/external/wasm-rules) — Policy rules engine
