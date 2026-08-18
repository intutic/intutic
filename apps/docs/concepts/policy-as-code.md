---
title: Policy as Code
description: How Intutic treats governance as code — policies are files reviewed in git, enforced synchronously in-process, and turned into Continuous Compliance evidence and Continuous Enforcement action on every tool call.
---

# Policy as Code <Badge type="tip" text="Open-Core" />

Intutic's category line is **Policy as Code for Continuous Compliance and Continuous Enforcement for AI agents**. This page defines what that means concretely, and links to the pages that back each claim. The mechanism underneath it is the same one described in [Circuit Breaker](/concepts/circuit-breaker): policies are files, evaluated synchronously and in-process on the hot path, before an action reaches your infrastructure.

## What policy as code means here

A policy is not a setting in a dashboard. It is a file: `.intutic/sops/*.md` and the harness guideline files Intutic syncs into each agent's native config format. [GitOps for SOPs](/guide/gitops-sops) documents the two-plane model behind this — `.intutic/sops/*.md` is the **file plane**, git-reviewable and enforced directly by the local proxy, while the control plane's SOP registry is the **DB plane**, holding lifecycle state, the judge/validation pipeline, and anti-gaming checks. `intutic sops push` / `pull` / `status` bridge the two, deliberately as a manual step rather than a silent background sync. The SOP format itself — front matter fields, risk tiers, validation states — is documented in [SOP Format Reference](/reference/sop-format).

The practical consequence: a policy change is a diff. It goes through the same review your code does, in the same repository or the same GitOps pipeline, instead of a click in an admin panel that no pull request ever saw.

## Continuous Enforcement (CE)

**Continuous Enforcement** is what happens to that file once it's live: every tool call an agent makes is evaluated against it and resolves to exactly one of five verdicts — `BYPASS`, `ENHANCE`, `HIJACK`, `REASK`, or `KILL` — decided synchronously, in-process, before the action executes. There is no batch job, no after-the-fact audit pass; the policy is consulted on the call itself. See [Enforcement Actions](/concepts/enforcement-actions) for what each verdict does and how the verdict is decided, and [Circuit Breaker](/concepts/circuit-breaker) for the decision engine that runs the check in-process, with no model call in the evaluation path.

"Continuous" here means literal, not marketing: there is no window where a policy is defined but not yet checked. The moment a SOP is synced to the enforcement path, the next matching tool call is evaluated against it.

## Continuous Compliance (CC)

**Continuous Compliance** is the evidence side of the same loop. [Compliance Evidence](/guide/compliance-evidence) describes the eight compliance probes that run against live workspace state hourly and on demand, each reporting a 0–100 score with structured findings. The governing principle, stated on that page: a probe whose control is switched off reports `not_enforced`, never `pass` — a control that has not run has not passed. That's what makes the "continuous" claim honest: compliance isn't a report generated once a quarter from memory, it's a score that goes stale the moment a probe stops running, and the system says so rather than rounding up.

[Governance Controls Checklist](/guide/governance-controls) applies the same discipline to the broader control set — stating coverage as **Strong**, **Partial**, or **Partial-to-strong** depending on what's actually verified today, not what's aspirational.

## The loop

Policy as code, Continuous Enforcement, and Continuous Compliance describe one cycle, not three separate features:

1. **Author** — a policy is written as a file (an SOP, a harness guideline).
2. **Review** — the file is reviewed in git, like any other code change.
3. **Enforce** — the circuit breaker evaluates every matching tool call against it, synchronously and in-process, and returns a verdict.
4. **Observe** — every verdict produces a trace, so the decision is inspectable after the fact.
5. **Evidence** — compliance probes turn the accumulated enforcement history into a score, on the cadence described above.
6. **Amend** — gaps found in review or in probe results become the next file change, and the loop repeats.

## How this differs from GRC-style policy-as-code

Governance platforms have started using "policy-as-code" too — see [Intutic vs Credo AI](/compare/credo-ai) for a specific comparison. The distinction isn't the vocabulary, it's where the policy lives and what executes it: a GRC platform authors policy-as-code in the platform and compiles it down to a per-harness hook. Intutic's policies are files in your repository from the start, and the thing executing them is the enforcement path itself. See [How Intutic Compares](/compare/) for the full comparison hub, including observability platforms and AI-security gateways that sit at different layers entirely.

## Getting started

[Getting Started](/guide/getting-started) walks through installing the CLI, connecting a workspace, and routing an agent through the proxy — the fastest way to see a policy file turn into an enforced verdict.
