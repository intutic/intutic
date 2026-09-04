---
title: Evidence and Authority Provenance
description: Why "why did the system flag this?" and "who authorized this action?" are separate chains, and how Intutic keeps both connected to the execution record.
---

# Evidence and Authority Provenance <Badge type="tip" text="Open-Core" />

As AI agents move from producing text to taking consequential action — writing files, running commands, mutating databases — two different questions arise at the moment something happens, and they have different answers:

1. **What justified the conclusion?** Which detector fired, on what signal, at what confidence — the *evidence* chain.
2. **What authorized the action?** Who approved it, under what role, against what SOP, with what rationale — the *authority* chain.

A system's confidence in its own analysis is not, by itself, permission to act on it. A detector reaching high confidence does not create authority. Neither does agreement between several detectors. Those are both answers to the evidence question. The authority question — who is allowed to let this happen, and did that permission actually exist at the time — has to be answered independently, and the two answers need to both survive to the execution record rather than being collapsed into one number or silently substituting for each other.

This page names the distinction and points at where each chain actually lives in Intutic.

## The evidence chain

Every enforcement decision Intutic makes is backed by a detector, a WASM rule, or an SOP clause — not a black-box score. Concretely:

- **Detector findings** are stored per-detector, not just as a single promoted verdict — `detector_id`, `confidence`, `disposition`, and whether the finding was shadowed (evaluated but not enforced) all persist to `detector_findings`. See [Enforcement Actions](/concepts/enforcement-actions).
- **Corrective prompt cards carry SOP attribution** — when a promoted verdict traces back to a specific SOP clause, the corrective card cites it, not a generic "policy violation."
- **WASM shadow evaluations** report the real verdict a candidate rule would have produced, not a `WOULD_HAVE` sentinel — so promotion evidence is the same shape as production evidence, not a separate approximation.
- **Policy citations are evidence, not authority** — a guardrail derived from a policy document carries the verbatim sentence and the passage hash it stands on, and that citation travels with the rule into the block message the developer sees. It says why the rule exists. What lets the rule act is a separate, attributable step: a named owner or admin promotes it on counted shadow evidence, and that promotion is its own event on the guardrail's authority chain. See [Policy Guardrails](/guide/policy-guardrails).

The evidence chain answers: *why did the system believe this was worth flagging?* You can trace a decision backward to the specific signal that produced it.

## The authority chain

Separately, [Plan Governance](/guide/governance-controls) tracks who is allowed to let an agent's plan execute, and what happened when they did:

- **Role-gated approval** — `POST /plans/:id/approve|reject|close` requires `OWNER`, `ADMIN`, or `EM`, consistently across all three lifecycle transitions.
- **Named approvers, not flags** — `approvedBy`, `approvalTimestamp`, and `approvalRationale` are written by the approval itself, not inferred after the fact. A rejected plan carries `rejectedBy`/`rejectionRationale`; a closed plan carries `closedBy`/`closureRationale`/`executionOutcome`.
- **A transition table, not an implicit state machine** — `PENDING_APPROVAL → APPROVED/REJECTED/EXECUTING/COMPLETED`, `APPROVED → EXECUTING/COMPLETED`, `EXECUTING → COMPLETED`. An invalid transition is refused with a reason, not silently accepted.
- **Auto vs. human, distinguished, not merged** — when SkillOpt auto-applies a config edit because a confidence threshold and a workspace flag both permit it, the record carries `appliedVia: 'auto'`. A human-triggered apply carries `appliedVia: 'human'`. The same code path produces both; the record never pretends one is the other.

The authority chain answers: *who was allowed to let this happen, and is that permission still attributable after the fact?*

## Why keeping them separate matters

It would be easy to design a system where a high enough detector confidence *becomes* authorization — auto-approve above some threshold, no separate record. Intutic's plan lifecycle and SkillOpt auto-apply both do gate on confidence thresholds, but neither treats the threshold itself as the authority. Auto-apply requires a workspace admin to have explicitly enabled it as a flag, and the record says so (`appliedVia: 'auto'`) rather than presenting it identically to a human decision. The evidence justified considering the action; a separate, attributable permission is what let it actually happen. The Policy Clause Ledger holds the same line in one sentence: a citation is evidence; an approval is authority. A quote from the handbook can propose a rule and can mark it stale when the page changes; only a person can turn it on or off.

This is also why the two chains living in different subsystems — detector findings in the enforcement path, plan approval in the governance path — is a feature, not an accident to be tidied up. Collapsing them into one score would mean a reviewer asking "why did this execute?" gets a single number back, with no way to independently verify that the number came from the *right* place: real detector signal, and a real, attributable permission, not one masquerading as the other.

## Related

- [Circuit Breaker](/concepts/circuit-breaker) — where the evidence chain is evaluated
- [Enforcement Actions](/concepts/enforcement-actions) — the five outcomes a decision can produce, and the two rungs a check climbs
- [Governance Controls](/guide/governance-controls) — the plan approval lifecycle in full
- [Trace Integrity](/concepts/trace-integrity) — how the underlying records are made tamper-evident once written
